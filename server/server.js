/* Azagra Fishermen Monitor — tracker API, admin sessions, vessel registry.
   Zero dependencies. Admin credentials live in data/admin.json (seeded on boot). */
const http = require("http");
const crypto = require("crypto");
const zlib = require("zlib"); // gzip para mabilis mag-load ang dashboard sa cellphone
const fs = require("fs");
const path = require("path");
const os = require("os");

const root = path.join(__dirname, "..");
const dataDir = path.join(root, "data");
const dataFile = path.join(dataDir, "tracker-data.json");
const adminFile = path.join(dataDir, "admin.json");
const sessionsFile = path.join(dataDir, "sessions.json");
const uploadsDir = path.join(dataDir, "uploads"); // boat photos (1 JPEG kada device)
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TRACKER_API_KEY || "change-this-before-deployment";
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 oras
const DEFAULT_PASSWORD = "admin123";

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const hash = (pw, salt) =>
  crypto.createHash("sha256").update(salt + pw).digest("hex");

/* ---------- admin users (maraming account) ----------
   data/admin.json = { users: [ { id, username, salt, passwordHash, role,
   active, createdAt, lastLogin, mustChange } ] }
   Ang lumang single-admin format ({ username, salt, passwordHash }) ay
   awtomatikong ni-migrate — hindi nagbabago ang username/password. */
function makeUser(username, password, role = "owner", extra = {}) {
  const salt = crypto.randomBytes(16).toString("hex");
  return {
    id: crypto.randomBytes(8).toString("hex"),
    username,
    salt,
    passwordHash: hash(password, salt),
    // "owner" = buong access (kasama ang user management)
    // "operator" = dashboard lang (walang access sa user management)
    role: role === "operator" ? "operator" : "owner",
    active: true,
    createdAt: Date.now(),
    lastLogin: null,
    mustChange: false,
    ...extra,
  };
}

function loadAdmins() {
  try {
    const raw = JSON.parse(fs.readFileSync(adminFile, "utf8"));
    if (raw && Array.isArray(raw.users) && raw.users.length) return raw;
    if (raw && raw.username && raw.passwordHash) {
      const store = {
        users: [
          {
            id: crypto.randomBytes(8).toString("hex"),
            username: raw.username,
            salt: raw.salt,
            passwordHash: raw.passwordHash,
            role: "owner",
            active: true,
            createdAt: Date.now(),
            lastLogin: null,
            mustChange: !!raw.mustChange,
          },
        ],
      };
      fs.writeFileSync(adminFile, JSON.stringify(store, null, 2));
      return store;
    }
  } catch {}
  const store = {
    users: [makeUser("admin", DEFAULT_PASSWORD, "owner", { mustChange: true })],
  };
  fs.writeFileSync(adminFile, JSON.stringify(store, null, 2));
  return store;
}
let admins = loadAdmins();
const saveAdmins = () =>
  fs.writeFileSync(adminFile, JSON.stringify(admins, null, 2));
const userByName = (name) =>
  admins.users.find(
    (u) => u.username.toLowerCase() === String(name || "").trim().toLowerCase(),
  );
const userById = (id) => admins.users.find((u) => u.id === id);
const activeOwners = () =>
  admins.users.filter((u) => u.role === "owner" && u.active);

let sessions = {};
try {
  sessions = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
} catch {
  sessions = {};
}
const saveSessions = () =>
  fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2));
for (const t of Object.keys(sessions))
  if (
    !sessions[t] ||
    sessions[t].expires < Date.now() ||
    !userById(sessions[t].userId)?.active
  )
    delete sessions[t];
saveSessions();

