const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const http = require("http");

let daemon = null;

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
    const bundled = path.join(process.resourcesPath, "backend-bin", `rovot-daemon${ext}`);
    if (fs.existsSync(bundled)) return bundled;
  }
  return process.platform === "win32" ? "rovot.exe" : "rovot";
}

function daemonArgs(binary) {
  const isBundle = path.basename(binary).startsWith("rovot-daemon");
  if (isBundle) return ["start", "--host", "127.0.0.1", "--port", "18789"];
  return ["start", "--host", "127.0.0.1", "--port", "18789"];
}

async function startDaemon() {
  const port = 18789;
  try {
    await waitForHealth(port, 2);
    return;
  } catch (_) {}
  const bin = resolveDaemonBinary();
  daemon = spawn(bin, daemonArgs(bin), { stdio: "ignore" });
  daemon.on("error", (err) => {
    console.error("Failed to start daemon:", err.message);
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
}

function initAutoUpdater() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = false;
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  } catch (_) {}
}

app.whenReady().then(async () => {
  await startDaemon();
  createWindow();
  initAutoUpdater();
});

app.on("window-all-closed", () => {
  if (daemon) daemon.kill();
  if (process.platform !== "darwin") app.quit();
});
