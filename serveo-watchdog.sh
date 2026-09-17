#!/bin/bash
# Serveo tunnel watchdog — pinapatakbo ng launchd (com.fishermen.serveo)
# - Awtomatikong reconnect kapag namatay ang tunnel
# - Health-check kada 60s (3 sunod na kabiguan = bagong koneksyon)
# - Sinusulat ang kasalukuyang URL sa SERVEO-URL.txt
# - Awtomatikong nag-pa-patch + nagfa-flash ng board firmware kapag nagbago ang URL
#   (kailangang nakasaksak sa USB ang board)
LOG=/tmp/serveo.log
BASE="$(cd "$(dirname "$0")" && pwd)"
URL_FILE="$BASE/SERVEO-URL.txt"
WD_LOG=/tmp/serveo-watchdog.log
FW="$BASE/firmware/src/main.cpp"
PIO=$HOME/.platformio/penv/bin/pio

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$WD_LOG"; }

fw_hostname() { grep -o 'SERVER_HOSTNAME="[^"]*"' "$FW" 2>/dev/null | head -1 | cut -d'"' -f2; }

sync_board() { # $1 = kasalukuyang URL — i-patch at i-flash ang board kapag magkaiba
  local url="$1" cur dev ip host
  [ -z "$url" ] && return 0
  host="${url#https://}"   # MAHALAGA: ang Host header ay walang https:// scheme
  cur=$(fw_hostname)
  [ "$cur" = "$host" ] && return 0
  ip=$(dig +short "$host" 2>/dev/null | head -1)
  if [ -z "$ip" ]; then log "hindi ma-resolve ang edge IP — skip patch"; return 0; fi
  sed -i '' "s|const char\* SERVER_HOST=\"[^\"]*\"|const char* SERVER_HOST=\"$ip\"|" "$FW" 2>/dev/null
  sed -i '' "s|const char\* SERVER_HOSTNAME=\"[^\"]*\"|const char* SERVER_HOSTNAME=\"$host\"|" "$FW" 2>/dev/null
  log "firmware patched -> $host (edge IP: $ip)"
  dev=$(ls /dev/cu.wchusbserial* 2>/dev/null | head -1)
  if [ -n "$dev" ] && [ -x "$PIO" ]; then
    log "board plugged ($dev) — uploading..."
    if "$PIO" run -d "$BASE/firmware" -t upload --upload-port "$dev" >> "$WD_LOG" 2>&1; then
      log "board flashed OK"
    else
      log "board flash FAILED — susubukan ulit sa susunod na ikot"
    fi
  else
    log "walang board sa USB — kapag naka-plug na, awtomatikong ifa-flash sa susunod na ikot"
  fi
  return 0
}

while true; do
  # linisin ang anumang lumang ssh tunnel
  pkill -f "ssh.*-R 80:localhost:3000" 2>/dev/null
  sleep 2
  : > "$LOG"
  ssh -n -o StrictHostKeyChecking=no -o ServerAliveInterval=30 \
      -o ServerAliveCountMax=6 -o ExitOnForwardFailure=yes \
      -R 80:localhost:3000 serveo.net < /dev/null >> "$LOG" 2>&1 &
  SSH_PID=$!
  URL=""
  for i in $(seq 1 20); do
    URL=$(grep -o 'https://[a-z0-9-]*\.serveousercontent\.com' "$LOG" 2>/dev/null | head -1)
    [ -n "$URL" ] && break
    sleep 1
  done
  if [ -n "$URL" ]; then
    echo "$URL" > "$URL_FILE"
    log "tunnel UP: $URL"
    sync_board "$URL"
  else
    log "WALANG URL mula sa serveo — retry sa 20s"
    kill "$SSH_PID" 2>/dev/null
    sleep 20
    continue
  fi
  # health-check habang buhay ang ssh: 3 sunod na bigong request = sirang tunnel
  FAILS=0
  while kill -0 "$SSH_PID" 2>/dev/null; do
    sleep 60
    CODE=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$URL/login" 2>/dev/null || echo 000)
    if [ "$CODE" = "200" ]; then
      FAILS=0
    else
      FAILS=$((FAILS + 1))
      log "health-check FAIL ($FAILS/3) — code $CODE"
      if [ "$FAILS" -ge 3 ]; then
        log "3 sunod na kabiguan — pinapatay ang ssh para sa bagong koneksyon"
        kill "$SSH_PID" 2>/dev/null
        break
      fi
    fi
    sync_board "$URL"   # kapag naka-plug ang board mamaya, maifa-flash din
  done
  # manatiling buhay habang gumagana ang ssh; kapag namatay — reconnect
  wait "$SSH_PID" 2>/dev/null
  log "tunnel DOWN (exit $?) — reconnect sa 15s"
  sleep 15
done