const loginAttempts = new Map(); // ip -> { count, until }
const loginAllowed = (ip) => {
  const a = loginAttempts.get(ip);
  return !a || a.until <= Date.now();
};
const loginFail = (ip) => {
  const a = loginAttempts.get(ip) || { count: 0, until: 0 };
  a.count += 1;
  if (a.count >= 5) {
    a.until = Date.now() + 60 * 1000;
    a.count = 0;
  }
  loginAttempts.set(ip, a);
};

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((c) => {
    const i = c.indexOf("=");
    if (i > 0)
      out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function getSession(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const s = sessions[sid];
  if (!s || s.expires < Date.now()) {
    if (s) {
      delete sessions[sid];
      saveSessions();
    }
    return null;
  }
  const user = userById(s.userId);
  if (!user || !user.active) {
    // na-delete o na-deactivate ang account — patayin agad ang session
    delete sessions[sid];
    saveSessions();
    return null;
  }
  s.expires = Date.now() + SESSION_TTL; // sliding renewal
  return { sid, username: user.username, user };
}

const EMPTY_STORE = () => ({
  devices: [],
  locations: [],
  alerts: [],
  geofences: [],
});
// Defensive read: hindi na mag-crash ang buong dashboard kapag na-corrupt,
// na-empty, o nawala ang tracker-data.json (dati: `d.locations.slice()` ay
// TypeError kapag array o walang laman ang file — na-restart lang ng systemd
// at crash ulit). Sinisigurado rin na arrays ang lahat ng koleksyon.
const safeRead = () => {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  } catch {
    raw = null;
  }
  if (Array.isArray(raw)) raw = { locations: raw }; // legacy: array ng points
  if (!raw || typeof raw !== "object") raw = {};
  const out = { ...EMPTY_STORE(), ...raw };
  for (const k of ["devices", "locations", "alerts", "geofences"])
    if (!Array.isArray(out[k])) out[k] = [];
  return out;
};
const save = (data) => fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));

function send(res, code, value, type = "application/json", cache = "no-store") {
  let body = type === "application/json" ? JSON.stringify(value) : value;
  const headers = { "Cache-Control": cache, "Content-Type": type };
  // gzip kapag >1KB at kaya ng client (Accept-Encoding: gzip) — 4x pababa ang laki
  // ng leaflet.js at ng /api/state payload = mas mabilis mag-open sa mobile data
  const ae =
    (res.req && res.req.headers && res.req.headers["accept-encoding"]) || "";
  // gzip kapag >1KB at kaya ng client — pero hindi sa image (compressed na ang
  // JPEG/PNG; sayang lang sa CPU ng 512MB droplet)
  if (
    body.length > 1024 &&
    !type.startsWith("image/") &&
    /\bgzip\b/.test(ae) &&
    (typeof body === "string" || Buffer.isBuffer(body))
  ) {
    body = zlib.gzipSync(body);
    headers["Content-Encoding"] = "gzip";
  }
  res.writeHead(code, headers);
  res.end(body);
}
function body(req, maxBytes = 1e6) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      raw += c;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}
function isInside(point, f) {
  const R = 6371000,
    rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(point.lat - f.lat),
    dLon = rad(point.lng - f.lng),
    a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(f.lat)) * Math.cos(rad(point.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) <= f.radiusM;
}
function distM(a, b) {
  const R = 6371000,
    rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat),
    dLon = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
