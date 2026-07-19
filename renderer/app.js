// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);

const query = new URLSearchParams(window.location.search);
const benchmarkMode = query.get('benchmark') === '1';
const benchmarkFixture = query.get('fixture') || 'canonical-v1';
const renderDelayMs = Math.max(0, Number(query.get('renderDelayMs')) || 0);

if (benchmarkMode) localStorage.clear();

function createInitialState() {
  return {
    clicks: 0,
    formsSubmitted: 0,
    tasks: [
      { id: 1, title: 'Try out the Forms page', priority: 'medium', done: false },
      { id: 2, title: 'Sort the data table by salary', priority: 'low', done: false },
      { id: 3, title: 'Toggle dark mode in Settings', priority: 'high', done: true }
    ],
    nextTaskId: 4,
    taskFilter: 'all',
    table: { sortKey: 'id', sortAsc: true, page: 1, perPage: 10, query: '' }
  };
}

const state = createInitialState();
let benchmarkReady = false;
let benchmarkRevision = 0;

function logActivity(message) {
  const log = $('activity-log');
  $('log-empty')?.remove();
  const entry = document.createElement('li');
  entry.className = 'log-entry';
  const time = new Date().toLocaleTimeString();
  entry.innerHTML = `<span class="log-time">${time}</span>`;
  entry.appendChild(document.createTextNode(message));
  log.prepend(entry);
  while (log.children.length > 30) log.lastChild.remove();
  window.acp?.emitEvent('activity.logged', { message });
}

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  $('toast-container').appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function updateStats() {
  $('stat-tasks-value').textContent = state.tasks.filter((t) => !t.done).length;
  $('stat-completed-value').textContent = state.tasks.filter((t) => t.done).length;
  $('stat-clicks-value').textContent = state.clicks;
  $('stat-forms-value').textContent = state.formsSubmitted;
  window.acp?.notifyStateChanged('app_view');
  window.acp?.notifyStateChanged('tasks');
  publishBenchmarkState();
}

document.addEventListener('click', (e) => {
  if (e.target.closest('button')) {
    state.clicks++;
    $('stat-clicks-value').textContent = state.clicks;
    window.acp?.notifyStateChanged('app_view');
    publishBenchmarkState();
  }
});

// ---------- Navigation ----------
function navigate(page) {
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
  logActivity(`Navigated to ${page} page`);
  window.acp?.notifyStateChanged('app_view');
  publishBenchmarkState();
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => navigate(btn.dataset.page));
});

$('action-goto-forms').addEventListener('click', () => navigate('forms'));
$('action-goto-table').addEventListener('click', () => navigate('table'));
$('action-new-task').addEventListener('click', () => {
  navigate('tasks');
  $('input-new-task').focus();
});
$('action-clear-log').addEventListener('click', () => {
  $('activity-log').innerHTML = '<li class="log-entry muted" id="log-empty">No activity yet. Interact with the app to see events here.</li>';
  showToast('Activity log cleared');
});

// ---------- Forms page ----------
$('range-experience').addEventListener('input', (e) => {
  $('range-experience-value').textContent = e.target.value;
});

function setFieldError(inputId, errorId, message) {
  $(errorId).textContent = message;
  $(inputId).classList.toggle('invalid', Boolean(message));
  return !message;
}

$('profile-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;

  const validName = setFieldError('input-name', 'error-name', form.name.value.trim() ? '' : 'Name is required.');
  const validEmail = setFieldError(
    'input-email', 'error-email',
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.value) ? '' : 'Enter a valid email address.'
  );
  const validPassword = setFieldError(
    'input-password', 'error-password',
    form.password.value.length >= 8 ? '' : 'Password must be at least 8 characters.'
  );
  const validTerms = $('check-terms').checked;
  $('error-terms').textContent = validTerms ? '' : 'You must accept the terms.';

  if (!(validName && validEmail && validPassword && validTerms)) {
    showToast('Please fix the errors in the form', 'error');
    return;
  }

  const data = {
    name: form.name.value.trim(),
    email: form.email.value.trim(),
    birthday: form.birthday.value || null,
    country: form.country.value || null,
    website: form.website.value || null,
    contact: form.contact.value,
    interests: [...form.querySelectorAll('input[name="interests"]:checked')].map((c) => c.value),
    experience: Number(form.experience.value),
    bio: form.bio.value.trim() || null
  };

  $('form-result-json').textContent = JSON.stringify(data, null, 2);
  $('form-result').classList.remove('hidden');
  state.formsSubmitted++;
  updateStats();
  logActivity(`Form submitted by ${data.name}`);
  showToast('Form submitted successfully');
});

