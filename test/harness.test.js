const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_BOOTSTRAP_SAMPLES,
  classifyEvaluation,
  createSchedule,
  deriveMetrics,
  summarizeMetric,
  summarizePairedComparisons,
  summarizeTrials,
  validateCapabilities,
  wilsonInterval
} = require('../benchmark/harness-core');
const { semanticFailures, validateTrialRecord } = require('../benchmark/schema');
const { parseArgs, validateRunConfig } = require('../benchmark/cli');
const { platformEnvironment, surfaceIsReady } = require('../benchmark/app-process');
const { driverEnvironment } = require('../benchmark/run-trial');

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const COMPARISON_IDENTITY = {
  model: 'm1',
  provider: 'provider-1',
  agentConfigHash: HASH_A,
  baseInstructionHash: HASH_A,
  samplingHash: HASH_A
};

test('schedule uses deterministic randomized complete blocks', () => {
  const variants = ['screenshot', 'accessibility', 'acp', 'hybrid'];
  const first = createSchedule(variants, 5, 20260718);
  const second = createSchedule(variants, 5, 20260718);
  assert.deepEqual(first, second);
  assert.equal(first.length, 20);
  for (let block = 1; block <= 5; block++) {
    assert.deepEqual(
      first.filter((entry) => entry.block === block).map((entry) => entry.variant).sort(),
      [...variants].sort()
    );
  }
});

test('schedule rejects duplicate variants', () => {
  assert.throws(() => createSchedule(['acp', 'acp'], 2, 1), /unique/);
});

test('capability validation prevents an agent from receiving a stronger tool profile', () => {
  assert.equal(validateCapabilities('acp', ['acp']).valid, true);
  assert.equal(validateCapabilities('acp', ['acp', 'screenshot']).valid, false);
  assert.equal(
    validateCapabilities('screenshot', ['text', 'screenshot', 'keyboard', 'pointer']).valid,
    true
  );
});

test('app readiness requires canonical surface identities and destructive policy', () => {
  const description = {
    appId: 'com.linboxin.test-bench',
    name: 'Computer-Use Test Bench',
    protocolVersion: '0.1.0',
    actions: [
      'add_task', 'delete_task', 'fill_profile_form', 'navigate', 'search_employees',
      'set_counter', 'set_task_done', 'set_theme', 'show_notification', 'show_toast', 'sort_table'
    ].map((name) => ({ name, confirm: name === 'delete_task', destructive: name === 'delete_task' })),
    state: ['app_info', 'app_view', 'settings', 'table_view', 'tasks'].map((key) => ({ key })),
    events: [{ name: 'activity.logged' }]
  };
  assert.equal(surfaceIsReady(description), true);
  assert.equal(surfaceIsReady({
    ...description,
    actions: description.actions.map((action) =>
      action.name === 'set_theme' ? { ...action, name: 'renamed_theme' } : action
    )
  }), false);
  assert.equal(surfaceIsReady({
    ...description,
    actions: description.actions.map((action) =>
      action.name === 'delete_task' ? { ...action, confirm: false } : action
    )
  }), false);
});

test('trial summaries report success rate and successful-run latency only', () => {
  const summary = summarizeTrials([
    { variant: 'acp', model: 'm1', environmentFingerprint: 'shared-environment', driver: { kind: 'agent' }, publishable: true, outcome: 'success', timing: { endToEndMs: 100 }, metrics: { acpCalls: 4 } },
    { variant: 'acp', model: 'm1', environmentFingerprint: 'shared-environment', driver: { kind: 'agent' }, publishable: true, outcome: 'success', timing: { endToEndMs: 200 }, metrics: { acpCalls: 4 } },
    { variant: 'acp', model: 'm1', driver: { kind: 'agent' }, publishable: false, outcome: 'timeout', timing: { endToEndMs: 1000 }, metrics: { acpCalls: 2 } },
    { variant: 'screenshot', model: 'm1', driver: { kind: 'agent' }, publishable: false, outcome: 'incorrect_result', timing: { endToEndMs: 300 }, metrics: {} }
  ], { comparisonIdentity: COMPARISON_IDENTITY });
  assert.equal(summary.variants.acp.successRate, 1);
  assert.equal(summary.variants.acp.endToEndMs.median, 150);
  assert.equal(summary.variants.acp.endToEndMs.count, 2);
  assert.equal(summary.variants.acp.publishableTrials, 2);
  assert.equal(summary.diagnosticVariants.acp.successRate, 2 / 3);
  assert.equal(summary.nonPublishableTrials, 2);
  assert.deepEqual(summary.variants.acp.outcomes, { success: 2 });
  assert.deepEqual(summary.diagnosticVariants.acp.outcomes, { success: 2, timeout: 1 });
  assert.equal(summary.datasetEligible, false);
  assert.equal(summary.publishable, false);
});

