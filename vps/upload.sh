#!/bin/bash
# TAKBOHIN SA MAC — inilalagay ang buong tracker sa VPS:
#   ./upload.sh root@<VPS-IP>
# Unang takbo: isasama ang kasalukuyang data (devices, history, admin login).
# Mga sumunod: server/web lang — ANG DATA SA VPS AY HINDI NA GINALAW.
set -e
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:?Gamit: ./upload.sh root@<VPS-IP>}"

echo "=== [1/3] Code -> $DEST:/opt/fishermen-tracker ..."
rsync -av --delete --exclude '.pio' --exclude 'data' \
  "$SRC/" "$DEST:/opt/fishermen-tracker/"

echo "=== [2/3] Data migration (isang beses lang)..."
if ssh "$DEST" "test -f /opt/fishermen-tracker/data/tracker-data.json" 2>/dev/null; then
  echo "      may data na ang VPS — hindi ginalaw (live na roon ang bagong telemetry)"
else
  echo "      kopyahin ang kasalukuyang data (703+ points, admin login)...";
  rsync -av "$SRC/data/" "$DEST:/opt/fishermen-tracker/data/"
fi

echo "=== [3/3] Restart service..."
ssh "$DEST" "chown -R fishermen:fishermen /opt/fishermen-tracker 2>/dev/null; systemctl restart fishermen" || \
  echo "      NOTE: isasagawa ang install.sh pagkatapos: ssh $DEST 'bash /opt/fishermen-tracker/vps/install.sh'"

IP=$(echo "$DEST" | sed 's/.*@//')
echo
echo "  TAPOS! Dashboard: http://$IP:3000"