$('btn-reset-form').addEventListener('click', () => {
  ['error-name', 'error-email', 'error-password', 'error-terms'].forEach((id) => ($(id).textContent = ''));
  document.querySelectorAll('#profile-form .invalid').forEach((el) => el.classList.remove('invalid'));
  $('form-result').classList.add('hidden');
  $('range-experience-value').textContent = '5';
});

// ---------- Tasks page ----------
function renderTasks() {
  const list = $('task-list');
  list.innerHTML = '';

  const visible = state.tasks.filter((t) => {
    if (state.taskFilter === 'active') return !t.done;
    if (state.taskFilter === 'done') return t.done;
    return true;
  });

  $('task-empty').classList.toggle('hidden', visible.length > 0);
  const openCount = state.tasks.filter((t) => !t.done).length;
  $('task-count').textContent = `${openCount} task${openCount === 1 ? '' : 's'} remaining`;

  for (const task of visible) {
    const li = document.createElement('li');
    li.className = `task-item${task.done ? ' done' : ''}`;
    li.id = `task-${task.id}`;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = task.done;
    checkbox.setAttribute('aria-label', `Mark "${task.title}" as done`);
    checkbox.addEventListener('change', () => {
      task.done = checkbox.checked;
      logActivity(`Task "${task.title}" marked ${task.done ? 'done' : 'active'}`);
      renderTasks();
      updateStats();
    });

    const title = document.createElement('span');
    title.className = 'task-title';
    title.textContent = task.title;

    const badge = document.createElement('span');
    badge.className = `priority-badge priority-${task.priority}`;
    badge.textContent = task.priority;

    const del = document.createElement('button');
    del.className = 'task-delete';
    del.textContent = '✕';
    del.setAttribute('aria-label', `Delete "${task.title}"`);
    del.addEventListener('click', () => {
      state.tasks = state.tasks.filter((t) => t.id !== task.id);
      logActivity(`Task "${task.title}" deleted`);
      renderTasks();
      updateStats();
    });

    li.append(checkbox, title, badge, del);
    list.appendChild(li);
  }
}

$('task-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const title = $('input-new-task').value.trim();
  if (!title) {
    showToast('Enter a task title first', 'error');
    return;
  }
  state.tasks.push({ id: state.nextTaskId++, title, priority: $('select-task-priority').value, done: false });
  $('input-new-task').value = '';
  logActivity(`Task "${title}" added`);
  renderTasks();
  updateStats();
});

document.querySelectorAll('.filter-row .chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    state.taskFilter = chip.dataset.filter;
    document.querySelectorAll('.filter-row .chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderTasks();
    publishBenchmarkState();
  });
});

// ---------- Data Table page ----------
const FIRST = ['Ava', 'Liam', 'Mia', 'Noah', 'Zoe', 'Ethan', 'Ivy', 'Lucas', 'Nora', 'Owen', 'Ruby', 'Felix', 'Hana', 'Diego', 'Lena', 'Marco', 'Aisha', 'Kai', 'Elsa', 'Ravi'];
const LAST = ['Smith', 'Johnson', 'Garcia', 'Kim', 'Chen', 'Patel', 'Novak', 'Silva', 'Tanaka', 'Mueller'];
const ROLES = ['Engineer', 'Designer', 'Manager', 'Analyst', 'Marketer', 'Support', 'Recruiter', 'Accountant'];
const CITIES = ['New York', 'London', 'Berlin', 'Tokyo', 'Sydney', 'Toronto', 'Paris', 'Singapore'];

const employees = Array.from({ length: 50 }, (_, i) => ({
  id: i + 1,
  name: `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`,
  role: ROLES[(i * 3) % ROLES.length],
  city: CITIES[(i * 5) % CITIES.length],
  salary: 52000 + ((i * 3517) % 90000)
}));

