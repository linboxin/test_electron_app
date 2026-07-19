const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { resumeRun, startRun } = require('../benchmark/cli');
const { runTrial } = require('../benchmark/run-trial');

test('trial runner times a driver against the independent evaluator and retains sanitized artifacts', { timeout: 45_000 }, async (t) => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-trial-output-'));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const artifactDir = path.join(output, 'trials', '0001-acp');

  const result = await runTrial({
    artifactDir,
    trialId: 'integration-scripted-acp',
    variant: 'acp',
    model: 'none-scripted-smoke',
    driver: {
      command: process.execPath,
      args: [
        path.resolve(__dirname, '..', 'benchmark', 'drivers', 'scripted-acp.js'),
        '--final-delay-ms=200'
      ],
      name: 'scripted-acp-smoke',
      kind: 'scripted-smoke'
    },
    headless: true,
    timeoutMs: 10_000
  });

  assert.equal(result.outcome, 'success');
  assert.equal(result.publishable, false);
  assert.equal(result.metrics.acpCalls, 4);
  assert.equal(result.evaluation.success, true);
  assert.ok(result.timing.endToEndMs > 0);
  assert.ok(result.timing.stateSatisfiedMs > 0);
  assert.ok(result.timing.agentFinalMs > result.timing.stateSatisfiedMs);
  assert.ok(result.timing.endToEndMs >= result.timing.agentFinalMs);

  const audit = JSON.parse(await fs.readFile(path.join(artifactDir, 'audit.sanitized.json'), 'utf8'));
  assert.equal(audit.length, 4);
  assert.ok(audit.every((record) => !Object.hasOwn(record, 'args')));

  const environment = await fs.readFile(path.join(artifactDir, 'environment.json'), 'utf8');
  assert.doesNotMatch(environment, /"token"/);
  const trial = JSON.parse(await fs.readFile(path.join(artifactDir, 'trial.json'), 'utf8'));
  assert.equal(trial.outcome, 'success');
});

test('scheduled run writes resumable state and a summary without rerunning completed trials', { timeout: 45_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-scheduled-output-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'run');
  const configFile = path.join(root, 'config.json');
  const scriptedDriver = path.resolve(__dirname, '..', 'benchmark', 'drivers', 'scripted-acp.js');
  const pinnedEnvName = 'ACP_TEST_PINNED_DRIVER_VALUE';
  process.env[pinnedEnvName] = 'first-value';
  t.after(() => delete process.env[pinnedEnvName]);
  await fs.writeFile(configFile, JSON.stringify({
    runId: 'integration-schedule',
    variants: ['acp'],
    trialsPerVariant: 1,
    seed: 'fixed-test-seed',
    timeoutMs: 10_000,
    headless: true,
    drivers: {
      acp: {
        command: process.execPath,
        commandFile: scriptedDriver,
        args: [scriptedDriver],
        name: 'scripted-acp-smoke',
        kind: 'scripted-smoke',
        capabilityProfile: 'acp',
        model: 'none-scripted-smoke',
        provider: 'none-scripted-smoke',
        agentConfigHash: 'a'.repeat(64),
        baseInstructionHash: 'a'.repeat(64),
        samplingHash: 'a'.repeat(64),
        envNames: [pinnedEnvName]
      }
    }
  }, null, 2));

  const first = await startRun({ config: configFile, output });
  assert.equal(first.summary.totalTrials, 1);
  assert.equal(first.summary.variants.acp.successes, 0);
  assert.equal(first.summary.diagnosticVariants.acp.successes, 1);
  assert.equal(first.summary.publishable, false);

  const beforeResume = JSON.parse(await fs.readFile(path.join(output, 'run.json'), 'utf8'));
  assert.equal(beforeResume.status, 'complete');
  assert.equal(beforeResume.trials.length, 1);
  assert.match(beforeResume.runIdentity, /^[a-f0-9]{64}$/);
  assert.match(beforeResume.provenance.configHash, /^[a-f0-9]{64}$/);
  assert.match(beforeResume.config.drivers.acp.commandFileSha256, /^[a-f0-9]{64}$/);
  assert.match(beforeResume.config.drivers.acp.runtimeExecutableSha256, /^[a-f0-9]{64}$/);
  assert.match(beforeResume.config.drivers.acp.envValueIdentityHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(beforeResume.config), /first-value/);
  const resumed = await resumeRun({ run: output });
  assert.equal(resumed.summary.totalTrials, 1);
  const afterResume = JSON.parse(await fs.readFile(path.join(output, 'run.json'), 'utf8'));
  assert.equal(afterResume.trials.length, 1);
  await fs.access(path.join(output, 'summary.md'));

  process.env[pinnedEnvName] = 'second-value';
  await assert.rejects(() => resumeRun({ run: output }), /environment values changed/);
  process.env[pinnedEnvName] = 'first-value';

  const realTrials = path.join(root, 'real-trials');
  await fs.rename(path.join(output, 'trials'), realTrials);
  await fs.symlink(realTrials, path.join(output, 'trials'), 'dir');
  await assert.rejects(() => resumeRun({ run: output }), /non-symlink directory/);
  await fs.rm(path.join(output, 'trials'));
  await fs.rename(realTrials, path.join(output, 'trials'));

  afterResume.config.timeoutMs += 1;
  await fs.writeFile(path.join(output, 'run.json'), JSON.stringify(afterResume, null, 2));
  await assert.rejects(() => resumeRun({ run: output }), /config hash mismatch/);
});

