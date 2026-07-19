const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createRuntimeDir,
  startBenchmarkApp,
  stopBenchmarkApp
} = require('../benchmark/app-process');
const {
  DEFAULT_DRIVER_OUTPUT_LIMITS,
  startDriver
} = require('../benchmark/driver-process');
const { waitFor } = require('../benchmark/protocol');

function inlineDriver(source, artifactDir, options = {}) {
  return startDriver({
    command: process.execPath,
    args: ['-e', source],
    cwd: artifactDir,
    env: { ...process.env },
    artifactDir,
    gracefulShutdownMs: options.gracefulShutdownMs ?? 200,
    terminateTimeoutMs: options.terminateTimeoutMs ?? 500,
    forceKillTimeoutMs: options.forceKillTimeoutMs ?? 500,
    streamDrainTimeoutMs: options.streamDrainTimeoutMs ?? 500,
    ...(options.maxStdoutLineBytes ? { maxStdoutLineBytes: options.maxStdoutLineBytes } : {}),
    ...(options.maxStdoutBytes ? { maxStdoutBytes: options.maxStdoutBytes } : {}),
    ...(options.maxEvents ? { maxEvents: options.maxEvents } : {}),
    ...(options.maxStderrBytes ? { maxStderrBytes: options.maxStderrBytes } : {}),
    ...(options.maxArtifactFileBytes ? { maxArtifactFileBytes: options.maxArtifactFileBytes } : {}),
    ...(options.maxArtifactBytes ? { maxArtifactBytes: options.maxArtifactBytes } : {}),
    ...(options.maxArtifactFiles ? { maxArtifactFiles: options.maxArtifactFiles } : {}),
    ...(options.artifactPollMs ? { artifactPollMs: options.artifactPollMs } : {})
  });
}

