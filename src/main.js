"use strict";
// Nest Call staff app - main process.
// Owns: sign-in, the live Supabase connection, call state, tray icon, and both windows.
// Renderers never talk to Supabase directly; they only use the IPC API in preload.js.

const {
  app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, safeStorage, Notification, screen, shell,
} = require("electron");
const path = require("path");
const fs = require("fs");
const WebSocket = require("ws");
const { createClient } = require("@supabase/supabase-js");
const cfg = require("./config");

if (!app.requestSingleInstanceLock()) app.exit(0);
app.on("second-instance", () => showMain());
app.setAppUserModelId("uk.co.nest-call.staff");
Menu.setApplicationMenu(null);

const CALL_COLS = "id,site_id,table_id,table_label,request_type,note,status,location_status,created_at";
const POLL_MS = 10000, TABLE_POLL_MS = 20000, TICK_MS = 5000, OFFLINE_WARN_MS = 45000;
const ALERT_W = 480;

const rendererFile = (f) => path.join(__dirname, "renderer", f);
const trayImg = (f) => nativeImage.createFromPath(rendererFile(f)).resize({ width: 32, height: 32 });

// ------------------------------------------------------------------ settings
let settings = { siteIds: [], sound: true, realertSeconds: 60 };
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) }; } catch { /* first run */ }
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch (e) { console.error("settings save failed", e); }
  applyStartup();
}
// ALWAYS ON: the app starts with Windows and cannot be switched off from inside (no quit, no startup toggle).
// It is re-registered at every launch, so removing the startup entry heals itself the next time it runs.
// The only intended way to stop it is to uninstall it.
function applyStartup() {
  if (!app.isPackaged) return; // in dev this would register electron.exe itself
  app.setLoginItemSettings({ openAtLogin: true, args: ["--hidden"] });
}

// ------------------------------------------- encrypted session storage (Windows DPAPI)
const sessionFile = () => path.join(app.getPath("userData"), "session.bin");
function readSessionStore() {
  try {
    const buf = fs.readFileSync(sessionFile());
    const txt = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString("utf8");
    return JSON.parse(txt);
  } catch { return {}; }
}
function writeSessionStore(obj) {
  const txt = JSON.stringify(obj);
  fs.writeFileSync(sessionFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(txt) : Buffer.from(txt));
}
const sessionStorageAdapter = {
  getItem: (k) => readSessionStore()[k] ?? null,
  setItem: (k, v) => { const s = readSessionStore(); s[k] = v; writeSessionStore(s); },
  removeItem: (k) => { const s = readSessionStore(); delete s[k]; writeSessionStore(s); },
};

// --------------------------------------------------------------------- state
let supabase = null;
let user = null, noAccess = false;
let sites = [], tables = [], brandLabels = {};
let myTenantIds = [];
const calls = new Map();        // pending calls from the server, by id
const testCalls = new Map();    // local test alerts
const alertedAt = new Map();    // id -> last time we made noise for it
let rtOk = false, pollOk = false, connected = false, offlineSince = Date.now(), offlineWarned = false;
let channel = null, pollTimer = null, tableTimer = null, tickTimer = null;
let mainWin = null, alertWin = null, tray = null;
let alertHeightPx = 240;

const needsSites = () => !!user && !noAccess && settings.siteIds.length === 0;

function titleCase(s) { return String(s || "").replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()); }

function publicCalls() {
  const siteName = Object.fromEntries(sites.map((s) => [s.id, s.name]));
  return [...calls.values(), ...testCalls.values()]
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map((c) => ({
      id: c.id, table_id: c.table_id, table_label: c.table_label,
      request_label: c.test ? c.request_label : (brandLabels[c.request_type] || titleCase(c.request_type)),
      note: c.note || null, location_status: c.location_status, created_at: c.created_at,
      site_name: siteName[c.site_id] || "", test: !!c.test,
    }));
}

function snapshot() {
  return {
    signedIn: !!user, email: user ? user.email : null, noAccess, needsSites: needsSites(),
    sites, siteIds: settings.siteIds, connected, calls: publicCalls(), tables, settings,
    version: app.getVersion(),
  };
}

