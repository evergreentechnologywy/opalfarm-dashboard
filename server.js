const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { URL } = require("url");

const ROOT = __dirname;
const CONFIG_DIR = path.join(ROOT, "config");
const LOG_DIR = path.join(ROOT, "logs");
const WEB_DIR = path.join(ROOT, "web");
const SCRIPTS_DIR = path.join(ROOT, "scripts");
const SETTINGS_PATH = path.join(CONFIG_DIR, "settings.json");
const STATE_PATH = path.join(CONFIG_DIR, "state.json");
const USERS_PATH = path.join(CONFIG_DIR, "users.json");
const ROUTING_AUDIT_PATH = path.join(CONFIG_DIR, "routing-audit.json");
const ACTIVITY_LOG_PATH = path.join(LOG_DIR, "activity.log");
const PID_PATH = path.join(ROOT, "phonefarm.pid");
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const DEFAULT_SETTINGS = {
  host: "127.0.0.1",
  port: 7780,
  adbPath: "adb",
  scrcpyPath: "scrcpy",
  pollIntervalMs: 5000,
  ipRefreshIntervalMs: 15000,
  prep: {
    minWaitSeconds: 25,
    maxWaitSeconds: 45,
    onlineTimeoutSeconds: 90
  },
  deviceMetadata: {}
};

const DEFAULT_STATE = {
  queue: [],
  devices: {},
  recentActivity: []
};

const DEFAULT_USERS = {
  users: [
    {
      username: "admin",
      displayName: "Admin",
      role: "admin",
      allowedDevices: ["*"],
      passwordHash: "pbkdf2$210000$d5d2d23da02115eb83c4ee3f060ee253$efcd13bca1e29d682e132ab345da8ecd9f38f6b5a9c211fee4e50a3dfa6609f3"
    }
  ]
};

let settings = loadJson(SETTINGS_PATH, DEFAULT_SETTINGS);
let state = loadJson(STATE_PATH, DEFAULT_STATE);
let usersConfig = loadJson(USERS_PATH, DEFAULT_USERS);
let preparingSerial = null;
let deviceCache = {};
let lastIpRefreshAt = 0;
let lastRoutingAuditAt = 0;
const missingTools = new Set();
const sessions = new Map();

ensureDirectories();
writeJsonIfMissing(SETTINGS_PATH, settings);
writeJsonIfMissing(STATE_PATH, state);
writeJsonIfMissing(USERS_PATH, usersConfig);
fs.writeFileSync(PID_PATH, String(process.pid));

process.on("exit", cleanupPid);
process.on("SIGINT", () => {
  cleanupPid();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanupPid();
  process.exit(0);
});

logActivity("system", "PhoneFarm dashboard starting");
refreshDevices();
refreshRoutingAudit();
setInterval(refreshDevices, settings.pollIntervalMs || 5000);
setInterval(refreshRoutingAudit, 30000);
setInterval(trimRecentActivity, 10000);
setInterval(cleanExpiredSessions, 300000);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    const cookies = parseCookies(req.headers.cookie || "");
    const session = getSession(cookies.phonefarm_session);
    const user = session ? findUser(session.username) : null;

    if (req.method === "POST" && url.pathname === "/api/login") {
      const body = await readJsonBody(req);
      return handleLogin(res, body);
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      if (cookies.phonefarm_session) {
        sessions.delete(cookies.phonefarm_session);
      }
      return sendJson(res, 200, { ok: true }, [expireSessionCookie()]);
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
      if (!user) {
        return sendJson(res, 401, { error: "Authentication required" });
      }
      return sendJson(res, 200, { ok: true, user: sanitizeUser(user) });
    }

    if (url.pathname.startsWith("/api/")) {
      if (!user) {
        return sendJson(res, 401, { error: "Authentication required" });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      return sendJson(res, 200, buildStatus(user));
    }

    if (req.method === "GET" && url.pathname === "/api/logs/recent") {
      return sendJson(res, 200, { recentActivity: filterRecentActivityForUser(user) });
    }

    if (req.method === "POST" && url.pathname === "/api/config/reload") {
      settings = loadJson(SETTINGS_PATH, DEFAULT_SETTINGS);
      usersConfig = loadJson(USERS_PATH, DEFAULT_USERS);
      logActivity("system", `Configuration reloaded by ${user.username}`);
      return sendJson(res, 200, { ok: true, settings, user: sanitizeUser(user) });
    }

    const match = url.pathname.match(/^\/api\/devices\/([^/]+)\/([^/]+)$/);
    if (req.method === "POST" && match) {
      const serial = decodeURIComponent(match[1]);
      const action = match[2];
      const body = await readJsonBody(req);
      return handleDeviceAction(res, user, serial, action, body);
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    logActivity("error", `Request failed: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(settings.port, settings.host, () => {
  logActivity("system", `Dashboard listening on http://${settings.host}:${settings.port}`);
});

function cleanupPid() {
  if (fs.existsSync(PID_PATH)) {
    try {
      fs.unlinkSync(PID_PATH);
    } catch (error) {
      // Ignore cleanup failures during shutdown.
    }
  }
}

function ensureDirectories() {
  for (const dir of [CONFIG_DIR, LOG_DIR, WEB_DIR, SCRIPTS_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return JSON.parse(JSON.stringify(fallback));
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return JSON.parse(JSON.stringify(fallback));
  }
}

function writeJsonIfMissing(filePath, data) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
  }
}