async function temporaryArtifacts(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-lifecycle-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function assertReadyFailureIsImmediate(driver, pattern) {
  const startedAt = Date.now();
  await assert.rejects(driver.waitUntilReady(5_000), pattern);
  assert.ok(Date.now() - startedAt < 1_500, 'readiness failure should not wait for its timeout');
  const pid = driver.child.pid;
  const stopped = await driver.stop('expected_test_failure');
  assert.ok(stopped.close);
  if (process.platform !== 'win32' && Number.isInteger(pid)) {
    assert.throws(
      () => process.kill(-pid, 0),
      (error) => error.code === 'ESRCH'
    );
  }
}

test('driver output defaults bound every retained stream dimension', () => {
  assert.deepEqual(DEFAULT_DRIVER_OUTPUT_LIMITS, {
    maxStdoutLineBytes: 256 * 1024,
    maxStdoutBytes: 16 * 1024 * 1024,
    maxEvents: 10_000,
    maxStderrBytes: 4 * 1024 * 1024,
    maxArtifactFileBytes: 32 * 1024 * 1024,
    maxArtifactBytes: 128 * 1024 * 1024,
    maxArtifactFiles: 2_000,
    artifactPollMs: 100
  });
});

test('driver readiness fails immediately on spawn, exit, and invalid JSON', async (t) => {
  const artifactRoot = await temporaryArtifacts(t);
  const cases = [
    {
      name: 'spawn',
      start: () => startDriver({
        command: path.join(artifactRoot, 'missing-driver-command'),
        cwd: artifactRoot,
        env: { ...process.env },
        artifactDir: path.join(artifactRoot, 'spawn'),
        gracefulShutdownMs: 100,
        terminateTimeoutMs: 200,
        forceKillTimeoutMs: 200,
        streamDrainTimeoutMs: 200
      }),
      pattern: /ENOENT/
    },
    {
      name: 'exit',
      source: 'process.exit(7)',
      pattern: /exited before ready.*code 7/
    },
    {
      name: 'invalid-json',
      source: "process.stdout.write('not-json\\n'); setInterval(() => {}, 1000)",
      pattern: /invalid JSON/
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async (subtest) => {
      const artifactDir = path.join(artifactRoot, item.name);
      const driver = item.start
        ? await item.start()
        : await inlineDriver(item.source, artifactDir);
      subtest.after(() => driver.stop('test_cleanup').catch(() => {}));
      await assertReadyFailureIsImmediate(driver, item.pattern);
    });
  }
});

test('driver output overflow terminates the owned process and records the exact limit', async (t) => {
  const artifactRoot = await temporaryArtifacts(t);
  const cases = [
    {
      name: 'stdout-line',
      source: "process.stdout.write('x'.repeat(1024)); setInterval(() => {}, 1000)",
      limits: { maxStdoutLineBytes: 128, maxStdoutBytes: 4096 },
      code: 'DRIVER_STDOUT_LINE_LIMIT',
      pattern: /stdout line exceeded 128 bytes/
    },
    {
      name: 'stdout-total',
      source: "process.stdout.write('\\n'.repeat(256)); setInterval(() => {}, 1000)",
      limits: { maxStdoutLineBytes: 128, maxStdoutBytes: 128 },
      code: 'DRIVER_STDOUT_LIMIT',
      pattern: /stdout exceeded 128 total bytes/
    },
    {
      name: 'event-count',
      source: `
        process.stdout.write([
          JSON.stringify({ type: 'model.turn' }),
          JSON.stringify({ type: 'usage' }),
          JSON.stringify({ type: 'driver.ready' })
        ].join('\\n') + '\\n');
        setInterval(() => {}, 1000);
      `,
      limits: { maxStdoutLineBytes: 256, maxStdoutBytes: 4096, maxEvents: 2 },
      code: 'DRIVER_EVENT_LIMIT',
      pattern: /exceeded 2 JSONL event records/
    },
    {
      name: 'stderr-total',
      source: "process.stderr.write('e'.repeat(1024)); setInterval(() => {}, 1000)",
      limits: { maxStderrBytes: 128 },
      code: 'DRIVER_STDERR_LIMIT',
      pattern: /stderr exceeded 128 bytes/
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async (subtest) => {
      const artifactDir = path.join(artifactRoot, item.name);
      const driver = await inlineDriver(item.source, artifactDir, item.limits);
      subtest.after(() => driver.stop('test_cleanup').catch(() => {}));
      await assertReadyFailureIsImmediate(driver, item.pattern);
      assert.equal(driver.parseErrors[0].code, item.code);
    });
  }
});

test('driver artifact budget rejects oversized, excessive, and linked evidence', async (t) => {
  const artifactRoot = await temporaryArtifacts(t);
  const cases = [
    {
      name: 'single-file-size',
      source: "require('node:fs').writeFileSync('large.bin', Buffer.alloc(1024)); setInterval(() => {}, 1000)",
      limits: { maxArtifactFileBytes: 128, maxArtifactBytes: 4096, artifactPollMs: 20 },
      code: 'DRIVER_ARTIFACT_FILE_SIZE_LIMIT',
      pattern: /artifact file exceeded 128 bytes/
    },
    {
      name: 'tree-size',
      source: `
        const fs = require('node:fs');
        fs.writeFileSync('first.bin', Buffer.alloc(80));
        fs.writeFileSync('second.bin', Buffer.alloc(80));
        setInterval(() => {}, 1000);
      `,
      limits: { maxArtifactFileBytes: 128, maxArtifactBytes: 128, artifactPollMs: 20 },
      code: 'DRIVER_ARTIFACT_TOTAL_SIZE_LIMIT',
      pattern: /artifact tree exceeded 128 total bytes/
    },
    {
      name: 'file-count',
      source: "require('node:fs').writeFileSync('third-file.txt', 'x'); setInterval(() => {}, 1000)",
      limits: { maxArtifactFiles: 2, artifactPollMs: 20 },
      code: 'DRIVER_ARTIFACT_FILE_LIMIT',
      pattern: /artifact tree exceeded 2 files/
    },
    ...(process.platform === 'win32' ? [] : [{
      name: 'symbolic-link',
      source: "require('node:fs').symlinkSync(process.execPath, 'linked-artifact'); setInterval(() => {}, 1000)",
      limits: { artifactPollMs: 20 },
      code: 'DRIVER_ARTIFACT_SYMLINK',
      pattern: /artifact tree contains a symbolic link/
    }])
  ];

  for (const item of cases) {
    await t.test(item.name, async (subtest) => {
      const artifactDir = path.join(artifactRoot, item.name);
      const driver = await inlineDriver(item.source, artifactDir, item.limits);
      subtest.after(() => driver.stop('test_cleanup').catch(() => {}));
      await assertReadyFailureIsImmediate(driver, item.pattern);
      assert.equal(driver.resourceError?.code, item.code);
      assert.equal(driver.parseErrors[0].code, item.code);
    });
  }
});

test('driver shutdown waits for close and retains the final stdout line', async (t) => {
  const artifactDir = await temporaryArtifacts(t);
  const source = `
    const readline = require('node:readline');
    const emit = (value, callback) => process.stdout.write(JSON.stringify(value) + '\\n', callback);
    emit({ type: 'driver.ready', schemaVersion: 1, capabilities: ['acp'] });
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      if (JSON.parse(line).type !== 'start') return;
      emit({ type: 'final', text: 'last-line-must-be-drained' }, () => process.exit(0));
    });
  `;
  const driver = await inlineDriver(source, artifactDir);
  t.after(() => driver.stop('test_cleanup').catch(() => {}));

  await driver.waitUntilReady(2_000);
  driver.send({ type: 'start' });
  await waitFor(() => driver.exit, { timeoutMs: 2_000, description: 'driver exit' });
  const stopped = await driver.stop('test_complete');

  assert.equal(stopped.close.code, 0);
  assert.equal(stopped.close.signal, null);
  assert.equal(driver.close.code, 0);
  assert.ok(driver.events.some(
    (event) => event.type === 'final' && event.text === 'last-line-must-be-drained'
  ));
  const transcript = await fs.readFile(driver.transcriptFile, 'utf8');
  assert.match(transcript, /last-line-must-be-drained/);
});

test('driver shutdown treats a signal exit as terminal and waits for close', async (t) => {
  const artifactDir = await temporaryArtifacts(t);
  const source = `
    const readline = require('node:readline');
    process.stdout.write(JSON.stringify({ type: 'driver.ready', schemaVersion: 1, capabilities: ['acp'] }) + '\\n');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      if (JSON.parse(line).type === 'start') process.kill(process.pid, 'SIGTERM');
    });
  `;
  const driver = await inlineDriver(source, artifactDir);
  t.after(() => driver.stop('test_cleanup').catch(() => {}));

  await driver.waitUntilReady(2_000);
  driver.send({ type: 'start' });
  await waitFor(() => driver.exit, { timeoutMs: 2_000, description: 'signal exit' });
  const stopped = await driver.stop('test_complete');

  assert.equal(stopped.close.code, null);
  assert.equal(stopped.close.signal, 'SIGTERM');
  assert.equal(driver.child.signalCode, 'SIGTERM');
});

test('driver shutdown terminates descendants in its owned POSIX process group', {
  skip: process.platform === 'win32'
}, async (t) => {
  const artifactDir = await temporaryArtifacts(t);
  const source = `
    const { spawn } = require('node:child_process');
    const readline = require('node:readline');
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.stdout.write(JSON.stringify({ type: 'driver.ready', schemaVersion: 1, capabilities: ['acp'], descendantPid: descendant.pid }) + '\\n');
    readline.createInterface({ input: process.stdin }).on('line', () => {});
    setInterval(() => {}, 1000);
  `;
  const driver = await inlineDriver(source, artifactDir, { gracefulShutdownMs: 100 });
  t.after(() => driver.stop('test_cleanup').catch(() => {}));

  const ready = await driver.waitUntilReady(2_000);
  const descendantPid = ready.descendantPid;
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 1);
  const stopped = await driver.stop('test_complete');

  assert.equal(stopped.close.signal, 'SIGTERM');
  await waitFor(() => {
    try {
      process.kill(descendantPid, 0);
      return false;
    } catch (error) {
      if (error.code === 'ESRCH') return true;
      throw error;
    }
  }, { timeoutMs: 2_000, description: 'driver descendant exit' });
});

