const { contextBridge, ipcRenderer } = require('electron');
const { exposeAcpBridge } = require('@appcontextprotocol/app-sdk/electron/preload');

exposeAcpBridge();

contextBridge.exposeInMainWorld('api', {
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  showMessageBox: (opts) => ipcRenderer.invoke('dialog:message', opts),
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  showNotification: (opts) => ipcRenderer.invoke('notification:show', opts),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url)
});