test('dataset summary requires twenty eligible agent trials per variant and retains eligible failures', () => {
  const records = ['acp', 'screenshot'].flatMap((variant) =>
    Array.from({ length: 20 }, (_, index) => ({
      variant,
      model: 'm1',
      environmentFingerprint: 'shared-environment',
      driver: { kind: 'agent' },
      publishable: true,
      outcome: index === 18 ? 'incorrect_result' : index === 19 ? 'timeout' : 'success',
      timing: { endToEndMs: 100 + index },
      metrics: {}
    }))
  );
  const summary = summarizeTrials(records, {
    expectedVariants: ['acp', 'screenshot'],
    comparisonIdentity: COMPARISON_IDENTITY
  });
  assert.equal(summary.datasetEligible, true);
  assert.equal(summary.publishable, true);
  assert.equal(summary.headlineDataset, 'dataset_eligible_trials_only');
  assert.equal(summary.datasetEligibleTrials, 40);
  assert.equal(summary.publishableTrials, summary.datasetEligibleTrials);
  assert.deepEqual(summary.environmentFingerprints, ['shared-environment']);
  assert.equal(summary.mixedEnvironments, false);
  assert.equal(summary.variants.acp.trials, 20);
  assert.equal(summary.variants.acp.successRate, 0.9);
  assert.deepEqual(summary.variants.acp.outcomes, {
    success: 18,
    incorrect_result: 1,
    timeout: 1
  });
});

test('dataset eligibility rejects missing or mixed environment fingerprints', () => {
  const records = Array.from({ length: 20 }, (_, index) => ({
    variant: 'acp',
    model: 'm1',
    environmentFingerprint: index === 19 ? 'different-environment' : 'shared-environment',
    driver: { kind: 'agent' },
    publishable: true,
    outcome: 'success',
    timing: { endToEndMs: 100 + index },
    metrics: {}
  }));
  const mixed = summarizeTrials(records, { comparisonIdentity: COMPARISON_IDENTITY });
  assert.equal(mixed.datasetEligible, false);
  assert.equal(mixed.mixedEnvironments, true);
  assert.deepEqual(mixed.environmentFingerprints, ['different-environment', 'shared-environment']);
  assert.ok(mixed.datasetIneligibleReasons.includes('missing_or_mixed_environment_fingerprint'));

  const missing = summarizeTrials(
    records.map((record) => ({ ...record, environmentFingerprint: undefined })),
    { comparisonIdentity: COMPARISON_IDENTITY }
  );
  assert.equal(missing.datasetEligible, false);
  assert.equal(missing.mixedEnvironments, false);
  assert.deepEqual(missing.environmentFingerprints, []);
  assert.ok(missing.datasetIneligibleReasons.includes('missing_or_mixed_environment_fingerprint'));
});

