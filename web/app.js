const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s || "").replace(
    /[&<>]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c],
  );

const AZAGRA = [12.2798, 122.6282]; // Azagra, San Fernando, Sibuyan Island, Romblon
const WARN_AFTER_S = 30; // walang post sa loob nito = "No response" (orange hint, hindi pa alarm). 30s = 3 missed cycles sa 10s heartbeat — hint lang, ligtas sa normal na LTE hiccups
const STALE_AFTER_S = 60; // OFFLINE alarm: 6 missed 10s heartbeats. Dati itong 120s (para sa lumang firmware na may 94-110s na modem dead-window); naka-flash na ang anti-wedge firmware (may retry sa loob ng cycle) kaya 60s na lang = 2x mas mabilis maka-detect ang admin ng pinatay/namamatay na board
let lastState = { devices: [], alerts: [], geofences: [], locations: [] };
let me = { authenticated: false, username: null, mustChange: false };
let centered = false;

// ---------- online / offline detection ----------
const knownOnline = {}; // deviceId -> last known online state (para sa alarm transitions)
let audioCtx = null;

function deviceOnline(d) {
  if (!d.lastLocation) return false;
  const age = (Date.now() - new Date(d.lastLocation.timestamp).getTime()) / 1000;
  return age <= STALE_AFTER_S;
}
const jsq = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
function insideFence(p) {
  const f = (lastState.geofences || [])[0];
  if (!f || !Number.isFinite(+f.lat) || !Number.isFinite(+f.lng)) return false;
  const R = 6371000,
    rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(p.lat - +f.lat),
    dLon = rad(p.lng - +f.lng),
    a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(+f.lat)) * Math.cos(rad(p.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) <= +f.radiusM;
}
function atSea(d) {
  return !!d.lastLocation && !insideFence(d.lastLocation);
}
const alarmActive = {}; // deviceId -> true (nag-o-offline episode, nasa laot)
const alarmAck = {}; // deviceId -> true (pindutan na ang Stop alarm)
let fenceAcked = false; // session-level: naka-mark-as-read na ang geofence banner (hindi na muna lalabas hanggang may bagong somobra)
const zoomedOffline = {}; // deviceId -> nag-zoom na sa huling posisyon ngayong episode
function tripStatus(d) {
  if (d.status === "SOS")
    return { label: "SOS", cls: "sos", pin: "sos waves", icon: '<span class="sos-txt">SOS</span>' };
  const p = d.lastLocation;
  if (!p) return { label: "No data", cls: "mut", pin: "off", icon: "💤" };
  const age = (Date.now() - new Date(p.timestamp).getTime()) / 1000;
  const online = deviceOnline(d);
  const inside = insideFence(p);
  if (online) {
    if (inside)
      return { label: "Arrived", cls: "on", pin: "", icon: "⚓" };
    // mabilisang VISUAL hint (45s): hindi dumating ang inaasahang post, pero hindi pa
    // alarm — maaaring modem dead-window lang; ang red alarm ay sa 120s pa
    if (age > WARN_AFTER_S)
      return { label: "No response", cls: "warn", pin: "warn blink", icon: "!" };
    return { label: "Sailing", cls: "sail", pin: "sail waves", icon: "⛵" };
  }
  return inside
    ? { label: "Arrived (offline)", cls: "mut", pin: "off", icon: "⚓" }
    : { label: "Offline at sea", cls: "off", pin: "danger blink hollow", icon: "!" };
}
// i-unlock ang audio sa unang user gesture (browser autoplay policy)
document.addEventListener("pointerdown", () => {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch {}
});
function beepPattern() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const t0 = audioCtx.currentTime;
    for (let i = 0; i < 3; i++) {
      const o = audioCtx.createOscillator(),
        g = audioCtx.createGain();
      o.type = "square";
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, t0 + i * 0.4);
      g.gain.exponentialRampToValueAtTime(0.22, t0 + i * 0.4 + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.4 + 0.3);
      o.connect(g);
      g.connect(audioCtx.destination);
      o.start(t0 + i * 0.4);
      o.stop(t0 + i * 0.4 + 0.32);
    }
  } catch {}
}
let alarmTicker = null;
// ---------- alert beeps ----------
// Geofence alert = beep x3 (isang beses kada bagong alert; hindi inuulit
// kahit mag-refresh/page-switch — naka-remember sa localStorage)
// SOS alert = NON-STOP beep hanggang hindi naa-resolve ang SOS alert
let sosTicker = null;
function sosBeep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const t0 = audioCtx.currentTime;
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "square"; o.frequency.value = 740;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(t0); o.stop(t0 + 0.2);
  } catch {}
}
function startSosBeep() {
  if (sosTicker) return;
  sosBeep();
  sosTicker = setInterval(sosBeep, 600); // tuloy-tuloy: beep-beep-beep...
}
function stopSosBeep() {
  if (sosTicker) { clearInterval(sosTicker); sosTicker = null; }
}
function loadBeepedKeys() {
  try { return new Set(JSON.parse(localStorage.getItem("fenceBeeped") || "[]")); }
  catch { return new Set(); }
}
function alertAudioHook(alerts) {
  // SOS: non-stop hanggang resolved
  const sosOpen = (alerts || []).some((a) => a.type === "SOS" && !a.resolved);
  if (sosOpen) startSosBeep(); else stopSosBeep();
  // Geofence: beep x3 kada bagong (hindi pa na-beep na) GEOFENCE alert
  const beeped = loadBeepedKeys();
  let dirty = false;
  for (const a of alerts || []) {
    if (a.type === "GEOFENCE" && !a.resolved) {
      const key = a.deviceId + "|" + a.timestamp;
      if (!beeped.has(key)) {
        beeped.add(key); dirty = true;
        beepPattern(); // 3 beeps
      }
    }
  }
  if (dirty) {
    try {
      const arr = [...beeped].slice(-200); // cap para hindi lumaki
      localStorage.setItem("fenceBeeped", JSON.stringify(arr));
    } catch {}
  }
}
function startAlarmTicker() {
  if (alarmTicker) return;
  beepPattern();
  alarmTicker = setInterval(beepPattern, 2200);
}
function stopAlarmTicker() {
  if (alarmTicker) {
    clearInterval(alarmTicker);
    alarmTicker = null;
  }
}
// ---------- auth guard + init ----------
async function init() {
  try {
    me = await fetch("/api/me").then((r) => r.json());
  } catch {
    me = { authenticated: false };
  }
  if (!me.authenticated) {
    window.location.href = "/login";
    return;
  }
  $("#side-username").textContent = me.username || "admin";
  load();
  // 1s re-render mula sa cached state (walang network): kahit HINDI na dumating ang
  // bagong data — eksaktong senaryo ng pinatay/namatay na board — lumalabas ang
  // "No response" at ang pulang "LOST SIGNAL AT SEA" alarm ~1s pagkatapos lumagpas
  // sa threshold, hindi na naghihintay pa ng susunod na poll
  setInterval(() => render(lastState, false), 1000);
  startStream();
}