test('resume preserves tampered evidence, records the interruption, and reruns the slot', {
  timeout: 60_000
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-tamper-output-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'run');
  const configFile = path.join(root, 'config.json');
  const scriptedDriver = path.resolve(__dirname, '..', 'benchmark', 'drivers', 'scripted-acp.js');
  await fs.writeFile(configFile, JSON.stringify({
    runId: 'integration-tamper',
    variants: ['acp'],
    trialsPerVariant: 1,
    seed: 'tamper-test-seed',
    timeoutMs: 10_000,
    headless: true,
    drivers: {
      acp: {
        command: process.execPath,
        commandFile: scriptedDriver,
        args: [scriptedDriver],
        name: 'scripted-acp-smoke',
        kind: 'scripted-smoke',
        capabilityProfile: 'acp',
        model: 'none-scripted-smoke',
        provider: 'none-scripted-smoke',
        agentConfigHash: 'a'.repeat(64),
        baseInstructionHash: 'a'.repeat(64),
        samplingHash: 'a'.repeat(64),
        envNames: []
      }
    }
  }, null, 2));

  await startRun({ config: configFile, output });
  await fs.appendFile(path.join(output, 'trials', '0001-acp', 'prompt.txt'), 'tampered\n');
  const resumed = await resumeRun({ run: output });
  const state = JSON.parse(await fs.readFile(path.join(output, 'run.json'), 'utf8'));
  const entries = await fs.readdir(path.join(output, 'trials'));

  assert.equal(state.trials.length, 1);
  assert.equal(state.interruptedAttempts.length, 1);
  assert.match(state.interruptedAttempts[0].reason, /Artifact .*mismatch|manifest/i);
  assert.ok(entries.some((name) => name.startsWith('0001-acp.invalid-recorded-')));
  assert.equal(resumed.summary.run.interruptedAttempts, 1);
  assert.equal(resumed.summary.datasetEligible, false);
  assert.ok(resumed.summary.datasetIneligibleReasons.includes('interrupted_attempts'));
});

test('deadline wins when state or final completion arrives after timeout', { timeout: 45_000 }, async (t) => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-deadline-output-'));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const scriptedDriver = path.resolve(__dirname, '..', 'benchmark', 'drivers', 'scripted-acp.js');
  const result = await runTrial({
    artifactDir: path.join(output, 'trials', '0001-acp'),
    trialId: 'deadline-scripted-acp',
    variant: 'acp',
    model: 'none-scripted-smoke',
    driver: {
      command: process.execPath,
      args: [scriptedDriver, '--final-delay-ms=120'],
      name: 'scripted-acp-smoke',
      kind: 'scripted-smoke'
    },
    headless: true,
    timeoutMs: 50,
    evaluatorPollMs: 5
  });

  assert.equal(result.outcome, 'timeout');
  assert.equal(result.timing.completedWithinDeadline, false);
  assert.equal(result.evaluation.success, false);
  assert.equal(result.evaluation.state.success, true);
  assert.equal(result.finalEvaluation.success, true);
});

