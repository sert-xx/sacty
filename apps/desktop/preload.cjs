const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktop", {
  settings: () => ipcRenderer.invoke("desktop:settings"),
  language: (value) => ipcRenderer.invoke("desktop:language", value),
  start: () => ipcRenderer.invoke("desktop:start"),
  saveKey: (value) => ipcRenderer.invoke("desktop:secret", value),
  help: () => ipcRenderer.invoke("desktop:help"),
  onProgress: (callback) => {
    ipcRenderer.on("desktop:progress", (_event, message) => callback(message));
  },
});
