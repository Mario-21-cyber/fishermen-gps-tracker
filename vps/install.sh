#!/bin/bash
# TAKBOHIN SA VPS (Ubuntu 22.04/24.04, bilang root):
#   bash /opt/fishermen-tracker/vps/install.sh
# Nag-i-install ng Node.js, gumagawa ng service user, sine-set up ang systemd
# auto-restart service, at binubuksan ang firewall.
set -e

echo "=== [1/5] Node.js 20..."
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "      node $(node -v)"

echo "=== [2/5] Service user at folder..."
id -u fishermen >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin fishermen
chown -R fishermen:fishermen /opt/fishermen-tracker

echo "=== [3/5] Systemd service (auto-restart + auto-start sa boot)..."
cp /opt/fishermen-tracker/vps/fishermen.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable fishermen
systemctl restart fishermen
sleep 2
CODE=$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://localhost:3000/ || echo 000)
echo "      localhost:3000 -> HTTP $CODE"

echo "=== [4/5] Firewall (ufw): SSH + HTTP lang ang bukas..."
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null 2>&1 || true
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 3000/tcp >/dev/null 2>&1 || true
  ufw --force enable >/dev/null 2>&1 || true
  echo "      ufw active: 22 / 80 / 3000"
else
  echo "      walang ufw — tiyaking bukas ang ports 80 at 3000 sa provider firewall"
fi

echo "=== [5/5] TAPOS!"
IP=$(curl -s -m 5 ifconfig.me 2>/dev/null || echo "<VPS-IP>")
echo
echo "  Dashboard : http://$IP:3000   (pareho ang admin login)"
echo "  Board     : SERVER_HOST=\"$IP\"  SERVER_HOSTNAME=\"$IP\""
