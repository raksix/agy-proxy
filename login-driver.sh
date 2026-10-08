#!/usr/bin/env bash
# Persistent agy login driver (see README). Keeps a FIFO-backed stdin alive so
# the CLI never sees EOF between the URL appearing and the code being pasted.
set -u

FIFO=/tmp/agy_in
OUT=/tmp/agy_login_out.txt

pkill -f "agy --print" 2>/dev/null
sleep 1
rm -f "$FIFO"
mkfifo "$FIFO"

cd /root

( sleep 7200 > "$FIFO" ) &
echo $! > /tmp/agy_holder.pid

tail -f "$FIFO" | agy --print="Waiting." --dangerously-skip-permissions --print-timeout 3600s > "$OUT" 2>&1 &
echo $! > /tmp/agy_pid.txt

sleep 10
echo "--- output so far ---"
tail -8 "$OUT"
echo "--- url ---"
URL=$(grep -oE 'https://accounts\.google\.com/o/oauth2/auth[^ ]+' "$OUT" | head -1)
echo "$URL" > /tmp/agy_url5.txt
echo "${#URL} chars"