function saveState() {
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function saveSettings() {
  fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
}

function trimRecentActivity() {
  if ((state.recentActivity || []).length > 200) {
    state.recentActivity = state.recentActivity.slice(0, 200);
    saveState();
  }
}

function logActivity(category, message, serial = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    category,
    serial,
    message
  };
  const line = `[${entry.timestamp}] [${category}]${serial ? ` [${serial}]` : ""} ${message}\n`;
  fs.appendFileSync(ACTIVITY_LOG_PATH, line);
  state.recentActivity = [entry, ...(state.recentActivity || [])].slice(0, 200);
  saveState();
}

function parseCookies(cookieHeader) {
  const cookies = {};
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index);
    const value = trimmed.slice(index + 1);
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function getSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function cleanExpiredSessions() {
  for (const [token, session] of sessions.entries()) {
    if (Date.now() > session.expiresAt) {
      sessions.delete(token);
    }
  }
}

function findUser(username) {
  return (usersConfig.users || []).find(item => item.username === username) || null;
}

function sanitizeUser(user) {
  return {
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role || "operator",
    allowedDevices: user.allowedDevices || []
  };
}

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  const salt = parts[2];
  const expected = parts[3];
  const actual = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function createSessionCookie(token) {
  return `phonefarm_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`;
}

function expireSessionCookie() {
  return "phonefarm_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0";
}

function handleLogin(res, body) {
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const user = findUser(username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    logActivity("auth", `Failed login attempt for ${username || "unknown"}`);
    return sendJson(res, 401, { error: "Invalid username or password" });
  }

  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, {
    username: user.username,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  logActivity("auth", `Successful login for ${user.username}`);
  return sendJson(res, 200, { ok: true, user: sanitizeUser(user) }, [createSessionCookie(token)]);
}

function userCanAccessDevice(user, serial) {
  if (!user) return false;
  const allowed = user.allowedDevices || [];
  return allowed.includes("*") || allowed.includes(serial);
}

function filterDevicesForUser(user) {
  return Object.values(deviceCache)
    .filter(device => userCanAccessDevice(user, device.serial))
    .sort((a, b) => a.serial.localeCompare(b.serial));
}

function filterRecentActivityForUser(user) {
  if (!user) return [];
  return (state.recentActivity || []).filter(entry => !entry.serial || userCanAccessDevice(user, entry.serial));
}

function buildStatus(user) {
  const visibleDevices = filterDevicesForUser(user);
  const visibleSerials = new Set(visibleDevices.map(device => device.serial));
  const visibleQueue = (state.queue || []).filter(serial => visibleSerials.has(serial));
  const visiblePreparing = preparingSerial && visibleSerials.has(preparingSerial) ? preparingSerial : null;
  return {
    ok: true,
    user: sanitizeUser(user),
    settings: {
      host: settings.host,
      port: settings.port,
      pollIntervalMs: settings.pollIntervalMs,
      ipRefreshIntervalMs: settings.ipRefreshIntervalMs,
      prep: settings.prep
    },
    queue: visibleQueue,
    preparingSerial: visiblePreparing,
    routingAudit: loadRoutingAudit(),
    devices: visibleDevices,
    recentActivity: filterRecentActivityForUser(user)
  };
}

function sendJson(res, statusCode, data, extraCookies = []) {
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  if (extraCookies.length) {
    headers["Set-Cookie"] = extraCookies;
  }
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(data));
}