const alive = (w) => w && !w.isDestroyed();

function emitState() {
  const s = snapshot();
  if (alive(mainWin)) mainWin.webContents.send("state", s);
  if (alive(alertWin)) alertWin.webContents.send("alert:state", { calls: s.calls, connected: s.connected });
  updateTray(s);
}

// ------------------------------------------------------------------- windows
function createMain(show) {
  mainWin = new BrowserWindow({
    width: 760, height: 700, minWidth: 560, minHeight: 520, show,
    title: "Nest Call", icon: rendererFile("tray.png"), autoHideMenuBar: true, backgroundColor: "#f3f4f6",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  watchSessionEnd(mainWin);
  mainWin.webContents.on("render-process-gone", () => { try { mainWin.destroy(); } catch { /* ignore */ } createMain(true); });
  mainWin.loadFile(rendererFile("index.html"));
  mainWin.on("close", (e) => {            // closing just hides to the tray
    if (!app.isQuitting) { e.preventDefault(); mainWin.hide(); }
  });
}

function showMain() {
  if (!alive(mainWin)) createMain(true);
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show(); mainWin.focus();
}

function ensureAlertWin() {
  if (alive(alertWin)) return alertWin;
  alertWin = new BrowserWindow({
    width: ALERT_W, height: alertHeightPx, show: false, frame: false, resizable: false,
    minimizable: false, maximizable: false, fullscreenable: false, alwaysOnTop: true,
    title: "Nest Call - call waiting", icon: rendererFile("tray.png"), backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false,
      sandbox: true, autoplayPolicy: "no-user-gesture-required", backgroundThrottling: false,
    },
  });
  alertWin.setAlwaysOnTop(true, "screen-saver");
  watchSessionEnd(alertWin);
  alertWin.webContents.on("render-process-gone", () => { try { alertWin.destroy(); } catch { /* ignore */ } alertWin = null; if (calls.size + testCalls.size) triggerAlert("new"); });
  alertWin.loadFile(rendererFile("alert.html"));
  alertWin.on("close", (e) => { if (!app.isQuitting) { e.preventDefault(); alertWin.hide(); } });
  return alertWin;
}

function positionAlert() {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  alertWin.setBounds({
    x: Math.round(d.x + (d.width - ALERT_W) / 2),
    y: Math.round(d.y + d.height * 0.1),
    width: ALERT_W, height: alertWin.getBounds().height,
  });
}

// Shows the popup on top of everything WITHOUT taking keyboard focus, so a stray
// Enter/Space keypress from someone typing in another app can't accept a call.
function showAlert() {
  ensureAlertWin();
  if (!alertWin.isVisible()) { positionAlert(); alertWin.showInactive(); }
  alertWin.setAlwaysOnTop(true, "screen-saver");
  alertWin.moveTop();
}

function sound(kind) {
  if (settings.sound && alive(alertWin)) alertWin.webContents.send("alert:sound", kind);
}

function refreshAlert() {
  const any = calls.size + testCalls.size > 0;
  if (any) ensureAlertWin();
  else if (alive(alertWin) && alertWin.isVisible()) alertWin.hide();
  emitState();
}

function triggerAlert(kind) {
  refreshAlert();
  if (calls.size + testCalls.size === 0) return;
  showAlert();
  sound(kind);
}

// ---------------------------------------------------------------------- tray
function updateTray(s = snapshot()) {
  if (!tray) return;
  const n = s.calls.length;
  tray.setImage(trayImg(n > 0 ? "tray-alert.png" : "tray.png"));
  tray.setToolTip(n > 0 ? `Nest Call - ${n} call${n === 1 ? "" : "s"} waiting`
    : s.signedIn && !s.connected ? "Nest Call - OFFLINE (calls may not arrive)" : "Nest Call");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: !s.signedIn ? "Not signed in" : s.connected ? "● Connected" : "○ Offline - calls may not arrive", enabled: false },
    { type: "separator" },
    { label: "Open Nest Call", click: showMain },
    { label: "Send test alert", enabled: s.signedIn && !s.needsSites, click: () => sendTestAlert() },
    { type: "separator" },
    { label: "Sign out", enabled: s.signedIn, click: () => signOut() },
  ]));
}