test('seeded bootstrap intervals are deterministic for median and p95', () => {
  const values = Array.from({ length: 20 }, (_, index) => 100 + (index * index));
  const first = summarizeMetric(values, { bootstrapSeed: 'fixed-ci-seed' });
  const second = summarizeMetric([...values].reverse(), { bootstrapSeed: 'fixed-ci-seed' });

  assert.deepEqual(first.confidenceIntervals95, second.confidenceIntervals95);
  assert.equal(first.confidenceIntervals95.method, 'seeded_percentile_bootstrap');
  assert.equal(first.confidenceIntervals95.confidenceLevel, 0.95);
  assert.equal(first.confidenceIntervals95.samples, DEFAULT_BOOTSTRAP_SAMPLES);
  assert.match(first.confidenceIntervals95.seed, /^[a-f0-9]{64}$/);
  assert.ok(first.confidenceIntervals95.median.low <= first.median);
  assert.ok(first.confidenceIntervals95.median.high >= first.median);
  assert.ok(first.confidenceIntervals95.p95.low <= first.p95);
  assert.ok(first.confidenceIntervals95.p95.high >= first.p95);
});

test('empty metric summaries retain a reproducible null bootstrap interval', () => {
  const summary = summarizeMetric([], { bootstrapSeed: 'empty' });
  assert.deepEqual(summary.confidenceIntervals95.median, { low: null, high: null });
  assert.deepEqual(summary.confidenceIntervals95.p95, { low: null, high: null });
});

function comparisonTrial(block, variant, outcome, endToEndMs) {
  return { block, variant, outcome, timing: { endToEndMs } };
}

test('paired success-rate bootstrap resamples whole blocks deterministically', () => {
  const variants = ['acp', 'screenshot'];
  const records = (outcomes) => outcomes.flatMap(([left, right], index) => [
    comparisonTrial(index + 1, 'acp', left ? 'success' : 'timeout', left ? 100 : null),
    comparisonTrial(index + 1, 'screenshot', right ? 'success' : 'timeout', right ? 200 : null)
  ]);
  const concordant = records([[1, 1], [1, 1], [0, 0], [0, 0]]);
  const discordant = records([[1, 0], [1, 0], [0, 1], [0, 1]]);
  const options = { bootstrapSamples: 2_000, bootstrapSeed: 'paired-success-seed' };
  const [concordantSummary] = summarizePairedComparisons(concordant, variants, options);
  const [reversedSummary] = summarizePairedComparisons([...concordant].reverse(), variants, options);
  const [discordantSummary] = summarizePairedComparisons(discordant, variants, options);

  assert.deepEqual(reversedSummary, concordantSummary);
  assert.equal(concordantSummary.successRateDifference.estimate, 0);
  assert.deepEqual(concordantSummary.successRateDifference.confidenceInterval95, {
    low: 0,
    high: 0,
    validSamples: 2_000
  });
  assert.equal(discordantSummary.successRateDifference.estimate, 0);
  assert.ok(discordantSummary.successRateDifference.confidenceInterval95.low < 0);
  assert.ok(discordantSummary.successRateDifference.confidenceInterval95.high > 0);
  assert.equal(
    concordantSummary.bootstrap.method,
    'seeded_paired_whole_block_percentile_bootstrap'
  );
  assert.equal(concordantSummary.bootstrap.confidenceLevel, 0.95);
  assert.equal(concordantSummary.bootstrap.samples, 2_000);
  assert.match(concordantSummary.bootstrap.seed, /^[a-f0-9]{64}$/);
});

test('paired whole-block latency bootstrap reports deterministic differences and ratios', () => {
  const variants = ['acp', 'screenshot'];
  const left = [100, 200, 300, 400];
  const translated = left.flatMap((latency, index) => [
    comparisonTrial(index + 1, 'acp', 'success', latency),
    comparisonTrial(index + 1, 'screenshot', 'success', latency + 10)
  ]);
  const scaled = left.flatMap((latency, index) => [
    comparisonTrial(index + 1, 'acp', 'success', latency),
    comparisonTrial(index + 1, 'screenshot', 'success', latency * 2)
  ]);
  const options = { bootstrapSamples: 1_000, bootstrapSeed: 'paired-latency-seed' };
  const [translatedSummary] = summarizePairedComparisons(translated, variants, options);
  const [scaledSummary] = summarizePairedComparisons(scaled, variants, options);

  assert.equal(translatedSummary.endToEndMs.median.differenceMs, -10);
  assert.deepEqual(
    translatedSummary.endToEndMs.median.confidenceIntervals95.differenceMs,
    { low: -10, high: -10, validSamples: 1_000 }
  );
  assert.equal(translatedSummary.endToEndMs.p95.differenceMs, -10);
  assert.deepEqual(
    translatedSummary.endToEndMs.p95.confidenceIntervals95.differenceMs,
    { low: -10, high: -10, validSamples: 1_000 }
  );
  assert.equal(scaledSummary.endToEndMs.median.ratio, 0.5);
  assert.deepEqual(
    scaledSummary.endToEndMs.median.confidenceIntervals95.ratio,
    { low: 0.5, high: 0.5, validSamples: 1_000 }
  );
  assert.equal(scaledSummary.endToEndMs.p95.ratio, 0.5);
  assert.deepEqual(
    scaledSummary.endToEndMs.p95.confidenceIntervals95.ratio,
    { low: 0.5, high: 0.5, validSamples: 1_000 }
  );
});