function matchingEmployees(queryText = state.table.query) {
  const normalized = queryText.trim().toLowerCase();
  return employees.filter((emp) =>
    !normalized
    || emp.name.toLowerCase().includes(normalized)
    || emp.role.toLowerCase().includes(normalized)
    || emp.city.toLowerCase().includes(normalized)
  );
}

function publishBenchmarkState() {
  if (!benchmarkMode || typeof window.api?.reportBenchmarkState !== 'function') return;
  const matches = matchingEmployees();
  window.api.reportBenchmarkState({
    schemaVersion: 1,
    fixture: benchmarkFixture,
    ready: benchmarkReady,
    revision: ++benchmarkRevision,
    generatedAt: new Date().toISOString(),
    tasks: state.tasks.map((task) => ({ ...task })),
    nextTaskId: state.nextTaskId,
    table: {
      ...state.table,
      resultCount: matches.length,
      totalRows: employees.length,
      matchingEmployeeIds: matches.map((employee) => employee.id)
    },
    settings: {
      theme: localStorage.getItem('theme') || 'light',
      appliedTheme: document.documentElement.dataset.theme || 'light',
      fontSize: Number(localStorage.getItem('fontSize') || '16'),
      displayName: localStorage.getItem('displayName') || ''
    },
    ui: {
      page: document.querySelector('.nav-item.active')?.dataset.page || 'dashboard',
      taskFilter: state.taskFilter,
      clicks: state.clicks,
      formsSubmitted: state.formsSubmitted,
      openOverlays: $('modal-overlay')?.classList.contains('hidden') ? [] : ['example-modal']
    },
    environment: {
      devicePixelRatio: window.devicePixelRatio,
      screen: {
        width: window.screen.width,
        height: window.screen.height,
        availWidth: window.screen.availWidth,
        availHeight: window.screen.availHeight
      },
      window: {
        x: window.screenX,
        y: window.screenY,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight
      }
    }
  });
}

function renderTable() {
  const { sortKey, sortAsc, page, perPage, query } = state.table;

  const rows = matchingEmployees(query);

  rows.sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv));
    return sortAsc ? cmp : -cmp;
  });

  const totalPages = Math.max(1, Math.ceil(rows.length / perPage));
  state.table.page = Math.min(page, totalPages);
  const start = (state.table.page - 1) * perPage;
  const pageRows = rows.slice(start, start + perPage);

  const tbody = $('employee-tbody');
  tbody.innerHTML = '';
  for (const emp of pageRows) {
    const tr = document.createElement('tr');
    tr.id = `emp-row-${emp.id}`;
    for (const value of [emp.id, emp.name, emp.role, emp.city, `$${emp.salary.toLocaleString()}`]) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  $('table-result-count').textContent = `${rows.length} of ${employees.length} employees`;
  $('page-indicator').textContent = `Page ${state.table.page} of ${totalPages}`;
  $('btn-prev-page').disabled = state.table.page <= 1;
  $('btn-next-page').disabled = state.table.page >= totalPages;

  document.querySelectorAll('#employee-table th').forEach((th) => {
    th.querySelector('.sort-arrow').textContent = th.dataset.sort === sortKey ? (sortAsc ? '▲' : '▼') : '';
  });
  window.acp?.notifyStateChanged('table_view');
  publishBenchmarkState();
}

document.querySelectorAll('#employee-table th').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (state.table.sortKey === key) {
      state.table.sortAsc = !state.table.sortAsc;
    } else {
      state.table.sortKey = key;
      state.table.sortAsc = true;
    }
    renderTable();
    logActivity(`Table sorted by ${key} (${state.table.sortAsc ? 'ascending' : 'descending'})`);
  });
});

$('input-table-search').addEventListener('input', (e) => {
  state.table.query = e.target.value.trim();
  state.table.page = 1;
  renderTable();
});

$('btn-prev-page').addEventListener('click', () => {
  state.table.page--;
  renderTable();
});

$('btn-next-page').addEventListener('click', () => {
  state.table.page++;
  renderTable();
});

// ---------- Widgets page ----------
document.querySelectorAll('#widget-tabs .tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#widget-tabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('#widget-tabs .tab-panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${tab.dataset.tab}`));
  });
});