test('a non-terminal driver is a timeout, not an infrastructure failure', {
  timeout: 45_000
}, async (t) => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-hanging-output-'));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const result = await runTrial({
    artifactDir: path.join(output, 'trials', '0001-acp'),
    trialId: 'hanging-scripted-acp',
    variant: 'acp',
    model: 'none-scripted-smoke',
    driver: {
      command: process.execPath,
      args: [path.resolve(__dirname, 'fixtures', 'hanging-driver.js')],
      name: 'hanging-test-driver',
      kind: 'scripted-smoke'
    },
    headless: true,
    timeoutMs: 50,
    evaluatorPollMs: 5
  });

  assert.equal(result.outcome, 'timeout');
  assert.equal(result.infrastructureError, null);
  assert.equal(result.timing.completedWithinDeadline, false);
  assert.ok(!result.publicationReasons.includes('infrastructure_failure'));
});

test('trial record and retained artifacts redact secrets from a final event', { timeout: 45_000 }, async (t) => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-secret-output-'));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const secret = 'provider-secret-value-123456789';
  const secretName = 'ACP_TEST_FINAL_SECRET';
  const scriptedDriver = path.resolve(__dirname, '..', 'benchmark', 'drivers', 'scripted-acp.js');
  const result = await runTrial({
    artifactDir: path.join(output, 'trials', '0001-acp'),
    trialId: 'secret-scripted-acp',
    variant: 'acp',
    model: 'none-scripted-smoke',
    driver: {
      command: process.execPath,
      args: [scriptedDriver, `--final-error-env=${secretName}`],
      env: { [secretName]: secret },
      name: 'scripted-acp-smoke',
      kind: 'scripted-smoke'
    },
    headless: true,
    timeoutMs: 10_000
  });

  assert.equal(result.outcome, 'partial');
  assert.equal(result.finalEvaluation.observed.hasError, true);
  const files = await fs.readdir(path.join(output, 'trials', '0001-acp'), { recursive: true });
  for (const relative of files) {
    const file = path.join(output, 'trials', '0001-acp', relative);
    const stat = await fs.lstat(file);
    if (stat.isFile()) assert.doesNotMatch(await fs.readFile(file, 'utf8'), new RegExp(secret));
  }
});

test('trial failures remain inspectable while credential-bearing runtimes are removed', { timeout: 45_000 }, async (t) => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-failure-output-'));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const runtimePrefix = 'acp-cleanup-invalid-json-';
  const before = new Set((await fs.readdir(os.tmpdir())).filter((name) => name.startsWith(runtimePrefix)));

  const result = await runTrial({
    artifactDir: path.join(output, 'trials', '0001-acp'),
    trialId: 'cleanup-invalid-json',
    variant: 'acp',
    model: 'test-model',
    driver: {
      command: process.execPath,
      args: [path.resolve(__dirname, 'fixtures', 'invalid-json-driver.js')],
      name: 'invalid-json-test-driver',
      kind: 'agent'
    },
    headless: true,
    timeoutMs: 2_000
  });

  assert.equal(result.outcome, 'infrastructure_failure');
  assert.equal(result.publishable, false);
  assert.equal(result.cleanup.runtimeRemoved, true);
  const after = (await fs.readdir(os.tmpdir())).filter(
    (name) => name.startsWith(runtimePrefix) && !before.has(name)
  );
  assert.deepEqual(after, []);
  await fs.access(path.join(output, 'trials', '0001-acp', 'trial.json'));
});

test('trial runner refuses to reuse an existing artifact directory', async (t) => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-existing-output-'));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  await assert.rejects(
    runTrial({
      artifactDir: output,
      variant: 'acp',
      model: 'test-model',
      driver: { command: process.execPath, kind: 'agent' }
    }),
    /refusing to reuse/
  );
});
