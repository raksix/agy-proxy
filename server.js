#!/usr/bin/env node
/**
 * agy-proxy — OpenAI-compatible bridge for Google Antigravity CLI (`agy`).
 *
 * Runs on 127.0.0.1 only. Hermes (and any local OpenAI client) sends standard
 * /v1/chat/completions requests; this process translates them into
 * `agy --print` invocations and returns the answer in OpenAI shape.
 *
 * Zero dependencies: node:http only.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.AGY_PROXY_PORT || 3611);
const HOST = process.env.AGY_PROXY_HOST || '127.0.0.1';
const AUTH_TOKEN = process.env.AGY_PROXY_TOKEN || 'agy-local';
const AGY_BIN = process.env.AGY_BIN || '/root/.local/bin/agy';
const AGY_CWD = process.env.AGY_CWD || '/root/agy-proxy/work';
const MAX_CONCURRENT = Number(process.env.AGY_MAX_CONCURRENT || 3);
const REQUEST_TIMEOUT_MS = Number(process.env.AGY_TIMEOUT_MS || 300000);
const DEFAULT_LANGUAGE = (process.env.AGY_LANGUAGE || '').trim().toLowerCase();

// No API key is injected: agy authenticates through its own OAuth session
// (antigravity-oauth-token in ~/.gemini/antigravity-cli). A Gemini provider
// key is only honoured when the operator explicitly opts in via AGY_USE_GEMINI_KEY.
const USE_GEMINI_KEY = process.env.AGY_USE_GEMINI_KEY === '1';
const GEMINI_KEY = USE_GEMINI_KEY ? (process.env.GEMINI_API_KEY || '') : '';

/** Friendly model name -> { slug, effort } */
const AGY_MODELS = {
  'antigravity-gemini-3.8-flash': { slug: 'gemini-3.8-flash-medium', effort: 'medium' },
  'antigravity-gemini-3.8-flash-fast': { slug: 'gemini-3.8-flash-low', effort: 'low' },
  'antigravity-gemini-3.8-flash-thinking': { slug: 'gemini-3.8-flash-high', effort: 'high' },
  'antigravity-gemini-3.7-flash': { slug: 'gemini-3.7-flash-medium', effort: 'medium' },
  'antigravity-gemini-3.6-flash': { slug: 'gemini-3.6-flash-medium', effort: 'medium' },
};

/** Raw slugs are accepted too, so `agy models` output works verbatim. */
const SLUG_TO_NAME = Object.fromEntries(
  Object.entries(AGY_MODELS).flatMap(([name, m]) => [[m.slug, name]])
);

// ---------------------------------------------------------------- concurrency
let running = 0;
const waiters = [];
function acquire() {
  if (running < MAX_CONCURRENT) { running++; return Promise.resolve(); }
  return new Promise((res) => waiters.push(res));
}
function release() {
  const next = waiters.shift();
  if (next) { next(); } else { running--; }
}

// ------------------------------------------------------------------ utilities
function now() { return Math.floor(Date.now() / 1000); }
function rid() { return 'chatcmpl-' + Math.random().toString(36).slice(2, 12); }

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Hard ceiling for the prompt handed to agy.
 *
 * The CLI runs a real agent loop with its own toolset, so a system prompt
 * carries all of its own instructions too. Measured on this box: agy answers
 * up to ~100k characters and dies SILENTLY (no result event, no error, exit≠0)
 * above ~130k. A caller receiving that sees an empty answer and retries the
 * same oversized request forever.
 */
const PROMPT_CHAR_LIMIT = Number(process.env.AGY_PROMPT_CHAR_LIMIT || 90000);

/**
 * Shrink an oversized conversation while keeping the parts that carry meaning.
 * Order matters: the last user message is the actual request, the first system
 * message carries the persona, and everything in between is history that can be
 * truncated from the MIDDLE (oldest turns first).
 */
