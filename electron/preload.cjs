const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cPlanner", {
  getInstalledVersion: () => ipcRenderer.invoke("app:get-version"),
  checkForUpdates: () => ipcRenderer.invoke("app:check-updates"),
  exportPdf: (payload) => ipcRenderer.invoke("app:export-pdf", payload),
  getStorageSnapshot: () => {
    const snapshot = {};
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key !== null) snapshot[key] = window.localStorage.getItem(key);
    }
    return snapshot;
  },
  onUpdateStatus: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on("app:update-status", listener);
    return () => ipcRenderer.removeListener("app:update-status", listener);
  },
});