function record(data, p) {
  if (!Number.isFinite(+p.lat) || !Number.isFinite(+p.lng) || !p.deviceId)
    throw new Error("deviceId, lat and lng are required");
  const device = data.devices.find((d) => d.deviceId === p.deviceId);
  if (!device) throw new Error("Unknown device");
  const point = {
    deviceId: p.deviceId,
    lat: +p.lat,
    lng: +p.lng,
    accuracyM: +p.accuracyM || 0,
    speedKph: +p.speedKph || 0,
    timestamp: p.timestamp || new Date().toISOString(),
  };
  // Smart logging: kapag naka-dock/naka-anchor ang boat (halos hindi gumagalaw,
  // <2 km/h, at <25m ang galaw), isang point kada minuto lang ang naka-store —
  // para hindi maubos ng padamyong docked points ang 10k history window (dating
  // dahilan ng "pagkawala" ng mga biyahe sa Activity log pag nakauwi na ang boat).
  // Ang device.lastLocation ay laging ina-update kaya live pa rin ang dashboard.
  const lastStored = device.lastStored;
  const moved = lastStored ? distM(lastStored, point) : Infinity;
  const gapMs = lastStored
    ? new Date(point.timestamp) - new Date(lastStored.timestamp)
    : Infinity;
  const idle =
    moved < 25 && (point.speedKph || 0) < 2 && gapMs > 0 && gapMs < 60000;
  if (!idle || p.sos) {
    data.locations.push(point);
    device.lastStored = point;
  }
  device.lastLocation = point;
  device.status = p.sos ? "SOS" : "Active";
  // Migration: lahat ng lumang alert na walang id ay bigyan ng unique id
  // (kailangan ito para tama ang resolve — dati ay timestamp lang ang key at
  // ang dalawang alert na magkatapat na timestamp ay nagpapatong sa resolve)
  for (const a of data.alerts) if (!a.id) a.id = crypto.randomBytes(8).toString("hex");
  // SOS: ISANG alert lang kada SOS episode. Ang board ay nagpapadala ng SOS kada
  // 10s habang aktibo (para hindi mawala sa mahinang signal) — kung walang dedupe,
  // bawat post ay bagong alert at "ayaw ma-resolve" ang dating.
  // Ang board ay may sosSeq (bilang ng 3-pindot na trigger): BAGONG sosSeq =
  // bagong episode = bagong SOS alert. Ang PAREHONG sosSeq (pauli-ulit na post ng
  // iisang pindot) ay HINDI na gumagawa ng alert — kaya kapag na-mark resolve na
  // ng admin, hindi na ito bumabalik (at ang sosCancel downlink ang nagtuturo sa
  // board na tumigil na sa SOS send at sa beep nito).
  if (p.sos) {
    const seq = p.sosSeq === undefined ? null : +p.sosSeq;
    const newEpisode =
      seq !== null ? seq !== device.sosSeq : device.sosSeq === undefined;
    if (seq !== null) device.sosSeq = seq;
    const sosOpen = data.alerts.some(
      (a) => a.type === "SOS" && a.deviceId === point.deviceId && !a.resolved,
    );
    if (newEpisode && !sosOpen) {
      if (seq === null) device.sosSeq = 0; // lumang firmware: isang alert lang
      data.alerts.unshift({
        id: crypto.randomBytes(8).toString("hex"),
        type: "SOS",
        deviceId: point.deviceId,
        message: "SOS received from " + device.boatName,
        timestamp: point.timestamp,
        resolved: false,
      });
    }
  }
  // GEOFENCE — isang alert kada TUNAY na paglabas (loob -> labas ng safe area).
  // Kapag naka-resolve na, HINDI na babalik ang alert habang nasa labas pa rin
  // ang boat (kahit maglipat-lipat ng page o mag-refresh). Muli lang itong
  // lilitaw kapag pumasok ulit ang boat sa safe area (re-arm) at lumabas na naman.
  device.fenceInside = device.fenceInside || {};
  for (const fence of data.geofences) {
    const inside = isInside(point, fence);
    const key = fence.name || fence.id || "fence";
    const wasInside = device.fenceInside[key];
    device.fenceInside[key] = inside;
    if (!inside && wasInside !== false) {
      // bagong paglabas (o unang observation na nasa labas)
      const message = device.boatName + " left " + fence.name;
      const alreadyOpen = data.alerts.some(
        (a) =>
          a.type === "GEOFENCE" &&
          a.deviceId === p.deviceId &&
          a.message === message &&
          !a.resolved,
      );
      if (!alreadyOpen)
        data.alerts.unshift({
          id: crypto.randomBytes(8).toString("hex"),
          type: "GEOFENCE",
          deviceId: p.deviceId,
          message,
          timestamp: point.timestamp,
          resolved: false,
        });
    }
  }
  // SAIL BAN: "bawat sail" — habang somobra ang naka-ban na boat at walang bukas
  // na SAIL BAN record, gagawa ng bago (mark-as-read → bagong record kung somobra pa rin)
  if (device.sailBan && data.geofences.some((f) => !isInside(point, f))) {
    const message =
      (device.boatName || device.fisherman) + " sailed during a no-sail order";
    const alreadyOpen = data.alerts.some(
      (a) => a.type === "SAIL BAN" && a.deviceId === p.deviceId && !a.resolved,
    );
    if (!alreadyOpen)
      data.alerts.unshift({
        id: crypto.randomBytes(8).toString("hex"),
        type: "SAIL BAN",
        deviceId: p.deviceId,
        message,
        timestamp: point.timestamp,
        resolved: false,
      });
  }
  data.alerts = data.alerts.slice(0, 100);
  // 10,000 points ≈ ~28 oras ng history sa 10s heartbeat — para may makikita pa ring
  // mga nakaraang biyahe sa Activity log, hindi lang ang huling ~3 oras
  data.locations = data.locations.slice(-10000);
  return point;
}

