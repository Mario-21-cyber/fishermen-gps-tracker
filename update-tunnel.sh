#!/bin/bash
# Azagra Fishermen Tracker — bench tunnel setup + optional self-healing watchdog
# Usage:
#   ./update-tunnel.sh            → one-shot: server + tunnel + firmware patch + upload
#   ./update-tunnel.sh --watch    → one-shot + auto-reconnect watchdog (leave running)
set -e
cd "$(dirname "$0")"
PORT_DEV=$(ls /dev/cu.wchusbserial* 2>/dev/null | head -1)

FLASHED_FILE=/tmp/tracker-board-flashed   # huling URL na naka-flash sa board (para sa --watch)
start_tunnel() {
  pkill -f "serveo.net" 2>/dev/null || true
  sleep 2
  nohup ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=6 -o ExitOnForwardFailure=yes \
    -R 80:localhost:3000 serveo.net > /tmp/serveo.log 2>&1 &
  SUB=""
  for i in $(seq 1 20); do
    SUB=$(grep -o 'https://[a-z0-9-]*\.serveousercontent\.com' /tmp/serveo.log 2>/dev/null | head -1 | sed 's|https://||')
    if [ -n "$SUB" ]; then break; fi
    sleep 1
  done
}

patch_firmware() {
  IP=$(dig +short "$SUB" | head -1)  # muling i-resolve sa loob: baka nagbago ang SUB pagkatapos ng reconnect
  sed -i '' "s|const char\* SERVER_HOST=\"[^\"]*\"|const char* SERVER_HOST=\"$IP\"|" firmware/src/main.cpp
  sed -i '' "s|const char\* SERVER_HOSTNAME=\"[^\"]*\"|const char* SERVER_HOSTNAME=\"$SUB\"|" firmware/src/main.cpp
}

upload_board() {
  DEV=$(ls /dev/cu.wchusbserial* 2>/dev/null | head -1)
  if [ -z "$DEV" ]; then
    echo "      upload: NO BOARD plugged — plug the USB; the watchdog will upload."
    return 1
  fi
  local out rc
  out=$("$HOME/.platformio/penv/bin/pio" run -d firmware -t upload --upload-port "$DEV" 2>&1)
  rc=$?
  echo "$out" | tail -1
  return $rc
}

echo "[1/5] Checking server..."
if ! curl -s -m 2 -o /dev/null http://localhost:3000/api/state; then
  nohup node server/server.js > /tmp/tracker-server.log 2>&1 &
  sleep 1.5
  echo "      server: started"
else
  echo "      server: already running"
fi

echo "[2/5] Starting serveo tunnel (with retries)..."
SUB=""
for attempt in 1 2 3; do
  start_tunnel
  if [ -n "$SUB" ]; then break; fi
  echo "      attempt $attempt: walang URL mula sa serveo — retrying in 10s..."
  sleep 10
done
if [ -z "$SUB" ]; then
  echo "      ERROR: serveo unavailable right now — firmware NOT changed (last config kept)."
  echo "      Try again in a few minutes: ./update-tunnel.sh"
  exit 1
fi
IP=$(dig +short "$SUB" | head -1)
echo "      tunnel: http://$SUB (edge IP: $IP)"

echo "[3/5] Patching firmware config..."
patch_firmware
grep -E '^const char\* SERVER_HOST' firmware/src/main.cpp | sed 's/^/      /'

echo "[4/5] Uploading to board..."
if upload_board; then echo "$SUB" > "$FLASHED_FILE"; fi
echo "[5/5] DONE! Open http://localhost:3000 and log in with your admin account."

if [ "$1" = "--watch" ]; then
  echo "---- WATCHDOG ON: checking the tunnel every 60s, self-healing when it dies (Ctrl+C to stop) ----"
  while true; do
    sleep 60
    CODE=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "http://$SUB/api/state" 2>/dev/null || echo 000)
    if [ "$CODE" != "200" ] && [ "$CODE" != "401" ]; then
      echo "$(date -u '+%H:%M:%S') tunnel down (code $CODE) — reconnecting..."
      start_tunnel
      if [ -z "$SUB" ]; then
        echo "$(date -u '+%H:%M:%S') reconnect failed — retrying next cycle."
        continue
      fi
      patch_firmware
      echo "$(date -u '+%H:%M:%S') patched firmware -> $SUB — uploading..."
      if upload_board; then echo "$SUB" > "$FLASHED_FILE"; fi
    elif [ "$(cat "$FLASHED_FILE" 2>/dev/null)" != "$SUB" ] && ls /dev/cu.wchusbserial* >/dev/null 2>&1; then
      # naka-plug ang board PERO hindi pa naka-flash ang URL na ito (file patched habang nakakalas)
      echo "$(date -u '+%H:%M:%S') board plugged but not yet flashed with $SUB — uploading..."
      if upload_board; then echo "$SUB" > "$FLASHED_FILE"; fi
    fi
  done
fi