function serveStatic(urlPath, res) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(WEB_DIR, requested));
  if (!filePath.startsWith(WEB_DIR)) {
    return sendJson(res, 403, { error: "Forbidden" });
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return sendJson(res, 404, { error: "Not found" });
  }
  res.writeHead(200, { "Content-Type": getContentType(filePath) });
  fs.createReadStream(filePath).pipe(res);
}

function getContentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Invalid JSON request body"));
      }
    });
    req.on("error", reject);
  });
}

function handleDeviceAction(res, user, serial, action, body) {
  if (!userCanAccessDevice(user, serial)) {
    return sendJson(res, 403, { error: "You do not have access to this device" });
  }

  const knownDevice = deviceCache[serial] || buildMissingDevice(serial);
  if (action === "metadata") {
    settings.deviceMetadata[serial] = {
      ...(settings.deviceMetadata[serial] || {}),
      sim: String(body.sim || "").trim(),
      proxy: String(body.proxy || "").trim()
    };
    saveSettings();
    refreshDevices();
    logActivity("metadata", `SIM/proxy metadata updated by ${user.username}`, serial);
    return sendJson(res, 200, { ok: true });
  }

  if (action === "open-control") {
    runPowerShellScript("open-scrcpy-for-device.ps1", ["-Serial", serial], { detached: true });
    logActivity("scrcpy", `Open Control requested by ${user.username}`, serial);
    return sendJson(res, 200, { ok: true });
  }

  if (action === "start-session") {
    updateDeviceState(serial, { sessionState: "running", sessionStartedAt: new Date().toISOString() });
    logActivity("session", `Session started by ${user.username}`, serial);
    return sendJson(res, 200, { ok: true });
  }

  if (action === "stop-session") {
    updateDeviceState(serial, { sessionState: "stopped", sessionStoppedAt: new Date().toISOString() });
    logActivity("session", `Session stopped by ${user.username}`, serial);
    return sendJson(res, 200, { ok: true });
  }

  if (action === "prep") {
    if (!knownDevice.serial) {
      return sendJson(res, 404, { error: "Unknown device serial" });
    }
    if ((state.queue || []).includes(serial) || preparingSerial === serial) {
      return sendJson(res, 409, { error: "Device already queued or preparing" });
    }
    state.queue = [...(state.queue || []), serial];
    updateDeviceState(serial, { prepState: "queued", prepMessage: "Queued for prep" });
    logActivity("queue", `Device added to prep queue by ${user.username}`, serial);
    processPrepQueue();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 400, { error: `Unsupported action: ${action}` });
}

function buildMissingDevice(serial) {
  return {
    serial,
    adbState: "unknown",
    online: false,
    model: "",
    product: "",
    transportId: "",
    sim: settings.deviceMetadata?.[serial]?.sim || "",
    proxy: settings.deviceMetadata?.[serial]?.proxy || "",
    network: state.devices?.[serial]?.network || {
      ipAddress: "",
      interface: "",
      source: "",
      status: "unknown",
      checkedAt: ""
    },
    prepState: state.devices?.[serial]?.prepState || "idle",
    prepMessage: state.devices?.[serial]?.prepMessage || "",
    sessionState: state.devices?.[serial]?.sessionState || "stopped"
  };
}

function updateDeviceState(serial, patch) {
  const current = state.devices[serial] || {};
  state.devices[serial] = { ...current, ...patch, updatedAt: new Date().toISOString() };
  saveState();
  refreshDevices();
}

