const { spawn } = require('child_process');
const fs = require('fs');
const fsPromises = require('fs/promises');
const { performance } = require('perf_hooks');
const { finished } = require('stream/promises');
const { waitFor } = require('./protocol');

const POSIX_PROCESS_GROUPS = process.platform !== 'win32';
// JSONL events should stay small because binary observations belong in separate
// artifacts. These caps bound both retained evidence and in-memory parsing.
const DEFAULT_DRIVER_OUTPUT_LIMITS = Object.freeze({
  maxStdoutLineBytes: 256 * 1024,
  maxStdoutBytes: 16 * 1024 * 1024,
  maxEvents: 10_000,
  maxStderrBytes: 4 * 1024 * 1024,
  maxArtifactFileBytes: 32 * 1024 * 1024,
  maxArtifactBytes: 128 * 1024 * 1024,
  maxArtifactFiles: 2_000,
  artifactPollMs: 100
});

function outputLimit(config, name) {
  const value = Number(config[name] ?? DEFAULT_DRIVER_OUTPUT_LIMITS[name]);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function artifactBudgetError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function inspectArtifactBudget(root, limits) {
  let files = 0;
  let bytes = 0;

  async function walk(directory, isRoot = false) {
    const directoryStat = await fsPromises.lstat(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw artifactBudgetError(
        'DRIVER_ARTIFACT_SYMLINK',
        `${isRoot ? 'Driver artifact root' : 'Driver artifact entry'} is not a non-symlink directory`
      );
    }
    const entries = await fsPromises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const resolved = `${directory}/${entry.name}`;
      let stat;
      try {
        stat = await fsPromises.lstat(resolved);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (stat.isSymbolicLink()) {
        throw artifactBudgetError(
          'DRIVER_ARTIFACT_SYMLINK',
          'Driver artifact tree contains a symbolic link'
        );
      }
      if (stat.isDirectory()) {
        await walk(resolved);
        continue;
      }
      if (!stat.isFile() || stat.nlink > 1) {
        throw artifactBudgetError(
          'DRIVER_ARTIFACT_NONREGULAR',
          'Driver artifact tree contains a non-regular or multiply-linked file'
        );
      }
      files += 1;
      if (files > limits.maxArtifactFiles) {
        throw artifactBudgetError(
          'DRIVER_ARTIFACT_FILE_LIMIT',
          `Driver artifact tree exceeded ${limits.maxArtifactFiles} files`
        );
      }
      if (stat.size > limits.maxArtifactFileBytes) {
        throw artifactBudgetError(
          'DRIVER_ARTIFACT_FILE_SIZE_LIMIT',
          `Driver artifact file exceeded ${limits.maxArtifactFileBytes} bytes`
        );
      }
      bytes += stat.size;
      if (bytes > limits.maxArtifactBytes) {
        throw artifactBudgetError(
          'DRIVER_ARTIFACT_TOTAL_SIZE_LIMIT',
          `Driver artifact tree exceeded ${limits.maxArtifactBytes} total bytes`
        );
      }
    }
  }

  await walk(root, true);
  return { files, bytes };
}

function withTimeout(promise, timeoutMs, description) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out waiting for ${description} after ${timeoutMs}ms`)),
        timeoutMs
      );
    })
  ]).finally(() => clearTimeout(timer));
}

function processGroupExists(pid) {
  if (!POSIX_PROCESS_GROUPS || !Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function signalOwnedDriver(child, signal) {
  if (!Number.isInteger(child.pid) || child.pid <= 1) {
    throw new Error('Cannot signal benchmark driver without a valid owned pid');
  }
  try {
    if (POSIX_PROCESS_GROUPS) process.kill(-child.pid, signal);
    else if (!child.kill(signal)) throw new Error(`Failed to send ${signal} to driver ${child.pid}`);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function startDriver(config) {
  await fsPromises.mkdir(config.artifactDir, { recursive: true, mode: 0o700 });
  const outputLimits = {
    maxStdoutLineBytes: outputLimit(config, 'maxStdoutLineBytes'),
    maxStdoutBytes: outputLimit(config, 'maxStdoutBytes'),
    maxEvents: outputLimit(config, 'maxEvents'),
    maxStderrBytes: outputLimit(config, 'maxStderrBytes'),
    maxArtifactFileBytes: outputLimit(config, 'maxArtifactFileBytes'),
    maxArtifactBytes: outputLimit(config, 'maxArtifactBytes'),
    maxArtifactFiles: outputLimit(config, 'maxArtifactFiles'),
    artifactPollMs: outputLimit(config, 'artifactPollMs')
  };
  const transcriptFile = `${config.artifactDir}/transcript.jsonl`;
  const stderrFile = `${config.artifactDir}/driver.stderr.log`;
  const transcript = fs.createWriteStream(transcriptFile, { flags: 'w', mode: 0o600 });
  const stderrStream = fs.createWriteStream(stderrFile, { flags: 'w', mode: 0o600 });
  const child = spawn(config.command, config.args ?? [], {
    cwd: config.cwd,
    detached: POSIX_PROCESS_GROUPS,
    env: config.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  child.stdin.on('error', () => {});
  const events = [];
  const parseErrors = [];
  let readyEvent = null;
  let exit = null;
  let close = null;
  let spawnError = null;
  let stopPromise = null;
  let outputError = null;
  let resourceError = null;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let eventRecords = 0;
  let stdoutPending = Buffer.alloc(0);
  let linesClosed = false;
  let resolveLinesClosed;
  const linesClosedPromise = new Promise((resolve) => {
    resolveLinesClosed = resolve;
  });
  const markLinesClosed = () => {
    if (linesClosed) return;
    linesClosed = true;
    resolveLinesClosed();
  };
  let stderrArtifactEnded = false;
  const endStderrArtifact = () => {
    if (stderrArtifactEnded) return;
    stderrArtifactEnded = true;
    if (!stderrStream.writableEnded && !stderrStream.destroyed) stderrStream.end();
  };

  function failDriverOutput(message, code) {
    if (outputError) return;
    outputError = Object.assign(new Error(message), { code });
    if (code.includes('_LIMIT') || code.startsWith('DRIVER_ARTIFACT_')) {
      resourceError = outputError;
    }
    const failure = { code, error: message };
    parseErrors.push(failure);
    if (!transcript.destroyed) {
      transcript.write(`${JSON.stringify({ type: 'driver.protocol_error', ...failure })}\n`);
    }
    try {
      signalOwnedDriver(child, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') failure.terminationError = error.message;
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
    endStderrArtifact();
  }

  function processStdoutLine(rawLine) {
    if (outputError) return;
    const withoutCarriageReturn = rawLine.at(-1) === 0x0d
      ? rawLine.subarray(0, -1)
      : rawLine;
    if (!withoutCarriageReturn.length || !withoutCarriageReturn.toString('utf8').trim()) return;
    eventRecords += 1;
    if (eventRecords > outputLimits.maxEvents) {
      failDriverOutput(
        `Driver stdout exceeded ${outputLimits.maxEvents} JSONL event records`,
        'DRIVER_EVENT_LIMIT'
      );
      return;
    }
    const line = withoutCarriageReturn.toString('utf8');
    try {
      const parsed = JSON.parse(line);
      const event = {
        ...parsed,
        harnessReceivedAt: new Date().toISOString(),
        harnessReceivedMonotonicMs: performance.now()
      };
      events.push(event);
      transcript.write(`${JSON.stringify(event)}\n`);
      if (event.type === 'driver.ready' && !readyEvent) readyEvent = event;
    } catch {
      failDriverOutput(
        `Driver emitted invalid JSON (${withoutCarriageReturn.length} bytes)`,
        'DRIVER_INVALID_JSON'
      );
    }
  }

  child.stdout.on('data', (chunk) => {
    if (outputError) return;
    stdoutBytes += chunk.length;
    if (stdoutBytes > outputLimits.maxStdoutBytes) {
      failDriverOutput(
        `Driver stdout exceeded ${outputLimits.maxStdoutBytes} total bytes`,
        'DRIVER_STDOUT_LIMIT'
      );
      return;
    }
    stdoutPending = Buffer.concat([stdoutPending, chunk]);
    let newlineIndex;
    while (!outputError && (newlineIndex = stdoutPending.indexOf(0x0a)) !== -1) {
      const line = stdoutPending.subarray(0, newlineIndex);
      stdoutPending = stdoutPending.subarray(newlineIndex + 1);
      if (line.length > outputLimits.maxStdoutLineBytes) {
        failDriverOutput(
          `Driver stdout line exceeded ${outputLimits.maxStdoutLineBytes} bytes`,
          'DRIVER_STDOUT_LINE_LIMIT'
        );
        return;
      }
      processStdoutLine(line);
    }
    if (!outputError && stdoutPending.length > outputLimits.maxStdoutLineBytes) {
      failDriverOutput(
        `Driver stdout line exceeded ${outputLimits.maxStdoutLineBytes} bytes`,
        'DRIVER_STDOUT_LINE_LIMIT'
      );
    }
  });
  child.stdout.once('end', () => {
    if (!outputError && stdoutPending.length) {
      if (stdoutPending.length > outputLimits.maxStdoutLineBytes) {
        failDriverOutput(
          `Driver stdout line exceeded ${outputLimits.maxStdoutLineBytes} bytes`,
          'DRIVER_STDOUT_LINE_LIMIT'
        );
      } else {
        processStdoutLine(stdoutPending);
      }
    }
    stdoutPending = Buffer.alloc(0);
    markLinesClosed();
  });
  child.stdout.once('close', markLinesClosed);
  child.stdout.once('error', (error) => {
    if (!outputError) {
      failDriverOutput(`Driver stdout stream failed: ${error.message}`, 'DRIVER_STDOUT_ERROR');
    }
    markLinesClosed();
  });

  child.stderr.on('data', (chunk) => {
    if (outputError) return;
    const remaining = Math.max(0, outputLimits.maxStderrBytes - stderrBytes);
    if (remaining) stderrStream.write(chunk.subarray(0, remaining));
    stderrBytes += chunk.length;
    if (stderrBytes > outputLimits.maxStderrBytes) {
      failDriverOutput(
        `Driver stderr exceeded ${outputLimits.maxStderrBytes} bytes`,
        'DRIVER_STDERR_LIMIT'
      );
    }
  });
  child.stderr.once('end', endStderrArtifact);
  child.stderr.once('close', endStderrArtifact);
  child.stderr.once('error', (error) => {
    if (!outputError) {
      failDriverOutput(`Driver stderr stream failed: ${error.message}`, 'DRIVER_STDERR_ERROR');
    }
    endStderrArtifact();
  });
  let artifactScanRunning = false;
  let artifactScanPromise = Promise.resolve();
  const runArtifactScan = () => {
    if (artifactScanRunning || outputError || close) return;
    artifactScanRunning = true;
    artifactScanPromise = inspectArtifactBudget(config.artifactDir, outputLimits)
      .catch((error) => {
        failDriverOutput(
          error.message,
          error.code?.startsWith('DRIVER_ARTIFACT_')
            ? error.code
            : 'DRIVER_ARTIFACT_SCAN_ERROR'
        );
      })
      .finally(() => {
        artifactScanRunning = false;
      });
  };
  const artifactMonitor = setInterval(runArtifactScan, outputLimits.artifactPollMs);
  artifactMonitor.unref?.();
  runArtifactScan();
  child.once('exit', (code, signal) => {
    exit = { code, signal, atMonotonicMs: performance.now() };
  });
  child.once('close', (code, signal) => {
    clearInterval(artifactMonitor);
    close = { code, signal, atMonotonicMs: performance.now() };
    exit ??= close;
  });
  child.once('error', (error) => {
    spawnError = error;
  });

  async function waitForTreeClose(timeoutMs, description) {
    return waitFor(() => {
      if (!close) return null;
      if (POSIX_PROCESS_GROUPS && processGroupExists(child.pid)) return null;
      return close;
    }, { timeoutMs, intervalMs: 25, description });
  }

  async function waitUntilReady(timeoutMs = 10_000) {
    return waitFor(() => {
      if (parseErrors.length) throw new Error(`Driver emitted invalid JSON: ${parseErrors[0].error}`);
      if (spawnError) throw spawnError;
      if (readyEvent) return readyEvent;
      if (close || exit || child.exitCode !== null || child.signalCode !== null) {
        const status = close ?? exit ?? { code: child.exitCode, signal: child.signalCode };
        throw new Error(`Driver exited before ready (code ${status.code}, signal ${status.signal})`);
      }
      return null;
    }, { timeoutMs, description: 'driver.ready event', retryErrors: false });
  }

  function send(event) {
    if (close || child.stdin.destroyed || !child.stdin.writable) {
      throw new Error('Driver stdin is closed');
    }
    child.stdin.write(`${JSON.stringify(event)}\n`);
  }

  async function performStop(reason) {
    const gracefulMs = Number(config.gracefulShutdownMs ?? 1_500);
    const terminateMs = Number(config.terminateTimeoutMs ?? 1_500);
    const forceMs = Number(config.forceKillTimeoutMs ?? 1_500);
    const drainMs = Number(config.streamDrainTimeoutMs ?? 1_500);
    const teardownErrors = [];
    let forced = false;

    if (!close) {
      try {
        send({ type: 'stop', reason });
        // One driver process handles one trial. EOF makes wrappers that use a
        // readline loop release stdin even if their explicit stop handler races.
        child.stdin.end();
      } catch {}
      try {
        await waitForTreeClose(gracefulMs, 'graceful driver process-tree close');
      } catch {}
    }

    if (!close || (POSIX_PROCESS_GROUPS && processGroupExists(child.pid))) {
      try {
        signalOwnedDriver(child, 'SIGTERM');
      } catch (error) {
        teardownErrors.push(error);
      }
      try {
        await waitForTreeClose(terminateMs, 'terminated driver process-tree close');
      } catch {}
    }

    if (!close || (POSIX_PROCESS_GROUPS && processGroupExists(child.pid))) {
      forced = true;
      try {
        signalOwnedDriver(child, 'SIGKILL');
      } catch (error) {
        teardownErrors.push(error);
      }
      try {
        await waitForTreeClose(forceMs, 'forced driver process-tree close');
      } catch (error) {
        teardownErrors.push(error);
      }
    }

    if (!close) {
      teardownErrors.push(new Error(`Driver process ${child.pid ?? 'unknown'} never emitted close`));
    }
    if (POSIX_PROCESS_GROUPS && processGroupExists(child.pid)) {
      teardownErrors.push(new Error(`Driver process group ${child.pid} still exists after teardown`));
    }

    if (teardownErrors.length) {
      child.stdout?.destroy();
      child.stderr?.destroy();
      markLinesClosed();
      endStderrArtifact();
    }

    try {
      await withTimeout(linesClosedPromise, drainMs, 'driver stdout drain');
    } catch (error) {
      teardownErrors.push(error);
      child.stdout?.destroy();
      markLinesClosed();
    }

    clearInterval(artifactMonitor);
    try {
      await withTimeout(artifactScanPromise, drainMs, 'driver artifact budget scan');
    } catch (error) {
      teardownErrors.push(error);
    }
    if (!resourceError) {
      try {
        await withTimeout(
          inspectArtifactBudget(config.artifactDir, outputLimits),
          drainMs,
          'final driver artifact budget scan'
        );
      } catch (error) {
        failDriverOutput(
          error.message,
          error.code?.startsWith('DRIVER_ARTIFACT_')
            ? error.code
            : 'DRIVER_ARTIFACT_SCAN_ERROR'
        );
      }
    }

    try {
      await withTimeout(finished(stderrStream), drainMs, 'driver stderr drain');
    } catch (error) {
      teardownErrors.push(error);
      child.stderr?.destroy();
      endStderrArtifact();
    }

    try {
      if (!transcript.writableEnded) transcript.end();
      await withTimeout(finished(transcript), drainMs, 'driver transcript flush');
    } catch (error) {
      teardownErrors.push(error);
      transcript.destroy();
    }

    if (teardownErrors.length) {
      throw new AggregateError(
        teardownErrors,
        `Driver teardown failed for process tree ${child.pid ?? 'unknown'}`
      );
    }
    return { close, forced };
  }

  function stop(reason = 'harness_complete') {
    if (!stopPromise) stopPromise = performStop(reason);
    return stopPromise;
  }

  return {
    child,
    get close() { return close; },
    events,
    get exit() { return exit; },
    outputLimits,
    parseErrors,
    get resourceError() { return resourceError; },
    send,
    stderrFile,
    stop,
    transcriptFile,
    waitUntilReady
  };
}

module.exports = { DEFAULT_DRIVER_OUTPUT_LIMITS, startDriver };