// ---------------------------------------------------------------------- auth
function friendlyAuthError(msg) {
  if (/invalid login|invalid credentials/i.test(msg)) return "That email or password isn't right.";
  if (/email not confirmed/i.test(msg)) return "Please confirm your email address first.";
  if (/fetch|network|ENOTFOUND/i.test(msg)) return "Can't reach the server. Check your internet connection.";
  return msg;
}

async function onSignedIn(u, accessToken) {
  user = u; noAccess = false;
  if (accessToken) supabase.realtime.setAuth(accessToken);
  // Only the businesses this person is a member of. (Row-level security alone isn't enough: a platform
  // administrator is allowed to read every site, but must still only see their own here.)
  const { data: mem, error: memErr } = await supabase.from("tenant_members").select("tenant_id").eq("user_id", u.id);
  myTenantIds = memErr ? [] : [...new Set((mem || []).map((m) => m.tenant_id))];
  if (!myTenantIds.length) sites = [];
  else {
    const { data, error } = await supabase.from("sites").select("id,name,tenant_id").in("tenant_id", myTenantIds).order("name");
    if (error) { console.error("load sites failed", error); sites = []; }
    else sites = data || [];
  }
  if (!sites.length) { noAccess = true; emitState(); return; }
  settings.siteIds = settings.siteIds.filter((id) => sites.some((s) => s.id === id));
  if (!settings.siteIds.length && sites.length === 1) settings.siteIds = [sites[0].id];
  saveSettings();
  if (settings.siteIds.length) await startMonitoring();
  emitState();
}

async function signOut() {
  const hadUser = user;
  user = null;
  await stopMonitoring();
  calls.clear(); testCalls.clear(); alertedAt.clear(); tables = []; sites = []; myTenantIds = []; settings.siteIds = []; saveSettings(); noAccess = false;
  if (hadUser) { try { await supabase.auth.signOut(); } catch { /* ignore */ } }
  refreshAlert();
  showMain();
}

// ---------------------------------------------------------------- monitoring
async function loadBrandLabels() {
  const { data } = myTenantIds.length ? await supabase.from("brand_profiles").select("copy").in("tenant_id", myTenantIds) : { data: [] };
  brandLabels = {};
  for (const b of data || []) {
    for (const r of (b.copy && b.copy.requests) || []) {
      if (r.key && r.label && !brandLabels[r.key]) brandLabels[r.key] = String(r.label);
    }
  }
}

function pickCall(row) {
  const o = {}; for (const k of CALL_COLS.split(",")) o[k] = row[k]; return o;
}

function updateConnected() {
  const now = rtOk && pollOk;
  if (now === connected) return;
  connected = now;
  if (!connected) { offlineSince = Date.now(); }
  else { offlineSince = 0; offlineWarned = false; pollCalls(); }
  emitState();
}

function onCallChange(payload) {
  if (payload.eventType === "DELETE") {
    const id = payload.old && payload.old.id;
    if (id && calls.delete(id)) { alertedAt.delete(id); refreshAlert(); }
    return;
  }
  const row = payload.new;
  if (!row || !row.id || !settings.siteIds.includes(row.site_id)) return;
  if (row.status === "pending") {
    if (calls.has(row.id)) { calls.set(row.id, pickCall(row)); emitState(); }
    else { calls.set(row.id, pickCall(row)); alertedAt.set(row.id, Date.now()); triggerAlert("new"); }
  } else if (calls.delete(row.id)) {
    alertedAt.delete(row.id); refreshAlert();
  }
}

async function pollCalls() {
  if (!user || !settings.siteIds.length) return;
  const { data, error } = await supabase.from("calls").select(CALL_COLS)
    .eq("status", "pending").in("site_id", settings.siteIds);
  if (error) { pollOk = false; updateConnected(); return; }
  pollOk = true;
  const serverIds = new Set(data.map((r) => r.id));
  let added = false, removed = false;
  for (const r of data) {
    if (!calls.has(r.id)) { calls.set(r.id, pickCall(r)); alertedAt.set(r.id, Date.now()); added = true; }
  }
  for (const id of [...calls.keys()]) {
    if (!serverIds.has(id)) { calls.delete(id); alertedAt.delete(id); removed = true; }
  }
  if (added) triggerAlert("new"); else if (removed) refreshAlert();
  updateConnected();
}

