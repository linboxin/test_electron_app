const { contextBridge, ipcRenderer } = require('electron');
const { exposeAcpBridge } = require('@appcontextprotocol/app-sdk/electron/preload');

exposeAcpBridge();

const api = {
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  showMessageBox: (opts) => ipcRenderer.invoke('dialog:message', opts),
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  showNotification: (opts) => ipcRenderer.invoke('notification:show', opts),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  ...(process.env.ACP_BENCHMARK === '1'
    ? { reportBenchmarkState: (snapshot) => ipcRenderer.send('benchmark:state', snapshot) }
    : {})
};

contextBridge.exposeInMainWorld('api', api);