function fitPrompt(messages, limit) {
  if (messages.length === 0) return messages;

  const measure = (arr) => arr.reduce((n, m) => {
    const c = typeof m?.content === 'string' ? m.content
      : Array.isArray(m?.content) ? m.content.map((p) => p?.text || '').join('')
      : '';
    return n + c.length + (m?.tool_calls ? 200 : 0);
  }, 0);

  if (measure(messages) <= limit) return messages;

  const head = messages[0]?.role === 'system' ? [messages[0]] : [];
  const tail = messages.slice(head.length);
  const last = tail[tail.length - 1];
  const middle = tail.slice(0, -1);

  // Keep as many of the most recent turns as fit, then note what was dropped.
  const kept = [];
  let budget = limit - measure(head) - measure([last]) - 400;
  for (let i = middle.length - 1; i >= 0; i--) {
    const cost = measure([middle[i]]) + 40;
    if (cost > budget) break;
    kept.unshift(middle[i]);
    budget -= cost;
  }
  const dropped = middle.length - kept.length;

  const out = [];
  if (head.length) {
    // Keep the persona but cap it too: it is the single biggest contributor.
    const sys = head[0];
    const raw = typeof sys.content === 'string' ? sys.content : measure([sys]);
    const cap = Math.max(20000, limit - 30000);
    if (String(raw).length > cap) {
      out.push({ ...sys, content: `${String(raw).slice(0, cap)}\n\n[system prompt truncated by agy-proxy: ${String(raw).length} chars → ${cap}]` });
    } else {
      out.push(sys);
    }
  }
  if (dropped > 0) {
    out.push({ role: 'user', content: `[earlier conversation omitted: ${dropped} older message(s) exceeded the prompt limit]` });
  }
  out.push(...kept);
  if (last) out.push(last);
  return out;
}

/** Flatten an OpenAI messages array into one plain-text prompt for agy. */
function buildPrompt(messages, opts = {}) {
  const transcript = fitPrompt(messages, opts.limit || PROMPT_CHAR_LIMIT);
  const lines = [];
  for (const m of transcript) {
    // Tool-result turns must stay machine-readable: the agent has to be able to
    // tell a tool name from its opaque payload, so JSON-encode them whole
    // instead of stringifying the object into "role: [object Object]".
    if (m.role === 'tool' || m.role === 'function') {
      let payload = m.content;
      if (typeof payload !== 'string') {
        try { payload = JSON.stringify(payload); } catch { payload = String(payload); }
      }
      lines.push(`TOOL RESULT (${m.name || m.tool_call_id || 'tool'}): ${payload}`);
      continue;
    }

    let content = m.content;
    if (Array.isArray(content)) {
      content = content.map((p) => {
        if (typeof p === 'string') return p;
        if (p.type === 'text') return p.text;
        if (p.type === 'image_url') return '[image attached]';
        return JSON.stringify(p);
      }).join('\n');
    }

    // An assistant turn that requested tools must show WHAT it asked for,
    // otherwise the agent re-issues the same call forever after the result.
    const tcs = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    if (tcs.length) {
      const rendered = tcs.map((tc) => {
        const fn = (tc && tc.function) || {};
        const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {});
        return `CALLED ${fn.name || 'unknown'}(${args})`;
      }).join('\n');
      const base = content ? `${content}\n` : '';
      lines.push(`ASSISTANT: ${base}${rendered}`);
      continue;
    }

    lines.push(`${String(m.role || 'user').toUpperCase()}: ${content ?? ''}`);
  }

  // Expose the caller's tool catalog so the agent can request one of them
  // instead of only reaching for its own built-in tools. Without this the
  // request is silently ignored and the answer is plain text.
  //
  // Only name + one-line description + the flat list of top-level parameter
  // names. Sending the full JSON schema made a real Hermes request (24 tools)
  // reach 312KB, which the CLI silently fails to run — no result event, no
  // error, so the caller only sees an empty answer.
  if (Array.isArray(opts.tools) && opts.tools.length) {
    lines.push('');
    lines.push('=== AVAILABLE TOOLS ===');
    lines.push('When a task needs a tool, reply with EXACTLY this one-line form and nothing else:');
    lines.push('TOOL_CALL: <name>(<json arguments>)');
    lines.push('If no tool is needed, answer normally. Never invent a tool name.');
    for (const t of opts.tools) {
      const fn = (t && t.function) || t || {};
      const name = fn.name || 'unknown';
      const desc = fn.description ? ` — ${String(fn.description).slice(0, 120)}` : '';
      let argNames = '';
      try {
        const props = fn.parameters && fn.parameters.properties;
        if (props && typeof props === 'object') {
          argNames = ` | args: ${Object.keys(props).join(', ')}`;
        }
      } catch {}
      lines.push(`- ${name}${desc}${argNames}`);
    }
  }

  // agy runs as an agent, so tell it the last line is the request to answer.
  lines.push('');
  const lang = (opts.language || '').toLowerCase();
  if (lang === 'ja' || lang === 'japanese' || lang === 'jp') {
    lines.push('ASSISTANT now responds to the final request above in Japanese. Reply directly to it in Japanese (日本語で回答してください).');
  } else if (lang === 'tr' || lang === 'turkish') {
    lines.push('ASSISTANT now responds to the final request above in Turkish. Reply directly to it in Turkish (Türkçe olarak yanıt veriniz).');
  } else if (lang === 'en' || lang === 'english') {
    lines.push('ASSISTANT now responds to the final request above in English. Reply directly to it in English.');
  } else {
    lines.push('ASSISTANT now responds to the final request above. Reply directly to it.');
  }
  return lines.join('\n');
}

