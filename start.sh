#!/usr/bin/env bash
# Start agy-proxy with the Gemini key injected from secret store if present.
# Key never lands in this file, in ecosystem.config.cjs, or in pm2 env.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

KEY="$(python3 - <<'PY'
import os
for path in ['/root/sooliva-v4/backend/.env', '.env']:
    if os.path.isfile(path):
        try:
            for line in open(path):
                if 'GEMINI_API_KEY' in line and not line.strip().startswith('#'):
                    parts = line.strip().split('=', 1)
                    if len(parts) == 2:
                        print(parts[1].strip().strip('"').strip("'"))
                        exit(0)
        except Exception:
            pass
print(os.environ.get('GEMINI_API_KEY', ''))
PY
)"

TOKEN="${AGY_PROXY_TOKEN:-$(python3 -c "import hashlib;print(hashlib.sha256(b'agy-local-token').hexdigest()[:32])")}"

# ESM/cache trap: pm2 restart can serve a stale binary; delete+start is the
# reliable recycle. Never `pm2 kill` — other server processes must remain alive.
pm2 delete agy-proxy >/dev/null 2>&1 || true

AGY_PROXY_PORT="${AGY_PROXY_PORT:-3611}" \
AGY_PROXY_HOST="${AGY_PROXY_HOST:-127.0.0.1}" \
AGY_CWD="${AGY_CWD:-$DIR/work}" \
AGY_MAX_CONCURRENT="${AGY_MAX_CONCURRENT:-3}" \
AGY_TIMEOUT_MS="${AGY_TIMEOUT_MS:-300000}" \
GEMINI_API_KEY="${KEY}" \
AGY_PROXY_TOKEN="${TOKEN}" \
  pm2 start server.js --name agy-proxy --time

pm2 save
