const { app, BrowserWindow, ipcMain, dialog, clipboard, Menu, Notification, shell } = require('electron');
const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');
const { attachAcp } = require('@appcontextprotocol/app-sdk/electron');

const benchmarkMode = process.env.ACP_BENCHMARK === '1';
const benchmarkStateFile = benchmarkMode && process.env.ACP_BENCHMARK_STATE_FILE
  ? path.resolve(process.env.ACP_BENCHMARK_STATE_FILE)
  : null;
const benchmarkRendererUrl = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
let benchmarkRenderer = null;
let benchmarkRevision = 0;

if (benchmarkMode && process.env.ACP_BENCHMARK_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.ACP_BENCHMARK_USER_DATA_DIR));
}

function benchmarkNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function createWindow() {
  const windowBounds = benchmarkMode
    ? {
        x: benchmarkNumber('ACP_BENCHMARK_WINDOW_X', 100),
        y: benchmarkNumber('ACP_BENCHMARK_WINDOW_Y', 80),
        width: benchmarkNumber('ACP_BENCHMARK_WINDOW_WIDTH', 1200),
        height: benchmarkNumber('ACP_BENCHMARK_WINDOW_HEIGHT', 800)
      }
    : { width: 1200, height: 800 };
  const win = new BrowserWindow({
    ...windowBounds,
    minWidth: 900,
    minHeight: 600,
    title: 'Computer-Use Test Bench',
    show: !(benchmarkMode && process.env.ACP_TEST_HEADLESS === '1'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: !benchmarkMode,
      backgroundThrottling: !benchmarkMode
    }
  });

  if (benchmarkMode) {
    // BrowserWindow.webContents throws after the native window has been
    // destroyed. Retain the original object so the later `closed` callback can
    // clear only the renderer that belonged to this window.
    const rendererContents = win.webContents;
    benchmarkRenderer = rendererContents;
    benchmarkRevision = 0;
    win.removeMenu();
    win.setMenuBarVisibility(false);
    rendererContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const eventName of ['will-navigate', 'will-redirect']) {
      rendererContents.on(eventName, (event) => event.preventDefault());
    }
    rendererContents.on('before-input-event', (event, input) => {
      const key = String(input.key ?? '').toLowerCase();
      const modifier = input.control || input.meta;
      const developerShortcut = input.key === 'F12'
        || (modifier && input.shift && ['i', 'j', 'c'].includes(key))
        || (input.meta && input.alt && ['i', 'j', 'c'].includes(key));
      const reloadOrClose = input.key === 'F5' || (modifier && ['r', 'w'].includes(key));
      if (developerShortcut || reloadOrClose) event.preventDefault();
    });
    win.on('closed', () => {
      if (benchmarkRenderer === rendererContents) benchmarkRenderer = null;
    });
  }

  const loadOptions = benchmarkMode
    ? {
        query: {
          benchmark: '1',
          fixture: process.env.ACP_BENCHMARK_FIXTURE || 'canonical-v1',
          renderDelayMs: String(benchmarkNumber('ACP_BENCHMARK_RENDER_DELAY_MS', 0))
        }
      }
    : undefined;
  void win.loadFile(path.join(__dirname, 'renderer', 'index.html'), loadOptions);
  return win;
}

let pendingBenchmarkSnapshot = null;
let benchmarkWriteInFlight = false;

async function flushBenchmarkSnapshots() {
  if (benchmarkWriteInFlight || !benchmarkStateFile) return;
  benchmarkWriteInFlight = true;
  try {
    await fs.mkdir(path.dirname(benchmarkStateFile), { recursive: true, mode: 0o700 });
    while (pendingBenchmarkSnapshot) {
      const snapshot = pendingBenchmarkSnapshot;
      pendingBenchmarkSnapshot = null;
      const temporaryFile = `${benchmarkStateFile}.${process.pid}.tmp`;
      await fs.writeFile(temporaryFile, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporaryFile, benchmarkStateFile);
      await fs.chmod(benchmarkStateFile, 0o600);
    }
  } catch (error) {
    console.error('Failed to write benchmark state:', error);
    pendingBenchmarkSnapshot = null;
    // A stale evaluator snapshot would misclassify an app/storage failure as an
    // agent timeout. Exiting makes the harness record infrastructure_failure.
    if (benchmarkMode) {
      // Electron normally exits synchronously here, but native shutdown can
      // stall behind an in-flight renderer bridge request. This process exists
      // only for one benchmark trial, so force the documented infrastructure
      // exit if graceful Electron shutdown has not completed promptly.
      setTimeout(() => process.exit(70), 250);
      app.exit(70);
    }
  } finally {
    benchmarkWriteInFlight = false;
    if (pendingBenchmarkSnapshot) void flushBenchmarkSnapshots();
  }
}

ipcMain.on('benchmark:state', (event, snapshot) => {
  if (
    !benchmarkStateFile
    || !benchmarkRenderer
    || event.sender !== benchmarkRenderer
    || event.senderFrame !== benchmarkRenderer.mainFrame
    || !event.senderFrame.url.startsWith(benchmarkRendererUrl)
    || !snapshot
    || typeof snapshot !== 'object'
    || Array.isArray(snapshot)
    || snapshot.schemaVersion !== 1
    || snapshot.fixture !== (process.env.ACP_BENCHMARK_FIXTURE || 'canonical-v1')
    || !Number.isSafeInteger(snapshot.revision)
    || snapshot.revision <= benchmarkRevision
  ) return;
  let serialized;
  try {
    serialized = JSON.stringify(snapshot);
  } catch {
    return;
  }
  if (Buffer.byteLength(serialized, 'utf8') > 1024 * 1024) return;
  benchmarkRevision = snapshot.revision;
  // Collapse a burst of UI updates to the latest canonical state. This keeps
  // per-keystroke UI snapshots from creating evaluator lag that ACP calls do
  // not incur, while retaining an atomic on-disk evaluator boundary.
  pendingBenchmarkSnapshot = snapshot;
  void flushBenchmarkSnapshots();
});

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

async function setupAcp() {
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

  acp.event('activity.logged', { description: 'A user-visible activity was recorded' });

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

  return acp;
}

app.whenReady().then(async () => {
  // Fail fast in the test bench: a visible but uninstrumented app would invalidate a trial.
  await setupAcp();
  if (benchmarkMode) Menu.setApplicationMenu(null);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error) => {
  console.error('Failed to initialize the test bench:', error);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