/**
 * Detect a tool request in the model's answer.
 * Returns { name, args } or null. The model is told to answer with the single
 * line `TOOL_CALL: name({...})`, so accept that first and fall back to a
 * generic `name({...})` shape.
 */
function parseToolCall(text) {
  if (!text) return null;
  const src = String(text);
  // Search the whole answer: a preamble sentence may precede the directive.
  const re = /(?:^|\n)\s*(?:TOOL_CALL:\s*)?([A-Za-z_][A-Za-z0-9_.-]*)\s*\((.*)\)\s*$/s;
  const m = re.exec(src);
  if (!m) return null;

  const name = m[1];
  if (name === 'function' || name === 'if' || name === 'for' || name === 'while' || name === 'return') return null;

  let rawArgs = (m[2] || '').trim();
  if (!rawArgs) return { name, args: {} };
  // Only accept a parseable JSON object; a prose parenthesis is not a call.
  try {
    const parsed = JSON.parse(rawArgs);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { name, args: parsed };
    return null;
  } catch {
    return null;
  }
}

/** True when the OpenAI `tools` array contains a tool with this name. */
function knownTool(tools, name) {
  if (!Array.isArray(tools) || !name) return false;
  return tools.some((t) => {
    const fn = (t && t.function) || t || {};
    return fn.name === name;
  });
}

/** Determine target response language from query string, body, headers, or default. */
function resolveLanguage(req, body, url) {
  const qLang = url.searchParams.get('lang') || url.searchParams.get('language');
  if (qLang) return qLang.trim().toLowerCase();

  if (body) {
    const bLang = body.language || body.lang || body.target_language;
    if (bLang) return String(bLang).trim().toLowerCase();
  }

  const hLang = req.headers['x-language'] || req.headers['x-lang'];
  if (hLang) return String(hLang).trim().toLowerCase();

  const acceptLang = req.headers['accept-language'];
  if (acceptLang) {
    const primary = acceptLang.split(',')[0].split(';')[0].trim().toLowerCase();
    if (primary.startsWith('ja')) return 'ja';
    if (primary.startsWith('tr')) return 'tr';
    if (primary.startsWith('en')) return 'en';
  }

  return DEFAULT_LANGUAGE;
}

function resolveModel(name) {
  if (!name) return AGY_MODELS['antigravity-gemini-3.8-flash'];
  if (AGY_MODELS[name]) return AGY_MODELS[name];
  if (SLUG_TO_NAME[name]) return AGY_MODELS[SLUG_TO_NAME[name]];
  // Unknown name: try a few sane defaults rather than failing hard.
  return { slug: name, effort: undefined };
}

