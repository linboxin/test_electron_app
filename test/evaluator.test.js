const assert = require('node:assert/strict');
const test = require('node:test');
const {
  EXPECTED_MATCHING_EMPLOYEE_IDS,
  FIXTURE_NAME,
  SEEDED_TASKS,
  evaluateFinalEvent,
  evaluateInitialSnapshot,
  evaluateSnapshot
} = require('../benchmark/scenario');

function successfulSnapshot() {
  return {
    schemaVersion: 1,
    fixture: FIXTURE_NAME,
    ready: true,
    revision: 9,
    tasks: [
      SEEDED_TASKS[0],
      { ...SEEDED_TASKS[1], done: true },
      SEEDED_TASKS[2],
      { id: 4, title: 'Prepare launch checklist', priority: 'high', done: false }
    ],
    nextTaskId: 5,
    table: {
      sortKey: 'id',
      sortAsc: true,
      page: 1,
      perPage: 10,
      query: 'Chen',
      resultCount: 5,
      totalRows: 50,
      matchingEmployeeIds: [...EXPECTED_MATCHING_EMPLOYEE_IDS]
    },
    settings: { theme: 'dark', appliedTheme: 'dark', fontSize: 16, displayName: '' },
    ui: {
      page: 'settings',
      taskFilter: 'all',
      clicks: 12,
      formsSubmitted: 0,
      openOverlays: []
    }
  };
}

test('independent evaluator accepts only the exact canonical final state', () => {
  const evaluation = evaluateSnapshot(successfulSnapshot());
  assert.equal(evaluation.success, true);
  assert.ok(Object.values(evaluation.assertions).every(Boolean));
  assert.equal(evaluation.observed.searchCount, 5);
});

test('independent evaluator accepts semantically equivalent Chen query casing and whitespace', () => {
  const snapshot = successfulSnapshot();
  snapshot.table.query = '  cHeN  ';

  assert.equal(evaluateSnapshot(snapshot).success, true);
});

test('initial-state evaluator detects a clean fixture and contamination', () => {
  const clean = successfulSnapshot();
  clean.tasks = SEEDED_TASKS.map((task) => ({ ...task }));
  clean.nextTaskId = 4;
  clean.table = {
    sortKey: 'id', sortAsc: true, page: 1, perPage: 10, query: '', resultCount: 50,
    matchingEmployeeIds: Array.from({ length: 50 }, (_, index) => index + 1)
  };
  clean.settings = { theme: 'light', appliedTheme: 'light', fontSize: 16, displayName: '' };
  clean.ui = {
    page: 'dashboard', taskFilter: 'all', clicks: 0, formsSubmitted: 0, openOverlays: []
  };

  assert.equal(evaluateInitialSnapshot(clean).success, true);
  clean.settings.theme = 'dark';
  assert.equal(evaluateInitialSnapshot(clean).success, false);
});

test('independent evaluator rejects partial and false-positive states', () => {
  const partial = successfulSnapshot();
  partial.tasks[1] = { ...partial.tasks[1], done: false };
  partial.table.resultCount = 4;
  partial.settings.appliedTheme = 'light';

  const evaluation = evaluateSnapshot(partial);
  assert.equal(evaluation.success, false);
  assert.equal(evaluation.assertions.targetTaskCompleted, false);
  assert.equal(evaluation.assertions.searchCountCorrect, false);
  assert.equal(evaluation.assertions.renderedThemeIsDark, false);
});

test('independent evaluator rejects extra tasks and changed seeded data', () => {
  const contaminated = successfulSnapshot();
  contaminated.tasks.push({ id: 5, title: 'Unintended task', priority: 'high', done: false });
  contaminated.tasks[0] = { ...contaminated.tasks[0], title: 'Changed' };

  const evaluation = evaluateSnapshot(contaminated);
  assert.equal(evaluation.success, false);
  assert.equal(evaluation.assertions.exactlyOneTaskAdded, false);
  assert.equal(evaluation.assertions.otherSeededTasksPreserved, false);
});

test('independent evaluator rejects unrelated table, settings, and form-state changes', () => {
  const contaminated = successfulSnapshot();
  contaminated.nextTaskId = 9;
  contaminated.table.sortKey = 'salary';
  contaminated.table.page = 2;
  contaminated.settings.fontSize = 18;
  contaminated.settings.displayName = 'Unexpected';
  contaminated.ui.taskFilter = 'done';
  contaminated.ui.formsSubmitted = 1;

  const evaluation = evaluateSnapshot(contaminated);
  assert.equal(evaluation.success, false);
  assert.equal(evaluation.assertions.nextTaskIdAdvancedOnce, false);
  assert.equal(evaluation.assertions.unrelatedTableStatePreserved, false);
  assert.equal(evaluation.assertions.unrelatedSettingsPreserved, false);
  assert.equal(evaluation.assertions.unrelatedUiStatePreserved, false);
});

test('final-event evaluator requires explicit completion and the reported match count', () => {
  const evaluation = evaluateFinalEvent({
    type: 'final',
    completed: true,
    reportedMatchCount: 5,
    text: 'All four steps are complete. Chen has 5 matches.'
  });

  assert.equal(evaluation.success, true);
  assert.ok(Object.values(evaluation.assertions).every(Boolean));
  assert.deepEqual(evaluation.observed, {
    type: 'final',
    completed: true,
    reportedMatchCount: 5,
      hasError: false
  });
});

test('final-event evaluator rejects missing, incorrect, or failed completion reports', () => {
  assert.equal(evaluateFinalEvent(null).success, false);
  assert.equal(evaluateFinalEvent({ type: 'final', completed: false, reportedMatchCount: 5 }).success, false);
  assert.equal(evaluateFinalEvent({ type: 'final', completed: true, reportedMatchCount: '5' }).success, false);
  assert.equal(evaluateFinalEvent({
    type: 'final',
    completed: true,
    reportedMatchCount: 5,
    error: 'provider failed'
  }).success, false);
});

test('independent evaluator handles missing or malformed snapshots without throwing', () => {
  assert.equal(evaluateSnapshot(null).success, false);
  assert.equal(evaluateSnapshot({ ready: true, tasks: 'not-an-array' }).success, false);
});
