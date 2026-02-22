const { contextBridge, ipcRenderer } = require("electron");
const os = require("os");
const path = require("path");
const fs = require("fs");

function tokenFile() {
  return path.join(os.homedir(), ".rovot", "auth_token.txt");
}

contextBridge.exposeInMainWorld("rovot", {
  readToken: () => {
    try {
      return fs.readFileSync(tokenFile(), "utf-8").trim();
    } catch (e) {
      return "";
    }
  },
  baseUrl: () => "http://127.0.0.1:18789",
  getDaemonError: () => ipcRenderer.invoke("get-daemon-error"),
});
