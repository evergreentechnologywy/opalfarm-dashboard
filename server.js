const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { URL } = require("url");

const ROOT = __dirname;
const CONFIG_DIR = path.join(ROOT, "config");
const LOG_DIR = path.join(ROOT, "logs");
const WEB_DIR = path.join(ROOT, "web");
const SCRIPTS_DIR = path.join(ROOT, "scripts");
const SETTINGS_PATH = path.join(CONFIG_DIR, "settings.json");
const STATE_PATH = path.join(CONFIG_DIR, "state.json");
const ACTIVITY_LOG_PATH = path.join(LOG_DIR, "activity.log");
const PID_PATH = path.join(ROOT, "phonefarm.pid");

const DEFAULT_SETTINGS = {
  host: "127.0.0.1",
  port: 7780,
  adbPath: "adb",
  scrcpyPath: "scrcpy",
  pollIntervalMs: 5000,
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

let settings = loadJson(SETTINGS_PATH, DEFAULT_SETTINGS);
let state = loadJson(STATE_PATH, DEFAULT_STATE);
let preparingSerial = null;
let deviceCache = {};
const missingTools = new Set();

ensureDirectories();
writeJsonIfMissing(SETTINGS_PATH, settings);
writeJsonIfMissing(STATE_PATH, state);
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
setInterval(refreshDevices, settings.pollIntervalMs || 5000);
setInterval(trimRecentActivity, 10000);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

    if (req.method === "GET" && url.pathname === "/api/status") {
      return sendJson(res, 200, buildStatus());
    }

    if (req.method === "GET" && url.pathname === "/api/logs/recent") {
      return sendJson(res, 200, { recentActivity: state.recentActivity || [] });
    }

    if (req.method === "POST" && url.pathname === "/api/config/reload") {
      settings = loadJson(SETTINGS_PATH, DEFAULT_SETTINGS);
      logActivity("system", "Configuration reloaded");
      return sendJson(res, 200, { ok: true, settings });
    }

    const match = url.pathname.match(/^\/api\/devices\/([^/]+)\/([^/]+)$/);
    if (req.method === "POST" && match) {
      const serial = decodeURIComponent(match[1]);
      const action = match[2];
      const body = await readJsonBody(req);
      return handleDeviceAction(res, serial, action, body);
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

function buildStatus() {
  return {
    ok: true,
    settings: {
      host: settings.host,
      port: settings.port,
      pollIntervalMs: settings.pollIntervalMs,
      prep: settings.prep
    },
    queue: state.queue || [],
    preparingSerial,
    devices: Object.values(deviceCache).sort((a, b) => a.serial.localeCompare(b.serial)),
    recentActivity: state.recentActivity || []
  };
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
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

  const contentType = getContentType(filePath);
  res.writeHead(200, { "Content-Type": contentType });
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

function handleDeviceAction(res, serial, action, body) {
  const knownDevice = deviceCache[serial] || buildMissingDevice(serial);

  if (action === "metadata") {
    settings.deviceMetadata[serial] = {
      ...(settings.deviceMetadata[serial] || {}),
      sim: String(body.sim || "").trim(),
      proxy: String(body.proxy || "").trim()
    };
    saveSettings();
    refreshDevices();
    logActivity("metadata", "SIM/proxy metadata updated", serial);
    return sendJson(res, 200, { ok: true });
  }

  if (action === "open-control") {
    runPowerShellScript("open-scrcpy-for-device.ps1", ["-Serial", serial], { detached: true });
    logActivity("scrcpy", "Open Control requested", serial);
    return sendJson(res, 200, { ok: true });
  }

  if (action === "start-session") {
    updateDeviceState(serial, { sessionState: "running", sessionStartedAt: new Date().toISOString() });
    logActivity("session", "Session started", serial);
    return sendJson(res, 200, { ok: true });
  }

  if (action === "stop-session") {
    updateDeviceState(serial, { sessionState: "stopped", sessionStoppedAt: new Date().toISOString() });
    logActivity("session", "Session stopped", serial);
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
    logActivity("queue", "Device added to prep queue", serial);
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

  for (const row of rows) {
    const stored = state.devices[row.serial] || {};
    const metadata = settings.deviceMetadata[row.serial] || {};
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
      next[serial] = preserved;
      if (previous[serial].online) {
        logActivity("disconnect", "Device disconnected from ADB", serial);
      }
    }
  }

  deviceCache = next;
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
  if (parts.length < 2) {
    return null;
  }

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

function processPrepQueue() {
  if (preparingSerial || !(state.queue || []).length) {
    return;
  }

  const serial = state.queue[0];
  preparingSerial = serial;
  state.queue = state.queue.slice(1);
  updateDeviceState(serial, { prepState: "preparing", prepMessage: "Prep workflow in progress" });
  logActivity("queue", "Prep worker claimed queued device", serial);

  const child = runPowerShellScript(
    "prep-device-session.ps1",
    [
      "-Serial",
      serial,
      "-SettingsPath",
      SETTINGS_PATH,
      "-ActivityLogPath",
      ACTIVITY_LOG_PATH
    ],
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
