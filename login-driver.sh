#!/usr/bin/env bash
# Interactive login helper for the Antigravity CLI (`agy`).
#
# `agy` needs a browser OAuth flow that no headless API call can satisfy, and
# its stdin reader closes as soon as the launching shell exits — which also
# discards the PKCE verifier and invalidates the code. This script keeps the
# process alive through a FIFO so a code can be pasted into it later:
#
#   bash login-driver.sh                 # prints the auth URL
#   echo "4/0AXlq..." > /tmp/agy_in      # paste the code
#
# The completed session is stored in
# ~/.gemini/antigravity-cli/antigravity-oauth-token, which the proxy reads
# through the CLI itself — no key is ever written to disk here.
set -u

FIFO=/tmp/agy_in
OUT=/tmp/agy_login_out.txt

pkill -f "agy --print" 2>/dev/null
sleep 1
rm -f "$FIFO"
mkfifo "$FIFO"

cd /root

# Hold the FIFO open so agy's stdin never sees EOF.
( sleep 7200 > "$FIFO" ) &
echo $! > /tmp/agy_holder.pid

tail -f "$FIFO" | agy --print="Waiting." --dangerously-skip-permissions --print-timeout 3600s > "$OUT" 2>&1 &
echo $! > /tmp/agy_pid.txt

# Give the CLI time to compute the PKCE challenge and print the URL.
for _ in $(seq 1 20); do
  sleep 2
  if grep -qE 'https://accounts\.google\.com' "$OUT" 2>/dev/null; then break; fi
done

echo "--- open this URL in a browser and sign in ---"
grep -oE 'https://accounts\.google\.com/o/oauth2/auth[^ ]+' "$OUT" | head -1
echo "--- then paste the code:  echo '<code>' > $FIFO"
