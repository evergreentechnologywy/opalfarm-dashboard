const { app, BrowserWindow, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SETTINGS_PATH = path.join(ROOT, "config", "settings.json");
const DEFAULT_URL = "http://127.0.0.1:7780";
const START_TIMEOUT_MS = 25000;

let mainWindow = null;
let serverProcess = null;
let serverOwnedByDesktop = false;

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  } catch (error) {
    return { host: "127.0.0.1", port: 7780 };
  }
}

function getBaseUrl() {
  const settings = loadSettings();
  const host = settings.host || "127.0.0.1";
  const port = Number(settings.port) || 7780;
  return `http://${host}:${port}`;
}

function checkServer(url) {
  return new Promise(resolve => {
    const req = http.get(`${url}/api/status`, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      if (await checkServer(url)) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`PhoneFarm server did not become ready at ${url} within ${timeoutMs}ms`));
        return;
      }
      setTimeout(poll, 500);
    };
    poll();
  });
}

async function ensureServer() {
  const baseUrl = getBaseUrl();
  if (await checkServer(baseUrl)) {
    return baseUrl;
  }

  const nodeExe = process.execPath.toLowerCase().includes("electron.exe")
    ? "node"
    : process.execPath;

  serverProcess = spawn(nodeExe, ["server.js"], {
    cwd: ROOT,
    windowsHide: false,
    stdio: "ignore"
  });
  serverOwnedByDesktop = true;

  serverProcess.on("exit", () => {
    serverProcess = null;
  });

  await waitForServer(baseUrl, START_TIMEOUT_MS);
  return baseUrl;
}

function createWindow(baseUrl) {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1280,
    minHeight: 820,
    title: "PhoneFarm",
    autoHideMenuBar: true,
    show: false,
    backgroundColor: "#f5f7fb",
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.loadURL(baseUrl);
}

async function bootstrap() {
  try {
    const baseUrl = await ensureServer();
    createWindow(baseUrl);
  } catch (error) {
    dialog.showErrorBox("PhoneFarm Startup Failed", error.message);
    app.quit();
  }
}

app.whenReady().then(bootstrap);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const baseUrl = getBaseUrl();
    createWindow(baseUrl);
  }
});

app.on("before-quit", () => {
  if (serverOwnedByDesktop && serverProcess) {
    try {
      serverProcess.kill();
    } catch (error) {
      // Ignore shutdown cleanup failures.
    }
  }
});