async function loadTables() {
  if (!user || !settings.siteIds.length) return;
  const { data, error } = await supabase.from("tables")
    .select("id,label,site_id,disabled_until,disabled_reason").in("site_id", settings.siteIds);
  if (!error) { tables = data || []; emitState(); }
}

function subscribeRealtime() {
  if (channel) { supabase.removeChannel(channel); channel = null; }
  channel = supabase.channel("calls-feed")
    .on("postgres_changes", { event: "*", schema: "public", table: "calls" }, onCallChange)
    .subscribe((status) => { rtOk = status === "SUBSCRIBED"; updateConnected(); });
}

async function startMonitoring() {
  await stopMonitoring();
  rtOk = false; pollOk = false; connected = false; offlineSince = Date.now(); offlineWarned = false;
  await loadBrandLabels();
  subscribeRealtime();
  await Promise.all([pollCalls(), loadTables()]);
  pollTimer = setInterval(pollCalls, POLL_MS);
  tableTimer = setInterval(loadTables, TABLE_POLL_MS);
}

async function stopMonitoring() {
  clearInterval(pollTimer); clearInterval(tableTimer); pollTimer = tableTimer = null;
  if (channel) { try { await supabase.removeChannel(channel); } catch { /* ignore */ } channel = null; }
  rtOk = pollOk = connected = false;
}

// Every few seconds: re-alert on unanswered calls, and warn if we've been offline a while.
function tick() {
  const now = Date.now();
  const gap = Math.max(15, Number(settings.realertSeconds) || 60) * 1000;
  let due = false;
  for (const id of [...calls.keys(), ...testCalls.keys()]) {
    if (now - (alertedAt.get(id) || 0) >= gap) { alertedAt.set(id, now); due = true; }
  }
  if (due) { showAlert(); sound("repeat"); }

  if (user && settings.siteIds.length && !connected && offlineSince && !offlineWarned && now - offlineSince > OFFLINE_WARN_MS) {
    offlineWarned = true;
    if (Notification.isSupported()) {
      new Notification({ title: "Nest Call is offline", body: "New calls may not appear until the connection returns." }).show();
    }
  }
}

// -------------------------------------------------------------- IPC handlers
const minutesUntilMidnight = () => {
  const n = new Date(), m = new Date(n); m.setHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((m - n) / 60000));
};
const modeMinutes = (mode) => (mode === "15" ? 15 : mode === "60" ? 60 : mode === "today" ? minutesUntilMidnight() : null);
const isHandledError = (e) => e && /ALREADY_HANDLED_OR_FORBIDDEN/.test(e.message || "");

function sendTestAlert() {
  const id = "test-" + Date.now();
  testCalls.set(id, {
    id, test: true, table_label: "Test table", request_label: "Test alert",
    note: "This is a test. Press Accept to dismiss it.", location_status: "verified",
    created_at: new Date().toISOString(), site_id: null,
  });
  alertedAt.set(id, Date.now());
  triggerAlert("new");
}

ipcMain.handle("state:get", () => snapshot());

ipcMain.handle("auth:login", async (_e, { email, password }) => {
  const { data, error } = await supabase.auth.signInWithPassword({ email: String(email || "").trim(), password: String(password || "") });
  if (error) return { error: friendlyAuthError(error.message) };
  await onSignedIn(data.user, data.session && data.session.access_token);
  return { ok: true };
});
ipcMain.handle("auth:reset", () => { shell.openExternal("https://app.nest-call.co.uk/?reset=1"); return { ok: true }; });
ipcMain.handle("auth:logout", () => signOut());

ipcMain.handle("call:accept", async (_e, id) => {
  if (testCalls.has(id)) { testCalls.delete(id); alertedAt.delete(id); refreshAlert(); return { ok: true }; }
  const { error } = await supabase.rpc("accept_call", { _call: id });
  if (error && !isHandledError(error)) return { error: error.message };
  calls.delete(id); alertedAt.delete(id); refreshAlert();
  return { ok: true, already: !!error };
});

