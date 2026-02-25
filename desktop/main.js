const { app, BrowserWindow, shell, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, spawnSync } = require("child_process");
const http = require("http");

let daemon = null;
let daemonError = "";

function waitForHealth(port, attempts = 40) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tick = () => {
      n += 1;
      http
        .get(`http://127.0.0.1:${port}/health`, (res) => {
          if (res.statusCode === 200) return resolve();
          if (n >= attempts) return reject(new Error("health timeout"));
          setTimeout(tick, 250);
        })
        .on("error", () => {
          if (n >= attempts) return reject(new Error("health timeout"));
          setTimeout(tick, 250);
        });
    };
    tick();
  });
}

function resolveDaemonBinary() {
  if (app.isPackaged) {
    const ext = process.platform === "win32" ? ".exe" : "";
    const bundled = path.join(
      process.resourcesPath,
      "backend-bin",
      `rovot-daemon${ext}`
    );
    if (fs.existsSync(bundled)) return bundled;
  }
  return process.platform === "win32" ? "rovot.exe" : "rovot";
}

function validatePackagedBinary(bin) {
  if (!app.isPackaged) return;

  const remediation =
    "Rebuild the app so backend-bin/rovot-daemon is bundled (run npm run build:backend:mac before npm run dist:mac).";

  if (!fs.existsSync(bin)) {
    const msg = `Bundled backend binary not found at: ${bin}\n${remediation}`;
    daemonError += `${msg}\n`;
    throw new Error(msg);
  }

  try {
    fs.accessSync(bin, fs.constants.R_OK);
  } catch (err) {
    const msg = `Bundled backend binary is not readable: ${bin}\n${remediation}\nDetails: ${err.message}`;
    daemonError += `${msg}\n`;
    throw new Error(msg);
  }

  if (process.platform !== "win32") {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
    } catch (err) {
      const msg = `Bundled backend binary is not executable: ${bin}\n${remediation}\nDetails: ${err.message}`;
      daemonError += `${msg}\n`;
      throw new Error(msg);
    }
  }
}

function prepareBinary(bin) {
  if (process.platform === "darwin") {
    const xattr = spawnSync("xattr", ["-cr", bin]);
    console.log("xattr -cr exit:", xattr.status);
  }
  try {
    fs.chmodSync(bin, 0o755);
  } catch (e) {
    console.warn("chmod failed (read-only FS?):", e.message);
  }
}

async function startDaemon() {
  const port = 18789;
  try {
    await waitForHealth(port, 2);
    console.log("Daemon already running on port", port);
    return;
  } catch (_) {}

  const bin = resolveDaemonBinary();
  console.log("Starting daemon:", bin);

  validatePackagedBinary(bin);
  prepareBinary(bin);

  daemon = spawn(bin, ["start", "--host", "127.0.0.1", "--port", "18789"], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: os.homedir(),
  });

  daemon.stdout.on("data", (d) => console.log("daemon stdout:", d.toString()));
  daemon.stderr.on("data", (d) => {
    const msg = d.toString();
    console.error("daemon stderr:", msg);
    daemonError += msg;
  });
  daemon.on("error", (err) => {
    const msg = `Failed to spawn daemon (${bin}): ${err.message}`;
    console.error(msg);
    daemonError += `${msg}\n`;
  });
  daemon.on("exit", (code, signal) => {
    console.error("Daemon exited:", { code, signal });
    if (code !== 0 && code !== null) {
      daemonError += `Daemon exited with code ${code}\n`;
    }
  });

  await waitForHealth(port);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  win.webContents.on("will-navigate", (e, url) => {
    const appOrigin = `file://${path.join(__dirname, "renderer")}`;
    if (!url.startsWith(appOrigin) && !url.startsWith("file://")) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });
}

function initAutoUpdater() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = false;
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  } catch (_) {}
}

ipcMain.handle("get-daemon-error", () => daemonError);

app.whenReady().then(async () => {
  try {
    await startDaemon();
  } catch (err) {
    console.error("Daemon startup failed:", err.message);
    daemonError += `Startup failed: ${err.message}\n`;
  }
  createWindow();
  initAutoUpdater();
});

app.on("window-all-closed", () => {
  if (daemon) daemon.kill();
  if (process.platform !== "darwin") app.quit();
});
