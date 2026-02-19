const { app, BrowserWindow } = require("electron");
const path = require("path");
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

async function startDaemon() {
  const port = 18789;
  try {
    await waitForHealth(port, 2);
    return;
  } catch (_) {}
  const cmd = process.platform === "win32" ? "rovot.exe" : "rovot";
  daemon = spawn(cmd, ["start", "--host", "127.0.0.1", "--port", String(port)], {
    stdio: "ignore",
  });
  await waitForHealth(port);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(async () => {
  await startDaemon();
  createWindow();
});

app.on("window-all-closed", () => {
  if (daemon) daemon.kill();
  if (process.platform !== "darwin") app.quit();
});