let counter = 0;
function setCounter(value) {
  counter = value;
  $('counter-value').textContent = counter;
}
$('btn-counter-plus').addEventListener('click', () => setCounter(counter + 1));
$('btn-counter-minus').addEventListener('click', () => setCounter(counter - 1));
$('btn-counter-reset').addEventListener('click', () => setCounter(0));

let progressTimer = null;
$('btn-progress-start').addEventListener('click', () => {
  if (progressTimer) return;
  let pct = parseInt($('progress-label').textContent, 10) || 0;
  progressTimer = setInterval(() => {
    pct = Math.min(pct + 2, 100);
    $('progress-fill').style.width = `${pct}%`;
    $('progress-label').textContent = `${pct}%`;
    if (pct >= 100) {
      clearInterval(progressTimer);
      progressTimer = null;
      showToast('Progress complete!');
    }
  }, 60);
});
$('btn-progress-reset').addEventListener('click', () => {
  clearInterval(progressTimer);
  progressTimer = null;
  $('progress-fill').style.width = '0%';
  $('progress-label').textContent = '0%';
});

$('btn-open-modal').addEventListener('click', () => {
  $('modal-overlay').classList.remove('hidden');
  $('modal-input').value = '';
  $('modal-input').focus();
});
$('btn-modal-cancel').addEventListener('click', () => $('modal-overlay').classList.add('hidden'));
$('btn-modal-confirm').addEventListener('click', () => {
  const text = $('modal-input').value.trim();
  $('modal-overlay').classList.add('hidden');
  showToast(text ? `Modal confirmed with "${text}"` : 'Modal confirmed (no text entered)');
  logActivity('Modal dialog confirmed');
});

$('btn-toast-success').addEventListener('click', () => showToast('This is a success toast 🎉'));
$('btn-toast-error').addEventListener('click', () => showToast('This is an error toast 💥', 'error'));

let draggedItem = null;
document.querySelectorAll('.drag-item').forEach((item) => {
  item.addEventListener('dragstart', () => {
    draggedItem = item;
    item.classList.add('dragging');
  });
  item.addEventListener('dragend', () => {
    item.classList.remove('dragging');
    draggedItem = null;
    logActivity('Drag list reordered');
  });
  item.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!draggedItem || draggedItem === item) return;
    const rect = item.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    item.parentNode.insertBefore(draggedItem, after ? item.nextSibling : item);
  });
});

// ---------- Settings page ----------
function notifySettingsChanged() {
  window.acp?.notifyStateChanged('settings');
  publishBenchmarkState();
}

function applySettings() {
  const theme = localStorage.getItem('theme') || 'light';
  const fontSize = localStorage.getItem('fontSize') || '16';
  const displayName = localStorage.getItem('displayName') || '';

  document.documentElement.dataset.theme = theme;
  document.documentElement.style.setProperty('--font-size', `${fontSize}px`);
  $('select-theme').value = theme;
  $('select-fontsize').value = fontSize;
  $('input-display-name').value = displayName;
  $('dashboard-greeting').textContent = displayName ? `Welcome back, ${displayName}!` : 'Welcome back!';
  notifySettingsChanged();
}

$('select-theme').addEventListener('change', (e) => {
  localStorage.setItem('theme', e.target.value);
  applySettings();
  logActivity(`Theme changed to ${e.target.value}`);
});

$('select-fontsize').addEventListener('change', (e) => {
  localStorage.setItem('fontSize', e.target.value);
  applySettings();
});

$('input-display-name').addEventListener('input', (e) => {
  localStorage.setItem('displayName', e.target.value.trim());
  $('dashboard-greeting').textContent = e.target.value.trim() ? `Welcome back, ${e.target.value.trim()}!` : 'Welcome back!';
  notifySettingsChanged();
});

$('btn-native-message').addEventListener('click', async () => {
  const choice = await window.api.showMessageBox({
    type: 'info',
    title: 'Native Dialog',
    message: 'This is a native message box from the main process.'
  });
  $('native-result').textContent = `Message box closed with: ${choice}`;
  logActivity(`Native message box → ${choice}`);
});

