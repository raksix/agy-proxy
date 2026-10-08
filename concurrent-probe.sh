#!/usr/bin/env bash
# Concurrent streaming probe: fire N simultaneous streaming requests and report
# how long each took. Under concurrency the proxy caps agy runs, so this is
# where a stall would show up as a request waiting far longer than its peers.
set -u

N="${1:-3}"
TOKEN="$(python3 -c "import hashlib;print(hashlib.sha256(b'agy-local-token').hexdigest()[:32])")"

cat > /tmp/agy_conc_req.json <<'EOF'
{"model":"antigravity-gemini-3.8-flash","stream":true,"messages":[{"role":"user","content":"Write a 120-word paragraph about the sea."}]}
EOF

pids=()
for i in $(seq 1 "$N"); do
  (
    S=$(date +%s)
    curl -s -N --max-time 250 -X POST http://127.0.0.1:3611/v1/chat/completions \
      -H 'content-type: application/json' \
      -H "authorization: Bearer $TOKEN" \
      --data @/tmp/agy_conc_req.json > "/tmp/agy_conc_$i.txt" 2>&1
    E=$(date +%s)
    echo "$((E - S))" > "/tmp/agy_conc_$i.time"
  ) &
  pids+=($!)
done

for p in "${pids[@]}"; do wait "$p"; done

for i in $(seq 1 "$N"); do
  echo "req$i: seconds=$(cat /tmp/agy_conc_$i.time 2>/dev/null) bytes=$(wc -c < /tmp/agy_conc_$i.txt) chunks=$(grep -c chunk /tmp/agy_conc_$i.txt)"
done
