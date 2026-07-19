const { execFileSync } = require('child_process');
const { createHash, randomUUID } = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const {
  MANIFEST_FILE,
  buildArtifactManifest,
  sha256File: sha256ArtifactFile
} = require('./artifact-integrity');
const {
  createRuntimeDir,
  startBenchmarkApp,
  stopBenchmarkApp
} = require('./app-process');
const { startDriver } = require('./driver-process');
const {
  classifyEvaluation,
  deriveMetrics,
  validateCapabilities
} = require('./harness-core');
const { readJson } = require('./protocol');
const { assertTrialRecord } = require('./schema');
const {
  FIXTURE_NAME,
  PROMPT,
  evaluateFinalEvent,
  evaluateInitialSnapshot,
  evaluateSnapshot,
  hashText
} = require('./scenario');
const {
  crossCheckAcpAudit,
  inspectDriverArtifacts,
  sanitizeArtifactTree,
  sanitizeJsonRecord,
  validateAgentEvidence,
  validateDriverEvents,
  validateDriverReady
} = require('./trial-validation');

const DEFAULT_WINDOW = Object.freeze({ x: 100, y: 80, width: 1200, height: 800 });
const RESERVED_DRIVER_ENV = new Set([
  'ACP_HOME',
  'ACP_BENCHMARK_APP_ID',
  'ACP_BENCHMARK_APP_PID',
  'ACP_BENCHMARK_ARTIFACT_DIR',
  'ACP_BENCHMARK_FIXTURE',
  'ACP_BENCHMARK_MODEL',
  'ACP_BENCHMARK_RENDER_DELAY_MS',
  'ACP_BENCHMARK_STATE_FILE',
  'ACP_BENCHMARK_USER_DATA_DIR',
  'ACP_BENCHMARK_VARIANT',
  'ACP_TEST_HEADLESS'
]);

