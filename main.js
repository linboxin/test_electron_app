const { app, BrowserWindow, ipcMain, dialog, clipboard, Notification, shell } = require('electron');
const path = require('path');
const { attachAcp } = require('@appcontextprotocol/app-sdk/electron');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Computer-Use Test Bench',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('app:info', () => ({
  appVersion: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform
}));

ipcMain.handle('dialog:message', async (event, { type, title, message }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showMessageBox(win, {
    type: type || 'info',
    title: title || 'Message',
    message: message || '',
    buttons: ['OK', 'Cancel']
  });
  return result.response === 0 ? 'OK' : 'Cancel';
});

ipcMain.handle('dialog:openFile', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile']
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('clipboard:write', (event, text) => {
  clipboard.writeText(text);
  return true;
});

ipcMain.handle('clipboard:read', () => clipboard.readText());

ipcMain.handle('notification:show', (event, { title, body }) => {
  new Notification({ title, body }).show();
  return true;
});

ipcMain.handle('shell:openExternal', (event, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    shell.openExternal(url);
    return true;
  }
  return false;
});

app.whenReady().then(async () => {
  createWindow();

  const acp = await attachAcp({
    appId: 'com.linboxin.test-bench',
    name: 'Computer-Use Test Bench',
    version: app.getVersion()
  });

  acp.exposeState('app_info', { description: 'Runtime versions and platform' }, () => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform
  }));

  acp.action('show_notification', {
    description: 'Show a system notification',
    params: {
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'string' } },
      required: ['title', 'body']
    },
    handler: ({ title, body }) => {
      new Notification({ title, body }).show();
      return { shown: true };
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
