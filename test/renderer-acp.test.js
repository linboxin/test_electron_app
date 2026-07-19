const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');

async function createRenderer(options = {}) {
  const benchmark = options.benchmark ?? true;
  const url = `https://test-bench.local/index.html${benchmark ? '?benchmark=1&fixture=canonical-v1' : ''}`;
  const dom = new JSDOM(html, { runScripts: 'outside-only', url });
  const { window } = dom;
  const actions = new Map();
  const states = new Map();
  const notifications = [];
  const events = [];
  const snapshots = [];

  window.acp = {
    registerAction(definition, handler) {
      actions.set(definition.name, { definition, handler });
    },
    registerState(key, description, getter) {
      states.set(key, { description, getter });
    },
    notifyStateChanged(key) {
      notifications.push(key);
    },
    emitEvent(event, payload) {
      events.push({ event, payload });
    }
  };

  window.api = {
    getAppInfo: async () => ({
      appVersion: '1.0.0',
      electron: '37.10.3',
      chrome: '138.0.0.0',
      node: '24.18.0',
      platform: 'darwin'
    }),
    showMessageBox: async () => 'OK',
    openFileDialog: async () => null,
    writeClipboard: async () => true,
    readClipboard: async () => '',
    showNotification: async () => true,
    openExternal: async () => true,
    reportBenchmarkState(snapshot) {
      snapshots.push(snapshot);
    }
  };

  for (const [key, value] of Object.entries(options.localStorage ?? {})) {
    window.localStorage.setItem(key, value);
  }

  window.eval(rendererSource);
  await Promise.resolve();
  return { actions, dom, events, notifications, snapshots, states, window };
}

function normalize(value) {
  return JSON.parse(JSON.stringify(value));
}

function dispatch(window, element, type) {
  element.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
}

test('registers the complete renderer ACP surface with destructive confirmation', async (t) => {
  const harness = await createRenderer();
  t.after(() => harness.dom.window.close());

  assert.equal(harness.actions.size, 10);
  assert.equal(harness.states.size, 4);
  assert.deepEqual([...harness.states.keys()].sort(), ['app_view', 'settings', 'table_view', 'tasks']);

  const deletion = harness.actions.get('delete_task').definition;
  assert.equal(deletion.destructive, true);
  assert.equal(deletion.confirm, true);
});

test('benchmark mode clears persisted settings and exposes the canonical fixture', async (t) => {
  const harness = await createRenderer({
    localStorage: { theme: 'dark', fontSize: '18', displayName: 'stale value' }
  });
  t.after(() => harness.dom.window.close());

  const appView = harness.states.get('app_view').getter();
  const tasks = harness.states.get('tasks').getter();
  const table = harness.states.get('table_view').getter();
  const settings = harness.states.get('settings').getter();
  const finalSnapshot = harness.snapshots.at(-1);

  assert.deepEqual(normalize(tasks), [
    { id: 1, title: 'Try out the Forms page', priority: 'medium', done: false },
    { id: 2, title: 'Sort the data table by salary', priority: 'low', done: false },
    { id: 3, title: 'Toggle dark mode in Settings', priority: 'high', done: true }
  ]);
  assert.deepEqual(normalize(appView), {
    page: 'dashboard',
    openTasks: 2,
    completedTasks: 1,
    clicks: 0,
    formsSubmitted: 0
  });
  assert.deepEqual(normalize(table), { sortKey: 'id', sortAsc: true, page: 1, perPage: 10, query: '' });
  assert.deepEqual(normalize(settings), { theme: 'light', fontSize: 16, displayName: '' });
  assert.equal(finalSnapshot.ready, true);
  assert.equal(finalSnapshot.fixture, 'canonical-v1');
  assert.equal(finalSnapshot.table.resultCount, 50);
  assert.deepEqual(normalize(finalSnapshot.ui.openOverlays), []);
});

test('normal mode preserves persisted renderer settings', async (t) => {
  const harness = await createRenderer({
    benchmark: false,
    localStorage: { theme: 'dark', fontSize: '18', displayName: 'Grace' }
  });
  t.after(() => harness.dom.window.close());
  assert.deepEqual(normalize(harness.states.get('settings').getter()), {
    theme: 'dark', fontSize: 18, displayName: 'Grace'
  });
  assert.equal(harness.window.document.documentElement.dataset.theme, 'dark');
});

test('UI mutations notify every exposed mutable state key', async (t) => {
  const harness = await createRenderer();
  t.after(() => harness.dom.window.close());
  const { notifications, window } = harness;
  notifications.length = 0;

  const tableSearch = window.document.getElementById('input-table-search');
  tableSearch.value = 'Chen';
  dispatch(window, tableSearch, 'input');
  assert.ok(notifications.includes('table_view'));

  notifications.length = 0;
  window.document.getElementById('th-salary').click();
  assert.ok(notifications.includes('table_view'));

  notifications.length = 0;
  const theme = window.document.getElementById('select-theme');
  theme.value = 'dark';
  dispatch(window, theme, 'change');
  assert.ok(notifications.includes('settings'));

  notifications.length = 0;
  const fontSize = window.document.getElementById('select-fontsize');
  fontSize.value = '18';
  dispatch(window, fontSize, 'change');
  assert.ok(notifications.includes('settings'));

  notifications.length = 0;
  const displayName = window.document.getElementById('input-display-name');
  displayName.value = 'Ada ';
  dispatch(window, displayName, 'input');
  assert.ok(notifications.includes('settings'));
  assert.equal(displayName.value, 'Ada ');
  assert.equal(harness.states.get('settings').getter().displayName, 'Ada');

  notifications.length = 0;
  const taskTitle = window.document.getElementById('input-new-task');
  taskTitle.value = 'A UI task';
  dispatch(window, window.document.getElementById('task-form'), 'submit');
  assert.ok(notifications.includes('tasks'));
  assert.ok(notifications.includes('app_view'));

  notifications.length = 0;
  window.document.getElementById('nav-forms').click();
  assert.ok(notifications.includes('app_view'));
});

test('ACP action handlers update state, notifications, and benchmark snapshots coherently', async (t) => {
  const harness = await createRenderer();
  t.after(() => harness.dom.window.close());
  const { actions, notifications, snapshots, states } = harness;

  notifications.length = 0;
  const searchResult = actions.get('search_employees').handler({ query: 'Chen' });
  assert.equal(searchResult.count, 5);
  assert.equal(states.get('table_view').getter().query, 'Chen');
  assert.ok(notifications.includes('table_view'));
  assert.deepEqual(normalize(snapshots.at(-1).table.matchingEmployeeIds), [3, 13, 23, 33, 43]);

  notifications.length = 0;
  actions.get('sort_table').handler({ key: 'salary', ascending: false });
  assert.deepEqual(normalize(states.get('table_view').getter()), {
    sortKey: 'salary', sortAsc: false, page: 1, perPage: 10, query: 'Chen'
  });
  assert.ok(notifications.includes('table_view'));

  notifications.length = 0;
  actions.get('set_theme').handler({ theme: 'dark' });
  assert.equal(states.get('settings').getter().theme, 'dark');
  assert.ok(notifications.includes('settings'));
  assert.equal(snapshots.at(-1).settings.appliedTheme, 'dark');

  const added = actions.get('add_task').handler({ title: '  Prepare launch checklist  ', priority: 'high' });
  assert.equal(added.title, 'Prepare launch checklist');
  assert.throws(
    () => actions.get('add_task').handler({ title: '   ', priority: 'high' }),
    /must not be empty/
  );
});