test('benchmark app launch failure does not wait for the readiness timeout', {
  timeout: 10_000
}, async (t) => {
  const runtimeDir = await createRuntimeDir('acp-app-failure-test-');
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const controlPrefix = 'acp-benchmark-control-';
  const controlsBefore = new Set(
    (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith(controlPrefix))
  );
  const startedAt = Date.now();
  await assert.rejects(
    startBenchmarkApp({
      runtimeDir,
      appRoot: path.join(runtimeDir, 'missing-electron-app'),
      headless: true,
      timeoutMs: 5_000
    }),
    /Electron exited before readiness|ENOENT/
  );
  assert.ok(Date.now() - startedAt < 2_000, 'app failure should not wait for readiness timeout');
  const leakedControls = (await fs.readdir(os.tmpdir())).filter(
    (name) => name.startsWith(controlPrefix) && !controlsBefore.has(name)
  );
  assert.deepEqual(leakedControls, []);
});

test('benchmark app shutdown waits for close and removes its owned process group', {
  timeout: 20_000
}, async (t) => {
  const runtimeDir = await createRuntimeDir('acp-app-lifecycle-test-');
  let app;
  t.after(async () => {
    await stopBenchmarkApp(app).catch(() => {});
    await fs.rm(runtimeDir, { recursive: true, force: true });
  });

  app = await startBenchmarkApp({ runtimeDir, headless: true });
  const pid = app.child.pid;
  const controlDir = app.paths.controlDir;
  assert.equal(path.dirname(app.paths.stateFile), controlDir);
  assert.ok(
    path.relative(runtimeDir, app.paths.stateFile).startsWith(`..${path.sep}`),
    'evaluator state must live outside the ACP runtime disclosed to ACP/hybrid drivers'
  );
  await stopBenchmarkApp(app, 3_000);
  await assert.rejects(fs.access(controlDir), (error) => error.code === 'ENOENT');
  assert.doesNotMatch(app.stderr.join(''), /Object has been destroyed|Uncaught Exception/);

  assert.ok(app.lifecycle.close);
  assert.ok(app.child.exitCode !== null || app.child.signalCode !== null);
  if (process.platform !== 'win32') {
    assert.throws(
      () => process.kill(-pid, 0),
      (error) => error.code === 'ESRCH'
    );
  }
});
