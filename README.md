# agy-proxy

OpenAI-compatible local bridge for the **Google Antigravity CLI** (`agy`).

Hermes (or any OpenAI client) talks standard `/v1/chat/completions` to this
process; it translates each request into an `agy --print` run and returns the
answer in OpenAI shape. Zero npm dependencies — Node built-ins only.

## Layout

```
server.js            the bridge (node:http)
ecosystem.config.cjs pm2 process definition
start.sh             starts pm2 with the Gemini key injected from the box store
work/                agy working directory (created on boot)
```

## Usage

```bash
bash /root/agy-proxy/start.sh          # start / recycle under pm2
curl http://127.0.0.1:3611/health      # liveness + key presence
curl http://127.0.0.1:3611/v1/models   # model catalog
```

Chat completions require a bearer token:

```bash
curl -X POST http://127.0.0.1:3611/v1/chat/completions \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGY_PROXY_TOKEN" \
  -d '{"model":"antigravity-gemini-3.8-flash-fast",
       "messages":[{"role":"user","content":"hi"}]}'
```

`stream: true` is supported and emits OpenAI-style SSE chunks.

## Models

| Model id | agy slug | Notes |
|---|---|---|
| `antigravity-gemini-3.8-flash` | `gemini-3.8-flash-medium` | default |
| `antigravity-gemini-3.8-flash-fast` | `gemini-3.8-flash-low` | cheapest/fastest |
| `antigravity-gemini-3.8-flash-thinking` | `gemini-3.8-flash-high` | deepest effort |
| `antigravity-gemini-3.7-flash` | `gemini-3.7-flash-medium` | |
| `antigravity-gemini-3.6-flash` | `gemini-3.6-flash-medium` | |

Raw `agy` slugs are accepted as model ids too.

## Hermes wiring

Registered as provider `agcli` in `~/.hermes/config.yaml`:

```yaml
providers:
  agcli:
    name: Antigravity CLI
    base_url: http://127.0.0.1:3611/v1
    api_mode: chat_completions
    key_env: AGY_PROXY_TOKEN
    models:
      antigravity-gemini-3.8-flash: {}
      # ...
```

Use it with `hermes chat --provider agcli --model antigravity-gemini-3.8-flash-fast`.

## Implementation notes

- **Prompt never travels in argv.** A full Hermes system prompt exceeds the
  kernel argv limit (`E2BIG`), so the prompt is written to a temp file and read
  back through `sh -c 'exec agy --print "$(...)"'`.
- **Transient Gemini 503s.** `agy` sometimes stamps a run `ERROR` *after* the
  model produced an answer. The proxy prefers the collected response text and
  only fails the request when no text arrived at all.
- **Concurrency** is capped (`AGY_MAX_CONCURRENT`, default 3) — each `agy` run
  is a full child process with its own agent toolset.
- Binds `127.0.0.1` only. Never expose this port without putting auth in front.
