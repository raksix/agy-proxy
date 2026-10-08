#!/usr/bin/env bash
# Start agy-proxy with the Gemini key injected from the box secret store.
# Key never lands in this file, in ecosystem.config.cjs, or in pm2 env.
set -euo pipefail

cd /root/agy-proxy

KEY="$(python3 - <<'PY'
for line in open('/root/sooliva-v4/backend/.env'):
    if 'GEMINI_API_KEY' in line and not line.strip().startswith('#'):
        k, v = line.strip().split('=', 1)
        print(v.strip().strip('"').strip("'"))
        break
PY
)"

if [ -z "${KEY}" ]; then
  echo "FATAL: GEMINI_API_KEY not found in /root/sooliva-v4/backend/.env" >&2
  exit 1
fi

TOKEN="$(python3 - <<'PY'
import hashlib
print(hashlib.sha256(b'agy-local-token').hexdigest()[:32])
PY
)"

# ESM/cache trap: pm2 restart can serve a stale binary; delete+start is the
# reliable recycle. Never `pm2 kill` — the 67 box runs ~20 projects.
pm2 delete agy-proxy >/dev/null 2>&1 || true

AGY_PROXY_PORT=3611 \
AGY_PROXY_HOST=127.0.0.1 \
AGY_CWD=/root/agy-proxy/work \
AGY_MAX_CONCURRENT=3 \
AGY_TIMEOUT_MS=300000 \
GEMINI_API_KEY="${KEY}" \
AGY_PROXY_TOKEN="${TOKEN}" \
  pm2 start server.js --name agy-proxy --time

pm2 save
