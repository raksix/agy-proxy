#!/usr/bin/env bash
# Measure streaming time-to-first-byte for the agy proxy.
# A long generation is requested so the proxy has something to stream; the
# interesting number is how many seconds pass before the first SSE chunk lands.
set -u

TOKEN="$(python3 -c "import hashlib;print(hashlib.sha256(b'agy-local-token').hexdigest()[:32])")"
OUT=/tmp/agy_stream_out.txt
MODEL="${1:-antigravity-gemini-3.8-flash}"

python3 - "$MODEL" > /tmp/agy_stream_req.json <<'PYEOF'
import json, sys
model = sys.argv[1]
big_system = "You are Hermes, an AI assistant with tools.\n" + ("TOOL DEFINITION filler content that is quite long and realistic. " * 400)
msgs = [
    {"role": "system", "content": big_system},
    {"role": "user", "content": "Write a 200-word paragraph about distributed systems."},
]
print(json.dumps({"model": model, "stream": True, "messages": msgs}))
PYEOF

rm -f "$OUT"
START=$(date +%s)
curl -s -N --max-time 400 -X POST http://127.0.0.1:3611/v1/chat/completions \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  --data @/tmp/agy_stream_req.json > "$OUT" 2>&1 &
CURL=$!

FIRST=-1
while kill -0 "$CURL" 2>/dev/null; do
  sleep 2
  NOW=$(date +%s)
  if [ "$FIRST" -lt 0 ] && grep -q "chat.completion.chunk" "$OUT" 2>/dev/null; then
    FIRST=$((NOW - START))
    echo "time_to_first_chunk=${FIRST}s"
  fi
  if [ $((NOW - START)) -gt 380 ]; then
    echo "watchdog firing at 380s"
    kill "$CURL" 2>/dev/null
    break
  fi
done
wait "$CURL" 2>/dev/null
echo "total_seconds=$(( $(date +%s) - START ))s bytes=$(wc -c < "$OUT") chunks=$(grep -c 'chat.completion.chunk' "$OUT" 2>/dev/null || echo 0)"