test('paired latency comparisons stay null when a successful latency estimand is invalid', () => {
  const variants = ['acp', 'screenshot'];
  const [noSuccesses] = summarizePairedComparisons([
    comparisonTrial(1, 'acp', 'timeout', null),
    comparisonTrial(1, 'screenshot', 'incorrect_result', null)
  ], variants, { bootstrapSamples: 100, bootstrapSeed: 'no-successes' });
  assert.equal(noSuccesses.endToEndMs.median.differenceMs, null);
  assert.deepEqual(noSuccesses.endToEndMs.median.confidenceIntervals95.differenceMs, {
    low: null,
    high: null,
    validSamples: 0
  });

  const [zeroDenominator] = summarizePairedComparisons([
    comparisonTrial(1, 'acp', 'success', 10),
    comparisonTrial(1, 'screenshot', 'success', 0)
  ], variants, { bootstrapSamples: 100, bootstrapSeed: 'zero-denominator' });
  assert.equal(zeroDenominator.endToEndMs.median.ratio, null);
  assert.deepEqual(zeroDenominator.endToEndMs.median.confidenceIntervals95.ratio, {
    low: null,
    high: null,
    validSamples: 0
  });
  assert.doesNotMatch(JSON.stringify(zeroDenominator), /Infinity|NaN/);
});

test('trial summaries separate eligible and diagnostic paired block comparisons', () => {
  const records = [
    { ...comparisonTrial(1, 'acp', 'success', 100), publishable: true, driver: { kind: 'agent' } },
    { ...comparisonTrial(1, 'screenshot', 'success', 200), publishable: true, driver: { kind: 'agent' } },
    { ...comparisonTrial(2, 'acp', 'success', 110), publishable: true, driver: { kind: 'agent' } },
    { ...comparisonTrial(2, 'screenshot', 'timeout', null), publishable: false, driver: { kind: 'agent' } }
  ];
  const summary = summarizeTrials(records, {
    expectedVariants: ['acp', 'screenshot'],
    bootstrapSamples: 100,
    bootstrapSeed: 'paired-dataset-split'
  });

  assert.equal(summary.pairedComparisons[0].blocks.complete, 1);
  assert.equal(summary.pairedComparisons[0].blocks.leftOnly, 1);
  assert.equal(summary.diagnosticPairedComparisons[0].blocks.complete, 2);
  assert.notEqual(
    summary.pairedComparisons[0].bootstrap.seed,
    summary.diagnosticPairedComparisons[0].bootstrap.seed
  );
  assert.throws(
    () => summarizePairedComparisons([
      comparisonTrial(1, 'acp', 'success', 1),
      comparisonTrial(1, 'acp', 'success', 2)
    ], ['acp', 'screenshot'], { bootstrapSamples: 1 }),
    /Duplicate acp trial/
  );
});

