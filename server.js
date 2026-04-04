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
const DEVICES_CONFIG_PATH = path.join(CONFIG_DIR, "devices.json");
const DEVICE_IP_HISTORY_PATH = path.join(CONFIG_DIR, "device-ip-history.json");
const ACTIVITY_LOG_PATH = path.join(LOG_DIR, "activity.log");
const IP_CHECK_LOG_PATH = path.join(LOG_DIR, "ip-check.log");
const PID_PATH = path.join(ROOT, "phonefarm.pid");
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PHONEFARM_REMOTE_PREFIX = "/phonefarm";
const AUTH_DISABLED = true;
const AUTH_BYPASS_USER = {
  username: "operator",
  displayName: "Operator",
  role: "admin",
  allowedDevices: ["*"]
};

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
  }
};

const DEFAULT_STATE = {
  queue: [],
  devices: {},
  recentActivity: []
};

const DEFAULT_IP_HISTORY = {
  devices: {}
};

const DEFAULT_DEVICES_CONFIG = {
  devices: []
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
let devicesConfig = loadJson(DEVICES_CONFIG_PATH, DEFAULT_DEVICES_CONFIG);
let preparingSerial = null;
let deviceCache = {};
let lastIpRefreshAt = 0;
let lastAccountRefreshAt = 0;
let lastRoutingAuditAt = 0;
let deviceIpHistory = loadJson(DEVICE_IP_HISTORY_PATH, DEFAULT_IP_HISTORY);
const missingTools = new Set();
const sessions = new Map();
const ipCheckPromises = new Map();

ensureDirectories();
writeJsonIfMissing(SETTINGS_PATH, settings);
writeJsonIfMissing(STATE_PATH, state);
writeJsonIfMissing(USERS_PATH, usersConfig);
writeJsonIfMissing(DEVICES_CONFIG_PATH, devicesConfig);
writeJsonIfMissing(DEVICE_IP_HISTORY_PATH, deviceIpHistory);
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
    const originalUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    const pathname = normalizeRequestPath(originalUrl.pathname);
    const url = new URL(`${pathname}${originalUrl.search}`, `http://${req.headers.host || "127.0.0.1"}`);
    const cookies = parseCookies(req.headers.cookie || "");
    const session = AUTH_DISABLED ? null : getSession(cookies.phonefarm_session);
    const user = AUTH_DISABLED ? AUTH_BYPASS_USER : (session ? findUser(session.username) : null);

    if (req.method === "POST" && url.pathname === "/api/login") {
      if (AUTH_DISABLED) {
        return sendJson(res, 200, { ok: true, user: sanitizeUser(AUTH_BYPASS_USER) });
      }
      const body = await readJsonBody(req);
      return handleLogin(res, body);
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      if (AUTH_DISABLED) {
        return sendJson(res, 200, { ok: true, user: sanitizeUser(AUTH_BYPASS_USER) });
      }
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
      devicesConfig = loadJson(DEVICES_CONFIG_PATH, DEFAULT_DEVICES_CONFIG);
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

function saveDevicesConfig() {
  fs.writeFileSync(DEVICES_CONFIG_PATH, `${JSON.stringify(devicesConfig, null, 2)}\n`);
}

function saveDeviceIpHistory() {
  fs.writeFileSync(DEVICE_IP_HISTORY_PATH, `${JSON.stringify(deviceIpHistory, null, 2)}\n`);
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

function logIpCheck(message, serial = null) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}]${serial ? ` [${serial}]` : ""} ${message}\n`;
  fs.appendFileSync(IP_CHECK_LOG_PATH, line);
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

function getDeviceConfig(serial) {
  return (devicesConfig.devices || []).find(device => device.serial === serial) || {
    serial,
    phoneNumber: null,
    nickname: "",
    role: "sim-direct",
    parentHotspotSerial: ""
  };
}

function upsertDeviceConfig(serial, patch) {
  const devices = devicesConfig.devices || [];
  const index = devices.findIndex(device => device.serial === serial);
  const nextRecord = {
    ...getDeviceConfig(serial),
    ...patch,
    serial
  };
  if (index >= 0) {
    devices[index] = nextRecord;
  } else {
    devices.push(nextRecord);
  }
  devicesConfig.devices = devices;
  saveDevicesConfig();
  return nextRecord;
}

function getAssignedPhoneNumbers() {
  const numbers = new Set();
  for (const device of devicesConfig.devices || []) {
    const phoneNumber = Number(device.phoneNumber);
    if (Number.isInteger(phoneNumber) && phoneNumber > 0) {
      numbers.add(phoneNumber);
      continue;
    }

    const nicknameMatch = String(device.nickname || "").match(/^Phone\s+(\d{1,3})$/i);
    if (nicknameMatch) {
      numbers.add(Number(nicknameMatch[1]));
    }
  }
  return numbers;
}

function getNextPhoneNumber() {
  const assigned = getAssignedPhoneNumbers();
  let phoneNumber = 1;
  while (assigned.has(phoneNumber)) {
    phoneNumber += 1;
  }
  return phoneNumber;
}

function formatPhoneNumber(phoneNumber) {
  return `Phone ${String(phoneNumber).padStart(2, "0")}`;
}

function ensureDeviceNumberAssignment(serial) {
  const existing = getDeviceConfig(serial);
  const currentNumber = Number(existing.phoneNumber);
  if (Number.isInteger(currentNumber) && currentNumber > 0) {
    return existing;
  }

  const nicknameMatch = String(existing.nickname || "").match(/^Phone\s+(\d{1,3})$/i);
  const phoneNumber = nicknameMatch ? Number(nicknameMatch[1]) : getNextPhoneNumber();
  return upsertDeviceConfig(serial, {
    phoneNumber,
    nickname: existing.nickname || formatPhoneNumber(phoneNumber)
  });
}

function buildStatus(user) {
  const routingAudit = loadRoutingAudit();
  const routingGuard = buildRoutingGuard(routingAudit);
  const visibleDevices = applyDuplicateFlags(filterDevicesForUser(user)).map(device => enrichDeviceForStatus(device, routingAudit));
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
    prepTelemetry: buildPrepTelemetry(visibleDevices),
    routingAudit,
    routingGuard,
    devices: visibleDevices,
    recentActivity: filterRecentActivityForUser(user)
  };
}

function sendJson(res, statusCode, data, extraCookies = []) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0"
  };
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
  res.writeHead(200, {
    "Content-Type": getContentType(filePath),
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0"
  });
  fs.createReadStream(filePath).pipe(res);
}

function normalizeRequestPath(pathname) {
  if (pathname === PHONEFARM_REMOTE_PREFIX || pathname === `${PHONEFARM_REMOTE_PREFIX}/`) {
    return "/";
  }
  if (pathname.startsWith(`${PHONEFARM_REMOTE_PREFIX}/`)) {
    return pathname.slice(PHONEFARM_REMOTE_PREFIX.length);
  }
  return pathname;
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
  return handleDeviceActionAsync(res, user, serial, action, body);
}

async function handleDeviceActionAsync(res, user, serial, action, body) {
  if (!userCanAccessDevice(user, serial)) {
    return sendJson(res, 403, { error: "You do not have access to this device" });
  }

  const knownDevice = deviceCache[serial] || buildMissingDevice(serial);
  const routingGuard = buildRoutingGuard(loadRoutingAudit());
  if (action === "metadata") {
    upsertDeviceConfig(serial, {
      nickname: String(body.nickname || "").trim(),
      role: String(body.role || "sim-direct").trim() || "sim-direct",
      parentHotspotSerial: String(body.parentHotspotSerial || "").trim()
    });
    refreshDevices();
    logActivity("metadata", `Device metadata updated by ${user.username}`, serial);
    return sendJson(res, 200, { ok: true });
  }

  if (action === "viewer-state") {
    const current = state.devices?.[serial]?.viewerLaunch || buildMissingDevice(serial).viewerLaunch;
    const sourceAction = String(body.sourceAction || current.sourceAction || "").trim();
    const nextViewerLaunch = {
      ...current,
      status: String(body.status || current.status || "unknown"),
      sourceAction,
      requestedAt: String(body.requestedAt || current.requestedAt || new Date().toISOString()),
      confirmedAt: String(body.confirmedAt || current.confirmedAt || ""),
      pid: Number.isFinite(Number(body.pid)) ? Number(body.pid) : (current.pid || null),
      processName: String(body.processName || current.processName || ""),
      filePath: String(body.filePath || current.filePath || ""),
      aliveAfterLaunch: body.aliveAfterLaunch === undefined ? Boolean(current.aliveAfterLaunch) : Boolean(body.aliveAfterLaunch),
      windowReady: body.windowReady === undefined ? Boolean(current.windowReady) : Boolean(body.windowReady),
      fallbackViewer: String(body.fallbackViewer || current.fallbackViewer || ""),
      manualSelectionRequired: body.manualSelectionRequired === undefined ? Boolean(current.manualSelectionRequired) : Boolean(body.manualSelectionRequired),
      lastError: String(body.lastError || "")
    };
    updateDeviceState(serial, { viewerLaunch: nextViewerLaunch });
    logActivity("scrcpy", `Viewer state synced by ${user.username} for ${sourceAction || "desktop"}: ${nextViewerLaunch.status}`, serial);
    return sendJson(res, 200, { ok: true, viewerLaunch: nextViewerLaunch });
  }

  if (action === "open-control") {
    const launchResult = await launchViewerForDevice(serial, user.username, "open-control");
    if (!launchResult.success) {
      return sendJson(res, 500, { error: launchResult.error || "Viewer launch failed", viewerLaunch: launchResult.viewerLaunch || null });
    }
    return sendJson(res, 200, { ok: true, viewerLaunch: launchResult.viewerLaunch });
  }

  if (action === "check-ip") {
    if (ipCheckPromises.has(serial)) {
      return sendJson(res, 409, { error: "An IP check is already running for this device" });
    }
    const result = await runDevicePublicIpCheck(serial, "manual");
    if (!result.success) {
      return sendJson(res, 500, { error: result.error || "IP check failed", ipCheck: result.publicIp });
    }
    return sendJson(res, 200, { ok: true, ipCheck: result.publicIp });
  }

  if (action === "recover-radios") {
    updateDeviceState(serial, { prepMessage: "Clearing airplane mode and recovering radios" });
    const child = runPowerShellScript(
      "recover-device-radios.ps1",
      ["-Serial", serial, "-SettingsPath", SETTINGS_PATH, "-ActivityLogPath", ACTIVITY_LOG_PATH],
      { detached: false }
    );

    child.on("exit", code => {
      const success = code === 0;
      updateDeviceState(serial, {
        prepMessage: success ? "Airplane mode cleared and radios recovered" : "Radio recovery failed; review logs"
      });
      logActivity("recover", success ? "Radio recovery completed" : `Radio recovery failed with exit code ${code}`, serial);
    });

    logActivity("recover", `Radio recovery requested by ${user.username}`, serial);
    return sendJson(res, 200, { ok: true });
  }

  if (action === "engage-airplane") {
    updateDeviceState(serial, { prepMessage: "Engaging airplane mode" });
    const child = runPowerShellScript(
      "set-device-airplane-mode.ps1",
      ["-Serial", serial, "-Mode", "on", "-SettingsPath", SETTINGS_PATH, "-ActivityLogPath", ACTIVITY_LOG_PATH],
      { detached: false }
    );

    child.on("exit", code => {
      const success = code === 0;
      updateDeviceState(serial, {
        prepMessage: success ? "Airplane mode requested" : "Airplane mode request failed; review logs"
      });
      logActivity("airplane", success ? "Airplane mode engaged" : `Airplane mode request failed with exit code ${code}`, serial);
    });

    logActivity("airplane", `Airplane mode requested by ${user.username}`, serial);
    return sendJson(res, 200, { ok: true });
  }

  if (action === "start-session") {
    if (routingGuard.blocked) {
      return sendJson(res, 409, { error: `Session start blocked: ${routingGuard.reasons.join(" | ")}`, routingGuard });
    }
    const verification = await runDevicePublicIpCheck(serial, "pre-session");
    if (!verification.success) {
      return sendJson(res, 409, { error: verification.error || "IP verification failed; session not started" });
    }
    if (body && body.skipViewerLaunch) {
      updateDeviceState(serial, { sessionState: "running", sessionStartedAt: new Date().toISOString() });
      logActivity("session", `Session started by ${user.username} with desktop-managed viewer launch`, serial);
      return sendJson(res, 200, { ok: true, desktopLaunchPending: true, viewerLaunch: state.devices?.[serial]?.viewerLaunch || null });
    }
    const launchResult = await launchViewerForDevice(serial, user.username, "start-session");
    if (!launchResult.success) {
      return sendJson(res, 500, { error: launchResult.error || "Viewer launch failed; session not started", viewerLaunch: launchResult.viewerLaunch || null });
    }
    updateDeviceState(serial, { sessionState: "running", sessionStartedAt: new Date().toISOString() });
    logActivity("session", `Session started by ${user.username} and viewer launch confirmed`, serial);
    return sendJson(res, 200, { ok: true, viewerLaunch: launchResult.viewerLaunch });
  }

  if (action === "stop-session") {
    const viewerPid = state.devices?.[serial]?.viewerLaunch?.pid;
    const stopArgs = ["-Serial", serial];
    if (viewerPid) {
      stopArgs.push("-Pid", String(viewerPid));
    }
    runPowerShellScript("stop-scrcpy-for-device.ps1", stopArgs, { detached: true, windowsHide: false });
    updateDeviceState(serial, { sessionState: "stopped", sessionStoppedAt: new Date().toISOString() });
    logActivity("session", `Session stopped by ${user.username} and scrcpy close requested`, serial);
    return sendJson(res, 200, { ok: true });
  }

  if (action === "prep") {
    if (!knownDevice.serial) {
      return sendJson(res, 404, { error: "Unknown device serial" });
    }
    if (routingGuard.blocked) {
      return sendJson(res, 409, { error: `Prep blocked: ${routingGuard.reasons.join(" | ")}`, routingGuard });
    }
    if ((state.queue || []).includes(serial) || preparingSerial === serial) {
      return sendJson(res, 409, { error: "Device already queued or preparing" });
    }
    state.queue = [...(state.queue || []), serial];
    updateDeviceState(serial, {
      prepState: "queued",
      prepMessage: "Queued for prep",
      prepEnqueuedAt: new Date().toISOString()
    });
    logActivity("queue", `Device added to prep queue by ${user.username}`, serial);
    processPrepQueue();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 400, { error: `Unsupported action: ${action}` });
}

function buildMissingDevice(serial) {
  const existingPublicIp = state.devices?.[serial]?.publicIp || {
    currentIp: "",
    lastCheckedAt: "",
    status: "unknown",
    source: "",
    changedSinceLastPrep: false,
    duplicateWith: [],
    reusedRecently: false,
    reusedWithinLast100: [],
    last100History: [],
    lastError: "",
    lastReason: ""
  };
  const deviceConfig = getDeviceConfig(serial);
  return {
    serial,
    adbState: "unknown",
    online: false,
    model: "",
    product: "",
    transportId: "",
    nickname: deviceConfig.nickname || "",
    phoneNumber: deviceConfig.phoneNumber || null,
    role: deviceConfig.role || "sim-direct",
    parentHotspotSerial: deviceConfig.parentHotspotSerial || "",
    network: state.devices?.[serial]?.network || {
      ipAddress: "",
      interface: "",
      source: "",
      status: "unknown",
      checkedAt: ""
    },
      publicIp: existingPublicIp,
      account: state.devices?.[serial]?.account || {
        gmail: "",
        status: "unknown",
        checkedAt: ""
      },
      prepState: state.devices?.[serial]?.prepState || "idle",
    prepEnqueuedAt: state.devices?.[serial]?.prepEnqueuedAt || "",
    prepStartedAt: state.devices?.[serial]?.prepStartedAt || "",
    prepFinishedAt: state.devices?.[serial]?.prepFinishedAt || "",
    lastPrepDurationMs: state.devices?.[serial]?.lastPrepDurationMs || 0,
    prepMessage: state.devices?.[serial]?.prepMessage || "",
    sessionState: state.devices?.[serial]?.sessionState || "stopped",
    viewerLaunch: state.devices?.[serial]?.viewerLaunch || {
      status: "unknown",
      sourceAction: "",
      requestedAt: "",
      confirmedAt: "",
      pid: null,
      processName: "",
      filePath: "",
      aliveAfterLaunch: false,
      windowReady: false,
      fallbackViewer: "",
      manualSelectionRequired: false,
      lastError: ""
    }
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
  const shouldRefreshAccounts = Date.now() - lastAccountRefreshAt >= 30000;

  for (const row of rows) {
    const stored = state.devices[row.serial] || {};
    const metadata = ensureDeviceNumberAssignment(row.serial);
    const network = shouldRefreshNetwork
      ? queryDeviceNetwork(row.serial, row.state === "device")
      : (stored.network || previous[row.serial]?.network || {
          ipAddress: "",
          interface: "",
          source: "",
          status: row.state === "device" ? "pending" : "offline",
          checkedAt: ""
        });
    const account = shouldRefreshAccounts
      ? queryDeviceGoogleAccount(row.serial, row.state === "device")
      : (stored.account || previous[row.serial]?.account || {
          gmail: "",
          status: row.state === "device" ? "unknown" : "offline",
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
      nickname: metadata.nickname || "",
      phoneNumber: metadata.phoneNumber || null,
      role: metadata.role || "sim-direct",
      parentHotspotSerial: metadata.parentHotspotSerial || "",
      network,
      account,
      publicIp: stored.publicIp || previous[row.serial]?.publicIp || buildMissingDevice(row.serial).publicIp,
      prepState: stored.prepState || "idle",
      prepEnqueuedAt: stored.prepEnqueuedAt || "",
      prepStartedAt: stored.prepStartedAt || "",
      prepFinishedAt: stored.prepFinishedAt || "",
      lastPrepDurationMs: stored.lastPrepDurationMs || 0,
      prepMessage: stored.prepMessage || "",
      sessionState: stored.sessionState || "stopped",
      sessionStartedAt: stored.sessionStartedAt || "",
      sessionStoppedAt: stored.sessionStoppedAt || "",
      viewerLaunch: stored.viewerLaunch || buildMissingDevice(row.serial).viewerLaunch,
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
      preserved.publicIp = state.devices?.[serial]?.publicIp || previous[serial]?.publicIp || preserved.publicIp;
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
  if (shouldRefreshAccounts) {
    lastAccountRefreshAt = Date.now();
  }
}

function applyDuplicateFlags(devices) {
  const counts = new Map();
  for (const device of devices) {
    const ip = device.publicIp?.currentIp;
    if (!ip) continue;
    counts.set(ip, (counts.get(ip) || 0) + 1);
  }

  return devices.map(device => {
    const ip = device.publicIp?.currentIp || "";
    const duplicate = ip && (counts.get(ip) || 0) > 1;
    return {
      ...device,
      publicIp: {
        ...(device.publicIp || {}),
        duplicateWith: duplicate
          ? devices.filter(other => other.serial !== device.serial && other.publicIp?.currentIp === ip).map(other => other.serial)
          : [],
        status: duplicate && (device.publicIp?.status === "verified" || device.publicIp?.status === "changed")
          ? "duplicate"
          : (device.publicIp?.status || "unknown")
      }
    };
  });
}

function getRecentSuccessfulIpEntries(limit) {
  const entries = [];
  for (const [serial, history] of Object.entries(deviceIpHistory.devices || {})) {
    for (const entry of history.entries || []) {
      if (!entry.ip) continue;
      if (entry.status === "failed") continue;
      entries.push({
        serial,
        ip: entry.ip,
        timestamp: entry.timestamp || "",
        reason: entry.reason || "",
        source: entry.source || ""
      });
    }
  }

  entries.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
  return entries.slice(0, limit);
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

function queryDeviceGoogleAccount(serial, online) {
  const checkedAt = new Date().toISOString();
  if (!online) {
    return {
      gmail: "",
      status: "offline",
      checkedAt
    };
  }

  const result = spawnSync(settings.adbPath || "adb", ["-s", serial, "shell", "dumpsys", "account"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: 8000
  });

  if (result.error || result.status !== 0) {
    return {
      gmail: "",
      status: "unavailable",
      checkedAt
    };
  }

  const output = String(result.stdout || "");
  const match = output.match(/Account\s+\{name=([^,]+),\s*type=com\.google\}/i);
  if (match) {
    return {
      gmail: match[1].trim(),
      status: "assigned",
      checkedAt
    };
  }

  return {
    gmail: "",
    status: "unassigned",
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

async function runDevicePublicIpCheck(serial, reason) {
  if (ipCheckPromises.has(serial)) {
    return ipCheckPromises.get(serial);
  }

  const promise = Promise.resolve().then(() => performDevicePublicIpCheck(serial, reason));
  ipCheckPromises.set(serial, promise);
  try {
    return await promise;
  } finally {
    ipCheckPromises.delete(serial);
  }
}

function performDevicePublicIpCheck(serial, reason) {
  const startedAt = new Date().toISOString();
  const deviceState = state.devices?.[serial] || {};
  const history = ensureDeviceIpHistory(serial);
  const helperResult = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(SCRIPTS_DIR, "check-device-ip.ps1"),
    "-Serial",
    serial,
    "-SettingsPath",
    SETTINGS_PATH
  ], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
      timeout: 70000
    });

  let helperPayload = null;
  let resolvedIp = "";
  let resolvedSource = "";
  let failure = "";
  try {
    helperPayload = JSON.parse(String(helperResult.stdout || "{}").trim() || "{}");
  } catch (error) {
    helperPayload = null;
  }

  if (helperPayload?.success) {
    resolvedIp = helperPayload.ip || "";
    resolvedSource = helperPayload.source || "";
  } else {
    failure = helperPayload?.error || helperResult.error?.message || String(helperResult.stderr || helperResult.stdout || "").trim() || "No device-side IP method succeeded.";
  }

  const checkedAt = new Date().toISOString();
  if (!resolvedIp) {
    const failedState = {
      currentIp: deviceState.publicIp?.currentIp || "",
      lastCheckedAt: checkedAt,
      status: "failed",
      source: resolvedSource,
      changedSinceLastPrep: Boolean(deviceState.publicIp?.changedSinceLastPrep),
      duplicateWith: [],
      reusedRecently: Boolean(deviceState.publicIp?.reusedRecently),
      reusedWithinLast100: deviceState.publicIp?.reusedWithinLast100 || deviceState.publicIp?.reusedWithinLast50 || [],
      last100History: deviceState.publicIp?.last100History || deviceState.publicIp?.last50History || [],
      lastError: failure || "Public IP lookup failed on device side.",
      lastReason: reason
    };
    updateDeviceState(serial, { publicIp: failedState });
    history.entries = [
      {
        timestamp: checkedAt,
        ip: "",
        reason,
        source: resolvedSource,
        status: "failed",
        error: failedState.lastError
      },
      ...(history.entries || [])
    ].slice(0, 100);
    saveDeviceIpHistory();
    logIpCheck(`FAILED reason=${reason} error=${failedState.lastError}`, serial);
    logActivity("ip-check", `Public IP check failed: ${failedState.lastError}`, serial);
    return { success: false, error: failedState.lastError, publicIp: failedState };
  }

  const previousSuccessfulPrepIp = history.lastSuccessfulPrepIp || "";
  const changedSinceLastPrep = Boolean(previousSuccessfulPrepIp && previousSuccessfulPrepIp !== resolvedIp);
  let status = changedSinceLastPrep ? "changed" : "verified";
  const currentOtherDevices = Object.values(deviceCache).filter(device => device.serial !== serial);
  const duplicateWith = currentOtherDevices
    .filter(device => device.publicIp?.currentIp && device.publicIp.currentIp === resolvedIp)
    .map(device => device.serial);
  const recentSuccessfulEntries = getRecentSuccessfulIpEntries(100);
  const reusedWithinLast100 = recentSuccessfulEntries
    .filter(entry => entry.ip === resolvedIp && entry.serial !== serial)
    .slice(0, 10);
  const reusedRecently = reusedWithinLast100.length > 0;
  if (duplicateWith.length) {
    status = "duplicate";
  }

  const publicIpState = {
    currentIp: resolvedIp,
    lastCheckedAt: checkedAt,
    status,
    source: resolvedSource,
    changedSinceLastPrep,
    duplicateWith,
    reusedRecently,
    reusedWithinLast100,
    last100History: recentSuccessfulEntries,
    lastError: "",
    lastReason: reason
  };

  updateDeviceState(serial, { publicIp: publicIpState });

  history.entries = [
    {
      timestamp: checkedAt,
      ip: resolvedIp,
      reason,
      source: resolvedSource,
      status,
      changedSinceLastPrep,
      duplicateWith,
      reusedRecently
    },
    ...(history.entries || [])
  ].slice(0, 100);
  history.lastSuccessfulIp = resolvedIp;
  history.lastVerifiedAt = checkedAt;
  if (reason === "post-prep") {
    history.lastSuccessfulPrepIp = resolvedIp;
    history.lastSuccessfulPrepAt = checkedAt;
  }
  saveDeviceIpHistory();

  logIpCheck(`SUCCESS startedAt=${startedAt} reason=${reason} ip=${resolvedIp} status=${status} source=${resolvedSource}`, serial);
  logActivity("ip-check", `Public IP ${resolvedIp} verified via ${resolvedSource} (${status})`, serial);
  return { success: true, publicIp: publicIpState };
}

function ensureDeviceIpHistory(serial) {
  if (!deviceIpHistory.devices) {
    deviceIpHistory.devices = {};
  }
  if (!deviceIpHistory.devices[serial]) {
    deviceIpHistory.devices[serial] = {
      entries: [],
      lastSuccessfulIp: "",
      lastSuccessfulPrepIp: "",
      lastVerifiedAt: "",
      lastSuccessfulPrepAt: ""
    };
  }
  return deviceIpHistory.devices[serial];
}

function parsePublicIp(output) {
  const normalized = String(output || "").trim();
  const ipv4 = normalized.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  if (ipv4) return ipv4[0];
  const ipv6 = normalized.match(/\b(?:[a-fA-F0-9]{1,4}:){2,}[a-fA-F0-9]{1,4}\b/);
  if (ipv6) return ipv6[0];
  return "";
}

function processPrepQueue() {
  if (preparingSerial || !(state.queue || []).length) return;
  const serial = state.queue[0];
  const prepStartedAt = new Date().toISOString();
  preparingSerial = serial;
  state.queue = state.queue.slice(1);
  updateDeviceState(serial, {
    prepState: "preparing",
    prepMessage: "Prep workflow in progress",
    prepStartedAt,
    prepFinishedAt: ""
  });
  logActivity("queue", "Prep worker claimed queued device", serial);

  const child = runPowerShellScript(
    "prep-device-session.ps1",
    ["-Serial", serial, "-SettingsPath", SETTINGS_PATH, "-ActivityLogPath", ACTIVITY_LOG_PATH],
    { detached: false }
  );

  child.on("exit", code => {
    const success = code === 0;
    const prepFinishedAt = new Date().toISOString();
    const prepDurationMs = Math.max(0, new Date(prepFinishedAt).getTime() - new Date(prepStartedAt).getTime());
    updateDeviceState(serial, {
      prepState: success ? "ready" : "failed",
      prepMessage: success ? "Prep completed successfully" : "Prep failed; review logs",
      prepFinishedAt,
      lastPrepDurationMs: prepDurationMs
    });
    logActivity("queue", success ? `Prep completed in ${formatDuration(prepDurationMs)}` : `Prep failed with exit code ${code} after ${formatDuration(prepDurationMs)}`, serial);
    if (success) {
      runDevicePublicIpCheck(serial, "post-prep").catch(error => {
        logActivity("ip-check", `Automatic post-prep IP check failed: ${error.message}`, serial);
      });
    }
    preparingSerial = null;
    refreshDevices();
    processPrepQueue();
  });
}

function launchViewerForDevice(serial, username, sourceAction) {
  const requestedAt = new Date().toISOString();
  updateDeviceState(serial, {
    viewerLaunch: {
      status: "launching",
      sourceAction,
      requestedAt,
      confirmedAt: "",
      pid: null,
      processName: "",
      filePath: "",
      aliveAfterLaunch: false,
      windowReady: false,
      fallbackViewer: "",
      manualSelectionRequired: false,
      lastError: ""
    }
  });

  return new Promise(resolve => {
    const child = runPowerShellScript("open-scrcpy-for-device.ps1", ["-Serial", serial], { detached: false, windowsHide: false });
    let stdout = "";
    if (child.stdout) {
      child.stdout.on("data", chunk => {
        stdout += chunk.toString();
      });
    }

    child.on("error", error => {
      const message = error.message || "Viewer launch failed to start";
      const viewerLaunch = {
        status: "failed",
        sourceAction,
        requestedAt,
        confirmedAt: "",
        pid: null,
        processName: "",
        filePath: "",
        aliveAfterLaunch: false,
        windowReady: false,
        fallbackViewer: "",
        manualSelectionRequired: false,
        lastError: message
      };
      updateDeviceState(serial, { viewerLaunch });
      logActivity("scrcpy", `Viewer launch failed for ${sourceAction}: ${message}`, serial);
      resolve({ success: false, error: message, viewerLaunch });
    });

    child.on("exit", code => {
      const payload = parseViewerLaunchPayload(stdout);
      if (code === 0 && payload?.ok) {
        const viewerLaunch = {
          status: payload.fallbackViewer ? "fallback" : (payload.windowReady ? "confirmed" : "unverified"),
          sourceAction,
          requestedAt,
          confirmedAt: payload.startedAt || new Date().toISOString(),
          pid: payload.pid || null,
          processName: payload.processName || "",
          filePath: payload.filePath || "",
          aliveAfterLaunch: Boolean(payload.aliveAfterLaunch),
          windowReady: Boolean(payload.windowReady),
          fallbackViewer: payload.fallbackViewer || "",
          manualSelectionRequired: Boolean(payload.manualSelectionRequired),
          lastError: payload.fallbackViewer ? (payload.scrcpyError || "") : ""
        };
        updateDeviceState(serial, { viewerLaunch });
        logActivity("scrcpy", `Viewer launch ${payload.fallbackViewer ? `fell back to ${payload.fallbackViewer}` : (payload.windowReady ? "confirmed" : "unverified")} for ${sourceAction} with PID ${payload.pid || "unknown"} by ${username}`, serial);
        resolve({ success: true, viewerLaunch, payload });
        return;
      }

      const errorMessage = payload?.error || `Viewer launch script exited with code ${code}`;
      const viewerLaunch = {
        status: "failed",
        sourceAction,
        requestedAt,
        confirmedAt: "",
        pid: null,
        processName: "",
        filePath: payload?.filePath || "",
        aliveAfterLaunch: false,
        windowReady: false,
        fallbackViewer: "",
        manualSelectionRequired: false,
        lastError: errorMessage
      };
      updateDeviceState(serial, { viewerLaunch });
      logActivity("scrcpy", `Viewer launch failed for ${sourceAction}: ${errorMessage}`, serial);
      resolve({ success: false, error: errorMessage, viewerLaunch, payload });
    });
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

function buildPrepTelemetry(devices) {
  const active = devices.find(device => device.serial === preparingSerial) || null;
  const completed = devices
    .filter(device => device.prepFinishedAt)
    .sort((a, b) => new Date(b.prepFinishedAt).getTime() - new Date(a.prepFinishedAt).getTime())[0] || null;
  return {
    active: active ? {
      serial: active.serial,
      label: formatDeviceLabel(active),
      startedAt: active.prepStartedAt || "",
      elapsedMs: getActivePrepElapsedMs(active),
      queueDepthBehind: (state.queue || []).length
    } : null,
    lastCompleted: completed ? {
      serial: completed.serial,
      label: formatDeviceLabel(completed),
      finishedAt: completed.prepFinishedAt || "",
      durationMs: completed.lastPrepDurationMs || 0,
      prepState: completed.prepState || "idle"
    } : null
  };
}

function enrichDeviceForStatus(device, routingAudit) {
  const normalizedPublicIp = normalizePublicIpState(device.serial, device.publicIp);
  return {
    ...device,
    publicIp: normalizedPublicIp,
    prepElapsedMs: getActivePrepElapsedMs(device),
    queueWaitMs: getQueueWaitMs(device),
    routingRisk: getDeviceRoutingRisk({ ...device, publicIp: normalizedPublicIp }, routingAudit)
  };
}

function getActivePrepElapsedMs(device) {
  if (device.prepState !== "preparing" || !device.prepStartedAt) {
    return 0;
  }
  return Math.max(0, Date.now() - new Date(device.prepStartedAt).getTime());
}

function getQueueWaitMs(device) {
  if (device.prepState !== "queued" || !device.prepEnqueuedAt) {
    return 0;
  }
  return Math.max(0, Date.now() - new Date(device.prepEnqueuedAt).getTime());
}

function buildRoutingGuard(routingAudit) {
  const hardBlockChecks = new Set([
    "PhoneFarm Bind Mode",
    "Tailscale Exit Node",
    "Internet Connection Sharing",
    "WinHTTP Proxy",
    "Windows User Proxy",
    "IPv4 Forwarding"
  ]);
  const failedChecks = (routingAudit.checks || []).filter(check => {
    if (check.ok || !hardBlockChecks.has(check.name)) {
      return false;
    }
    const detail = String(check.detail || "").toLowerCase();
    if (check.name === "PhoneFarm Bind Mode") {
      return !detail.includes("127.0.0.1");
    }
    if (check.name === "Tailscale Exit Node") {
      return detail.includes("configured as an exit node");
    }
    if (check.name === "Internet Connection Sharing") {
      return detail.includes("running");
    }
    if (check.name === "WinHTTP Proxy") {
      return !detail.includes("direct access");
    }
    if (check.name === "Windows User Proxy") {
      return detail.includes("proxy enabled");
    }
    if (check.name === "IPv4 Forwarding") {
      return detail.includes("enabled via ipenablerouter");
    }
    return false;
  });
  const pcPublicIpCheck = (routingAudit.checks || []).find(check => check.name === "PC Public IP");
  return {
    blocked: failedChecks.length > 0,
    reasons: failedChecks.map(check => `${check.name}: ${check.detail}`),
    checkedAt: routingAudit.checkedAt || "",
    pcPublicIp: extractPcPublicIp(pcPublicIpCheck?.detail || ""),
    dashboardAccessPath: routingAudit.dashboardAccessPath || "",
    deviceTrafficPath: routingAudit.deviceTrafficPath || ""
  };
}

function normalizePublicIpState(serial, publicIp) {
  const historyEntries = (ensureDeviceIpHistory(serial).entries || []).filter(entry => entry.ip).slice(0, 100);
  const normalizedHistory = publicIp?.last100History || publicIp?.last50History || historyEntries;
  const crossDeviceReuse = normalizedHistory
    .filter(entry => entry.ip && entry.ip === publicIp?.currentIp && entry.serial && entry.serial !== serial)
    .slice(0, 10);
  return {
    ...(publicIp || {}),
    reusedRecently: crossDeviceReuse.length > 0,
    reusedWithinLast100: crossDeviceReuse,
    last100History: normalizedHistory
  };
}

function getDeviceRoutingRisk(device, routingAudit) {
  const routingGuard = buildRoutingGuard(routingAudit);
  const interfaceName = String(device.network?.interface || "").toLowerCase();
  if (interfaceName === "lo" || interfaceName === "loopback") {
    return {
      level: "critical",
      label: "Loopback Route",
      detail: "Device network reports a loopback interface. That is not a valid direct data path."
    };
  }

  if (routingGuard.pcPublicIp && device.publicIp?.currentIp && device.publicIp.currentIp === routingGuard.pcPublicIp) {
    return {
      level: "warning",
      label: "Shared Egress",
      detail: "Phone public IP matches the PC public IP. Verify the phone is not leaving through the PC."
    };
  }

  if (routingGuard.blocked) {
    return {
      level: "warning",
      label: "PC Guard Failed",
      detail: "PC routing guardrails are not fully clean. Prep and session starts are blocked until fixed."
    };
  }

  if (!device.publicIp?.currentIp) {
    return {
      level: "neutral",
      label: "Unverified",
      detail: "No phone-side public IP verification yet."
    };
  }

  return {
    level: "safe",
    label: "Separated",
    detail: "No direct sign that this phone is routing through the PC."
  };
}

function extractPcPublicIp(detail) {
  return parsePublicIp(detail || "");
}

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round((durationMs || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatDeviceLabel(device) {
  return device.nickname || (device.phoneNumber ? formatPhoneNumber(device.phoneNumber) : device.serial);
}

function parseViewerLaunchPayload(stdout) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) return null;
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch (error) {
      // Keep scanning for the last JSON line from the PowerShell launcher.
    }
  }
  return null;
}

function runPowerShellScript(scriptName, scriptArgs = [], options) {
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  const argsDescription = scriptArgs.length ? ` ${scriptArgs.join(" ")}` : "";
  logActivity("system", `Running PowerShell script ${scriptName}${argsDescription}`);
  const psArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...scriptArgs];
  const child = spawn("powershell.exe", psArgs, {
    cwd: ROOT,
    windowsHide: options?.windowsHide ?? true,
    detached: Boolean(options?.detached),
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.on("error", error => {
    logActivity("system", `PowerShell ${scriptName} failed to start: ${error.message}`);
  });

  child.on("exit", code => {
    if (code !== 0) {
      logActivity("system", `PowerShell ${scriptName} exited with code ${code}`);
    }
  });

  if (child.stderr) {
    child.stderr.on("data", chunk => {
      const message = chunk.toString().trim();
      if (message) {
        logActivity("system", `PowerShell ${scriptName} stderr: ${message}`);
      }
    });
  }

  if (options?.detached) {
    child.unref();
  }

  return child;
}