ipcMain.handle("call:false-alarm", async (_e, { id, mode, block }) => {
  if (testCalls.has(id)) { testCalls.delete(id); alertedAt.delete(id); refreshAlert(); return { ok: true }; }
  const call = calls.get(id);
  const { error } = await supabase.rpc("mark_false_alarm", {
    _call: id, _disable_minutes: modeMinutes(mode), _block_caller: !!block,
  });
  if (error && !isHandledError(error)) return { error: error.message };
  if (!error && mode === "forever" && call) {
    await supabase.rpc("disable_table", { _table: call.table_id, _minutes: null, _reason: "False alarm" });
  }
  calls.delete(id); alertedAt.delete(id); refreshAlert(); loadTables();
  return { ok: true };
});

ipcMain.handle("alert:hide", () => { if (alive(alertWin)) alertWin.hide(); });
ipcMain.on("alert:height", (_e, h) => {
  if (!alive(alertWin)) return;
  alertHeightPx = Math.min(Math.max(Math.ceil(Number(h) || 240), 180), 680);
  alertWin.setContentSize(ALERT_W, alertHeightPx);
});

ipcMain.handle("table:disable", async (_e, { id, mode }) => {
  const { error } = await supabase.rpc("disable_table", { _table: id, _minutes: modeMinutes(mode), _reason: "Disabled by staff" });
  if (error) return { error: error.message };
  await loadTables(); return { ok: true };
});
ipcMain.handle("table:enable", async (_e, id) => {
  const { error } = await supabase.rpc("enable_table", { _table: id });
  if (error) return { error: error.message };
  await loadTables(); return { ok: true };
});

ipcMain.handle("sites:set", async (_e, ids) => {
  const valid = (Array.isArray(ids) ? ids : []).filter((id) => sites.some((s) => s.id === id));
  if (!valid.length) return { error: "Choose at least one site." };
  settings.siteIds = valid; saveSettings();
  calls.clear(); alertedAt.clear(); tables = [];
  await startMonitoring(); refreshAlert();
  return { ok: true };
});

ipcMain.handle("settings:set", (_e, patch) => {
  if (typeof patch.sound === "boolean") settings.sound = patch.sound;
  if ([30, 60, 120, 300].includes(Number(patch.realertSeconds))) settings.realertSeconds = Number(patch.realertSeconds);
  saveSettings(); emitState();
  return { ok: true };
});
ipcMain.handle("test:alert", () => { sendTestAlert(); return { ok: true }; });

// ----------------------------------------------------------------- lifecycle
// Nothing in the app can quit it. The only exceptions are Windows shutting down / logging off (so we never
// block a restart) and the installer or uninstaller, which stops the process itself.
let systemEnding = false;
app.on("before-quit", (e) => { if (!systemEnding) e.preventDefault(); else app.isQuitting = true; });
function watchSessionEnd(w) { w.on("session-end", () => { systemEnding = true; app.isQuitting = true; }); }
app.on("window-all-closed", () => { /* keep running in the tray */ });
app.on("will-quit", (e) => { if (!systemEnding) e.preventDefault(); });
process.on("uncaughtException", (e) => console.error("uncaught", e));
process.on("unhandledRejection", (e) => console.error("unhandled", e));

app.whenReady().then(async () => {
  loadSettings(); applyStartup();

  supabase = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
    auth: { storage: sessionStorageAdapter, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    realtime: { transport: WebSocket },
  });
  supabase.auth.onAuthStateChange((event, session) => {
    if (session && (event === "TOKEN_REFRESHED" || event === "SIGNED_IN")) supabase.realtime.setAuth(session.access_token);
    if (event === "SIGNED_OUT" && user) signOut();   // session revoked elsewhere
  });

  tray = new Tray(trayImg("tray.png"));
  tray.on("click", showMain);
  updateTray();

  const startHidden = process.argv.includes("--hidden");
  const { data } = await supabase.auth.getSession();
  createMain(!(startHidden && data.session));
  ensureAlertWin();
  tickTimer = setInterval(tick, TICK_MS);

  if (data.session) await onSignedIn(data.session.user, data.session.access_token);
  else emitState();
});