function refreshDevices() {
  const previous = deviceCache;
  const rows = queryAdbDevices();
  const next = {};
  const shouldRefreshNetwork = Date.now() - lastIpRefreshAt >= (settings.ipRefreshIntervalMs || 15000);

  for (const row of rows) {
    const stored = state.devices[row.serial] || {};
    const metadata = settings.deviceMetadata[row.serial] || {};
    const network = shouldRefreshNetwork
      ? queryDeviceNetwork(row.serial, row.state === "device")
      : (stored.network || previous[row.serial]?.network || {
          ipAddress: "",
          interface: "",
          source: "",
          status: row.state === "device" ? "pending" : "offline",
          checkedAt: ""
        });
    next[row.serial] = {
      serial: row.serial,
      adbState: row.state,
      online: row.state === "device",
      model: row.model || "",
      product: row.product || "",
      deviceName: row.deviceName || "",
      transportId: row.transportId || "",
      sim: metadata.sim || "",
      proxy: metadata.proxy || "",
      network,
      prepState: stored.prepState || "idle",
      prepMessage: stored.prepMessage || "",
      sessionState: stored.sessionState || "stopped",
      sessionStartedAt: stored.sessionStartedAt || "",
      sessionStoppedAt: stored.sessionStoppedAt || "",
      lastSeenAt: new Date().toISOString()
    };

    const previousState = previous[row.serial]?.adbState;
    if (previousState && previousState !== row.state) {
      logActivity("device", `ADB state changed from ${previousState} to ${row.state}`, row.serial);
    }
  }

  for (const serial of Object.keys(previous)) {
    if (!next[serial]) {
      const preserved = buildMissingDevice(serial);
      preserved.prepMessage = "Device not currently visible in ADB";
      preserved.network = {
        ipAddress: "",
        interface: "",
        source: "",
        status: "offline",
        checkedAt: new Date().toISOString()
      };
      next[serial] = preserved;
      if (previous[serial].online) {
        logActivity("disconnect", "Device disconnected from ADB", serial);
      }
    }
  }

  deviceCache = next;
  if (shouldRefreshNetwork) {
    lastIpRefreshAt = Date.now();
  }
}