async function writeAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, value, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function writeJson(file, value) {
  await writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(file, value) {
  await writeAtomic(file, value);
}

async function sha256File(file) {
  const data = await fs.readFile(file);
  return createHash('sha256').update(data).digest('hex');
}

function gitValue(appRoot, args, fallback = null) {
  try {
    return execFileSync('git', args, { cwd: appRoot, encoding: 'utf8' }).trim();
  } catch {
    return fallback;
  }
}

async function implementationIdentity(appRoot) {
  const appSdk = path.join(appRoot, 'vendor', 'appcontextprotocol-app-sdk-0.1.0.tgz');
  const protocol = path.join(appRoot, 'vendor', 'appcontextprotocol-protocol-0.1.0.tgz');
  return {
    appCommit: gitValue(appRoot, ['rev-parse', 'HEAD']),
    appWorkingTreeClean: gitValue(appRoot, ['status', '--porcelain'], '') === '',
    electronVersion: require('electron/package.json').version,
    appSdkTarballSha256: await sha256File(appSdk),
    protocolTarballSha256: await sha256File(protocol)
  };
}

function safeRegistration(registration) {
  const { token: _token, ...safe } = registration;
  return safe;
}

function driverEnvironment(variant, _appInstance, options = {}) {
  const baseNames = [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'SHELL',
    'USER',
    'LOGNAME',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
    'SystemRoot',
    'ComSpec',
    'PATHEXT'
  ];
  const env = {};
  for (const name of baseNames) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  for (const [name, value] of Object.entries(options.driverEnv ?? {})) {
    if (RESERVED_DRIVER_ENV.has(name)) {
      throw new Error(`Driver environment may not override reserved variable ${name}`);
    }
    env[name] = value;
  }

  env.ACP_HOME = options.emptyAcpHome;
  env.ACP_BENCHMARK_VARIANT = variant;
  env.ACP_BENCHMARK_MODEL = options.model ?? 'unspecified';
  env.ACP_BENCHMARK_ARTIFACT_DIR = options.driverOutputDir;
  return env;
}

async function sanitizedAudit(appInstance) {
  const auditFile = path.join(
    appInstance.paths.acpHome,
    'logs',
    `${appInstance.registration.appId}.jsonl`
  );
  try {
    const lines = (await fs.readFile(auditFile, 'utf8')).split('\n').filter(Boolean);
    return lines.map((line) => {
      const record = JSON.parse(line);
      return {
        ts: record.ts,
        action: record.action,
        status: record.status,
        durationMs: record.durationMs,
        ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode })
      };
    });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function createTrialId(variant) {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${timestamp}-${variant}-${randomUUID().slice(0, 8)}`;
}

async function createExclusiveDirectory(directory) {
  await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`Artifact directory already exists; refusing to reuse it: ${directory}`);
    }
    throw error;
  }
}

function initialStateFingerprint(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return JSON.stringify({
    fixture: snapshot.fixture,
    ready: snapshot.ready,
    tasks: snapshot.tasks,
    nextTaskId: snapshot.nextTaskId,
    table: snapshot.table,
    settings: snapshot.settings,
    ui: snapshot.ui
  });
}

function combinedEvaluation(stateEvaluation, finalEvaluation, completedWithinDeadline = false) {
  return {
    schemaVersion: 1,
    fixture: FIXTURE_NAME,
    promptHash: hashText(PROMPT),
    success: completedWithinDeadline,
    assertions: {
      ...stateEvaluation.assertions,
      finalResponseValid: finalEvaluation.success,
      completedWithinDeadline
    },
    state: stateEvaluation,
    final: finalEvaluation,
    observed: stateEvaluation.observed,
    evaluatedAt: new Date().toISOString()
  };
}

function asError(error, context) {
  if (error instanceof Error) {
    if (context) error.message = `${context}: ${error.message}`;
    return error;
  }
  return new Error(`${context ? `${context}: ` : ''}${String(error)}`);
}

function driverProvenance(driver, model) {
  return {
    provider: driver.provider ?? null,
    model,
    capabilityProfile: driver.capabilityProfile ?? null,
    agentConfigHash: driver.agentConfigHash ?? null,
    baseInstructionHash: driver.baseInstructionHash ?? null,
    samplingHash: driver.samplingHash ?? null,
    commandFile: driver.commandFile ?? null,
    commandFileSha256: driver.commandFileSha256 ?? null,
    adapterBuildHash: driver.adapterBuildHash ?? driver.commandFileSha256 ?? null,
    runtimeExecutable: driver.runtimeExecutable ?? null,
    runtimeExecutableSha256: driver.runtimeExecutableSha256 ?? null,
    envValueIdentityHash: driver.envValueIdentityHash ?? null,
    argsHash: hashText(JSON.stringify(driver.args ?? [])),
    explicitCwd: driver.cwd ? path.resolve(driver.cwd) : null
  };
}

function trialPublicationReasons(context) {
  const reasons = [];
  const provenance = context.provenance;
  if (context.configuredKind !== 'agent' || context.ready?.kind !== 'agent') reasons.push('non_agent_driver');
  if (!context.model || context.model === 'unspecified') reasons.push('model_not_pinned');
  if (!context.identity.appWorkingTreeClean) reasons.push('dirty_working_tree');
  if (!context.environmentFingerprint) reasons.push('missing_environment_fingerprint');
  if (!context.readyEvaluation.success) reasons.push('driver_attestation_failed');
  if (!context.eventValidation.valid) reasons.push('driver_protocol_invalid');
  if (!context.artifactInspection.valid) reasons.push('required_artifacts_invalid');
  if (!context.auditCheck.valid) reasons.push('acp_audit_mismatch');
  if (!context.artifactHygiene.clean) reasons.push('artifact_secret_redaction_required');
  if (!context.artifactIntegrity.valid) reasons.push('artifact_integrity_invalid');
  if (!context.agentEvidence.valid) reasons.push('missing_or_invalid_agent_evidence');
  if (context.headless) reasons.push('headless_trial');
  if (provenance.explicitCwd) reasons.push('nonisolated_driver_cwd');
  for (const field of [
    'provider',
    'agentConfigHash',
    'baseInstructionHash',
    'samplingHash',
    'capabilityProfile',
    'commandFile',
    'commandFileSha256',
    'adapterBuildHash',
    'runtimeExecutable',
    'runtimeExecutableSha256',
    'envValueIdentityHash'
  ]) {
    if (!provenance[field]) reasons.push(`missing_${field}`);
  }
  if (context.infrastructureError) reasons.push('infrastructure_failure');
  return [...new Set(reasons)];
}

async function runTrial(options) {
  const appRoot = path.resolve(options.appRoot ?? path.join(__dirname, '..'));
  const variant = options.variant;
  const trialId = options.trialId ?? createTrialId(variant);
  const artifactDir = path.resolve(options.artifactDir);
  const timeoutMs = Number(options.timeoutMs ?? 180_000);
  const evaluatorPollMs = Number(options.evaluatorPollMs ?? 10);
  const headless = options.headless ?? false;
  const model = options.model ?? 'unspecified';
  const configuredKind = options.driver.kind ?? 'agent';
  const identity = await implementationIdentity(appRoot);

  await createExclusiveDirectory(artifactDir);
  const runtimeDir = await createRuntimeDir(`acp-${trialId}-`);
  // Keep the baseline's empty ACP_HOME and working directory in unrelated
  // random roots. A screenshot/accessibility adapter must not be able to derive
  // the live ACP discovery directory from a sibling path it was given.
  const emptyAcpHome = await createRuntimeDir('acp-empty-home-');
  const driverCwd = await createRuntimeDir('acp-driver-cwd-');
  const driverOutputDir = path.join(artifactDir, 'driver-artifacts');
  await fs.mkdir(driverOutputDir, { recursive: true, mode: 0o700 });

  let appInstance;
  let driver;
  let result;
  let finalSnapshot = null;
  let stateEvaluation = evaluateSnapshot(null);
  let finalEvaluation = evaluateFinalEvent(null);
  let evaluation = combinedEvaluation(stateEvaluation, finalEvaluation, false);
  let initialEvaluation = null;
  let readyEvaluation = validateDriverReady(null, {
    kind: configuredKind,
    model,
    capabilityProfile: variant
  });
  let capabilityEvaluation = validateCapabilities(variant, []);
  let eventValidation = { valid: false, errors: ['driver did not start'], finalEvent: null };
  let artifactInspection = { valid: variant === 'acp', errors: [], artifacts: [] };
  let artifactHygiene = { clean: true, findings: [] };
  let artifactIntegrity = {
    valid: false,
    manifest: null,
    manifestSha256: null,
    fileCount: 0,
    totalBytes: 0
  };
  let agentEvidence = validateAgentEvidence([], {
    kind: configuredKind,
    provider: options.driver.provider,
    model
  });
  let auditCheck = { valid: false, errors: ['audit not checked'], attempts: 0, auditRecords: 0 };
  let audit = [];
  let environmentFingerprint = null;
  let taskStartedAt = null;
  let taskEndedAt = null;
  let stateSatisfiedAt = null;
  let finalSatisfiedAt = null;
  let timedOut = false;
  let infrastructureError = null;
  let interruptedError = null;
  let runtimeRemoved = false;
  let emptyHomeRemoved = false;
  let driverCwdRemoved = false;
  const provenance = driverProvenance(options.driver, model);
  const onSignal = (signal) => {
    interruptedError ??= Object.assign(new Error(`Benchmark interrupted by ${signal}`), {
      name: 'AbortError',
      code: 'ABORT_ERR'
    });
  };
  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  const recordInfrastructureError = (error, context) => {
    infrastructureError ??= asError(error, context);
  };
  const throwIfInterrupted = () => {
    if (interruptedError) throw interruptedError;
  };

  try {
    await writeText(path.join(artifactDir, 'prompt.txt'), `${PROMPT}\n`);
    try {
      appInstance = await startBenchmarkApp({
        appRoot,
        runtimeDir,
        headless,
        renderDelayMs: options.renderDelayMs ?? 0,
        window: options.window,
        timeoutMs: options.appTimeoutMs ?? 20_000
      });
      throwIfInterrupted();
      initialEvaluation = evaluateInitialSnapshot(appInstance.initialSnapshot);
      if (!initialEvaluation.success) {
        throw new Error(`Initial fixture failed: ${JSON.stringify(initialEvaluation.assertions)}`);
      }
      await writeJson(path.join(artifactDir, 'initial-state.json'), appInstance.initialSnapshot);
      const environmentRecord = {
        capturedAt: new Date().toISOString(),
        os: { platform: os.platform(), release: os.release(), arch: os.arch() },
        node: process.version,
        window: options.window ?? DEFAULT_WINDOW,
        startupRenderDelayMs: options.renderDelayMs ?? 0,
        headless,
        appReported: appInstance.initialSnapshot.environment,
        registration: safeRegistration(appInstance.registration),
        implementation: identity
      };
      environmentFingerprint = hashText(JSON.stringify({
        os: environmentRecord.os,
        node: environmentRecord.node,
        electronVersion: identity.electronVersion,
        configuredWindow: environmentRecord.window,
        headless,
        appReported: environmentRecord.appReported
      }));
      environmentRecord.environmentFingerprint = environmentFingerprint;
      await writeJson(path.join(artifactDir, 'environment.json'), environmentRecord);

      driver = await startDriver({
        command: options.driver.command,
        args: options.driver.args ?? [],
        cwd: options.driver.cwd ? path.resolve(options.driver.cwd) : driverCwd,
        env: driverEnvironment(variant, appInstance, {
          model,
          driverEnv: options.driver.env,
          emptyAcpHome,
          driverOutputDir
        }),
        artifactDir
      });
      const ready = await driver.waitUntilReady(options.driverReadyTimeoutMs ?? 15_000);
      throwIfInterrupted();
      readyEvaluation = validateDriverReady(ready, {
        name: options.driver.name,
        kind: configuredKind,
        model,
        capabilityProfile: variant
      });
      if (!readyEvaluation.success) {
        throw new Error(`Driver attestation mismatch: ${JSON.stringify(readyEvaluation.assertions)}`);
      }
      capabilityEvaluation = validateCapabilities(variant, ready.capabilities);
      if (!capabilityEvaluation.valid) {
        throw new Error(
          `Driver capability mismatch: expected ${capabilityEvaluation.expected.join(', ')}, got ${capabilityEvaluation.actual.join(', ')}`
        );
      }
      eventValidation = validateDriverEvents(driver.events, { variant, taskStartedAt: null, complete: false });
      if (!eventValidation.valid) {
        throw new Error(`Driver worked before start: ${eventValidation.errors.join('; ')}`);
      }

      const preStartSnapshot = await readJson(appInstance.paths.stateFile);
      const preStartEvaluation = evaluateInitialSnapshot(preStartSnapshot);
      const preStartAudit = await sanitizedAudit(appInstance);
      if (
        !preStartEvaluation.success
        || initialStateFingerprint(preStartSnapshot) !== initialStateFingerprint(appInstance.initialSnapshot)
        || preStartAudit.length !== 0
      ) {
        throw new Error('Fixture or ACP audit changed between app readiness and timed start');
      }

      taskStartedAt = performance.now();
      const deadline = taskStartedAt + timeoutMs;
      driver.send({
        type: 'start',
        schemaVersion: 1,
        prompt: PROMPT,
        promptHash: hashText(PROMPT),
        fixture: FIXTURE_NAME,
        variant,
        capabilityProfile: variant,
        model,
        capabilities: capabilityEvaluation.actual,
        artifactDirectory: driverOutputDir,
        app: {
          appId: appInstance.registration.appId,
          pid: appInstance.child.pid,
          windowTitle: 'Computer-Use Test Bench',
          ...(['acp', 'hybrid'].includes(variant)
            ? { acpHome: appInstance.paths.acpHome }
            : {})
        }
      });

      while (true) {
        throwIfInterrupted();
        if (driver.resourceError) {
          throw new Error(`Driver resource limit exceeded: ${driver.resourceError.message}`);
        }
        if (driver.parseErrors.length) {
          throw new Error(`Driver emitted invalid JSON: ${driver.parseErrors[0].error}`);
        }
        eventValidation = validateDriverEvents(driver.events, {
          variant,
          taskStartedAt,
          complete: false
        });
        if (!eventValidation.valid) {
          throw new Error(`Driver protocol violation: ${eventValidation.errors.join('; ')}`);
        }
        if (appInstance.child.exitCode !== null || appInstance.child.signalCode !== null) {
          throw new Error(
            `Electron exited during the task (code ${appInstance.child.exitCode ?? 'null'}, signal ${appInstance.child.signalCode ?? 'null'})`
          );
        }

        finalSnapshot = await readJson(appInstance.paths.stateFile);
        const observedAt = performance.now();
        if (observedAt >= deadline) {
          timedOut = true;
          taskEndedAt = observedAt;
          break;
        }
        stateEvaluation = evaluateSnapshot(finalSnapshot);
        const finalEvent = eventValidation.finalEvent;
        finalEvaluation = evaluateFinalEvent(finalEvent);
        if (stateEvaluation.success && stateSatisfiedAt === null) stateSatisfiedAt = observedAt;
        if (
          finalEvaluation.success
          && finalEvent.harnessReceivedMonotonicMs <= deadline
          && finalSatisfiedAt === null
        ) {
          finalSatisfiedAt = finalEvent.harnessReceivedMonotonicMs;
        }
        if (stateSatisfiedAt !== null && finalSatisfiedAt !== null) {
          taskEndedAt = Math.max(stateSatisfiedAt, finalSatisfiedAt);
          break;
        }

        const terminalAt = driver.closed?.atMonotonicMs
          ?? driver.exit?.atMonotonicMs
          ?? finalEvent?.harnessReceivedMonotonicMs;
        if (terminalAt && observedAt - terminalAt >= Math.max(250, evaluatorPollMs * 2)) {
          if (!finalEvent) throw new Error('Driver became terminal without a final event');
          // A valid final may race the renderer-to-main atomic state writer.
          // Keep polling until state success or the task deadline so storage
          // latency cannot turn a correct agent result into a false failure.
          if (!finalEvaluation.success) {
            taskEndedAt = observedAt;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, evaluatorPollMs));
      }
    } catch (error) {
      recordInfrastructureError(error);
      if (taskStartedAt !== null && taskEndedAt === null) taskEndedAt = performance.now();
    }

    if (driver) {
      let stopResult = null;
      try {
        stopResult = await driver.stop('trial_complete');
      } catch (error) {
        recordInfrastructureError(error, 'Driver teardown failed');
      }
      if (driver.resourceError) {
        recordInfrastructureError(
          new Error(`Driver resource limit exceeded: ${driver.resourceError.message}`)
        );
      } else if (driver.parseErrors.length) {
        recordInfrastructureError(
          new Error(`Driver emitted invalid JSON: ${driver.parseErrors[0].error}`)
        );
      }
      eventValidation = validateDriverEvents(driver.events, {
        variant,
        taskStartedAt,
        complete: !timedOut
      });
      if (!eventValidation.valid) {
        recordInfrastructureError(new Error(`Driver protocol violation: ${eventValidation.errors.join('; ')}`));
      }
      const expectedTimeoutTermination = timedOut
        && stopResult?.close?.code === driver.exit?.code
        && stopResult?.close?.signal === driver.exit?.signal
        && ['SIGTERM', 'SIGKILL'].includes(driver.exit?.signal);
      if (
        !driver.exit
        || (!expectedTimeoutTermination && (driver.exit.code !== 0 || driver.exit.signal !== null))
      ) {
        recordInfrastructureError(new Error(
          `Driver exited abnormally (code ${driver.exit?.code ?? 'unknown'}, signal ${driver.exit?.signal ?? 'unknown'})`
        ));
      }
      agentEvidence = validateAgentEvidence(driver.events, {
        kind: configuredKind,
        provider: options.driver.provider,
        model
      });
    }

    if (appInstance) {
      try {
        finalSnapshot = await readJson(appInstance.paths.stateFile) ?? finalSnapshot;
        stateEvaluation = evaluateSnapshot(finalSnapshot);
        const finalEvent = eventValidation.finalEvent
          ?? driver?.events.find((event) => event.type === 'final');
        finalEvaluation = evaluateFinalEvent(finalEvent);
        audit = await sanitizedAudit(appInstance);
        await writeJson(path.join(artifactDir, 'audit.sanitized.json'), audit);
      } catch (error) {
        recordInfrastructureError(error, 'Final app artifact capture failed');
      }
      try {
        await stopBenchmarkApp(appInstance);
      } catch (error) {
        recordInfrastructureError(error, 'Electron teardown failed');
      }
      try {
        await writeText(path.join(artifactDir, 'app.stdout.log'), appInstance.stdout.join(''));
        await writeText(path.join(artifactDir, 'app.stderr.log'), appInstance.stderr.join(''));
      } catch (error) {
        recordInfrastructureError(error, 'App log capture failed');
      }
    }

    const completedWithinDeadline = !timedOut
      && stateSatisfiedAt !== null
      && finalSatisfiedAt !== null;
    evaluation = combinedEvaluation(stateEvaluation, finalEvaluation, completedWithinDeadline);
    if (finalSnapshot) await writeJson(path.join(artifactDir, 'final-state.json'), finalSnapshot);
    await writeJson(path.join(artifactDir, 'evaluator.json'), evaluation);

    const knownSecrets = [
        appInstance?.registration?.token,
        runtimeDir,
        appInstance?.paths?.acpHome,
        appInstance?.paths?.controlDir,
        appInstance?.paths?.stateFile,
        appInstance?.paths?.userDataDir,
        emptyAcpHome,
        driverCwd,
        driverOutputDir,
        ...Object.values(options.driver.env ?? {})
    ];
    try {
      artifactHygiene = await sanitizeArtifactTree(artifactDir, knownSecrets);
      artifactInspection = await inspectDriverArtifacts(driver?.events ?? [], driverOutputDir, variant);
      auditCheck = crossCheckAcpAudit(driver?.events ?? [], audit, variant);
      if (!artifactInspection.valid) {
        recordInfrastructureError(new Error(`Driver artifact validation failed: ${artifactInspection.errors.join('; ')}`));
      }
      if (!auditCheck.valid) {
        recordInfrastructureError(new Error(`ACP audit validation failed: ${auditCheck.errors.join('; ')}`));
      }
    } catch (error) {
      recordInfrastructureError(error, 'Artifact validation failed');
    }

    try {
      await fs.rm(runtimeDir, { recursive: true, force: true });
      runtimeRemoved = true;
      await fs.rm(emptyAcpHome, { recursive: true, force: true });
      emptyHomeRemoved = true;
      await fs.rm(driverCwd, { recursive: true, force: true });
      driverCwdRemoved = true;
    } catch (error) {
      recordInfrastructureError(error, 'Runtime cleanup failed');
    }

    try {
      const manifest = await buildArtifactManifest(artifactDir);
      const manifestFile = path.join(artifactDir, MANIFEST_FILE);
      await writeJson(manifestFile, manifest);
      artifactIntegrity = {
        valid: true,
        manifest: MANIFEST_FILE,
        manifestSha256: await sha256ArtifactFile(manifestFile),
        fileCount: manifest.fileCount,
        totalBytes: manifest.totalBytes
      };
    } catch (error) {
      recordInfrastructureError(error, 'Artifact manifest creation failed');
      artifactIntegrity = {
        ...artifactIntegrity,
        error: error.message
      };
    }

    const finalEvent = eventValidation.finalEvent
      ?? driver?.events.find((event) => event.type === 'final');
    const publicationReasons = trialPublicationReasons({
      artifactHygiene,
      artifactIntegrity,
      agentEvidence,
      artifactInspection,
      auditCheck,
      configuredKind,
      eventValidation,
      environmentFingerprint,
      finalEvaluation,
      headless,
      identity,
      infrastructureError,
      model,
      provenance,
      ready: driver?.events.find((event) => event.type === 'driver.ready'),
      readyEvaluation
    });
    const outcome = classifyEvaluation(evaluation, {
      timedOut,
      infrastructureFailure: Boolean(infrastructureError)
    });
    result = {
      schemaVersion: 1,
      trialId,
      variant,
      fixture: FIXTURE_NAME,
      promptHash: hashText(PROMPT),
      model,
      driver: {
        name: readyEvaluation.observed.name ?? options.driver.name ?? path.basename(options.driver.command),
        kind: readyEvaluation.observed.kind ?? configuredKind,
        configuredName: options.driver.name ?? null,
        configuredKind,
        capabilities: capabilityEvaluation.actual,
        attestation: readyEvaluation,
        provenance,
        exit: driver?.exit ?? null
      },
      measurementEligible: publicationReasons.length === 0,
      publishable: publicationReasons.length === 0,
      publicationReasons,
      outcome,
      timing: {
        appLaunchReadyMs: appInstance?.appLaunchReadyMs ?? null,
        endToEndMs: taskStartedAt === null || taskEndedAt === null
          ? null
          : Math.max(0, taskEndedAt - taskStartedAt),
        stateSatisfiedMs: taskStartedAt === null || stateSatisfiedAt === null
          ? null
          : stateSatisfiedAt - taskStartedAt,
        agentFinalMs: taskStartedAt === null || !finalEvent
          ? null
          : Math.max(0, finalEvent.harnessReceivedMonotonicMs - taskStartedAt),
        evaluatorLagMs: stateSatisfiedAt === null || finalSatisfiedAt === null
          ? null
          : stateSatisfiedAt - finalSatisfiedAt,
        completedWithinDeadline,
        timeoutMs,
        evaluatorPollMs
      },
      metrics: deriveMetrics(driver?.events ?? []),
      initialFixture: initialEvaluation,
      evaluation,
      finalEvaluation,
      protocolValidation: {
        valid: eventValidation.valid,
        errors: eventValidation.errors
      },
      agentEvidence,
      auditValidation: auditCheck,
      artifactValidation: {
        ...artifactInspection,
        hygiene: artifactHygiene
      },
      artifactIntegrity,
      implementation: identity,
      environmentFingerprint,
      perturbation: {
        window: options.window ?? DEFAULT_WINDOW,
        startupRenderDelayMs: options.renderDelayMs ?? 0,
        headless
      },
      infrastructureError: infrastructureError
        ? { name: infrastructureError.name, message: infrastructureError.message }
        : null,
      artifacts: {
        transcript: driver ? 'transcript.jsonl' : null,
        evaluator: 'evaluator.json',
        initialState: appInstance ? 'initial-state.json' : null,
        finalState: finalSnapshot ? 'final-state.json' : null,
        environment: appInstance ? 'environment.json' : null,
        audit: appInstance ? 'audit.sanitized.json' : null,
        appStdout: appInstance ? 'app.stdout.log' : null,
        appStderr: appInstance ? 'app.stderr.log' : null,
        driverStderr: driver ? 'driver.stderr.log' : null,
        manifest: artifactIntegrity.valid ? MANIFEST_FILE : null,
        driverObservations: artifactInspection.artifacts
      },
      cleanup: {
        runtimeRemoved,
        emptyAcpHomeRemoved: emptyHomeRemoved,
        driverCwdRemoved
      },
      recordedAt: new Date().toISOString()
    };
    const sanitizedResult = sanitizeJsonRecord(result, knownSecrets);
    result = sanitizedResult.value;
    if (!sanitizedResult.clean) {
      artifactHygiene = {
        clean: false,
        findings: [...artifactHygiene.findings, ...sanitizedResult.findings]
      };
      result.artifactValidation.hygiene = artifactHygiene;
      result.publicationReasons = [
        ...new Set([...result.publicationReasons, 'artifact_secret_redaction_required'])
      ];
      result.measurementEligible = false;
      result.publishable = false;
    }
    assertTrialRecord(result);
    await writeJson(path.join(artifactDir, 'trial.json'), result);
    if (interruptedError) throw interruptedError;
    return result;
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    if (driver && !driver.exit) await driver.stop('forced_cleanup').catch(() => {});
    if (appInstance && appInstance.child.exitCode === null && appInstance.child.signalCode === null) {
      await stopBenchmarkApp(appInstance).catch(() => {});
    }
    await fs.rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(emptyAcpHome, { recursive: true, force: true }).catch(() => {});
    await fs.rm(driverCwd, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  RESERVED_DRIVER_ENV,
  createTrialId,
  driverEnvironment,
  implementationIdentity,
  runTrial,
  writeJson,
  writeText
};
