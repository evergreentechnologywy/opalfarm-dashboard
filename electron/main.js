const { app, BrowserWindow, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");

const START_TIMEOUT_MS = 25000;
const DEFAULT_WORKSPACE_ROOT = "C:\\PhoneFarm";

let mainWindow = null;
let serverProcess = null;
let serverOwnedByDesktop = false;

function pathExists(targetPath) {
  try {
    return fs.existsSync(targetPath);
  } catch (error) {
    return false;
  }
}

function resolveWorkspaceRoot() {
  const candidates = [
    process.env.PHONEFARM_ROOT,
    DEFAULT_WORKSPACE_ROOT,
    path.join(__dirname, "..")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (pathExists(path.join(candidate, "server.js")) && pathExists(path.join(candidate, "config", "settings.json"))) {
      return candidate;
    }
  }

  throw new Error("PhoneFarm workspace was not found. Expected C:\\PhoneFarm or PHONEFARM_ROOT.");
}

function getWorkspaceContext() {
  const root = resolveWorkspaceRoot();
  const settingsPath = path.join(root, "config", "settings.json");
  let settings = { host: "127.0.0.1", port: 7780, nodePath: "" };

  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsPath, "utf8")) };
  } catch (error) {
    // Keep defaults when settings are not readable.
  }

  return {
    root,
    settingsPath,
    settings,
    baseUrl: `http://${settings.host || "127.0.0.1"}:${Number(settings.port) || 7780}`,
    serverScript: path.join(root, "server.js")
  };
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

function resolveNodeCommand(settings) {
  const candidates = [
    process.env.PHONEFARM_NODE_PATH,
    settings.nodePath,
    "C:\\Program Files\\nodejs\\node.exe",
    "node"
  ].filter(Boolean);

  return candidates[0];
}

async function ensureServer(context) {
  if (await checkServer(context.baseUrl)) {
    return context.baseUrl;
  }

  const nodeCommand = resolveNodeCommand(context.settings);
  serverProcess = spawn(nodeCommand, [context.serverScript], {
    cwd: context.root,
    windowsHide: false,
    stdio: "ignore"
  });
  serverOwnedByDesktop = true;

  serverProcess.on("exit", () => {
    serverProcess = null;
  });

  serverProcess.on("error", error => {
    dialog.showErrorBox("PhoneFarm Server Start Failed", error.message);
  });

  await waitForServer(context.baseUrl, START_TIMEOUT_MS);
  return context.baseUrl;
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
    const context = getWorkspaceContext();
    const baseUrl = await ensureServer(context);
    createWindow(baseUrl);
  } catch (error) {
    dialog.showErrorBox("PhoneFarm Startup Failed", error.message);
    app.quit();
  }
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.whenReady().then(bootstrap);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    try {
      const context = getWorkspaceContext();
      createWindow(context.baseUrl);
    } catch (error) {
      dialog.showErrorBox("PhoneFarm Activate Failed", error.message);
    }
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
