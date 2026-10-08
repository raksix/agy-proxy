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

/** Flatten an OpenAI messages array into one plain-text prompt for agy. */
function buildPrompt(messages, opts = {}) {
  const transcript = (opts.transcriptMode === 'raw')
    ? messages
    : messages;
  const lines = [];
  for (const m of transcript) {
    const role = String(m.role || 'user').toUpperCase();
    let content = m.content;
    if (Array.isArray(content)) {
      content = content.map((p) => {
        if (typeof p === 'string') return p;
        if (p.type === 'text') return p.text;
        if (p.type === 'image_url') return '[image attached]';
        return JSON.stringify(p);
      }).join('\n');
    }
    lines.push(`${role}: ${content ?? ''}`);
  }
  // agy runs as an agent, so tell it the last line is the request to answer.
  lines.push('');
  lines.push('ASSISTANT now responds to the final request above. Reply directly to it.');
  return lines.join('\n');
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
function runAgy({ slug, effort, prompt, signal, onDelta }) {
  return new Promise((resolve, reject) => {
    // The full Hermes system prompt easily exceeds the exec argv limit
    // (E2BIG), so agy never receives it as an argument. Pass it via a
    // temporary file read back through the shell instead.
    const promptFile = path.join(
      fs.mkdtempSync(path.join(AGY_CWD, '.pr-')),
      'prompt.txt'
    );
    fs.writeFileSync(promptFile, prompt, 'utf8');

    const args = [
      '--print', `$(cat ${JSON.stringify(promptFile)})`,
      '--model', slug,
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--print-timeout', String(Math.ceil(REQUEST_TIMEOUT_MS / 1000)) + 's',
    ];
    if (effort) args.push('--effort', effort);

    const cleanup = () => {
      try { fs.rmSync(path.dirname(promptFile), { recursive: true, force: true }); } catch {}
    };

    const child = spawn('/bin/sh', ['-c',
      `exec ${JSON.stringify(AGY_BIN)} "$@"`,
      'agy-shim', // $0 for the shim (unused by agy)
      ...args,
    ], {
      cwd: AGY_CWD,
      env: { ...process.env, GEMINI_API_KEY: GEMINI_KEY },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

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
      cleanup();
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

    child.on('close', () => {
      if (!killed && !text) {
        finish({ text, usage, status, error: lastError || 'agy exited without output' });
      } else {
        finish({ text, usage, status, error: lastError });
      }
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
      running, max: MAX_CONCURRENT, version: '1.0.0',
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
    const prompt = buildPrompt(body.messages || []);
    if (!prompt.trim()) return errorResponse(res, 400, 'no messages');

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
      const r = await runAgy({
        slug: spec.slug, effort: spec.effort, prompt,
        signal: controller.signal,
        onDelta: (delta) => {
          acc += delta;
          sse(res, { id, object: 'chat.completion.chunk', created: now(), model,
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] });
        },
      });

      // If the model answered but the CLI marked ERROR, the answer is still valid.
      const finalText = r.text || acc;
      sse(res, { id, object: 'chat.completion.chunk', created: now(), model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      sse(res, { id, object: 'chat.completion.chunk', created: now(), model,
        choices: [], usage: openAIShape(model, finalText, r.usage, 'stop').usage });
      res.write('data: [DONE]\n\n');
      res.end();
      done();
      return;
    }

    const r = await runAgy({ slug: spec.slug, effort: spec.effort, prompt, signal: controller.signal });
    const finalText = r.text;
    if (!finalText) {
      done();
      const msg = (r.error || 'agy produced no output').slice(0, 400);
      return errorResponse(res, 502, msg);
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