$('btn-native-open').addEventListener('click', async () => {
  const file = await window.api.openFileDialog();
  $('native-result').textContent = file ? `Selected file: ${file}` : 'File dialog canceled.';
  logActivity(file ? 'File selected via native dialog' : 'File dialog canceled');
});

$('btn-native-notification').addEventListener('click', () => {
  window.api.showNotification({ title: 'Test Bench', body: 'This is a system notification.' });
  $('native-result').textContent = 'System notification sent.';
  logActivity('System notification sent');
});

$('btn-clipboard-copy').addEventListener('click', async () => {
  const text = $('input-clipboard').value;
  if (!text) {
    showToast('Type something to copy first', 'error');
    return;
  }
  await window.api.writeClipboard(text);
  showToast('Copied to clipboard');
  logActivity('Text copied to clipboard');
});

$('btn-clipboard-paste').addEventListener('click', async () => {
  const text = await window.api.readClipboard();
  $('clipboard-output').textContent = text || '(clipboard is empty)';
  logActivity('Clipboard pasted');
});

async function loadAppInfo() {
  const info = await window.api.getAppInfo();
  $('about-app').textContent = info.appVersion;
  $('about-electron').textContent = info.electron;
  $('about-chrome').textContent = info.chrome;
  $('about-node').textContent = info.node;
  $('about-platform').textContent = info.platform;
  $('sidebar-version').textContent = `v${info.appVersion} · Electron ${info.electron}`;
}

