#!/bin/bash
# Azagra Fishermen Tracker — DigitalOcean Droplet deployment
# Usage:
#   ./deploy-droplet.sh root@<DROPLET_IP>             → deploy server (Node + nginx + systemd + firewall)
#   ./deploy-droplet.sh root@<DROPLET_IP> --flash     → deploy + i-patch at i-flash ang board papunta sa Droplet
#   ./deploy-droplet.sh root@<DROPLET_IP> --flash --rotate-api-key
#                                                     → deploy + bagong API key + flash
# Notes:
#   - Ang DO Droplets ay naka-login bilang root by default (SSH key na kinabit mo sa paggawa ng Droplet).
#   - Ang board ay nagte-text ng plain HTTP sa port 80 (hindi kinakain ng carrier middlebox), kaya
#     nginx ang gagamitin nating port 80 → 3000 (Node).
set -e
cd "$(dirname "$0")"

TARGET="$1"; shift || true
DO_FLASH=0
ROTATE_KEY=0
for a in "$@"; do
  case "$a" in
    --flash) DO_FLASH=1 ;;
    --rotate-api-key) ROTATE_KEY=1 ;;
    *) echo "Hindi kilalang argumento: $a"; exit 1 ;;
  esac
done
[ -z "$TARGET" ] && { echo "Gamit: ./deploy-droplet.sh root@<DROPLET_IP> [--flash] [--rotate-api-key]"; exit 1; }

DEST="/root/fishermen-tracker"
PIO="$HOME/.platformio/penv/bin/pio"

step() { echo; echo "== $1 =="; }

step "[1/6] Sinusuri ang SSH connection sa $TARGET ..."
ssh -o BatchMode=yes -o ConnectTimeout=10 "$TARGET" "echo '      OK — connected: ' \$(hostname)"

step "[2/6] Pagpapalit ng API key (kung --rotate-api-key) ..."
NEW_KEY=""
if [ "$ROTATE_KEY" = "1" ]; then
  NEW_KEY="trk_$(openssl rand -hex 24)"
  echo "      bagong API key: $NEW_KEY"
fi

step "[3/6] Pagpapadala ng project files (server, web — HINDI kasama ang data/) ..."
# SAFETY: huwag i-sync ang data/ — dito nakatira ang LIVE data ng Droplet
# (tracker-data.json GPS history, admin.json users, alerts). Kapag na-overwrite
# ito ng local copy, mawawala ang lahat ng naitalang data sa production.
rsync -az --exclude 'firmware' --exclude '.pio' --exclude '.git' --exclude 'data' \
  server web "$TARGET:$DEST/"
ssh "$TARGET" "ls '$DEST' >/dev/null"

step "[4/6] Pag-install ng Node.js + nginx at pag-setup ng serbisyo ..."
ssh "$TARGET" bash -s "$NEW_KEY" <<'REMOTE'
set -e
NEW_KEY="$1"
for i in 1 2 3 4 5; do apt-get update -y && break || sleep 15; done
apt-get install -y nodejs nginx >/dev/null 2>&1 || apt-get install -y nodejs nginx

# 1G swap — proteksyon sa 512MB RAM na Droplet (hindi mamatay ang Node sa memory spike)
if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

cat > /etc/systemd/system/fishermen-tracker.service <<UNIT
[Unit]
Description=Fishermen GPS Tracker (Node)
After=network.target

[Service]
WorkingDirectory=/root/fishermen-tracker
ExecStart=/usr/bin/node server/server.js
Environment=PORT=3000
Environment=TRACKER_API_KEY=${NEW_KEY:-change-this-before-deployment}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/nginx/sites-available/fishermen-tracker <<NGINX
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
}
NGINX

rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/fishermen-tracker /etc/nginx/sites-enabled/fishermen-tracker
nginx -t
systemctl daemon-reload
systemctl enable --now fishermen-tracker
systemctl restart nginx
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 80/tcp  >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true
sleep 1
CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/login || echo 000)
echo "      local check /login -> $CODE (dapat 200)"
REMOTE

step "[5/6] Pagsusuri mula sa Mac (public URL) ..."
IP="${TARGET#*@}"
sleep 2
CODE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "http://$IP/login" || echo 000)
echo "      http://$IP/login -> $CODE (dapat 200)"
[ "$CODE" = "200" ] || echo "      BABALA: hindi pa 200 — tingnan ang journal: ssh $TARGET journalctl -u fishermen-tracker -n 20"

step "[6/6] Dashboard: http://$IP  (login: admin account mo)"

if [ "$DO_FLASH" = "1" ]; then
  echo
  echo "== BONUS: Pag-patch at pag-flash ng board papunta sa Droplet =="
  sed -i '' "s|const char\* SERVER_HOST=\"[^\"]*\"|const char* SERVER_HOST=\"$IP\"|" firmware/src/main.cpp
  sed -i '' "s|constexpr uint16_t SERVER_PORT=[0-9]*;|constexpr uint16_t SERVER_PORT=80;|" firmware/src/main.cpp
  sed -i '' "s|const char\* SERVER_HOSTNAME=\"[^\"]*\"|const char* SERVER_HOSTNAME=\"$IP\"|" firmware/src/main.cpp
  if [ -n "$NEW_KEY" ]; then
    sed -i '' "s|const char\* API_KEY=\"[^\"]*\"|const char* API_KEY=\"$NEW_KEY\"|" firmware/src/main.cpp
  fi
  grep -E '^const char\* (SERVER_HOST|API_KEY)' firmware/src/main.cpp | sed 's/^/      /'
  DEV=$(ls /dev/cu.wchusbserial* 2>/dev/null | head -1)
  if [ -n "$DEV" ] && [ -x "$PIO" ]; then
    "$PIO" run -d firmware -t upload --upload-port "$DEV" 2>&1 | tail -3
    echo "      Board: na-flash na papunta sa Droplet ($IP)"
  else
    echo "      walang board sa USB — patakbuhin muli ang --flash kapag naka-plug na"
  fi
else
  echo
  echo "      TANDAAN: para magsimulang magpadala ng GPS data ang board sa Droplet:"
  echo "        ./deploy-droplet.sh $TARGET --flash"
fi
