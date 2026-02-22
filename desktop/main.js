const { app, BrowserWindow, shell } = require("electron");
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

async function startDaemon() {
  const port = 18789;
  try {
    await waitForHealth(port, 2);
    console.log("Daemon already running on port", port);
    return;
  } catch (_) {}

  const bin = resolveDaemonBinary();
  console.log("Starting daemon:", bin);

  daemon = spawn(bin, ["start", "--host", "127.0.0.1", "--port", "18789"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  daemon.stderr.on("data", (d) => console.error("daemon:", d.toString()));
  daemon.on("error", (err) => {
    console.error("Failed to spawn daemon:", err.message);
  });
  daemon.on("exit", (code, signal) => {
    console.error("Daemon exited:", { code, signal });
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

app.whenReady().then(async () => {
  try {
    await startDaemon();
  } catch (err) {
    console.error("Daemon startup failed:", err.message);
  }
  createWindow();
  initAutoUpdater();
});

app.on("window-all-closed", () => {
  if (daemon) daemon.kill();
  if (process.platform !== "darwin") app.quit();
});
