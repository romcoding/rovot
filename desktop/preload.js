const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rovot", {
  // Async: token is read once at startup by the main process and returned from
  // an in-memory cache.  Call this once at renderer init and cache the result
  // locally — do NOT call on every API request.
  getToken: () => ipcRenderer.invoke("get-token"),
  baseUrl: () => "http://127.0.0.1:18789",
  getDaemonError: () => ipcRenderer.invoke("get-daemon-error"),
  isPackaged: () => ipcRenderer.invoke("is-packaged"),
});