// ---------- live updates: SSE push (primary) + 3s polling (fallback) ----------
let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(load, 3000);
}
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
function startStream() {
  if (!window.EventSource) return startPolling();
  const es = new EventSource("/api/stream"); // cookie auth: automatic sa same-origin
  es.addEventListener("state", (ev) => {
    try {
      render(JSON.parse(ev.data), true);
    } catch {}
  });
  es.onopen = stopPolling; // buhay ang stream: itigil ang polling
  es.onerror = startPolling; // naputol: bumalik muna sa polling hanggang sa reconnect
}

// ---------- mapa ----------
const map = L.map("map").setView(AZAGRA, 11);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
const fenceLayer = L.layerGroup().addTo(map);
const boatLayer = L.layerGroup().addTo(map);
const track = L.polyline([], { color: "#1261a0", weight: 3, opacity: 0.75 }).addTo(map);

function drawGeofences(fences) {
  fenceLayer.clearLayers();
  (fences || []).forEach((f) => {
    if (!Number.isFinite(+f.lat) || !Number.isFinite(+f.lng)) return;
    L.circle([+f.lat, +f.lng], {
      radius: +f.radiusM || 0,
      color: "#1261a0",
      weight: 2,
      fillColor: "#17a2b8",
      fillOpacity: 0.08,
    })
      .bindTooltip(`${esc(f.name)} · ${f.radiusM} m safe radius`)
      .addTo(fenceLayer);
  });
}
function boatIcon(st) {
  return L.divIcon({
    className: "",
    html: `<div class="boat-pin ${st.pin}">${st.icon}</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -16],
  });
}
// ---------- boat photo: popup layout + table thumb ----------
function boatPhoto(d, cls) {
  if (d.photo)
    return `<img class="${cls}" src="${esc(d.photo)}" alt="Boat photo" loading="lazy" />`;
  return `<div class="${cls} empty">🚤</div>`;
}
function popupHTML(d, p) {
  const st = tripStatus(d);
  return `<div class="boat-pop">
    ${boatPhoto(d, "pp-photo")}
    <div class="pp-info">
      <b class="pp-name">${esc(d.boatName || d.fisherman || d.deviceId)}</b>
      <span class="pp-badge ${st.cls}">${esc(st.label)}</span>
      <span class="pp-row">👤 ${esc(d.fisherman)}</span>
      <span class="pp-row">🛰️ ${esc(d.deviceId)}${d.registration ? ` · ${esc(d.registration)}` : ""}</span>
      <span class="pp-row">📍 ${Number(p.lat).toFixed(5)}, ${Number(p.lng).toFixed(5)}</span>
      <span class="pp-row">💨 ${Math.round(p.speedKph || 0)} km/h${d.emergencyContact ? ` · ☎️ ${esc(d.emergencyContact)}` : ""}</span>
      <span class="pp-when">${new Date(p.timestamp).toLocaleString()}</span>
    </div>
  </div>`;
}

// ---------- sidebar / views ----------
const TITLES = { dashboard: "Dashboard", vessels: "Vessels", alerts: "Alerts", activities: "Activity log", settings: "Settings" };
function showView(v) {
  document.querySelectorAll(".view").forEach((x) => x.classList.remove("active"));
  const el = $("#view-" + v);
  if (el) el.classList.add("active");
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === v),
  );
  $("#view-title").textContent = TITLES[v] || v;
  document.body.classList.remove("side-open");
  if (v === "dashboard") setTimeout(() => map.invalidateSize(), 50);
  if (v === "activities") loadActivities();
  if (v === "settings") fillSettings();
}
document.querySelectorAll(".nav-item").forEach((b) => {
  b.onclick = () => showView(b.dataset.view);
});
$("#menu").onclick = () => document.body.classList.toggle("side-open");
$("#backdrop").onclick = () => document.body.classList.remove("side-open");
$("#logout").onclick = async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login";
};

// ---------- rendering ----------
function alertCard(a, withResolve) {
  return `<div class="alert ${a.resolved ? "resolved" : ""}">
    <div><b>${esc(a.type)}</b> · <span class="muted">${esc(a.deviceId)}</span><br>${esc(a.message)}<br>
    <small>${new Date(a.timestamp).toLocaleString()}</small></div>
    ${withResolve && !a.resolved ? `<button class="mini resolve" data-id="${esc(a.id || "")}" data-ts="${esc(a.timestamp)}" data-type="${esc(a.type)}">Mark resolved</button>` : ""}
  </div>`;
}
// ---------- alerts view: search + print (pareho ng Sailing records) ----------
// Ang search ay tumutugma sa type (SOS/GEOFENCE/SAIL BAN), device ID, fisherman
// name, boat name, message text, at "resolved"/"unresolved" — lahat ng tugma ang
// lalabas, at ang 🖨️ Print ay nagpi-print ng eksaktong naka-filter na listahan.
function alertMatches(a, q) {
  if (!q) return true;
  const dev = (lastState.devices || []).find((d) => d.deviceId === a.deviceId);
  const hay = [
    a.type,
    a.deviceId,
    dev && dev.fisherman,
    dev && dev.boatName,
    a.message,
    a.resolved ? "resolved" : "unresolved",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}
function renderAllAlerts() {
  const alerts = lastState.alerts || [];
  const q = ($("#alert-search").value || "").trim().toLowerCase();
  const list = alerts.filter((a) => alertMatches(a, q));
  $("#alerts-all").innerHTML =
    list.map((a) => alertCard(a, true)).join("") ||
    `<p class="ok">${q ? `No alerts match "${esc(q)}".` : "No alerts recorded yet."}</p>`;
  $("#alert-total").textContent = `${list.length} of ${alerts.length} shown · ${alerts.filter((a) => !a.resolved).length} unresolved`;
}

function render(s, redrawMap = true) {
  lastState = s;
  const devices = s.devices || [],
    alerts = s.alerts || [],
    locations = s.locations || [];

  // Icon tugma sa beep: hanggang may UNRESOLVED na SOS alert ang isang device,
  // SOS ang pinapakita sa mapa/table (kahit bumalik na sa "Active" ang status
  // sa susunod na ping) — para hindi mag-beep nang hindi visible ang dahilan
  const sosDevs = new Set(alerts.filter((a) => a.type === "SOS" && !a.resolved).map((a) => a.deviceId));
  devices.forEach((d) => { if (sosDevs.has(d.deviceId)) d.status = "SOS"; });

  $("#active").textContent = devices.filter((x) => deviceOnline(x)).length;
  $("#sos").textContent = alerts.filter((x) => x.type === "SOS" && !x.resolved).length;
  $("#fence").textContent = alerts.filter((x) => x.type === "GEOFENCE" && !x.resolved).length;
  $("#nav-alert-count").textContent = alerts.filter((a) => !a.resolved).length;
  alertAudioHook(alerts); // geofence = beep x3 (isang beses), SOS = non-stop hanggang resolved

  const newest = devices.map((x) => x.lastLocation?.timestamp).filter(Boolean).sort().pop();
  $("#updated").textContent = newest ? new Date(newest).toLocaleTimeString() : "—";
  const chip = $("#live");
  if (!newest) {
    chip.textContent = "● WAITING FOR GPS";
    chip.className = "live-chip stale";
  } else {
    const age = (Date.now() - new Date(newest).getTime()) / 1000;
    chip.textContent = age <= STALE_AFTER_S ? "● LIVE TRACKING" : "● NO SIGNAL";
    chip.className = "live-chip " + (age <= STALE_AFTER_S ? "online" : "stale");
  }

  $("#boats").innerHTML =
    devices
      .map((d) => {
        const p = d.lastLocation;
        const coords = p ? `${Number(p.lat).toFixed(5)}, ${Number(p.lng).toFixed(5)}` : "Awaiting GPS fix";
        const speed = p ? `${Math.round(p.speedKph || 0)} km/h` : "—";
        const seen = p ? new Date(p.timestamp).toLocaleString() : "—";
        const st = tripStatus(d);
        return `<tr><td>${boatPhoto(d, "v-thumb")}</td><td>${esc(d.fisherman)}${d.sailBan ? ' <span class="ban-pill">🚫 NO-SAIL</span>' : ""}</td><td>${esc(d.boatName)}</td><td>${esc(d.deviceId)}</td><td><span class="pill ${st.cls}">${st.label}</span></td><td>${coords}</td><td>${speed}</td><td class="muted">${seen}</td><td><button class="mini" onclick="openEdit('${jsq(d.deviceId)}')">Edit</button> <button class="mini del" onclick="removeVessel('${jsq(d.deviceId)}')">✕</button></td></tr>`;
      })
      .join("") || "";

  // Recent alerts: mga UNRESOLVED lang (ibalik sa dati — malinis na panel;
  // ang buong history, nasa 🔔 Alerts view na may search + print)
  $("#alerts-dash").innerHTML =
    alerts.filter((a) => !a.resolved).slice(0, 5).map((a) => alertCard(a, true)).join("") ||
    '<p class="ok">No active alerts.</p>';
  renderAllAlerts(); // naka-filter ayon sa search box sa Alerts view

  // Ang mapa ay nag-redraw lang kapag may BAGONG data (hindi sa 1s time-tick) —
  // para hindi magsara ang nakabukas na marker popup bawat segundo
  if (redrawMap) {
  drawGeofences(s.geofences);
  boatLayer.clearLayers();
  devices.forEach((d) => {
    const p = d.lastLocation;
    if (!p) return;
    L.marker([p.lat, p.lng], {
      icon: boatIcon(tripStatus(d)),
    })
      .bindPopup(popupHTML(d, p), { maxWidth: 320 })
      .addTo(boatLayer)
      .on("mouseover", function () {
        this.openPopup(); // hover sa boat icon = agad lumalabas ang photo + buong info
      })
      .on("mouseout", function () {
        this.closePopup();
      });
  });
  const ids = new Set(devices.map((d) => d.deviceId));
  // Track history = KASALUKUYANG biyahe lamang. PANIBAGONG simula ng biyahe kapag:
  // (1) ang naunang point ay nasa loob ng safe area (umuwi), o
  // (2) may ≥10-min na gap sa magkasunod na points (pinatay ang board pagkatapos
  //     gumabi / matagal na walang signal) — kaya ang susunod na sailing ay laging
  //     panibagong record, hindi na kadugtong ng lumang linya.
  const pts = locations.filter((p) => ids.has(p.deviceId));
  const TRIP_GAP_MS = 10 * 60 * 1000; // 10 minutong katahimikan = bagong biyahe
  let tripStart = 0;
  for (let i = 1; i < pts.length; i++) {
    const gap = new Date(pts[i].timestamp) - new Date(pts[i - 1].timestamp);
    // track = kasalukuyang sailing leg lang: bagong simula sa pag-alis O pag-uwi
    // sa fence, o sa 10-min gap (pareho ng Sailing records rule)
    const left = insideFence(pts[i - 1]) && !insideFence(pts[i]);
    const arrived = !insideFence(pts[i - 1]) && insideFence(pts[i]);
    if (
      pts[i].deviceId !== pts[i - 1].deviceId ||
      left ||
      arrived ||
      gap >= TRIP_GAP_MS
    )
      tripStart = i;
  }
  const nakaUwi = pts.length > 0 && insideFence(pts[pts.length - 1]);
  track.setLatLngs(
    nakaUwi ? [] : pts.slice(tripStart).map((p) => [p.lat, p.lng]),
  );
  } // end redrawMap — ang mga sumusunod (offline alarm, banner, tunog) ay tumatakbo sa bawat tick

  // ---------- offline alarm: ONLY when an AT SEA (outside safe area) boat dies ----------
  devices.forEach((d) => {
    if (deviceOnline(d)) {
      delete alarmActive[d.deviceId];
      delete alarmAck[d.deviceId];
      delete zoomedOffline[d.deviceId];
    }
  });
  const seaOffline = devices.filter(
    (d) => d.lastLocation && !deviceOnline(d) && atSea(d),
  );
  seaOffline.forEach((d) => (alarmActive[d.deviceId] = true));
  if (seaOffline.length) {
    const d = seaOffline[0];
    const p = d.lastLocation;
    const acked = !!alarmAck[d.deviceId];
    $("#offline-banner").style.display = "flex";
    $("#offline-text").innerHTML = `🆘 <b>${esc(
      d.boatName,
    )}</b> (${esc(d.deviceId)}) <b>LOST SIGNAL AT SEA</b> — last signal ${new Date(
      p.timestamp,
    ).toLocaleString()}`;
    $("#alarm-stop").style.display = acked ? "none" : "";
    $("#alarm-acked").style.display = acked ? "" : "none";
    if (!zoomedOffline[d.deviceId]) {
      zoomedOffline[d.deviceId] = true;
      showView("dashboard");
      map.setView([p.lat, p.lng], 15, { animate: true });
    }
  } else {
    $("#offline-banner").style.display = "none";
  }

  // ---------- geofence / sail-ban banner na may "Mark as read" ----------
  // Habang somobra ang boat (may bukas na GEOFENCE/SAIL BAN alert), naka-display
  // ang dilaw na banner sa itaas ng mapa. Pag pinindot ang ✅ Mark as read:
  // nago-resolve sa server at hindi na muna lalabas ang banner sa session na ito
  // (fenceAcked) — pero babalik kapag nawala ang alert tapos may bagong somobra ulit.
  const openFenceAlert = alerts.find(
    (a) => !a.resolved && (a.type === "GEOFENCE" || a.type === "SAIL BAN"),
  );
  if (!openFenceAlert) fenceAcked = false; // reset — bagong somobra = lalabas ulit
  if (openFenceAlert && !fenceAcked) {
    $("#fence-text").innerHTML = `${openFenceAlert.type === "SAIL BAN" ? "🚫" : "⚠️"} <b>${esc(openFenceAlert.message)}</b> · ${new Date(openFenceAlert.timestamp).toLocaleTimeString()}`;
    $("#fence-banner").style.display = "flex";
  } else {
    $("#fence-banner").style.display = "none";
  }
  const unacked = seaOffline.some((d) => !alarmAck[d.deviceId]);
  if (unacked) startAlarmTicker();
  else stopAlarmTicker();

  const live = devices.find((d) => d.lastLocation);
  if (live) {
    if (!centered) {
      map.setView([live.lastLocation.lat, live.lastLocation.lng], 13);
      centered = true;
    }
  } else {
    centered = false;
    map.setView(AZAGRA, 11);
  }
}

let loadTimer = null;
async function load() {
  try {
    const r = await fetch("/api/state");
    if (r.status === 401) return (window.location.href = "/login");
    render(await r.json());
  } catch {
    const chip = $("#live");
    chip.textContent = "● SERVER OFFLINE";
    chip.className = "live-chip offline";
  }
}

// ---------- vessel management (add / edit) ----------
let editing = null;
// ---------- boat photo upload (register / edit) ----------
let pendingPhoto = null; // data URL ng bagong pipiliin na photo (hindi pa naka-save)
function setPhotoPreview(src) {
  const el = $("#photo-preview");
  if (!el) return;
  if (src) {
    el.classList.remove("empty");
    el.style.backgroundImage = `url("${src}")`;
    el.textContent = "";
  } else {
    el.classList.add("empty");
    el.style.backgroundImage = "";
    el.textContent = "🚤";
  }
}
// Binabasa ang file → canvas redraw (auto-resize ≤560px + EXIF/geo tags natatanggal)
// → JPEG data URL ~30–80KB: mabilis umakyat kahit sa mobile data
async function fileToJpeg(file, maxSide = 560, quality = 0.82) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("decode failed"));
      i.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d").drawImage(img, 0, 0, w, h);
    return c.toDataURL("image/jpeg", quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}
$("#f-photo").onchange = async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (!file.type || !file.type.startsWith("image/")) {
    $("#form-error").textContent = "Please choose an image file (JPEG or PNG).";
    return;
  }
  try {
    pendingPhoto = await fileToJpeg(file);
    setPhotoPreview(pendingPhoto);
    $("#photo-label").textContent = "📷 Change photo";
    $("#form-error").textContent = "";
  } catch {
    $("#form-error").textContent = "Could not read that image — try another photo.";
  }
};
function openForm(device) {
  editing = device || null;
  pendingPhoto = null;
  $("#f-photo").value = "";
  $("#form-title").textContent = device ? "Edit vessel" : "Add vessel";
  $("#f-deviceId").value = device?.deviceId || "";
  $("#f-deviceId").disabled = !!device;
  $("#f-fisherman").value = device?.fisherman || "";
  $("#f-boatName").value = device?.boatName || "";
  $("#f-emergencyContact").value = device?.emergencyContact || "";
  $("#f-registration").value = device?.registration || "";
  $("#f-sailBan").checked = !!device?.sailBan;
  setPhotoPreview(device?.photo || null);
  $("#photo-label").textContent = device?.photo ? "📷 Change photo" : "📷 Add photo";
  $("#form-error").textContent = "";
  $("#form-wrap").classList.add("open");
  $("#f-deviceId").focus();
}
function closeForm() {
  $("#form-wrap").classList.remove("open");
  editing = null;
  pendingPhoto = null;
}
$("#add").onclick = () => openForm(null);
$("#cancel").onclick = closeForm;
$("#form-wrap").onclick = (e) => {
  if (e.target === $("#form-wrap")) closeForm();
};
$("#vessel-form").onsubmit = async (e) => {
  e.preventDefault();
  const payload = {
    deviceId: $("#f-deviceId").value.trim(),
    fisherman: $("#f-fisherman").value.trim(),
    boatName: $("#f-boatName").value.trim(),
    emergencyContact: $("#f-emergencyContact").value.trim(),
    registration: $("#f-registration").value.trim(),
    sailBan: $("#f-sailBan").checked,
  };
  $("#form-error").textContent = "";
  try {
    const r = await fetch(editing ? "/api/devices/update" : "/api/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || "Save failed");
    if (pendingPhoto) {
      // upload ng bagong photo pagkatapos ma-save ang vessel record
      const pres = await fetch("/api/devices/photo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: payload.deviceId, image: pendingPhoto }),
      });
      const pout = await pres.json().catch(() => ({}));
      if (!pres.ok) throw new Error(pout.error || "Photo upload failed");
    }
    closeForm();
    load();
  } catch (err) {
    $("#form-error").textContent = err.message;
  }
};

window.openEdit = function (deviceId) {
  const d = (lastState.devices || []).find((x) => x.deviceId === deviceId);
  if (d) openForm(d);
};
window.removeVessel = async function (deviceId) {
  if (!confirm(`Remove vessel ${deviceId} from the registry?`)) return;
  await fetch("/api/devices/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId }),
  });
  load();
};

// ---------- activity log (Strava-style ruta history) ----------
// Hatiin ang location history sa mga BIYAHE: bagong biyahe kapag (1) ≥10-min na gap
// sa magkasunod na points, o (2) ang naunang point ay nasa loob ng safe area (umuwi)
// — kapareho ng trip logic ng mapa. Ang mga stats ay kinakalkula sa browser para
// hindi mabigat ang server (512MB droplet).
let actData = null; // { devices, locations } mula sa /api/activities
let actList = []; // kasalukuyang naka-render na trips (para sa openRoute)
let actMap = null; // lazy-created Leaflet map sa route modal
let actLine = null;
const ACT_TRIP_GAP_MS = 10 * 60 * 1000;

async function loadActivities() {
  try {
    const r = await fetch("/api/activities");
    if (r.status === 401) return (window.location.href = "/login");
    actData = await r.json();
    renderActivities();
  } catch {
    $("#act-total").textContent = "— could not load history";
  }
}
function haversine(a, b) {
  const R = 6371000,
    rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat),
    dLon = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
function splitTrips(pts) {
  const segs = [];
  let start = 0;
  for (let i = 1; i < pts.length; i++) {
    const gap = new Date(pts[i].timestamp) - new Date(pts[i - 1].timestamp);
    const arrived = !insideFence(pts[i - 1]) && insideFence(pts[i]);
    if (arrived) {
      // ARAW ng pag-uwi: ang SAIL record ay nagtatapos SA arrival point (kaya
      // laging "✅ Arrived" ang lumalabas, hindi nawawala), at ang STAY ASHORE
      // record ay nagsisimula din sa arrival point
      segs.push(pts.slice(start, i + 1));
      start = i;
    } else if (gap >= ACT_TRIP_GAP_MS) {
      // ≥10-min na katahimikan (pinatay ang board / nawalan ng signal) = bagong record
      segs.push(pts.slice(start, i));
      start = i;
    }
  }
  segs.push(pts.slice(start));
  return segs.filter((s) => s.length >= 2); // isang point lang = test ping
}
function tripInfo(seg) {
  let dist = 0,
    maxS = 0,
    sailed = false;
  for (let i = 0; i < seg.length; i++) {
    if (i) dist += haversine(seg[i - 1], seg[i]);
    maxS = Math.max(maxS, seg[i].speedKph || 0);
    if (!insideFence(seg[i])) sailed = true;
  }
  const t0 = new Date(seg[0].timestamp),
    t1 = new Date(seg[seg.length - 1].timestamp);
  const mins = Math.max(1, Math.round((t1 - t0) / 60000));
  return {
    seg,
    sailed,
    returned: insideFence(seg[seg.length - 1]),
    distKm: dist / 1000,
    maxKph: Math.round(maxS),
    start: seg[0],
    end: seg[seg.length - 1],
    t0,
    t1,
    durH: Math.floor(mins / 60),
    durM: mins % 60,
  };
}
function miniRouteSVG(seg) {
  // Strava-style route thumbnail: naka-normalize sa bbox, max ~120 sampled points
  const W = 120,
    H = 78,
    pad = 8;
  const step = Math.max(1, Math.ceil(seg.length / 120));
  const s = seg.filter((_, k) => k % step === 0 || k === seg.length - 1);
  const lats = s.map((p) => p.lat),
    lngs = s.map((p) => p.lng);
  const minLa = Math.min(...lats),
    maxLa = Math.max(...lats);
  const minLn = Math.min(...lngs),
    maxLn = Math.max(...lngs);
  const sx = maxLn - minLn || 1e-6,
    sy = maxLa - minLa || 1e-6;
  const xy = s.map((p) => [
    pad + ((p.lng - minLn) / sx) * (W - 2 * pad),
    H - pad - ((p.lat - minLa) / sy) * (H - 2 * pad),
  ]);
  const ptsStr = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [x0, y0] = xy[0],
    [xN, yN] = xy[xy.length - 1];
  return `<svg class="route-mini" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Route preview">
    <rect width="${W}" height="${H}" rx="8" fill="#f3f7fb"/>
    <polyline points="${ptsStr}" fill="none" stroke="#1261a0" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x0.toFixed(1)}" cy="${y0.toFixed(1)}" r="3.5" fill="#087a64"/>
    <circle cx="${xN.toFixed(1)}" cy="${yN.toFixed(1)}" r="3.5" fill="#c0392b"/>
  </svg>`;
}

function actCard(x, i) {
  const t = x.t;
  const badge = t.sailed
    ? x.d.sailBan
      ? '<span class="trip-badge viol">🚫 SAIL BAN VIOLATION</span>'
      : '<span class="trip-badge sail">⛵ SAILED</span>'
    : '<span class="trip-badge stay">⚓ STAYED ASHORE</span>';
  const ret = t.returned
    ? t.sailed
      ? "✅ Arrived — back in safe area"
      : "✅ At shore"
    : "🚨 Last position: AT SEA";
  const ongoing =
    x.d.lastLocation &&
    t.end.timestamp === x.d.lastLocation.timestamp &&
    deviceOnline(x.d);
  return `<article class="trip-card" data-i="${i}">
    ${miniRouteSVG(t.seg)}
    <div class="trip-body">
      <div class="trip-head"><b>${esc(x.d.fisherman)}</b><span class="muted">${esc(x.d.boatName || x.d.deviceId)}</span>${badge}${ongoing ? '<span class="trip-badge live">● ONGOING</span>' : ""}</div>
      <div class="trip-stats">
        <span>📅 ${t.t0.toLocaleDateString()} · ${t.t0.toLocaleTimeString()}–${t.t1.toLocaleTimeString()}</span>
        <span>⏱️ ${t.durH ? t.durH + "h " : ""}${t.durM}m</span>
        <span>📏 ${t.distKm.toFixed(2)} km</span>
        <span>💨 ${t.maxKph} km/h max</span>
      </div>
      <div class="trip-geo">
        <span>📍 Start: ${t.start.lat.toFixed(5)}, ${t.start.lng.toFixed(5)}</span>
        <span>📍 End: ${t.end.lat.toFixed(5)}, ${t.end.lng.toFixed(5)}</span>
        <span>${ret}</span>
        <span class="muted">${t.seg.length} GPS points</span>
      </div>
    </div>
    <span class="trip-open">View route ▸</span>
  </article>`;
}
function renderActivities() {
  if (!actData) return;
  const q = ($("#act-search").value || "").trim().toLowerCase();
  const nPoints = (actData.locations || []).length;
  // Flat list ng LAHAT ng records (walang group header) — bawat card ay may
  // pangalan ng fisherman + boat, pinakabago sa taas. Search: tsuper ng pangalan.
  const list = [];
  (actData.devices || []).forEach((d) => {
    if (
      q &&
      !String(d.fisherman).toLowerCase().includes(q) &&
      !String(d.deviceId).toLowerCase().includes(q)
    )
      return;
    const pts = (actData.locations || []).filter((p) => p.deviceId === d.deviceId);
    splitTrips(pts).forEach((seg) => list.push({ d, t: tripInfo(seg) }));
  });
  list.sort((a, b) => new Date(b.t.end.timestamp) - new Date(a.t.end.timestamp));
  actList = list;
  $("#act-total").textContent = `${list.length} records · ${nPoints} GPS points`;
  $("#act-list").innerHTML =
    list.map((x, i) => actCard(x, i)).join("") ||
    `<p class="ok">${q ? `No records match "${esc(q)}".` : "No recorded trips yet — every sail will appear here once GPS data comes in."}</p>`;
  document.querySelectorAll("#act-list .trip-card").forEach((el) => {
    el.onclick = () => openRoute(Number(el.dataset.i));
  });
}
function openRoute(i) {
  const x = actList[i];
  if (!x) return;
  const t = x.t;
  $("#route-title").textContent = `${x.d.fisherman}${x.d.boatName ? " · " + x.d.boatName : ""}`;
  $("#route-sub").innerHTML = `📅 ${t.t0.toLocaleString()} → ${t.t1.toLocaleTimeString()} · ⏱️ ${t.durH ? t.durH + "h " : ""}${t.durM}m · 📏 ${t.distKm.toFixed(2)} km · 💨 ${t.maxKph} km/h max · ${t.sailed ? (x.d.sailBan ? "🚫 sailed during no-sail order" : "⛵ sailed") : "⚓ did not sail"} · ${t.returned ? "✅ returned" : "🚨 last position at sea"}`;
  $("#route-wrap").classList.add("open");
  // timeline: lahat ng points kung maliit, i-sample kapag lumagpas sa 300
  const step = Math.max(1, Math.ceil(t.seg.length / 300));
  $("#route-timeline").innerHTML = t.seg
    .filter((_, k) => k % step === 0 || k === t.seg.length - 1)
    .map(
      (p) =>
        `<div class="tl-row"><span class="tl-t">${new Date(p.timestamp).toLocaleString()}</span><span class="tl-c">📍 ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</span><span class="tl-s">💨 ${Math.round(p.speedKph || 0)} km/h</span></div>`,
    )
    .join("");
  // mapa: lazy-create sa unang bukas; i-invalidate pagkatapos maging visible
  setTimeout(() => {
    if (!actMap) {
      actMap = L.map("route-map");
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(actMap);
      actLine = L.layerGroup().addTo(actMap);
    }
    actMap.invalidateSize();
    actLine.clearLayers();
    const latlngs = t.seg.map((p) => [p.lat, p.lng]);
    L.polyline(latlngs, { color: "#1261a0", weight: 3, opacity: 0.85 }).addTo(actLine);
    const f = (lastState.geofences || [])[0];
    if (f && Number.isFinite(+f.lat))
      L.circle([+f.lat, +f.lng], {
        radius: +f.radiusM || 0,
        color: "#17a2b8",
        weight: 1,
        fillOpacity: 0.05,
      }).addTo(actLine);
    L.marker(latlngs[0], {
      icon: L.divIcon({
        className: "",
        html: '<div class="route-pin start">⚓</div>',
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      }),
    })
      .addTo(actLine)
      .bindTooltip("Trip start");
    L.marker(latlngs[latlngs.length - 1], {
      icon: L.divIcon({
        className: "",
        html: t.returned
          ? '<div class="route-pin end-ok">🏁</div>'
          : '<div class="route-pin end-sea">🚨</div>',
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      }),
    })
      .addTo(actLine)
      .bindTooltip(t.returned ? "End — returned to shore" : "End — at sea");
    actMap.fitBounds(L.latLngBounds(latlngs).pad(0.25));
  }, 60);
}
$("#route-close").onclick = () => $("#route-wrap").classList.remove("open");
$("#route-wrap").onclick = (e) => {
  if (e.target === $("#route-wrap")) $("#route-wrap").classList.remove("open");
};
$("#act-search").oninput = renderActivities;
$("#act-print").onclick = () => window.print(); // print CSS: results lang ang ilalabas
// Alerts view: parehong search + print na tulad ng Sailing records
$("#alert-search").oninput = renderAllAlerts;
$("#alert-print").onclick = () => window.print();
// auto-refresh habang naka-bukas ang Activity log (max kada 30s) — lumalabas agad
// ang bagong biyahe nang hindi na kailangang bumalik-balik sa ibang view
setInterval(() => {
  if (document.querySelector("#view-activities.active")) loadActivities();
}, 30000);

// ---------- alerts: resolve ----------
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button.resolve");
  if (!btn) return;
  await fetch("/api/alerts/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: btn.dataset.id || undefined,
      timestamp: btn.dataset.ts,
      type: btn.dataset.type,
    }),
  });
  load();
});

// ---------- settings ----------
function fillSettings() {
  $("#new-user").value = me.username || "";
  loadAdminUsers(); // listahan ng admin accounts (owner lang ang makaka-manage)
  const f = (lastState.geofences || [])[0] || {};
  $("#g-name").value = f.name || "";
  $("#g-lat").value = f.lat ?? "";
  $("#g-lng").value = f.lng ?? "";
  $("#g-radius").value = f.radiusM ?? "";
  fetch("/api/admin/summary")
    .then((r) => r.json())
    .then((s) => {
      $("#sysinfo").innerHTML = `
        <div><span>Admin username</span><b>${esc(s.username)}</b></div>
        <div><span>Registered vessels</span><b>${s.vessels}</b></div>
        <div><span>Stored GPS points</span><b>${s.points}</b></div>
        <div><span>Alert records</span><b>${s.alerts}</b></div>
        <div><span>Active sessions</span><b>${s.activeSessions}</b></div>
        <div><span>Data store</span><b>data/tracker-data.json</b></div>
        ${s.mustChange ? '<div class="warn">⚠ Default password in use — palitan na sa itaas.</div>' : ""}`;
    })
    .catch(() => {});
}

$("#cred-form").onsubmit = async (e) => {
  e.preventDefault();
  const msg = $("#cred-msg");
  msg.textContent = "";
  const np = $("#new-pass").value,
    np2 = $("#new-pass2").value;
  if (np && np !== np2) {
    msg.className = "form-msg err";
    msg.textContent = "New password and confirmation do not match.";
    return;
  }
  try {
    const r = await fetch("/api/admin/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentPassword: $("#cur-pass").value,
        newUsername: $("#new-user").value.trim(),
        newPassword: np,
      }),
    });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || "Update failed");
    me.username = out.username;
    me.mustChange = out.mustChange;
    $("#side-username").textContent = out.username;
    msg.className = "form-msg okm";
    msg.textContent =
      "✓ Admin account updated." +
      (out.mustChange ? " (Default password still in use — change it for security.)" : "");
    $("#cur-pass").value = "";
    $("#new-pass").value = "";
    $("#new-pass2").value = "";
  } catch (err) {
    msg.className = "form-msg err";
    msg.textContent = err.message;
  }
};

$("#fence-form").onsubmit = async (e) => {
  e.preventDefault();
  const msg = $("#fence-msg");
  msg.textContent = "";
  try {
    const r = await fetch("/api/geofence/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: $("#g-name").value.trim(),
        lat: +$("#g-lat").value,
        lng: +$("#g-lng").value,
        radiusM: +$("#g-radius").value,
      }),
    });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || "Save failed");
    msg.className = "form-msg okm";
    msg.textContent = "✓ Geofence saved.";
    load();
  } catch (err) {
    msg.className = "form-msg err";
    msg.textContent = err.message;
  }
};

$("#alarm-stop").onclick = () => {
  Object.keys(alarmActive).forEach((id) => (alarmAck[id] = true));
  stopAlarmTicker();
  render(lastState);
};

// ✅ Mark as read — sa geofence / sail-ban banner
$("#fence-ack").onclick = async () => {
  const a = (lastState.alerts || []).find(
    (x) => !x.resolved && (x.type === "GEOFENCE" || x.type === "SAIL BAN"),
  );
  if (!a) return;
  fenceAcked = true; // itago muna ang banner sa session na ito
  render(lastState, false);
  try {
    await fetch("/api/alerts/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: a.id || undefined,
        timestamp: a.timestamp,
        type: a.type,
      }),
    });
  } catch {}
  load();
};

// ---------- admin users: dagdag / activate / deactivate / delete (owner lang) ----------
let adminUsers = []; // listahan mula sa GET /api/admin/users
let editUserId = null; // null = "Add admin" mode; id = "Edit admin" mode

function roleTag(u) {
  return u.role === "owner"
    ? '<span class="usr-badge owner">👑 Owner</span>'
    : '<span class="usr-badge op">👤 Operator</span>';
}
function stateTag(u) {
  if (!u.active) return '<span class="usr-badge off">🚫 Deactivated</span>';
  return u.online
    ? '<span class="usr-badge on">✅ Active · signed in</span>'
    : '<span class="usr-badge on">✅ Active</span>';
}
function renderAdminUsers() {
  const box = $("#admin-users");
  if (!box) return;
  const addBtn = $("#user-add");
  if (addBtn) addBtn.style.display = me.role === "owner" ? "" : "none";
  if (me.role !== "owner") {
    box.innerHTML =
      '<p class="muted">Only an <b>owner</b> account can manage admin users.</p>';
    return;
  }
  if (!adminUsers.length) {
    box.innerHTML = '<p class="muted">No admin accounts yet.</p>';
    return;
  }
  box.innerHTML = adminUsers
    .map((u) => {
      const last = u.lastLogin ? new Date(u.lastLogin).toLocaleString() : "never";
      const created = u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "—";
      return `<div class="usr-row${u.active ? "" : " is-off"}">
        <div class="usr-avatar">${u.role === "owner" ? "👑" : "👤"}</div>
        <div class="usr-main">
          <b>${esc(u.username)}</b>${u.self ? ' <small class="muted">(you)</small>' : ""}
          <div class="usr-badges">${roleTag(u)} ${stateTag(u)}${
            u.mustChange ? ' <span class="usr-badge warn">⚠ Must change password</span>' : ""
          }</div>
          <small class="muted">Created ${esc(created)} · Last login: ${esc(last)}</small>
        </div>
        <div class="usr-actions">
          <button class="mini usr-act" data-act="toggle" data-id="${u.id}"${
            u.self ? ' disabled title="You cannot deactivate your own account"' : ""
          }>${u.active ? "🚫 Deactivate" : "✅ Activate"}</button>
          <button class="mini usr-act" data-act="edit" data-id="${u.id}">✏️ Edit</button>
          <button class="mini del usr-act" data-act="del" data-id="${u.id}"${
            u.self ? ' disabled title="You cannot delete your own account"' : ""
          }>🗑️ Delete</button>
        </div>
      </div>`;
    })
    .join("");
}

async function loadAdminUsers() {
  if (me.role !== "owner") return renderAdminUsers();
  try {
    const r = await fetch("/api/admin/users");
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || "Could not load admin users");
    adminUsers = out.users || [];
  } catch (e) {
    const box = $("#admin-users");
    if (box) box.innerHTML = `<p class="form-msg err">${esc(e.message)}</p>`;
    return;
  }
  renderAdminUsers();
}

function userMsg(text, cls = "okm") {
  const m = $("#user-msg");
  if (!m) return;
  m.className = "form-msg " + cls;
  m.textContent = text;
}

// ---------- admin user modal: Add / Edit ----------
function openUserForm(u) {
  editUserId = u ? u.id : null;
  const add = !u;
  $("#user-title").textContent = add
    ? "Add admin"
    : `Edit admin — ${u.username}`;
  $("#u-name").value = u ? u.username : "";
  $("#u-pass").value = "";
  $("#u-pass2").value = "";
  $("#u-pass").placeholder = add ? "min 6 characters" : "leave blank to keep current";
  $("#u-pass2").placeholder = add ? "repeat password" : "leave blank to keep current";
  $("#u-role").value = u ? u.role : "owner";
  $("#u-mustchange").checked = add ? true : !!u.mustChange;
  const mcRow = $("#u-mustchange").closest(".ban-toggle");
  if (mcRow) mcRow.style.display = add ? "" : "none";
  const actRow = $("#u-active-row");
  if (actRow) actRow.style.display = add ? "none" : "";
  $("#u-active").checked = add ? true : !!u.active;
  const selfNote = $("#u-self-note");
  if (selfNote) selfNote.style.display = u && u.self ? "" : "none";
  $("#user-error").textContent = "";
  $("#user-wrap").classList.add("open");
  $("#u-name").focus();
}
function closeUserForm() {
  $("#user-wrap").classList.remove("open");
  editUserId = null;
}
$("#user-add").onclick = () => openUserForm(null);
$("#user-cancel").onclick = closeUserForm;
$("#user-wrap").onclick = (e) => {
  if (e.target === $("#user-wrap")) closeUserForm();
};

$("#user-form").onsubmit = async (e) => {
  e.preventDefault();
  const msg = $("#user-error");
  msg.textContent = "";
  const username = $("#u-name").value.trim();
  const password = $("#u-pass").value;
  const p2 = $("#u-pass2").value;
  if (password || p2) {
    if (password !== p2) {
      msg.textContent = "Password and confirmation do not match.";
      return;
    }
    if (password.length < 6) {
      msg.textContent = "Password too short (min 6 characters).";
      return;
    }
  }
  if (!editUserId && !password) {
    msg.textContent = "Password is required when creating an admin.";
    return;
  }
  const isEdit = !!editUserId;
  try {
    const r = isEdit
      ? await fetch("/api/admin/users/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: editUserId,
            username,
            role: $("#u-role").value,
            active: $("#u-active").checked,
            password: password || undefined,
          }),
        })
      : await fetch("/api/admin/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username,
            password,
            role: $("#u-role").value,
            mustChange: $("#u-mustchange").checked,
          }),
        });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || "Save failed");
    // kung sariling account ang in-edit, i-sync agad ang sidebar/me
    if (out.user && out.user.self && out.username) {
      me.username = out.username;
      $("#side-username").textContent = out.username;
    }
    closeUserForm();
    userMsg(
      (isEdit ? "✓ Admin account updated: " : "✓ New admin created: ") +
        (out.user ? out.user.username : username) +
        ".",
    );
  } catch (err) {
    msg.textContent = err.message;
    return;
  }
  loadAdminUsers();
};

// ---------- activate / deactivate / edit / delete (list buttons) ----------
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button.usr-act");
  if (!btn) return;
  const u = adminUsers.find((x) => x.id === btn.dataset.id);
  if (!u) return;
  const act = btn.dataset.act;
  if (act === "edit") return openUserForm(u);

  if (act === "toggle") {
    const verb = u.active ? "Deactivate" : "Activate";
    if (
      !confirm(
        `${verb} the admin account "${u.username}"?` +
          (u.active
            ? "\n\nAny active sign-in of this account will be ended immediately."
            : ""),
      )
    )
      return;
    btn.disabled = true;
    try {
      const r = await fetch("/api/admin/users/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: u.id }),
      });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || "Action failed");
      userMsg(
        `✓ ${out.user.username} is now ${out.user.active ? "active" : "deactivated"}.`,
      );
    } catch (err) {
      userMsg(err.message, "err");
    }
  }

  if (act === "del") {
    if (!confirm(`Delete the admin account "${u.username}"?\n\nThis cannot be undone.`))
      return;
    btn.disabled = true;
    try {
      const r = await fetch("/api/admin/users/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: u.id }),
      });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || "Delete failed");
      userMsg(`✓ Admin account deleted: ${u.username}.`);
    } catch (err) {
      userMsg(err.message, "err");
    }
  }

  loadAdminUsers();
});

init();