// ---------- ACP (App Context Protocol) ----------
function initAcp() {
  if (!window.acp) return;
  const acp = window.acp;
  const obj = (properties, required) => ({ type: 'object', properties, required });

  acp.registerState('app_view', 'Current page and headline stats', () => ({
    page: document.querySelector('.nav-item.active')?.dataset.page || 'dashboard',
    openTasks: state.tasks.filter((t) => !t.done).length,
    completedTasks: state.tasks.filter((t) => t.done).length,
    clicks: state.clicks,
    formsSubmitted: state.formsSubmitted
  }));

  acp.registerState('tasks', 'All tasks with id, title, priority, done', () => state.tasks);

  acp.registerState('table_view', 'Employee table query, sort, and page', () => ({ ...state.table }));

  acp.registerState('settings', 'Theme, font size, and display name', () => ({
    theme: localStorage.getItem('theme') || 'light',
    fontSize: Number(localStorage.getItem('fontSize') || '16'),
    displayName: localStorage.getItem('displayName') || ''
  }));

  acp.registerAction(
    {
      name: 'navigate',
      description: 'Switch to one of the app pages',
      paramsSchema: obj(
        { page: { type: 'string', enum: ['dashboard', 'forms', 'tasks', 'table', 'widgets', 'settings'] } },
        ['page']
      )
    },
    ({ page }) => {
      navigate(page);
      return { page };
    }
  );

  acp.registerAction(
    {
      name: 'add_task',
      description: 'Add a task to the task list',
      paramsSchema: obj(
        {
          title: { type: 'string', minLength: 1 },
          priority: { type: 'string', enum: ['low', 'medium', 'high'] }
        },
        ['title']
      )
    },
    ({ title, priority }) => {
      const normalizedTitle = typeof title === 'string' ? title.trim() : '';
      if (!normalizedTitle) throw new Error('task title must not be empty');
      const task = {
        id: state.nextTaskId++,
        title: normalizedTitle,
        priority: priority || 'medium',
        done: false
      };
      state.tasks.push(task);
      renderTasks();
      updateStats();
      logActivity(`Task "${normalizedTitle}" added`);
      return task;
    }
  );

  acp.registerAction(
    {
      name: 'set_task_done',
      description: 'Mark a task as done or active',
      paramsSchema: obj({ taskId: { type: 'integer' }, done: { type: 'boolean' } }, ['taskId', 'done'])
    },
    ({ taskId, done }) => {
      const task = state.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`no task with id ${taskId}`);
      task.done = done;
      renderTasks();
      updateStats();
      logActivity(`Task "${task.title}" marked ${done ? 'done' : 'active'}`);
      return task;
    }
  );

  acp.registerAction(
    {
      name: 'delete_task',
      description: 'Delete a task from the list',
      confirm: true,
      destructive: true,
      paramsSchema: obj({ taskId: { type: 'integer' } }, ['taskId'])
    },
    ({ taskId }) => {
      const task = state.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`no task with id ${taskId}`);
      state.tasks = state.tasks.filter((t) => t.id !== taskId);
      renderTasks();
      updateStats();
      logActivity(`Task "${task.title}" deleted`);
      return { deleted: taskId };
    }
  );

  acp.registerAction(
    {
      name: 'search_employees',
      description: 'Search the employee table by name, role, or city and return matches',
      paramsSchema: obj({ query: { type: 'string' } }, ['query'])
    },
    ({ query }) => {
      $('input-table-search').value = query;
      state.table.query = query.trim();
      state.table.page = 1;
      renderTable();
      const q = query.trim().toLowerCase();
      const rows = employees.filter(
        (e) => !q || e.name.toLowerCase().includes(q) || e.role.toLowerCase().includes(q) || e.city.toLowerCase().includes(q)
      );
      return { count: rows.length, rows: rows.slice(0, 10) };
    }
  );

  acp.registerAction(
    {
      name: 'sort_table',
      description: 'Sort the employee table by a column',
      paramsSchema: obj(
        {
          key: { type: 'string', enum: ['id', 'name', 'role', 'city', 'salary'] },
          ascending: { type: 'boolean' }
        },
        ['key']
      )
    },
    ({ key, ascending }) => {
      state.table.sortKey = key;
      state.table.sortAsc = ascending !== false;
      renderTable();
      logActivity(`Table sorted by ${key} (${state.table.sortAsc ? 'ascending' : 'descending'})`);
      return { ...state.table };
    }
  );

  acp.registerAction(
    {
      name: 'fill_profile_form',
      description: 'Fill the profile form and optionally submit it; returns the submitted data or validation state',
      paramsSchema: obj(
        {
          name: { type: 'string' },
          email: { type: 'string' },
          password: { type: 'string' },
          bio: { type: 'string' },
          submit: { type: 'boolean' }
        },
        ['name', 'email', 'password']
      )
    },
    (args) => {
      const form = $('profile-form');
      navigate('forms');
      form.name.value = args.name;
      form.email.value = args.email;
      form.password.value = args.password;
      if (args.bio) form.bio.value = args.bio;
      if (args.submit === false) return { submitted: false };
      $('check-terms').checked = true;
      const before = state.formsSubmitted;
      form.requestSubmit();
      const submitted = state.formsSubmitted > before;
      return {
        submitted,
        result: submitted ? JSON.parse($('form-result-json').textContent) : null,
        errors: submitted
          ? []
          : ['error-name', 'error-email', 'error-password', 'error-terms'].map((id) => $(id).textContent).filter(Boolean)
      };
    }
  );

  acp.registerAction(
    {
      name: 'set_theme',
      description: 'Switch between light and dark theme',
      paramsSchema: obj({ theme: { type: 'string', enum: ['light', 'dark'] } }, ['theme'])
    },
    ({ theme }) => {
      localStorage.setItem('theme', theme);
      applySettings();
      logActivity(`Theme changed to ${theme}`);
      return { theme };
    }
  );

  acp.registerAction(
    {
      name: 'set_counter',
      description: 'Set the widgets-page counter to a value',
      paramsSchema: obj({ value: { type: 'integer' } }, ['value'])
    },
    ({ value }) => {
      setCounter(value);
      return { value };
    }
  );

  acp.registerAction(
    {
      name: 'show_toast',
      description: 'Show an in-app toast message',
      paramsSchema: obj(
        { message: { type: 'string' }, type: { type: 'string', enum: ['success', 'error'] } },
        ['message']
      )
    },
    ({ message, type }) => {
      showToast(message, type || 'success');
      return { shown: true };
    }
  );
}

// ---------- Init ----------
function startApp() {
  initAcp();
  applySettings();
  renderTasks();
  renderTable();
  updateStats();
  loadAppInfo();
  benchmarkReady = true;
  publishBenchmarkState();
}

if (benchmarkMode && renderDelayMs > 0) setTimeout(startApp, renderDelayMs);
else startApp();
