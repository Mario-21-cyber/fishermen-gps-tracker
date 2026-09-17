#!/bin/bash
# I-deploy ang pinakabagong server/web/firmware mula sa dev folder papunta sa
# production (~/fishermen-tracker) at i-restart ang launchd server service.
# ANG data/ AY HINDI GINALAW — ang totoong tracker data ay nananatili sa production.
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DST=/Users/johnmatthew/fishermen-tracker
rsync -a --delete "$SRC/server/" "$DST/server/"
rsync -a --delete "$SRC/web/" "$DST/web/"
rsync -a --delete --exclude '.pio' "$SRC/firmware/" "$DST/firmware/"
cp -f "$SRC/serveo-watchdog.sh" "$DST/serveo-watchdog.sh"
chmod +x "$DST/serveo-watchdog.sh"
# Itakda ang firmware URL sa KASALUKUYANG tunnel (Host header walang https://)
# para hindi ma-regress ang URL kapag nag-deploy mula sa dev
if [ -f "$DST/SERVEO-URL.txt" ]; then
  HOST=$(sed 's|https://||' "$DST/SERVEO-URL.txt" | tr -d '[:space:]' | head -1)
  if [ -n "$HOST" ]; then
    sed -i '' "s|const char\* SERVER_HOSTNAME=\"[^\"]*\"|const char* SERVER_HOSTNAME=\"$HOST\"|" "$DST/firmware/src/main.cpp" || true
    IP=$(dig +short "$HOST" 2>/dev/null | head -1)
    [ -n "$IP" ] && sed -i '' "s|const char\* SERVER_HOST=\"[^\"]*\"|const char* SERVER_HOST=\"$IP\"|" "$DST/firmware/src/main.cpp" || true
  fi
fi
launchctl kickstart -k "gui/$(id -u)/com.fishermen.server"
sleep 2
CODE=$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://localhost:3000/ || echo 000)
echo "Deployed -> $DST (server HTTP $CODE)"
echo "Public URL: $(cat "$DST/SERVEO-URL.txt" 2>/dev/null || echo 'naghihintay pa ng tunnel')"
