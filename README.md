# Fishermen GPS Tracker

Local, working prototype for the **Solar-Powered Real-Time GPS Tracking and Monitoring System for Fishermen**. It follows the paper's core functions: authorised dashboard, fisherman and boat records, live location history, geofence alerts, SOS records, and printable tracking logs.

## What is included

- `server/` – zero-dependency Node.js API and local JSON data store.
- `web/` – responsive dashboard with a real OpenStreetMap (Leaflet) live map, geofence display, track history, alerts, printable tracking log, and a vessel registry manager (add / edit / remove fishermen and boats). No demo/simulator.
- `firmware/` – PlatformIO firmware for the LilyGO T-SIM A7670G R2 + external L76K GPS (real GPS tracking, 60-second reporting).
- `update-tunnel.sh` – one-command bench setup: starts the server, opens the public tunnel, patches the firmware, and uploads it to the board.
- `docs/BUILD-GUIDE-FILIPINO.md` – exact safe hardware and upload procedure.

## Run the dashboard (real tracker — final version)

1. Open Terminal in this folder and run `node server/server.js`.
2. Open `http://localhost:3000` — **admin log-in is required** (you will be redirected to `/login`).
3. Power the ESP32 tracker — it sends its **real GPS position every 60 seconds** and the map, metrics, and tracking log update automatically.

### Open the dashboard from other devices (phone / laptop)

The server listens on all network interfaces, so any device that can reach the machine running it may open the dashboard.

- **Same Wi-Fi:** run `node server/server.js` — on startup it prints the local network URL, e.g. `http://192.168.1.20:3000`. Open that address on any phone, tablet, or laptop connected to the same router and log in. (If it does not load, allow incoming connections for Node.js in your firewall.)
- **Over the internet:** the public tunnel opened by `./update-tunnel.sh` serves the same dashboard — anyone with the printed `http://<subdomain>.serveousercontent.com` URL can open it and must log in. Keep `./update-tunnel.sh --watch` running so the tunnel reconnects automatically when serveo drops it.

### Admin access

- Default credentials: **username `admin` · password `admin123`**
- **Change them immediately** in **Settings → Admin account** (current password + new username/password). Credentials are stored salted-hashed in `data/admin.json`.
- Sessions last 24 hours (HttpOnly cookie). **Log out** from the sidebar. Wrong-password attempts are rate-limited.
- Only `/api/telemetry` (the ESP32's own endpoint) uses the `X-API-Key` header — the board keeps posting even while the dashboard requires a login.

### Views (sidebar)

- **Dashboard** — metrics, live OpenStreetMap with the boat's exact position, geofence circle, track history, recent alerts.
- **Vessels** — registry of fishermen/boats: **Add vessel**, **Edit** (name, boat, emergency contact, registration), remove.
- **Alerts** — full history with **Mark resolved**.
- **Settings** — admin account (username/password), geofence editor (name, center, radius), system info.

The sidebar collapses into a **hamburger drawer** on screens ≤ 900 px (mobile / small window).

The dashboard shows the actual position of the board on an OpenStreetMap map, the safe-operating-area geofence, track history, and alerts. **No demo/simulator is included in the final version.**

For bench testing from a laptop, run `./update-tunnel.sh` (one command) — it starts the server, opens a public tunnel, patches the firmware with the current tunnel address, and uploads it to the board.

**Security note:** the API key is currently `change-this-before-deployment` (matched in `server/server.js` and `firmware/src/main.cpp`). Change it in both files before any real deployment, and place the server on a secure host.

## Important hardware decision

The supplied board is a LilyGO **T-SIM A7670G R2**, which already contains an ESP32 and LTE modem. It is not the generic ESP32 + NEO-6M setup in the paper. A7670G itself has no built-in GNSS; the GPS edition uses a separate L76K board. Confirm that a small L76K GPS board/antenna is physically included before uploading the GPS firmware. The supplied folder does not show a GPS antenna, LTE antenna, active nano SIM, or a 5 V step-up regulator, so do not permanently wire or deploy until those are present.