test('scripted records are intrinsically excluded from publication metrics', () => {
  const records = Array.from({ length: 20 }, () => ({
    variant: 'acp',
    model: 'm1',
    driver: { kind: 'scripted-smoke' },
    publishable: true,
    outcome: 'success',
    timing: { endToEndMs: 1 },
    metrics: {}
  }));
  const summary = summarizeTrials(records, { comparisonIdentity: COMPARISON_IDENTITY });
  assert.equal(summary.publishable, false);
  assert.equal(summary.variants.acp.trials, 0);
  assert.equal(summary.diagnosticVariants.acp.trials, 20);
  assert.ok(summary.nonPublishableReasons.includes('scripted_or_non_agent_driver_records'));
});

test('Wilson interval remains bounded for all-success and all-failure samples', () => {
  assert.deepEqual(wilsonInterval(0, 0), { low: null, high: null });
  assert.equal(wilsonInterval(0, 10).low, 0);
  assert.equal(wilsonInterval(10, 10).high, 1);
});

test('evaluation classification preserves partial, timeout, and infrastructure failures', () => {
  assert.equal(classifyEvaluation({ success: true, assertions: {} }), 'success');
  assert.equal(
    classifyEvaluation({ success: false, assertions: { targetTaskCompleted: true } }),
    'partial'
  );
  assert.equal(classifyEvaluation({ success: false }, { timedOut: true }), 'timeout');
  assert.equal(classifyEvaluation({ success: true }, { timedOut: true }), 'timeout');
  assert.equal(
    classifyEvaluation({ success: false }, { infrastructureFailure: true }),
    'infrastructure_failure'
  );
});

test('driver events produce comparable interaction and usage metrics', () => {
  const metrics = deriveMetrics([
    { type: 'model.turn' },
    { type: 'observation', kind: 'screenshot' },
    { type: 'observation', kind: 'accessibility' },
    { type: 'tool.start', toolKind: 'ui' },
    { type: 'tool.end', toolKind: 'ui', durationMs: 10 },
    { type: 'tool.start', toolKind: 'acp' },
    { type: 'tool.end', toolKind: 'acp', durationMs: 5, hostDurationMs: 2 },
    { type: 'tool.start', toolKind: 'acp' },
    { type: 'tool.error', toolKind: 'acp', durationMs: 3 },
    { type: 'recovery' },
    { type: 'usage', inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.01 }
  ]);
  assert.deepEqual(metrics, {
    modelTurns: 1,
    usageRecords: 1,
    observations: 2,
    screenshotObservations: 1,
    accessibilityObservations: 1,
    uiActionAttempts: 1,
    acpCallAttempts: 2,
    uiActions: 1,
    acpCalls: 1,
    toolErrors: 1,
    toolDurationMs: 18,
    hostDurationMs: 2,
    recoveryLoops: 1,
    inputTokens: 10,
    outputTokens: 5,
    estimatedCostUsd: 0.01
  });
});

test('trial schema rejects records that omit benchmark identity', () => {
  assert.equal(validateTrialRecord({ schemaVersion: 1 }), false);
  assert.ok(validateTrialRecord.errors.some((error) => error.keyword === 'required'));
});

test('trial semantic checks reject post-deadline success and contradictory eligibility', () => {
  const errors = semanticFailures({
    measurementEligible: true,
    publishable: false,
    publicationReasons: [],
    outcome: 'success',
    timing: {
      completedWithinDeadline: false,
      stateSatisfiedMs: 25,
      agentFinalMs: 75,
      endToEndMs: 75,
      timeoutMs: 50
    },
    evaluation: { success: true },
    finalEvaluation: { success: true },
    infrastructureError: null
  });
  assert.match(errors.join(' '), /measurementEligible/);
  assert.match(errors.join(' '), /evaluation.success/);
  assert.match(errors.join(' '), /deadline-bounded completion/);
});

test('CLI preserves a driver command after the argument separator', () => {
  assert.deepEqual(
    parseArgs(['run-one', '--variant', 'acp', '--timeout-ms=1000', '--', 'node', 'driver.js']),
    {
      command: 'run-one',
      options: { variant: 'acp', 'timeout-ms': '1000' },
      passthrough: ['node', 'driver.js']
    }
  );
});

