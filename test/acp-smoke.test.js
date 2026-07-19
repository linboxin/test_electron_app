const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const test = require('node:test');
const {
  createRuntimeDir,
  startBenchmarkApp,
  stopBenchmarkApp
} = require('../benchmark/app-process');
const { evaluateSnapshot } = require('../benchmark/scenario');
const { waitFor, waitForJson } = require('../benchmark/protocol');

test('Electron benchmark mode exposes a stable ACP surface, evaluates independently, and resets', { timeout: 45_000 }, async (t) => {
  const runtimeDir = await createRuntimeDir('acp-electron-smoke-');
  let appInstance;
  t.after(async () => {
    await stopBenchmarkApp(appInstance);
    await fs.rm(runtimeDir, { recursive: true, force: true });
  });

  appInstance = await startBenchmarkApp({ runtimeDir });
  assert.equal(appInstance.description.actions.length, 11);
  assert.equal(appInstance.description.state.length, 5);
  assert.deepEqual(appInstance.description.events.map((event) => event.name), ['activity.logged']);

  const deleteTask = appInstance.description.actions.find((action) => action.name === 'delete_task');
  assert.equal(deleteTask.destructive, true);
  assert.equal(deleteTask.confirm, true);

  const initialState = await appInstance.client.request('state/get', {});
  assert.equal(Object.hasOwn(initialState.state.app_info, 'benchmarkMode'), false);
  assert.equal(initialState.state.tasks.length, 3);
  assert.equal(initialState.state.settings.theme, 'light');
  assert.deepEqual(initialState.state.table_view, {
    sortKey: 'id', sortAsc: true, page: 1, perPage: 10, query: ''
  });

  await appInstance.client.request('state/subscribe', { keys: ['table_view', 'settings'] });
  await appInstance.client.request('actions/call', {
    action: 'add_task',
    args: { title: 'Prepare launch checklist', priority: 'high' }
  });
  await appInstance.client.request('actions/call', {
    action: 'set_task_done',
    args: { taskId: 2, done: true }
  });
  const search = await appInstance.client.request('actions/call', {
    action: 'search_employees',
    args: { query: 'Chen' }
  });
  assert.equal(search.result.count, 5);
  await appInstance.client.request('actions/call', {
    action: 'set_theme',
    args: { theme: 'dark' }
  });

  await appInstance.client.waitForNotification(
    'state/changed',
    (params) => params?.key === 'table_view' && params.value?.query === 'Chen'
  );
  await appInstance.client.waitForNotification(
    'state/changed',
    (params) => params?.key === 'settings' && params.value?.theme === 'dark'
  );

  const completedSnapshot = await waitForJson(
    appInstance.paths.stateFile,
    (snapshot) => evaluateSnapshot(snapshot).success,
    { timeoutMs: 5_000, description: 'successful independent evaluation state' }
  );
  assert.equal(evaluateSnapshot(completedSnapshot).success, true);

  const stateFile = appInstance.paths.stateFile;
  await stopBenchmarkApp(appInstance);
  appInstance = null;
  await fs.unlink(stateFile).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });

  appInstance = await startBenchmarkApp({ runtimeDir });
  const resetSnapshot = appInstance.initialSnapshot;
  assert.equal(resetSnapshot.tasks.length, 3);
  assert.equal(resetSnapshot.table.query, '');
  assert.equal(resetSnapshot.settings.theme, 'light');
  assert.equal(resetSnapshot.settings.displayName, '');
  assert.equal(evaluateSnapshot(resetSnapshot).success, false);
});

test('benchmark state-writer failure terminates Electron as infrastructure', { timeout: 45_000 }, async (t) => {
  const runtimeDir = await createRuntimeDir('acp-electron-write-failure-');
  let appInstance;
  t.after(async () => {
    await stopBenchmarkApp(appInstance).catch(() => {});
    await fs.rm(runtimeDir, { recursive: true, force: true });
  });

  appInstance = await startBenchmarkApp({ runtimeDir, headless: true });
  await fs.rm(appInstance.paths.controlDir, { recursive: true, force: true });
  await fs.writeFile(appInstance.paths.controlDir, 'block benchmark state directory creation');
  await appInstance.client.request('actions/call', {
    action: 'set_theme',
    args: { theme: 'dark' }
  }, 15_000).catch(() => {});
  let exit;
  try {
    exit = await waitFor(() => appInstance.lifecycle.exit, {
      timeoutMs: 20_000,
      description: 'Electron infrastructure exit'
    });
  } catch (error) {
    error.message = `${error.message}; stderr: ${appInstance.stderr.join('').trim() || '(empty)'}`;
    throw error;
  }
  assert.equal(exit.code, 70);
});