// ------------------------------------------------------------------ agy runner
/** Run a short agy subcommand (e.g. `models`) and capture raw stdout. */
function runPlain(args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const child = spawn(AGY_BIN, args, {
      cwd: AGY_CWD,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve({ status: -1, stdout: '' }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code, stdout: out }); });
  });
}

/**
 * Run one prompt through agy.
 * Resolves { text, usage, status, error } — `text` is non-empty whenever the
 * model actually produced an answer, even when the CLI stamps the run ERROR
 * after the fact (transient Gemini 503s hit post-processing).
 */
function runAgy({ slug, effort, prompt, signal, onDelta, onTool }) {
  return new Promise((resolve, reject) => {
    // Pass prompt via stdin using `--input-format text` so the prompt size
    // is unlimited and never hits kernel exec argv limits (E2BIG).
    const args = [
      '--input-format', 'text',
      '--output-format', 'stream-json',
      '--model', slug,
      '--dangerously-skip-permissions',
      '--print-timeout', String(Math.ceil(REQUEST_TIMEOUT_MS / 1000)) + 's',
    ];
    // agy REJECTS an --effort flag when the model slug already encodes one
    // ("--model gemini-3.7-flash-medium conflicts with --effort=low"), so the
    // suffix must be stripped before the bare model name is passed through.
    // Every slug in AGY_MODELS ends in -low/-medium/-high, which is exactly
    // the effort the friendly alias asked for, so there is nothing to add.
    // Hermes also sends its own reasoning_effort ("none" when the model should
    // not think), which agy does not accept at all — valid values are only
    // low/medium/high/xhigh/max, so anything else is dropped.
    const AGY_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
    const safeEffort = AGY_EFFORTS.has(String(effort || '').toLowerCase())
      ? String(effort).toLowerCase()
      : null;
    if (safeEffort && !/-(low|medium|high)$/.test(slug)) {
      args.push('--effort', safeEffort);
    }

    const child = spawn(AGY_BIN, args, {
      cwd: AGY_CWD,
      env: { ...process.env, GEMINI_API_KEY: GEMINI_KEY },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin.on('error', () => {});
    child.stdin.end(prompt, 'utf8');

    let buf = '';
    let text = '';
    let usage = null;
    let status = null;
    let lastError = '';
    let finalized = false;
    let killed = false;

    const finish = (payload) => {
      if (finalized) return;
      finalized = true;
      clearTimeout(hardTimer);
      resolve(payload);
    };

    const hardTimer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch {}
      finish({ text, usage, status, error: 'timeout' });
    }, REQUEST_TIMEOUT_MS + 15000);

    if (signal) {
      signal.addEventListener('abort', () => {
        killed = true;
        try { child.kill('SIGKILL'); } catch {}
        finish({ text, usage, status, error: 'aborted' });
      }, { once: true });
    }

    child.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.event === 'step_update' && ev.step_update) {
          const su = ev.step_update;
          if (su.step_type === 'agent_response' && su.text_delta) {
            text += su.text_delta;
            if (onDelta) onDelta(su.text_delta);
          }
          // A tool step going ACTIVE means the agent is mid-action and will
          // emit nothing else for a while — report it so the client can show
          // progress instead of treating the silence as a stall. DONE is
          // reported too, otherwise a fast tool is never seen at all.
          if (su.tool_name && su.state && onTool) {
            onTool(su.tool_name, su.state);
          }
          if (su.usage) usage = su.usage;
        } else if (ev.event === 'result' && ev.result) {
          const r = ev.result;
          if (typeof r.response === 'string' && r.response.length > text.length) {
            text = r.response;
          }
          if (r.usage) usage = r.usage;
          status = r.status;
          if (r.error) lastError = r.error;
          finish({ text, usage, status, error: r.error });
        }
      }
    });

    child.stderr.on('data', (d) => {
      const s = d.toString();
      lastError += s.slice(-600);
    });

    child.on('error', (e) => {
      finish({ text, usage, status, error: String(e && e.message || e) });
    });

    child.on('close', (code) => {
      // No result event AND no text: the CLI died before answering. The
      // oversized-prompt case fails exactly this way (silent death, exit≠0),
      // so surface the exit code instead of an empty 200 response — a caller
      // that receives 200+"" just retries the same oversized request.
      if (!text) {
        const detail = lastError ? `: ${lastError.slice(0, 300)}` : '';
        finish({
          text, usage, status,
          error: `agy exited without a result event (code ${code})${detail}`,
        });
        return;
      }
      finish({ text, usage, status, error: lastError });
    });
  });
}

