const { createHash } = require('crypto');

const FIXTURE_NAME = 'canonical-v1';
const PROMPT = 'In the Computer-Use Test Bench, add a high-priority task titled “Prepare launch checklist,” mark “Sort the data table by salary” complete, search the employee table for “Chen” and report the number of matches, then switch the application to dark mode. Tell me when all four steps are complete.';
const EXPECTED_MATCHING_EMPLOYEE_IDS = Object.freeze([3, 13, 23, 33, 43]);
const SEEDED_TASKS = Object.freeze([
  Object.freeze({ id: 1, title: 'Try out the Forms page', priority: 'medium', done: false }),
  Object.freeze({ id: 2, title: 'Sort the data table by salary', priority: 'low', done: false }),
  Object.freeze({ id: 3, title: 'Toggle dark mode in Settings', priority: 'high', done: true })
]);

function hashText(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sameArray(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameTask(actual, expected, done = expected.done) {
  return Boolean(actual)
    && actual.id === expected.id
    && actual.title === expected.title
    && actual.priority === expected.priority
    && actual.done === done;
}

function normalizedSearchQuery(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function evaluateFinalEvent(event) {
  const value = event && typeof event === 'object' ? event : {};
  const assertions = {
    finalEventPresent: value.type === 'final',
    completionConfirmed: value.completed === true,
    reportedMatchCountCorrect: value.reportedMatchCount === EXPECTED_MATCHING_EMPLOYEE_IDS.length,
    noFinalError: value.error === undefined || value.error === null
  };

  return {
    success: Object.values(assertions).every(Boolean),
    assertions,
    observed: {
      type: value.type ?? null,
      completed: value.completed ?? null,
      reportedMatchCount: value.reportedMatchCount ?? null,
      hasError: value.error !== undefined && value.error !== null
    }
  };
}

function evaluateSnapshot(snapshot) {
  const value = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const tasks = Array.isArray(value.tasks) ? value.tasks : [];
  const addedTasks = tasks.filter((task) => task?.title === 'Prepare launch checklist');
  const addedTask = addedTasks[0];
  const task1 = tasks.find((task) => task?.id === 1);
  const task2 = tasks.find((task) => task?.id === 2);
  const task3 = tasks.find((task) => task?.id === 3);

  const assertions = {
    fixtureReady: value.ready === true && value.fixture === FIXTURE_NAME,
    exactlyOneTaskAdded: tasks.length === 4 && addedTasks.length === 1 && addedTask?.id === 4,
    addedTaskIsHighPriority: addedTask?.priority === 'high',
    addedTaskIsIncomplete: addedTask?.done === false,
    nextTaskIdAdvancedOnce: value.nextTaskId === 5,
    targetTaskCompleted: sameTask(task2, SEEDED_TASKS[1], true),
    otherSeededTasksPreserved: sameTask(task1, SEEDED_TASKS[0]) && sameTask(task3, SEEDED_TASKS[2]),
    searchQueryApplied: normalizedSearchQuery(value.table?.query) === 'chen',
    searchCountCorrect: value.table?.resultCount === EXPECTED_MATCHING_EMPLOYEE_IDS.length,
    searchRowsCorrect: sameArray(value.table?.matchingEmployeeIds, EXPECTED_MATCHING_EMPLOYEE_IDS),
    unrelatedTableStatePreserved: value.table?.sortKey === 'id'
      && value.table?.sortAsc === true
      && value.table?.page === 1
      && value.table?.perPage === 10
      && value.table?.totalRows === 50,
    storedThemeIsDark: value.settings?.theme === 'dark',
    renderedThemeIsDark: value.settings?.appliedTheme === 'dark',
    unrelatedSettingsPreserved: value.settings?.fontSize === 16
      && value.settings?.displayName === '',
    unrelatedUiStatePreserved: value.ui?.taskFilter === 'all'
      && value.ui?.formsSubmitted === 0,
    noOverlayOpen: Array.isArray(value.ui?.openOverlays) && value.ui.openOverlays.length === 0
  };

  return {
    schemaVersion: 1,
    fixture: FIXTURE_NAME,
    promptHash: hashText(PROMPT),
    success: Object.values(assertions).every(Boolean),
    assertions,
    observed: {
      taskCount: tasks.length,
      matchingTaskCount: addedTasks.length,
      searchCount: value.table?.resultCount ?? null,
      searchQuery: value.table?.query ?? null,
      storedTheme: value.settings?.theme ?? null,
      renderedTheme: value.settings?.appliedTheme ?? null,
      snapshotRevision: value.revision ?? null
    },
    evaluatedAt: new Date().toISOString()
  };
}

function evaluateInitialSnapshot(snapshot) {
  const value = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const tasks = Array.isArray(value.tasks) ? value.tasks : [];
  const assertions = {
    fixtureReady: value.ready === true && value.fixture === FIXTURE_NAME,
    seededTasksExact: tasks.length === SEEDED_TASKS.length
      && SEEDED_TASKS.every((expected, index) => sameTask(tasks[index], expected)),
    nextTaskIdReset: value.nextTaskId === 4,
    tableReset: value.table?.query === ''
      && value.table?.sortKey === 'id'
      && value.table?.sortAsc === true
      && value.table?.page === 1
      && value.table?.perPage === 10
      && value.table?.resultCount === 50,
    settingsReset: value.settings?.theme === 'light'
      && value.settings?.appliedTheme === 'light'
      && value.settings?.fontSize === 16
      && value.settings?.displayName === '',
    uiReset: value.ui?.page === 'dashboard'
      && value.ui?.taskFilter === 'all'
      && value.ui?.clicks === 0
      && value.ui?.formsSubmitted === 0
      && Array.isArray(value.ui?.openOverlays)
      && value.ui.openOverlays.length === 0
  };

  return {
    success: Object.values(assertions).every(Boolean),
    assertions
  };
}

module.exports = {
  EXPECTED_MATCHING_EMPLOYEE_IDS,
  FIXTURE_NAME,
  PROMPT,
  SEEDED_TASKS,
  evaluateFinalEvent,
  evaluateInitialSnapshot,
  evaluateSnapshot,
  hashText
};