function serveStatic(res, pathname) {
  const p = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, "");
  const file = path.join(root, "web", p);
  if (
    !file.startsWith(path.join(root, "web")) ||
    !fs.existsSync(file) ||
    !fs.statSync(file).isFile()
  )
    return false;
  const ext = path.extname(file);
  const type =
    ext === ".css"
      ? "text/css"
      : ext === ".js"
        ? "application/javascript"
        : ext === ".html"
          ? "text/html; charset=utf-8"
          : "application/octet-stream";
  // caching: leaflet (hindi kailanman nagbabago) = 30 araw, instant sa repeat visits;
  // app.js/style.css = 5 minuto para kumalat pa rin ang mga update; html = laging sariwa
  const base = path.basename(file);
  const cache = base.startsWith("leaflet.")
    ? "public, max-age=2592000, immutable"
    : base === "app.js" || base === "style.css"
      ? "public, max-age=300"
      : "no-cache";
  send(res, 200, fs.readFileSync(file), type, cache);
  return true;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const ip = req.socket.remoteAddress || "unknown";

  // ---------- mga pampublikong pahina ----------
  if (
    req.method === "GET" &&
    (u.pathname === "/login" || u.pathname === "/login.html")
  ) {
    serveStatic(res, "/login.html");
    return;
  }
  if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
    if (!getSession(req)) {
      res.writeHead(302, { Location: "/login" });
      return res.end();
    }
    serveStatic(res, "/index.html");
    return;
  }

  // ---------- mga static asset (css/js/leaflet): walang sensitibong data, malayang i-serve ----------
  if (req.method === "GET" && serveStatic(res, u.pathname)) return;

  // ---------- pampublikong API: login / logout / me ----------
  if (req.method === "POST" && u.pathname === "/api/login") {
    if (!loginAllowed(ip))
      return send(res, 429, {
        error: "Too many attempts. Try again in a minute.",
      });
    try {
      const b = await body(req);
      const user = userByName(b.username);
      const ok =
        !!user &&
        hash(String(b.password || ""), user.salt) === user.passwordHash;
      if (!ok) {
        loginFail(ip);
        return send(res, 401, { error: "Wrong username or password" });
      }
      if (!user.active)
        return send(res, 403, {
          error: "This account is deactivated. Ask the owner to activate it.",
        });
      loginAttempts.delete(ip);
      user.lastLogin = Date.now();
      saveAdmins();
      const sid = crypto.randomBytes(24).toString("hex");
      sessions[sid] = {
        userId: user.id,
        username: user.username,
        created: Date.now(),
        expires: Date.now() + SESSION_TTL,
      };
      saveSessions();
      res.setHeader(
        "Set-Cookie",
        `sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400`,
      );
      return send(res, 200, {
        ok: true,
        username: user.username,
        role: user.role,
        mustChange: !!user.mustChange,
      });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }
  if (req.method === "POST" && u.pathname === "/api/logout") {
    const sid = parseCookies(req).sid;
    if (sid && sessions[sid]) {
      delete sessions[sid];
      saveSessions();
    }
    res.setHeader("Set-Cookie", "sid=; HttpOnly; Path=/; Max-Age=0");
    return send(res, 200, { ok: true });
  }
  if (req.method === "GET" && u.pathname === "/api/me") {
    const s = getSession(req);
    return send(res, 200, {
      authenticated: !!s,
      username: s ? s.username : null,
      role: s ? s.user.role : null,
      mustChange: s ? !!s.user.mustChange : false,
    });
  }

  // ---------- API ng ESP32: API key ang proteksyon, hindi session ----------
  if (req.method === "POST" && u.pathname === "/api/telemetry") {
    if (req.headers["x-api-key"] !== API_KEY)
      return send(res, 401, { error: "Unauthorized" });
    try {
      const d = safeRead(),
        point = record(d, await body(req));
      save(d);
      console.log(
        `[TELEMETRY] ${new Date().toISOString()} ${point.deviceId} lat=${point.lat} lng=${point.lng} speed=${point.speedKph}kph (total ${d.locations.length})`,
      );
      // Downlink: isama sa sagot kung WALA nang unresolved SOS alert para sa
      // device na ito — ganito nalalaman ng board na na-resolve na ng admin
      // ang SOS (titigil na ang pag-send at ang beep sa board)
      return send(res, 201, {
        ok: true,
        point,
        sosCancel: !d.alerts.some(
          (a) => a.type === "SOS" && a.deviceId === point.deviceId && !a.resolved,
        ),
      });
    } catch (e) {
      console.log(`[TELEMETRY REJECT] ${new Date().toISOString()} ${e.message}`);
      return send(res, 400, { error: e.message });
    }
  }

  // ---------- lahat ng iba pang API: kailangan ng admin session ----------
  const session = getSession(req);
  if (!session) return send(res, 401, { error: "Not authenticated" });

  // ---------- boat photos (pribado: kailangan ng login; <img> tags ay nagpapadala
  // ng cookie sa same-origin, kaya gumagana ito sa popup at sa vessels table) ----------
  if (req.method === "GET" && u.pathname.startsWith("/uploads/")) {
    const name = path.basename(decodeURIComponent(u.pathname)); // walang path traversal
    const file = path.join(uploadsDir, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile())
      return send(res, 404, { error: "No photo" });
    const ext = path.extname(name).toLowerCase();
    const type =
      ext === ".png"
        ? "image/png"
        : ext === ".webp"
          ? "image/webp"
          : "image/jpeg";
    // 1 oras na cache + ?v= timestamp sa URL ang nagsisilbing cache-buster pagkatapos
    // ng pagpalit ng photo
    return send(res, 200, fs.readFileSync(file), type, "public, max-age=3600");
  }

  // ---------- live push (SSE): event: state kada pagbabago ng data (≤2s ang latency),
  // ": ping" kada 2s na keepalive para hindi putulin ng nginx/proxy ang idle stream ----------
  if (req.method === "GET" && u.pathname === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no", // huwag i-buffer ng nginx ang stream
      Connection: "keep-alive",
    });
    res.write("retry: 3000\n\n");
    let lastPayload = null;
    const push = () => {
      try {
        const d = safeRead();
        const payload = JSON.stringify({
          devices: d.devices,
          alerts: d.alerts,
          geofences: d.geofences,
          locations: d.locations.slice(-100),
        });
        if (payload !== lastPayload) {
          lastPayload = payload;
          res.write(`event: state\ndata: ${payload}\n\n`);
        } else {
          res.write(": ping\n\n");
        }
      } catch {}
    };
    push();
    const iv = setInterval(push, 2000);
    req.on("close", () => clearInterval(iv));
    return;
  }

  if (req.method === "GET" && u.pathname === "/api/state") {
    const d = safeRead();
    return send(res, 200, {
      devices: d.devices,
      alerts: d.alerts,
      geofences: d.geofences,
      locations: d.locations.slice(-100),
    });
  }
  // activity log: buong location history (hanggang 1000 points) + registry
  if (req.method === "GET" && u.pathname === "/api/activities") {
    const d = safeRead();
    return send(res, 200, {
      devices: d.devices,
      locations: d.locations,
      geofences: d.geofences,
    });
  }
  if (req.method === "POST" && u.pathname === "/api/alerts/resolve") {
    const d = safeRead(),
      b = await body(req),
      // bagong alerts: may unique id (eksaktong isa lang ang maresolve);
      // lumang alerts (walang id): timestamp + type + deviceId ang pares
      a = d.alerts.find(
        (x) =>
          (b.id && x.id === b.id) ||
          (!x.id && x.timestamp === b.timestamp && x.type === b.type),
      );
    if (a) a.resolved = true;
    save(d);
    return send(res, 200, { ok: true, resolvedId: a ? a.id : null });
  }
  if (req.method === "POST" && u.pathname === "/api/devices") {
    try {
      const b = await body(req);
      if (!b.deviceId || !b.fisherman)
        throw new Error("deviceId and fisherman are required");
      const d = safeRead();
      if (d.devices.some((x) => x.deviceId === b.deviceId))
        throw new Error("deviceId already exists");
      d.devices.push({
        deviceId: String(b.deviceId).trim(),
        fisherman: String(b.fisherman).trim(),
        boatName: String(b.boatName || "").trim(),
        emergencyContact: String(b.emergencyContact || "").trim(),
        registration: String(b.registration || "").trim(),
        sailBan: !!b.sailBan,
        status: "Active",
        lastLocation: null,
      });
      save(d);
      return send(res, 201, { ok: true });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }
  if (req.method === "POST" && u.pathname === "/api/devices/update") {
    try {
      const b = await body(req);
      const d = safeRead();
      const device = d.devices.find((x) => x.deviceId === b.deviceId);
      if (!device) throw new Error("Unknown device");
      for (const k of [
        "fisherman",
        "boatName",
        "emergencyContact",
        "registration",
      ])
        if (b[k] !== undefined) device[k] = String(b[k]).trim();
      if (b.sailBan !== undefined) device.sailBan = !!b.sailBan;
      save(d);
      return send(res, 200, { ok: true, device });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }
  if (req.method === "POST" && u.pathname === "/api/devices/photo") {
    try {
      const b = await body(req, 4e6); // liberahang laki para sa base64 image
      const m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/.exec(
        String(b.image || ""),
      );
      if (!b.deviceId || !m)
        throw new Error("deviceId and image data URL are required");
      const buf = Buffer.from(m[2], "base64");
      if (buf.length < 100) throw new Error("Image file is too small / corrupted");
      if (buf.length > 3e6) throw new Error("Image too large (max 3MB)");
      // beripikasyon ng magic bytes — tunay na JPEG/PNG lang, hindi iba pang file type
      const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
      const isPng = buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG";
      if (!isJpeg && !isPng) throw new Error("Only JPEG or PNG images are allowed");
      const d = safeRead();
      const device = d.devices.find((x) => x.deviceId === b.deviceId);
      if (!device) throw new Error("Unknown device");
      const fname = encodeURIComponent(b.deviceId) + ".jpg"; // pare-pareho: palaging naka-overwrite
      fs.writeFileSync(path.join(uploadsDir, fname), buf);
      // ?v= timestamp = cache-buster para agad makita ang bagong photo (kahit naka-cache ang luma)
      device.photo = `/uploads/${fname}?v=${Date.now()}`;
      save(d);
      console.log(
        `[PHOTO] ${new Date().toISOString()} ${b.deviceId} -> ${fname} (${Math.round(buf.length / 1024)}KB)`,
      );
      return send(res, 200, { ok: true, photo: device.photo });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }
  if (req.method === "POST" && u.pathname === "/api/devices/delete") {
    try {
      const b = await body(req);
      const d = safeRead();
      const i = d.devices.findIndex((x) => x.deviceId === b.deviceId);
      if (i < 0) throw new Error("Unknown device");
      if (d.devices.length <= 1)
        throw new Error("Cannot delete the last vessel");
      d.devices.splice(i, 1);
      save(d);
      // burahin din ang photo file para walang maiwang orphan sa uploads/
      try {
        fs.unlinkSync(
          path.join(uploadsDir, encodeURIComponent(b.deviceId) + ".jpg"),
        );
      } catch {} // walang photo — hindi kritikal
      return send(res, 200, { ok: true });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }
  if (req.method === "POST" && u.pathname === "/api/geofence/update") {
    try {
      const b = await body(req);
      const lat = +b.lat,
        lng = +b.lng,
        radiusM = +b.radiusM;
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        !Number.isFinite(radiusM)
      )
        throw new Error("lat, lng and radiusM must be numbers");
      if (radiusM < 100 || radiusM > 100000)
        throw new Error("radiusM must be between 100 and 100000");
      const d = safeRead();
      if (!d.geofences.length) d.geofences.push({});
      Object.assign(d.geofences[0], {
        name: String(
          b.name || d.geofences[0].name || "Safe operating area",
        ).trim(),
        lat,
        lng,
        radiusM,
      });
      save(d);
      return send(res, 200, { ok: true, geofence: d.geofences[0] });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }
  if (req.method === "POST" && u.pathname === "/api/admin/credentials") {
    try {
      const b = await body(req);
      const me = session.user;
      if (hash(String(b.currentPassword || ""), me.salt) !== me.passwordHash)
        throw new Error("Current password is wrong");
      const newUsername = String(b.newUsername || me.username).trim();
      const newPassword = String(b.newPassword || "");
      if (newUsername.length < 3) throw new Error("Username too short (min 3)");
      if (newUsername.length > 32) throw new Error("Username too long (max 32)");
      const clash = userByName(newUsername);
      if (clash && clash.id !== me.id)
        throw new Error("That username is already taken");
      if (newPassword && newPassword.length < 6)
        throw new Error("Password too short (min 6)");
      const salt = crypto.randomBytes(16).toString("hex");
      me.username = newUsername;
      if (newPassword) {
        me.passwordHash = hash(newPassword, salt);
        me.salt = salt;
        me.mustChange = false;
      }
      saveAdmins();
      for (const t of Object.keys(sessions))
        if (sessions[t].userId === me.id) sessions[t].username = me.username;
      saveSessions();
      return send(res, 200, {
        ok: true,
        username: me.username,
        mustChange: !!me.mustChange,
      });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }
  if (req.method === "GET" && u.pathname === "/api/admin/summary") {
    const d = safeRead();
    return send(res, 200, {
      username: session.username,
      role: session.user.role,
      mustChange: !!session.user.mustChange,
      vessels: d.devices.length,
      points: d.locations.length,
      alerts: d.alerts.length,
      activeSessions: Object.keys(sessions).length,
      admins: admins.users.length,
      activeAdmins: admins.users.filter((x) => x.active).length,
    });
  }

  /* ---------- user management (owners lang ang pwedeng gumamit) ---------- */
  const publicUser = (usr) => ({
    id: usr.id,
    username: usr.username,
    role: usr.role,
    active: !!usr.active,
    createdAt: usr.createdAt || null,
    lastLogin: usr.lastLogin || null,
    mustChange: !!usr.mustChange,
    online: Object.values(sessions).some((s) => s.userId === usr.id),
    self: usr.id === session.user.id,
  });

  if (u.pathname.startsWith("/api/admin/users")) {
    if (session.user.role !== "owner")
      return send(res, 403, { error: "Only an owner can manage admins" });

    // listahan ng admins (walang salt/hash — hindi kailanman lumalabas)
    if (req.method === "GET" && u.pathname === "/api/admin/users")
      return send(res, 200, {
        users: admins.users.map(publicUser),
        self: session.user.id,
      });

    // gumawa ng bagong admin
    if (req.method === "POST" && u.pathname === "/api/admin/users") {
      try {
        const b = await body(req);
        const username = String(b.username || "").trim();
        const password = String(b.password || "");
        if (username.length < 3) throw new Error("Username too short (min 3)");
        if (username.length > 32) throw new Error("Username too long (max 32)");
        if (!/^[A-Za-z0-9._@-]+$/.test(username))
          throw new Error("Username: letters, numbers, . _ @ - lang");
        if (userByName(username)) throw new Error("Username already exists");
        if (password.length < 6) throw new Error("Password too short (min 6)");
        const usr = makeUser(
          username,
          password,
          b.role === "operator" ? "operator" : "owner",
          { mustChange: !!b.mustChange },
        );
        admins.users.push(usr);
        saveAdmins();
        return send(res, 201, { ok: true, user: publicUser(usr) });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }

    // i-edit ang admin (username, role, active, bagong password)
    if (req.method === "POST" && u.pathname === "/api/admin/users/update") {
      try {
        const b = await body(req);
        const target = userById(String(b.id || ""));
        if (!target) throw new Error("Admin not found");
        const isSelf = target.id === session.user.id;

        if (b.username !== undefined) {
          const username = String(b.username || "").trim();
          if (username.length < 3) throw new Error("Username too short (min 3)");
          if (username.length > 32) throw new Error("Username too long (max 32)");
          if (!/^[A-Za-z0-9._@-]+$/.test(username))
            throw new Error("Username: letters, numbers, . _ @ - lang");
          const clash = userByName(username);
          if (clash && clash.id !== target.id)
            throw new Error("Username already taken");
          target.username = username;
        }

        if (b.role !== undefined) {
          const role = b.role === "operator" ? "operator" : "owner";
          if (target.role === "owner" && role === "operator" && activeOwners().length <= 1)
            throw new Error("Kailangan ng kahit isang active owner");
          target.role = role;
        }

        if (b.active !== undefined) {
          const active = !!b.active;
          if (!active && isSelf)
            throw new Error("Hindi mo pwedeng i-deactivate ang sarili mong account");
          if (!active && target.role === "owner" && activeOwners().length <= 1)
            throw new Error("Kailangan ng kahit isang active owner");
          target.active = active;
        }

        if (b.password) {
          const password = String(b.password);
          if (password.length < 6) throw new Error("Password too short (min 6)");
          const salt = crypto.randomBytes(16).toString("hex");
          target.passwordHash = hash(password, salt);
          target.salt = salt;
          target.mustChange = false;
        }

        saveAdmins();
        for (const t of Object.keys(sessions))
          if (sessions[t].userId === target.id) {
            if (target.active) sessions[t].username = target.username;
            else delete sessions[t]; // na-deactivate = patay agad ang session
          }
        saveSessions();
        return send(res, 200, {
          ok: true,
          user: publicUser(target),
          username: target.username,
        });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }

    // activate / deactivate (mabilis na toggle)
    if (req.method === "POST" && u.pathname === "/api/admin/users/toggle") {
      try {
        const b = await body(req);
        const target = userById(String(b.id || ""));
        if (!target) throw new Error("Admin not found");
        if (target.active && target.id === session.user.id)
          throw new Error("Hindi mo pwedeng i-deactivate ang sarili mong account");
        if (target.active && target.role === "owner" && activeOwners().length <= 1)
          throw new Error("Kailangan ng kahit isang active owner");
        target.active = !target.active;
        saveAdmins();
        if (!target.active)
          for (const t of Object.keys(sessions))
            if (sessions[t].userId === target.id) delete sessions[t];
        saveSessions();
        return send(res, 200, { ok: true, user: publicUser(target) });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }

    // burahin ang admin
    if (req.method === "POST" && u.pathname === "/api/admin/users/delete") {
      try {
        const b = await body(req);
        const target = userById(String(b.id || ""));
        if (!target) throw new Error("Admin not found");
        if (target.id === session.user.id)
          throw new Error("Hindi mo pwedeng burahin ang sarili mong account");
        if (admins.users.length <= 1)
          throw new Error("Kailangan ng kahit isang admin account");
        if (target.role === "owner" && target.active && activeOwners().length <= 1)
          throw new Error("Kailangan ng kahit isang active owner");
        admins.users = admins.users.filter((x) => x.id !== target.id);
        saveAdmins();
        for (const t of Object.keys(sessions))
          if (sessions[t].userId === target.id) delete sessions[t];
        saveSessions();
        return send(res, 200, { ok: true, id: target.id });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }
  }

  send(res, 404, { error: "Not found" });
});
server.listen(PORT, () => {
  console.log(`Fishermen tracker: http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) {
        console.log(
          `Ibang device sa iisang Wi-Fi: http://${net.address}:${PORT}`,
        );
      }
    }
  }
});