// ------------------------------------------------------------------ responses
function openAIShape(model, text, usage, finishReason) {
  const u = usage || {};
  const pt = Number(u.input_tokens || 0);
  const ct = Number(u.output_tokens || 0);
  return {
    id: rid(),
    object: 'chat.completion',
    created: now(),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: pt,
      completion_tokens: ct,
      total_tokens: pt + ct,
      ...(u.thinking_tokens ? { reasoning_tokens: Number(u.thinking_tokens) } : {}),
    },
  };
}

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function errorResponse(res, code, message) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type: 'proxy_error', code: String(code) } }));
}

// ---------------------------------------------------------------------- routes
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': '*',
    });
    return res.end();
  }

  if (p === '/health' || p === '/healthz') {
    // Prove the CLI is actually signed in, not merely that the proxy booted.
    let auth = 'unknown';
    let authModels = 0;
    try {
      const r = await runPlain(['models']);
      auth = r.status === 0 ? 'authenticated' : 'error';
      authModels = (r.stdout.match(/gemini-/g) || []).length;
    } catch (e) { auth = 'error'; }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok', auth, authModels,
      gemini_key: USE_GEMINI_KEY ? (GEMINI_KEY ? 'injected' : 'missing') : 'not-used',
      running, max: MAX_CONCURRENT, version: '1.1.0',
      languages: ['en', 'tr', 'ja'],
      default_language: DEFAULT_LANGUAGE || 'auto',
    }));
  }

  if ((p === '/v1/models' || p === '/models') && req.method === 'GET') {
    const data = Object.entries(AGY_MODELS).map(([id, m]) => ({
      id, object: 'model', created: now(), owned_by: 'antigravity-cli',
      // extra metadata some clients read
      provider_slug: m.slug,
    }));
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data }));
  }

  if (p === '/v1/chat/completions' || p === '/chat/completions') {
    if (req.method !== 'POST') return errorResponse(res, 405, 'POST required');

    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (AUTH_TOKEN && token !== AUTH_TOKEN) {
      return errorResponse(res, 401, 'invalid bearer token');
    }

    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { return errorResponse(res, 400, 'invalid JSON body: ' + e.message); }

    const model = body.model || 'antigravity-gemini-3.8-flash';
    const spec = resolveModel(model);
    const lang = resolveLanguage(req, body, url);
    const tools = Array.isArray(body.tools) ? body.tools : [];
    // Hermes sends reasoning_effort ("none" to disable thinking); when present it
    // must override the alias default, otherwise a reasoning-forced client gets
    // an effort it never asked for.
    const effortOverride = body.reasoning_effort !== undefined
      ? String(body.reasoning_effort || '').toLowerCase()
      : null;
    const prompt = buildPrompt(body.messages || [], { language: lang, tools });
    if (!prompt.trim()) return errorResponse(res, 400, 'no messages');

    if (process.env.AGY_DEBUG_PROMPT === '1') {
      try {
        fs.appendFileSync('/tmp/agy-dbg.log', `${Date.now()} proplen=${prompt.length} tools=${tools.length} eff=${effortOverride ?? spec.effort}\n`, 'utf8');
        fs.writeFileSync('/tmp/agy-dbg-prompt.txt', prompt, 'utf8');
      } catch {}
    }

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    const permit = await acquire();
    let released = false;
    const done = () => { if (!released) { released = true; release(); } };

    if (body.stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const id = rid();
      sse(res, { id, object: 'chat.completion.chunk', created: now(), model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });

      let acc = '';
      // agy emits nothing while a tool runs, and the agent_response step stays
      // ACTIVE with no text_delta for minutes. Every client-side stale-stream
      // watchdog sees that as a dead connection, so keep the socket live with
      // comment heartbeats and surface tool activity as reasoning deltas.
      // 5s, not 15s: Hermes' own watchdog treats a ping-only connection as
      // dead after ~16s, so a 15s interval sat right on the boundary and the
      // request was dropped mid-turn.
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 5000);
      let lastPing = Date.now();
      // Text is buffered (not forwarded live) when tools are on the line: a
      // directive like `TOOL_CALL: x({})` must not reach the user as prose
      // before we know whether it is a real call.
      const liveText = tools.length === 0;

      const r = await runAgy({
        slug: spec.slug, effort: effortOverride ?? spec.effort, prompt,
        signal: controller.signal,
        onDelta: (delta) => {
          acc += delta;
          lastPing = Date.now();
          if (liveText) {
            sse(res, { id, object: 'chat.completion.chunk', created: now(), model,
              choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] });
          }
        },
        onTool: (tool, state) => {
          lastPing = Date.now();
          // Emitted as reasoning content, which Hermes renders as thinking/activity
          // rather than polluting the visible answer.
          const label = state === 'DONE' ? `[agy: ${tool} → done]` : `[agy: ${tool}]`;
          sse(res, { id, object: 'chat.completion.chunk', created: now(), model,
            choices: [{ index: 0, delta: { reasoning_content: label }, finish_reason: null }] });
        },
      });
      clearInterval(hb);
      void lastPing;

      const finalText = r.text || acc;
      const toolCall = (tools.length && finalText) ? parseToolCall(finalText) : null;
      // Only honour a name the caller actually advertised — a hallucinated tool
      // would send Hermes down a dead path.
      const valid = (toolCall && knownTool(tools, toolCall.name)) ? toolCall : null;

      if (valid) {
        const tcId = 'call_' + Math.random().toString(36).slice(2, 12);
        sse(res, { id, object: 'chat.completion.chunk', created: now(), model,
          choices: [{ index: 0, delta: { tool_calls: [{
            index: 0, id: tcId, type: 'function',
            function: { name: valid.name, arguments: JSON.stringify(valid.args) },
          }] }, finish_reason: null }] });
        sse(res, { id, object: 'chat.completion.chunk', created: now(), model,
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        sse(res, { id, object: 'chat.completion.chunk', created: now(), model,
          choices: [], usage: openAIShape(model, '', r.usage, 'tool_calls').usage });
        res.write('data: [DONE]\n\n');
        res.end();
        done();
        return;
      }

      // If the model answered but the CLI marked ERROR, the answer is still valid.
      sse(res, { id, object: 'chat.completion.chunk', created: now(), model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      sse(res, { id, object: 'chat.completion.chunk', created: now(), model,
        choices: [], usage: openAIShape(model, finalText, r.usage, 'stop').usage });
      res.write('data: [DONE]\n\n');
      res.end();
      done();
      return;
    }

    const r = await runAgy({ slug: spec.slug, effort: effortOverride ?? spec.effort, prompt, signal: controller.signal });
    const finalText = r.text;
    if (!finalText) {
      done();
      const msg = (r.error || 'agy produced no output').slice(0, 400);
      return errorResponse(res, 502, msg);
    }

    // Same validation on the non-streaming path: only an advertised tool name
    // becomes a tool_call, everything else is returned as the answer text.
    const toolCall = tools.length ? parseToolCall(finalText) : null;
    if (toolCall && knownTool(tools, toolCall.name)) {
      const shape = openAIShape(model, '', r.usage, 'tool_calls');
      shape.choices[0].message = {
        role: 'assistant', content: null,
        tool_calls: [{
          id: 'call_' + Math.random().toString(36).slice(2, 12),
          type: 'function',
          function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) },
        }],
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(shape));
      done();
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(openAIShape(model, finalText, r.usage, 'stop')));
    done();
    return;
  }

  errorResponse(res, 404, 'not found: ' + p);
});

fs.mkdirSync(AGY_CWD, { recursive: true });
server.listen(PORT, HOST, () => {
  console.log(`agy-proxy listening on http://${HOST}:${PORT}  gemini_key=${GEMINI_KEY ? 'present' : 'MISSING'}`);
});