test('run config requires a pinned model and one driver per unique variant', () => {
  const driver = {
    command: 'node',
    commandFile: '/absolute/driver.js',
    capabilityProfile: 'acp',
    model: 'pinned-model',
    provider: 'provider-1',
    agentConfigHash: HASH_A,
    baseInstructionHash: HASH_A,
    samplingHash: HASH_A,
    agentConfigFile: '/absolute/agent-config.json',
    baseInstructionFile: '/absolute/base-instructions.txt',
    samplingFile: '/absolute/sampling.json'
  };
  assert.deepEqual(validateRunConfig({
    variants: ['acp'],
    trialsPerVariant: 10,
    drivers: { acp: driver }
  }), {
    variants: ['acp'],
    trialsPerVariant: 10,
    minimumPublishableTrialsPerVariant: 20,
    comparisonIdentity: {
      model: 'pinned-model',
      provider: 'provider-1',
      agentConfigHash: HASH_A,
      baseInstructionHash: HASH_A,
      samplingHash: HASH_A
    }
  });
  assert.throws(
    () => validateRunConfig({ variants: ['acp'], drivers: { acp: { command: 'node' } } }),
    /model/
  );
  assert.throws(
    () => validateRunConfig({
      variants: ['acp', 'screenshot'],
      drivers: {
        acp: driver,
        screenshot: { ...driver, capabilityProfile: 'screenshot', samplingHash: HASH_B }
      }
    }),
    /same samplingHash/
  );
});

test('driver environment excludes ambient secrets and benchmark control paths', (t) => {
  process.env.ACP_TEST_PARENT_SECRET = 'must-not-leak';
  const priorXauthority = process.env.XAUTHORITY;
  process.env.XAUTHORITY = '/tmp/test-driver-xauthority';
  t.after(() => {
    delete process.env.ACP_TEST_PARENT_SECRET;
    if (priorXauthority === undefined) delete process.env.XAUTHORITY;
    else process.env.XAUTHORITY = priorXauthority;
  });
  const app = {
    child: { pid: 123 },
    registration: { appId: 'com.linboxin.test-bench' },
    paths: { acpHome: '/isolated/acp-home' }
  };
  assert.throws(() => driverEnvironment('acp', app, {
    model: 'm1',
    emptyAcpHome: '/isolated/empty',
    driverEnv: {
      EXPLICIT_PROVIDER_KEY: 'allowed-by-config',
      ACP_BENCHMARK_STATE_FILE: '/forbidden/control.json'
    }
  }), /reserved variable ACP_BENCHMARK_STATE_FILE/);
  const env = driverEnvironment('acp', app, {
    model: 'm1',
    emptyAcpHome: '/isolated/empty',
    driverEnv: { EXPLICIT_PROVIDER_KEY: 'allowed-by-config' }
  });
  assert.equal(env.ACP_TEST_PARENT_SECRET, undefined);
  assert.equal(env.EXPLICIT_PROVIDER_KEY, 'allowed-by-config');
  assert.equal(env.ACP_BENCHMARK_STATE_FILE, undefined);
  assert.equal(env.ACP_HOME, '/isolated/empty');
  assert.equal(env.XAUTHORITY, '/tmp/test-driver-xauthority');
  assert.equal(
    driverEnvironment('screenshot', app, { emptyAcpHome: '/isolated/empty' }).ACP_HOME,
    '/isolated/empty'
  );
});

test('benchmark Electron process receives only the platform environment allowlist', (t) => {
  process.env.ACP_TEST_APP_PARENT_SECRET = 'must-not-reach-electron';
  const priorXauthority = process.env.XAUTHORITY;
  process.env.XAUTHORITY = '/tmp/test-xauthority';
  t.after(() => {
    delete process.env.ACP_TEST_APP_PARENT_SECRET;
    if (priorXauthority === undefined) delete process.env.XAUTHORITY;
    else process.env.XAUTHORITY = priorXauthority;
  });
  const env = platformEnvironment();
  assert.equal(env.ACP_TEST_APP_PARENT_SECRET, undefined);
  assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.XAUTHORITY, '/tmp/test-xauthority');
});