function queryAdbDevices() {
  const adbPath = settings.adbPath || "adb";
  const result = spawnSync(adbPath, ["devices", "-l"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error) {
    logMissingToolOnce("adb", result.error.message);
    return [];
  }
  const output = String(result.stdout || "").trim();
  if (!output) {
    return [];
  }
  return output
    .split(/\r?\n/)
    .slice(1)
    .map(line => line.trim())
    .filter(Boolean)
    .map(parseAdbLine)
    .filter(Boolean);
}

function logMissingToolOnce(tool, message) {
  const key = `${tool}:${message}`;
  if (!missingTools.has(key)) {
    missingTools.add(key);
    logActivity("warning", `${tool} unavailable: ${message}`);
  }
}

function parseAdbLine(line) {
  const parts = line.split(/\s+/);
  if (parts.length < 2) return null;
  const info = {
    serial: parts[0],
    state: parts[1],
    model: "",
    product: "",
    deviceName: "",
    transportId: ""
  };
  for (const token of parts.slice(2)) {
    const [key, value] = token.split(":");
    if (!value) continue;
    if (key === "model") info.model = value;
    if (key === "product") info.product = value;
    if (key === "device") info.deviceName = value;
    if (key === "transport_id") info.transportId = value;
  }
  return info;
}

function queryDeviceNetwork(serial, online) {
  const checkedAt = new Date().toISOString();
  if (!online) {
    return {
      ipAddress: "",
      interface: "",
      source: "",
      status: "offline",
      checkedAt
    };
  }

  const attempts = [
    {
      source: "ip-route",
      args: ["-s", serial, "shell", "ip", "route"]
    },
    {
      source: "ip-addr",
      args: ["-s", serial, "shell", "ip", "-f", "inet", "addr", "show"]
    },
    {
      source: "getprop-wlan0",
      args: ["-s", serial, "shell", "getprop", "dhcp.wlan0.ipaddress"]
    },
    {
      source: "getprop-rmnet",
      args: ["-s", serial, "shell", "getprop", "dhcp.rmnet_data0.ipaddress"]
    }
  ];

  for (const attempt of attempts) {
    const result = spawnSync(settings.adbPath || "adb", attempt.args, {
      cwd: ROOT,
      encoding: "utf8",
      windowsHide: true,
      timeout: 8000
    });

    if (result.error || result.status !== 0) {
      continue;
    }

    const parsed = parseNetworkOutput(String(result.stdout || ""), attempt.source);
    if (parsed.ipAddress) {
      return {
        ipAddress: parsed.ipAddress,
        interface: parsed.interface,
        source: attempt.source,
        status: "ok",
        checkedAt
      };
    }
  }

  return {
    ipAddress: "",
    interface: "",
    source: "",
    status: "unresolved",
    checkedAt
  };
}

function parseNetworkOutput(output, source) {
  const normalized = String(output || "").trim();
  if (!normalized) {
    return { ipAddress: "", interface: "" };
  }

  if (source === "ip-route") {
    const lines = normalized.split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/\bsrc\s+(\d{1,3}(?:\.\d{1,3}){3}).*?\bdev\s+([A-Za-z0-9_.:-]+)/);
      if (match) {
        return { ipAddress: match[1], interface: match[2] };
      }
      const fallback = line.match(/\bdev\s+([A-Za-z0-9_.:-]+).*?\bsrc\s+(\d{1,3}(?:\.\d{1,3}){3})/);
      if (fallback) {
        return { ipAddress: fallback[2], interface: fallback[1] };
      }
    }
  }

  if (source === "ip-addr") {
    const match = normalized.match(/inet\s+(\d{1,3}(?:\.\d{1,3}){3})\/\d+\s+.*?\b([A-Za-z0-9_.:-]+)$/m);
    if (match) {
      return { ipAddress: match[1], interface: match[2] };
    }
    const alt = normalized.match(/\d+:\s+([A-Za-z0-9_.:-]+).*?inet\s+(\d{1,3}(?:\.\d{1,3}){3})\/\d+/s);
    if (alt) {
      return { ipAddress: alt[2], interface: alt[1] };
    }
  }

  if (source.startsWith("getprop")) {
    const match = normalized.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
    if (match) {
      return { ipAddress: match[1], interface: source.includes("wlan0") ? "wlan0" : "rmnet_data0" };
    }
  }

  return { ipAddress: "", interface: "" };
}

function processPrepQueue() {
  if (preparingSerial || !(state.queue || []).length) return;
  const serial = state.queue[0];
  preparingSerial = serial;
  state.queue = state.queue.slice(1);
  updateDeviceState(serial, { prepState: "preparing", prepMessage: "Prep workflow in progress" });
  logActivity("queue", "Prep worker claimed queued device", serial);

  const child = runPowerShellScript(
    "prep-device-session.ps1",
    ["-Serial", serial, "-SettingsPath", SETTINGS_PATH, "-ActivityLogPath", ACTIVITY_LOG_PATH],
    { detached: false }
  );

  child.on("exit", code => {
    const success = code === 0;
    updateDeviceState(serial, {
      prepState: success ? "ready" : "failed",
      prepMessage: success ? "Prep completed successfully" : "Prep failed; review logs"
    });
    logActivity("queue", success ? "Prep completed" : `Prep failed with exit code ${code}`, serial);
    preparingSerial = null;
    refreshDevices();
    processPrepQueue();
  });
}

function refreshRoutingAudit() {
  if (Date.now() - lastRoutingAuditAt < 25000) return;
  lastRoutingAuditAt = Date.now();
  runPowerShellScript("audit-phonefarm-routing.ps1", [], { detached: true });
}

function loadRoutingAudit() {
  return loadJson(ROUTING_AUDIT_PATH, {
    checkedAt: "",
    overallOk: false,
    summary: "Routing audit has not completed yet.",
    checks: []
  });
}

function runPowerShellScript(scriptName, scriptArgs, options) {
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  const psArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...scriptArgs];
  const child = spawn("powershell.exe", psArgs, {
    cwd: ROOT,
    windowsHide: true,
    detached: Boolean(options?.detached),
    stdio: "ignore"
  });
  if (options?.detached) {
    child.unref();
  }
  return child;
}
