const { spawn } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { RpcClient, readJson, waitFor } = require('./protocol');

const APP_ID = 'com.linboxin.test-bench';
const EXPECTED_SURFACE = Object.freeze({ actions: 11, state: 5, events: 1 });
const EXPECTED_SURFACE_NAMES = Object.freeze({
  actions: Object.freeze([
    'add_task',
    'delete_task',
    'fill_profile_form',
    'navigate',
    'search_employees',
    'set_counter',
    'set_task_done',
    'set_theme',
    'show_notification',
    'show_toast',
    'sort_table'
  ]),
  state: Object.freeze(['app_info', 'app_view', 'settings', 'table_view', 'tasks']),
  events: Object.freeze(['activity.logged'])
});
const POSIX_PROCESS_GROUPS = process.platform !== 'win32';
const childLifecycles = new WeakMap();

function platformEnvironment() {
  const env = {};
  for (const name of [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'SHELL',
    'USER',
    'LOGNAME',
    'DISPLAY',
    'XAUTHORITY',
    'WAYLAND_DISPLAY',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
    'SystemRoot',
    'ComSpec',
    'PATHEXT'
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
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

function trackChild(child, ownsProcessGroup) {
  let exit = null;
  let close = null;
  let spawnError = null;
  let resolveClose;
  const closePromise = new Promise((resolve) => {
    resolveClose = resolve;
  });

  child.once('error', (error) => {
    spawnError = error;
  });
  child.once('exit', (code, signal) => {
    exit = { code, signal, atMonotonicMs: performance.now() };
  });
  child.once('close', (code, signal) => {
    close = { code, signal, atMonotonicMs: performance.now() };
    exit ??= close;
    resolveClose(close);
  });

  const lifecycle = {
    closePromise,
    get close() { return close; },
    get exit() { return exit; },
    get spawnError() { return spawnError; },
    ownsProcessGroup
  };
  childLifecycles.set(child, lifecycle);
  return lifecycle;
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

function signalOwnedChild(child, lifecycle, signal) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 1) {
    throw new Error('Cannot signal benchmark process without a valid owned pid');
  }
  try {
    if (lifecycle.ownsProcessGroup) process.kill(-child.pid, signal);
    else if (!child.kill(signal)) throw new Error(`Failed to send ${signal} to process ${child.pid}`);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForOwnedTreeClose(child, lifecycle, timeoutMs, description) {
  return waitFor(() => {
    if (!lifecycle.close) return null;
    if (lifecycle.ownsProcessGroup && processGroupExists(child.pid)) return null;
    return lifecycle.close;
  }, {
    timeoutMs,
    intervalMs: 25,
    description: `${description} process-tree close and stream drain`
  });
}

function terminationMessage(child, lifecycle, stderr) {
  const status = lifecycle.close ?? lifecycle.exit ?? {
    code: child.exitCode,
    signal: child.signalCode
  };
  const detail = stderr.join('').trim();
  return `Electron exited before readiness (code ${status.code ?? 'null'}, signal ${status.signal ?? 'null'})${detail ? `: ${detail}` : ''}`;
}

async function createRuntimeDir(prefix = 'acp-benchmark-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.chmod(directory, 0o700);
  return directory;
}

function runtimePaths(runtimeDir, controlDir) {
  return {
    acpHome: path.join(runtimeDir, 'acp-home'),
    controlDir,
    manifestFile: path.join(runtimeDir, 'acp-home', 'apps', `${APP_ID}.json`),
    stateFile: path.join(controlDir, 'state.json'),
    userDataDir: path.join(runtimeDir, 'user-data')
  };
}

function surfaceIsReady(description) {
  const names = (records, field) => Array.isArray(records)
    ? records.map((record) => record?.[field]).sort()
    : [];
  const deletion = description?.actions?.find((action) => action?.name === 'delete_task');
  return description?.appId === APP_ID
    && description?.name === 'Computer-Use Test Bench'
    && description?.protocolVersion === '0.1.0'
    && JSON.stringify(names(description.actions, 'name')) === JSON.stringify(EXPECTED_SURFACE_NAMES.actions)
    && JSON.stringify(names(description.state, 'key')) === JSON.stringify(EXPECTED_SURFACE_NAMES.state)
    && JSON.stringify(names(description.events, 'name')) === JSON.stringify(EXPECTED_SURFACE_NAMES.events)
    && deletion?.confirm === true
    && deletion?.destructive === true;
}

async function startBenchmarkApp(options = {}) {
  const appRoot = path.resolve(options.appRoot ?? path.join(__dirname, '..'));
  const electronBinary = require('electron');
  const runtimeDir = path.resolve(options.runtimeDir ?? await createRuntimeDir());
  const controlDir = await createRuntimeDir('acp-benchmark-control-');
  const paths = runtimePaths(runtimeDir, controlDir);
  const stdout = [];
  const stderr = [];
  const startedAt = performance.now();

  try {
    await fs.mkdir(paths.acpHome, { recursive: true, mode: 0o700 });
    await fs.mkdir(paths.userDataDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    await fs.rm(controlDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  let child;
  try {
    child = spawn(electronBinary, [appRoot], {
      cwd: appRoot,
      detached: POSIX_PROCESS_GROUPS,
      env: {
        ...platformEnvironment(),
        ACP_HOME: paths.acpHome,
        ACP_BENCHMARK: '1',
        ACP_BENCHMARK_FIXTURE: options.fixture ?? 'canonical-v1',
        ACP_BENCHMARK_STATE_FILE: paths.stateFile,
        ACP_BENCHMARK_USER_DATA_DIR: paths.userDataDir,
        ACP_BENCHMARK_WINDOW_X: String(options.window?.x ?? 100),
        ACP_BENCHMARK_WINDOW_Y: String(options.window?.y ?? 80),
        ACP_BENCHMARK_WINDOW_WIDTH: String(options.window?.width ?? 1200),
        ACP_BENCHMARK_WINDOW_HEIGHT: String(options.window?.height ?? 800),
        ACP_BENCHMARK_RENDER_DELAY_MS: String(options.renderDelayMs ?? 0),
        ACP_TEST_HEADLESS: options.headless === false ? '0' : '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    await fs.rm(controlDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const lifecycle = trackChild(child, POSIX_PROCESS_GROUPS);
  child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));

  let client;
  try {
    const registration = await waitFor(async () => {
      if (lifecycle.spawnError) throw lifecycle.spawnError;
      if (lifecycle.exit || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(terminationMessage(child, lifecycle, stderr));
      }
      const value = await readJson(paths.manifestFile);
      return value?.appId === APP_ID ? value : null;
    }, {
      timeoutMs: options.timeoutMs ?? 15_000,
      description: 'ACP discovery manifest',
      retryErrors: false
    });
    client = await RpcClient.connect(registration);
    const description = await waitFor(async () => {
      if (lifecycle.spawnError) {
        lifecycle.spawnError.fatal = true;
        throw lifecycle.spawnError;
      }
      if (lifecycle.exit || child.exitCode !== null || child.signalCode !== null) {
        const error = new Error(terminationMessage(child, lifecycle, stderr));
        error.fatal = true;
        throw error;
      }
      const value = await client.request('acp/describe');
      return surfaceIsReady(value) ? value : null;
    }, {
      timeoutMs: options.timeoutMs ?? 15_000,
      description: `${EXPECTED_SURFACE.actions}-action/${EXPECTED_SURFACE.state}-state ACP surface`,
      retryErrors: false
    });
    const initialSnapshot = await waitFor(async () => {
      if (lifecycle.spawnError) throw lifecycle.spawnError;
      if (lifecycle.exit || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(terminationMessage(child, lifecycle, stderr));
      }
      if (client.socket.readyState !== 1) {
        throw new Error('ACP connection closed before benchmark state became ready');
      }
      const value = await readJson(paths.stateFile);
      return value?.ready === true ? value : null;
    }, {
      timeoutMs: options.timeoutMs ?? 15_000,
      description: 'ready benchmark state',
      retryErrors: false
    });

    return {
      appLaunchReadyMs: performance.now() - startedAt,
      child,
      client,
      description,
      initialSnapshot,
      lifecycle,
      paths,
      registration,
      runtimeDir,
      stderr,
      stdout
    };
  } catch (error) {
    const teardownErrors = [];
    if (client) {
      try {
        await withTimeout(client.close(), 2_000, 'ACP client close');
      } catch (teardownError) {
        client.socket?.terminate?.();
        teardownErrors.push(teardownError);
      }
    }
    try {
      await stopChild(child);
    } catch (teardownError) {
      teardownErrors.push(teardownError);
    }
    try {
      await fs.rm(controlDir, { recursive: true, force: true });
    } catch (teardownError) {
      teardownErrors.push(teardownError);
    }
    error.appStderr = stderr.join('');
    if (teardownErrors.length) error.teardownErrors = teardownErrors;
    throw error;
  }
}

async function stopChild(child, timeoutMs = 5_000) {
  if (!child) return null;
  let lifecycle = childLifecycles.get(child);
  if (!lifecycle && (child.exitCode !== null || child.signalCode !== null)) {
    return {
      code: child.exitCode,
      signal: child.signalCode,
      atMonotonicMs: performance.now()
    };
  }
  lifecycle ??= trackChild(child, false);

  if (lifecycle.close && (!lifecycle.ownsProcessGroup || !processGroupExists(child.pid))) {
    return lifecycle.close;
  }

  const failures = [];
  try {
    signalOwnedChild(child, lifecycle, 'SIGTERM');
  } catch (error) {
    failures.push(error);
  }
  try {
    return await waitForOwnedTreeClose(child, lifecycle, timeoutMs, 'Electron');
  } catch (error) {
    failures.push(error);
  }

  try {
    signalOwnedChild(child, lifecycle, 'SIGKILL');
  } catch (error) {
    failures.push(error);
  }
  try {
    return await waitForOwnedTreeClose(child, lifecycle, timeoutMs, 'forced Electron');
  } catch (error) {
    failures.push(error);
    throw new AggregateError(
      failures,
      `Failed to terminate benchmark Electron process tree ${child.pid}`
    );
  }
}

async function closeClient(client, timeoutMs) {
  if (!client) return;
  try {
    await withTimeout(client.close(), timeoutMs, 'ACP client close');
  } catch (error) {
    client.socket?.terminate?.();
    throw error;
  }
}

async function stopBenchmarkApp(instance, timeoutMs = 5_000) {
  if (!instance) return;
  const failures = [];
  try {
    await closeClient(instance.client, Math.min(timeoutMs, 2_000));
  } catch (error) {
    failures.push(error);
  }
  try {
    await stopChild(instance.child, timeoutMs);
  } catch (error) {
    failures.push(error);
  }
  if (instance.paths?.controlDir) {
    try {
      await fs.rm(instance.paths.controlDir, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, 'Benchmark app teardown failed');
  }
}

module.exports = {
  APP_ID,
  EXPECTED_SURFACE,
  EXPECTED_SURFACE_NAMES,
  createRuntimeDir,
  platformEnvironment,
  runtimePaths,
  startBenchmarkApp,
  stopChild,
  stopBenchmarkApp,
  surfaceIsReady
};
