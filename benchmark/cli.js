#!/usr/bin/env node

const { execFileSync } = require('child_process');
const { createHash, randomUUID } = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { verifyArtifactManifest } = require('./artifact-integrity');
const {
  createRuntimeDir,
  startBenchmarkApp,
  stopBenchmarkApp
} = require('./app-process');
const {
  COMPARISON_IDENTITY_HASH_FIELDS,
  MIN_PUBLISHABLE_TRIALS_PER_VARIANT,
  createSchedule,
  summarizeTrials,
  VARIANTS
} = require('./harness-core');
const { evaluateInitialSnapshot } = require('./scenario');
const {
  RESERVED_DRIVER_ENV,
  implementationIdentity,
  runTrial,
  writeJson,
  writeText
} = require('./run-trial');
const { assertTrialRecord } = require('./schema');
const { sanitizeJsonRecord } = require('./trial-validation');

const appRoot = path.resolve(__dirname, '..');
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalValue(value[key])])
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256File(file) {
  return sha256(await fs.readFile(file));
}

function assertSha256(value, description) {
  if (
    typeof value !== 'string'
    || !SHA256_PATTERN.test(value)
    || value === '0'.repeat(64)
  ) {
    throw new Error(`${description} must be a lowercase SHA-256 hex digest`);
  }
}

function gitBuffer(args) {
  try {
    return execFileSync('git', args, { cwd: appRoot, maxBuffer: 100 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`Could not fingerprint benchmark implementation: ${error.message}`);
  }
}

async function workspaceStateSha256() {
  const status = gitBuffer(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const workingDiff = gitBuffer(['diff', '--binary', 'HEAD', '--']);
  const stagedDiff = gitBuffer(['diff', '--cached', '--binary', 'HEAD', '--']);
  const untrackedOutput = gitBuffer(['ls-files', '--others', '--exclude-standard', '-z']);
  const untracked = untrackedOutput.toString('utf8').split('\0').filter(Boolean).sort();
  const hash = createHash('sha256');
  hash.update(status);
  hash.update(workingDiff);
  hash.update(stagedDiff);
  for (const relativeFile of untracked) {
    hash.update(relativeFile);
    hash.update('\0');
    hash.update(await fs.readFile(path.join(appRoot, relativeFile)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function currentImplementationProvenance() {
  const details = await implementationIdentity(appRoot);
  const workspaceState = await workspaceStateSha256();
  return {
    details,
    workspaceStateSha256: workspaceState,
    identityHash: sha256(canonicalJson({ details, workspaceStateSha256: workspaceState }))
  };
}

function parseArgs(argv) {
  const separator = argv.indexOf('--');
  const primary = separator === -1 ? argv : argv.slice(0, separator);
  const passthrough = separator === -1 ? [] : argv.slice(separator + 1);
  const command = primary.shift();
  const options = {};
  for (let index = 0; index < primary.length; index++) {
    const token = primary[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const [rawName, inlineValue] = token.slice(2).split(/=(.*)/s);
    if (inlineValue !== undefined) {
      options[rawName] = inlineValue;
      continue;
    }
    const next = primary[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options[rawName] = next;
      index += 1;
    } else {
      options[rawName] = true;
    }
  }
  return { command, options, passthrough };
}

function numberOption(options, name, fallback) {
  if (options[name] === undefined) return fallback;
  const value = Number(options[name]);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be numeric`);
  return value;
}

function booleanOption(options, name, fallback = false) {
  if (options[name] === undefined) return fallback;
  if (options[name] === true || options[name] === 'true' || options[name] === '1') return true;
  if (options[name] === 'false' || options[name] === '0') return false;
  throw new Error(`--${name} must be true or false`);
}

function driverConfigHash(driver) {
  const { driverConfigHash: _storedHash, ...pinned } = driver;
  return sha256(canonicalJson(pinned));
}

function environmentValueIdentity(envNames) {
  return sha256(canonicalJson(Object.fromEntries(
    [...envNames].sort().map((name) => [
      name,
      process.env[name] === undefined ? null : String(process.env[name])
    ])
  )));
}

async function resolveExecutable(command) {
  const candidates = [];
  if (path.isAbsolute(command)) {
    candidates.push(command);
  } else {
    for (const directory of String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
      candidates.push(path.join(directory, command));
    }
  }
  for (const candidate of candidates) {
    try {
      const resolved = await fs.realpath(candidate);
      const stat = await fs.stat(resolved);
      if (stat.isFile()) return resolved;
    } catch {
      // Keep searching the executable PATH.
    }
  }
  throw new Error(`Driver command executable could not be resolved: ${command}`);
}

async function safeDriver(driver, variant) {
  if (!path.isAbsolute(driver.commandFile)) {
    throw new Error('Driver commandFile must be an absolute adapter entrypoint path');
  }
  const commandFile = await fs.realpath(driver.commandFile);
  const commandFileStat = await fs.stat(commandFile);
  if (!commandFileStat.isFile()) throw new Error(`Driver commandFile is not a file: ${commandFile}`);
  let commandFileIsInvoked = false;
  let pinnedCommand = driver.command;
  const pinnedArgs = [...(driver.args ?? [])];
  for (const [index, candidate] of [driver.command, ...pinnedArgs].entries()) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) continue;
    try {
      if (await fs.realpath(candidate) === commandFile) {
        commandFileIsInvoked = true;
        if (index === 0) pinnedCommand = commandFile;
        else pinnedArgs[index - 1] = commandFile;
      }
    } catch {
      // Non-file arguments are not adapter entrypoints.
    }
  }
  if (!commandFileIsInvoked) {
    throw new Error('Driver command or arguments must invoke the absolute commandFile entrypoint');
  }
  const kind = driver.kind ?? 'agent';
  const identitySourceFiles = {};
  if (kind === 'agent') {
    for (const [hashField, sourceField] of [
      ['agentConfigHash', 'agentConfigFile'],
      ['baseInstructionHash', 'baseInstructionFile'],
      ['samplingHash', 'samplingFile']
    ]) {
      if (!path.isAbsolute(driver[sourceField])) {
        throw new Error(`drivers.${variant}.${sourceField} must be an absolute provenance file`);
      }
      const source = await fs.realpath(driver[sourceField]);
      const stat = await fs.stat(source);
      if (!stat.isFile()) throw new Error(`drivers.${variant}.${sourceField} is not a file`);
      const actualHash = await sha256File(source);
      if (actualHash !== driver[hashField]) {
        throw new Error(`drivers.${variant}.${hashField} does not match ${sourceField}`);
      }
      identitySourceFiles[sourceField] = source;
    }
  }
  const commandFileSha256 = await sha256File(commandFile);
  const runtimeExecutable = await resolveExecutable(pinnedCommand);
  const runtimeExecutableSha256 = await sha256File(runtimeExecutable);
  const envNames = [...new Set(driver.envNames ?? [])].sort();
  for (const name of envNames) {
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`drivers.${variant}.envNames contains an invalid environment variable name`);
    }
    if (RESERVED_DRIVER_ENV.has(name)) {
      throw new Error(`drivers.${variant}.envNames contains reserved variable ${name}`);
    }
  }
  const pinned = {
    command: pinnedCommand,
    args: pinnedArgs,
    ...(driver.cwd ? { cwd: path.resolve(driver.cwd) } : {}),
    name: driver.name,
    kind,
    model: driver.model,
    provider: driver.provider,
    capabilityProfile: driver.capabilityProfile,
    agentConfigHash: driver.agentConfigHash,
    baseInstructionHash: driver.baseInstructionHash,
    samplingHash: driver.samplingHash,
    ...identitySourceFiles,
    commandFile,
    commandFileSha256,
    adapterBuildHash: commandFileSha256,
    runtimeExecutable,
    runtimeExecutableSha256,
    envNames,
    envValueIdentityHash: environmentValueIdentity(envNames)
  };
  return { ...pinned, driverConfigHash: driverConfigHash(pinned) };
}

function resolveDriver(driver) {
  const currentIdentity = environmentValueIdentity(driver.envNames ?? []);
  if (currentIdentity !== driver.envValueIdentityHash) {
    throw new Error('Driver environment values changed since run creation; start a new run');
  }
  const env = {};
  for (const name of driver.envNames ?? []) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return { ...driver, env };
}

function runIdNow() {
  return `benchmark-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
}

function validateRunId(value) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 100
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
    || value.includes('..')
  ) {
    throw new Error('runId must be 1-100 safe filename characters without path traversal');
  }
  return value;
}

async function createExclusiveRunDirectory(directory) {
  await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`Output directory already exists; refusing to reuse it: ${directory}`);
    }
    throw error;
  }
}

function artifactNameForEntry(entry) {
  return `${String(entry.index).padStart(4, '0')}-${entry.variant}`;
}

function artifactRelativeForEntry(entry) {
  return `trials/${artifactNameForEntry(entry)}/trial.json`;
}

async function safeRecordedTrialFile(runDir, relative, entry) {
  const expected = artifactRelativeForEntry(entry);
  if (relative !== expected || path.isAbsolute(relative) || relative.includes('\\')) {
    throw new Error(`Recorded artifact must equal the scheduled path ${expected}`);
  }
  const trialsRoot = path.resolve(runDir, 'trials');
  const trialDirectory = path.dirname(path.resolve(runDir, relative));
  const target = path.resolve(runDir, relative);
  if (
    !trialDirectory.startsWith(`${trialsRoot}${path.sep}`)
    || !target.startsWith(`${trialsRoot}${path.sep}`)
  ) {
    throw new Error('Recorded artifact escapes the run trials directory');
  }
  for (const candidate of [trialsRoot, trialDirectory, target]) {
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink()) throw new Error(`Recorded artifact path contains a symlink: ${candidate}`);
  }
  const fileStat = await fs.lstat(target);
  if (!fileStat.isFile()) throw new Error(`Recorded artifact is not a regular file: ${target}`);
  return target;
}

async function assertSafeTrialsRoot(runDir, options = {}) {
  const trialsRoot = path.join(runDir, 'trials');
  try {
    const stat = await fs.lstat(trialsRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Run trials root must be a non-symlink directory');
    }
  } catch (error) {
    if (error.code !== 'ENOENT' || !options.create) throw error;
    await fs.mkdir(trialsRoot, { mode: 0o700 });
    const stat = await fs.lstat(trialsRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Run trials root must be a non-symlink directory');
    }
  }
  return trialsRoot;
}

async function writeRunState(runDir, runState) {
  runState.updatedAt = new Date().toISOString();
  await writeJson(path.join(runDir, 'run.json'), runState);
}

async function reconcilePreservationJournal(runDir, runState) {
  const trialsRoot = await assertSafeTrialsRoot(runDir);
  let changed = false;
  for (const attempt of runState.interruptedAttempts ?? []) {
    if (attempt.status !== 'preserving' || !attempt.sourceArtifact || !attempt.intendedArtifact) continue;
    const source = path.resolve(runDir, attempt.sourceArtifact);
    const destination = path.resolve(runDir, attempt.intendedArtifact);
    if (
      !source.startsWith(`${trialsRoot}${path.sep}`)
      || !destination.startsWith(`${trialsRoot}${path.sep}`)
    ) throw new Error('Preservation journal entry escapes the trials root');
    const sourceStat = await fs.lstat(source).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const destinationStat = await fs.lstat(destination).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (sourceStat?.isSymbolicLink() || destinationStat?.isSymbolicLink()) {
      throw new Error('Preservation journal path contains a symlink');
    }
    if (sourceStat && destinationStat) {
      throw new Error('Preservation journal source and destination both exist');
    }
    if (sourceStat) {
      if (!sourceStat.isDirectory()) throw new Error('Preservation source is not a directory');
      await fs.rename(source, destination);
    } else if (!destinationStat) {
      attempt.status = 'missing';
      attempt.reason = `${attempt.reason}; preservation source was missing during recovery`;
      changed = true;
      continue;
    } else if (!destinationStat.isDirectory()) {
      throw new Error('Preservation destination is not a directory');
    }
    attempt.artifact = attempt.intendedArtifact;
    attempt.status = 'preserved';
    attempt.preservedAt = new Date().toISOString();
    changed = true;
  }
  if (changed) await writeRunState(runDir, runState);
}

async function preserveScheduledDirectory(runDir, runState, entry, reason, label = 'invalid') {
  const trialsRoot = await assertSafeTrialsRoot(runDir);
  const sourceName = artifactNameForEntry(entry);
  const source = path.join(trialsRoot, sourceName);
  const sourceStat = await fs.lstat(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new Error('Interrupted artifact path must be a non-symlink directory');
  }
  const destinationName = `${sourceName}.${label}-${Date.now()}-${randomUUID()}`;
  const sourceArtifact = `trials/${sourceName}`;
  const intendedArtifact = `trials/${destinationName}`;
  const attempt = {
    ...entry,
    artifact: sourceArtifact,
    sourceArtifact,
    intendedArtifact,
    reason,
    status: 'preserving',
    detectedAt: new Date().toISOString()
  };
  runState.interruptedAttempts ??= [];
  runState.interruptedAttempts.push(attempt);
  await writeRunState(runDir, runState);
  await fs.rename(source, path.join(trialsRoot, destinationName));
  attempt.artifact = intendedArtifact;
  attempt.status = 'preserved';
  attempt.preservedAt = new Date().toISOString();
  await writeRunState(runDir, runState);
  return attempt;
}

async function discoverUntrackedTrialDirectories(runDir, runState) {
  const trialsRoot = await assertSafeTrialsRoot(runDir);
  const scheduled = new Set((runState.schedule ?? []).map(artifactNameForEntry));
  const tracked = new Set((runState.interruptedAttempts ?? [])
    .flatMap((attempt) => [attempt.artifact, attempt.sourceArtifact, attempt.intendedArtifact])
    .filter(Boolean)
    .map((relative) => path.basename(relative)));
  let changed = false;
  for (const name of await fs.readdir(trialsRoot)) {
    const candidate = path.join(trialsRoot, name);
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Unexpected non-directory entry in trials root: ${name}`);
    }
    if (scheduled.has(name) || tracked.has(name)) continue;
    runState.interruptedAttempts ??= [];
    runState.interruptedAttempts.push({
      artifact: `trials/${name}`,
      reason: 'untracked artifact directory recovered after an interrupted journal write',
      status: 'discovered',
      discoveredAt: new Date().toISOString()
    });
    tracked.add(name);
    changed = true;
  }
  if (changed) await writeRunState(runDir, runState);
}

async function readConfig(file) {
  const resolved = path.resolve(file);
  const source = await fs.readFile(resolved);
  const config = JSON.parse(source.toString('utf8'));
  return { config, resolved, sourceSha256: sha256(source) };
}

function comparisonIdentity(config, variants) {
  const first = config.drivers[variants[0]];
  return {
    model: first.model,
    provider: first.provider,
    agentConfigHash: first.agentConfigHash,
    baseInstructionHash: first.baseInstructionHash,
    samplingHash: first.samplingHash
  };
}

function normalizedProfileArgs(driver, variant) {
  const args = [...(driver.args ?? [])];
  let bindings = 0;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--profile') {
      if (args[index + 1] !== variant) {
        throw new Error(`--profile must be followed by capabilityProfile ${variant}`);
      }
      args[index + 1] = '<CAPABILITY_PROFILE>';
      bindings += 1;
      index += 1;
    } else if (args[index] === `--profile=${variant}`) {
      args[index] = '--profile=<CAPABILITY_PROFILE>';
      bindings += 1;
    } else if (typeof args[index] === 'string' && args[index].startsWith('--profile=')) {
      throw new Error(`--profile must equal capabilityProfile ${variant}`);
    }
  }
  if (bindings > 1) throw new Error(`drivers.${variant}.args contains multiple --profile bindings`);
  return args;
}

function validateRunConfig(config, options = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Config must be a JSON object');
  }
  if (config.schemaVersion !== undefined && config.schemaVersion !== 1) {
    throw new Error('Config schemaVersion must equal 1');
  }
  if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0)) {
    throw new Error('timeoutMs must be a positive integer');
  }
  if (
    config.renderDelayMs !== undefined
    && (!Number.isInteger(config.renderDelayMs) || config.renderDelayMs < 0)
  ) {
    throw new Error('renderDelayMs must be a non-negative integer');
  }
  if (config.headless !== undefined && typeof config.headless !== 'boolean') {
    throw new Error('headless must be boolean');
  }
  if (
    config.seed !== undefined
    && !['string', 'number'].includes(typeof config.seed)
  ) {
    throw new Error('seed must be a string or number');
  }
  if (typeof config.seed === 'string' && config.seed.length === 0) {
    throw new Error('seed must not be empty');
  }
  if (config.window !== undefined) {
    if (!config.window || typeof config.window !== 'object' || Array.isArray(config.window)) {
      throw new Error('window must be an object');
    }
    const allowed = new Set(['x', 'y', 'width', 'height']);
    for (const key of Object.keys(config.window)) {
      if (!allowed.has(key)) throw new Error(`window contains unknown field ${key}`);
    }
    for (const field of ['x', 'y', 'width', 'height']) {
      if (!Number.isInteger(config.window[field])) throw new Error(`window.${field} must be an integer`);
    }
    if (config.window.width <= 0 || config.window.height <= 0) {
      throw new Error('window width and height must be positive');
    }
  }
  const variants = config.variants ?? VARIANTS;
  if (!Array.isArray(variants) || variants.length === 0) throw new Error('Config needs variants');
  for (const variant of variants) {
    if (!VARIANTS.includes(variant)) throw new Error(`Unknown variant in config: ${variant}`);
    const driver = config.drivers?.[variant];
    if (typeof driver?.command !== 'string' || !driver.command) {
      throw new Error(`Config needs drivers.${variant}.command`);
    }
    if (driver.args !== undefined && (
      !Array.isArray(driver.args)
      || driver.args.some((argument) => typeof argument !== 'string')
    )) throw new Error(`drivers.${variant}.args must be an array of strings`);
    if (driver.envNames !== undefined && (
      !Array.isArray(driver.envNames)
      || driver.envNames.some((name) => (
        typeof name !== 'string'
        || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
        || RESERVED_DRIVER_ENV.has(name)
      ))
      || new Set(driver.envNames).size !== driver.envNames.length
    )) throw new Error(`drivers.${variant}.envNames must contain unique, non-reserved variable names`);
    for (const field of ['name', 'kind', 'model', 'provider', 'capabilityProfile']) {
      if (driver[field] !== undefined && (typeof driver[field] !== 'string' || !driver[field])) {
        throw new Error(`drivers.${variant}.${field} must be a non-empty string`);
      }
    }
    if (!driver.model) throw new Error(`Config needs drivers.${variant}.model`);
    if (!driver.provider) throw new Error(`Config needs drivers.${variant}.provider`);
    if (!driver.commandFile) throw new Error(`Config needs drivers.${variant}.commandFile`);
    if (!path.isAbsolute(driver.commandFile)) {
      throw new Error(`drivers.${variant}.commandFile must be absolute`);
    }
    for (const field of COMPARISON_IDENTITY_HASH_FIELDS) {
      assertSha256(driver[field], `drivers.${variant}.${field}`);
    }
    if (driver.capabilityProfile !== variant) {
      throw new Error(`drivers.${variant}.capabilityProfile must equal ${variant}`);
    }
    if ((driver.kind ?? 'agent') === 'agent') {
      for (const field of ['agentConfigFile', 'baseInstructionFile', 'samplingFile']) {
        if (!path.isAbsolute(driver[field] ?? '')) {
          throw new Error(`drivers.${variant}.${field} must be absolute`);
        }
      }
    }
    if (options.requirePins) {
      assertSha256(driver.commandFileSha256, `drivers.${variant}.commandFileSha256`);
      assertSha256(driver.adapterBuildHash, `drivers.${variant}.adapterBuildHash`);
      if (!path.isAbsolute(driver.runtimeExecutable ?? '')) {
        throw new Error(`drivers.${variant}.runtimeExecutable must be absolute`);
      }
      assertSha256(driver.runtimeExecutableSha256, `drivers.${variant}.runtimeExecutableSha256`);
      assertSha256(driver.envValueIdentityHash, `drivers.${variant}.envValueIdentityHash`);
      if (driver.adapterBuildHash !== driver.commandFileSha256) {
        throw new Error(`drivers.${variant}.adapterBuildHash must match commandFileSha256`);
      }
      assertSha256(driver.driverConfigHash, `drivers.${variant}.driverConfigHash`);
      if (driverConfigHash(driver) !== driver.driverConfigHash) {
        throw new Error(`drivers.${variant}.driverConfigHash does not match its pinned configuration`);
      }
    }
  }
  if (new Set(variants).size !== variants.length) throw new Error('Config variants must be unique');
  const identity = comparisonIdentity(config, variants);
  const firstDriver = config.drivers[variants[0]];
  for (const variant of variants.slice(1)) {
    const driver = config.drivers[variant];
    for (const field of ['model', 'provider', ...COMPARISON_IDENTITY_HASH_FIELDS]) {
      if (driver[field] !== identity[field]) {
        throw new Error(`Compared variants must use the same ${field}; mismatch at drivers.${variant}`);
      }
    }
    if (driver.commandFile !== firstDriver.commandFile) {
      throw new Error(`Compared variants must use the same commandFile; mismatch at drivers.${variant}`);
    }
    if (options.requirePins) {
      for (const field of [
        'command',
        'name',
        'kind',
        'runtimeExecutable',
        'runtimeExecutableSha256',
        'envValueIdentityHash',
        'agentConfigFile',
        'baseInstructionFile',
        'samplingFile'
      ]) {
        if (canonicalJson(driver[field]) !== canonicalJson(firstDriver[field])) {
          throw new Error(`Compared variants must use the same ${field}; mismatch at drivers.${variant}`);
        }
      }
      if (
        canonicalJson(normalizedProfileArgs(driver, variant))
        !== canonicalJson(normalizedProfileArgs(firstDriver, variants[0]))
      ) {
        throw new Error(`Compared variants may differ in args only by capabilityProfile; mismatch at drivers.${variant}`);
      }
      if (
        canonicalJson([...(driver.envNames ?? [])].sort())
        !== canonicalJson([...(firstDriver.envNames ?? [])].sort())
      ) {
        throw new Error(`Compared variants must use the same envNames; mismatch at drivers.${variant}`);
      }
    }
    if (
      options.requirePins
      && driver.adapterBuildHash !== firstDriver.adapterBuildHash
    ) {
      throw new Error(`Compared variants must use the same adapterBuildHash; mismatch at drivers.${variant}`);
    }
  }
  const trialsPerVariant = Number(
    config.trialsPerVariant ?? MIN_PUBLISHABLE_TRIALS_PER_VARIANT
  );
  if (!Number.isInteger(trialsPerVariant) || trialsPerVariant < 1) {
    throw new Error('trialsPerVariant must be a positive integer');
  }
  const minimumPublishableTrialsPerVariant = Number(
    config.minimumPublishableTrialsPerVariant ?? MIN_PUBLISHABLE_TRIALS_PER_VARIANT
  );
  if (
    !Number.isInteger(minimumPublishableTrialsPerVariant)
    || minimumPublishableTrialsPerVariant < MIN_PUBLISHABLE_TRIALS_PER_VARIANT
  ) {
    throw new Error(
      `minimumPublishableTrialsPerVariant must be an integer >= ${MIN_PUBLISHABLE_TRIALS_PER_VARIANT}`
    );
  }
  return { variants, trialsPerVariant, minimumPublishableTrialsPerVariant, comparisonIdentity: identity };
}

function runIdentityPayload(runState) {
  return {
    schemaVersion: runState.schemaVersion,
    runId: runState.runId,
    configHash: runState.provenance?.configHash,
    sourceConfigSha256: runState.provenance?.sourceConfigSha256,
    implementationIdentityHash: runState.provenance?.implementation?.identityHash,
    scheduleSha256: runState.provenance?.scheduleSha256,
    comparisonIdentity: runState.provenance?.comparisonIdentity,
    driverPins: Object.fromEntries(
      Object.entries(runState.config?.drivers ?? {}).map(([variant, driver]) => [variant, {
        commandFile: driver.commandFile,
        commandFileSha256: driver.commandFileSha256,
        adapterBuildHash: driver.adapterBuildHash,
        runtimeExecutable: driver.runtimeExecutable,
        runtimeExecutableSha256: driver.runtimeExecutableSha256,
        envValueIdentityHash: driver.envValueIdentityHash,
        driverConfigHash: driver.driverConfigHash
      }])
    )
  };
}

function calculateRunIdentity(runState) {
  return sha256(canonicalJson(runIdentityPayload(runState)));
}

async function assertStoredRunProvenance(runDir, runState, options = {}) {
  const validation = validateRunConfig(runState.config, { requirePins: true });
  if (!sanitizeJsonRecord(runState.config).clean) {
    throw new Error('Pinned run config contains a secret-shaped value');
  }
  if (!runState.provenance || typeof runState.provenance !== 'object') {
    throw new Error('Run is missing pinned provenance');
  }
  const configHash = sha256(canonicalJson(runState.config));
  if (configHash !== runState.provenance.configHash) {
    throw new Error('Run config hash mismatch; refusing to mix benchmark configuration');
  }
  if (runState.provenance.pinnedConfigArtifact !== 'config.pinned.json') {
    throw new Error('Pinned config artifact must be config.pinned.json');
  }
  const pinnedConfigFile = path.join(runDir, 'config.pinned.json');
  const pinnedConfigStat = await fs.lstat(pinnedConfigFile);
  if (!pinnedConfigStat.isFile() || pinnedConfigStat.isSymbolicLink()) {
    throw new Error('Pinned config artifact must be a non-symlink regular file');
  }
  const pinnedConfig = JSON.parse(await fs.readFile(pinnedConfigFile, 'utf8'));
  if (sha256(canonicalJson(pinnedConfig)) !== runState.provenance.configHash) {
    throw new Error('Pinned config artifact hash mismatch');
  }
  const scheduleHash = sha256(canonicalJson(runState.schedule));
  if (scheduleHash !== runState.provenance.scheduleSha256) {
    throw new Error('Run schedule hash mismatch');
  }
  const scheduleFile = path.join(runDir, 'schedule.json');
  const scheduleStat = await fs.lstat(scheduleFile);
  if (!scheduleStat.isFile() || scheduleStat.isSymbolicLink()) {
    throw new Error('Schedule artifact must be a non-symlink regular file');
  }
  const storedSchedule = JSON.parse(await fs.readFile(scheduleFile, 'utf8'));
  if (sha256(canonicalJson(storedSchedule)) !== runState.provenance.scheduleSha256) {
    throw new Error('Stored schedule artifact hash mismatch');
  }
  const expectedSchedule = createSchedule(
    validation.variants,
    validation.trialsPerVariant,
    runState.config.seed
  );
  if (canonicalJson(runState.schedule) !== canonicalJson(expectedSchedule)) {
    throw new Error('Run schedule does not match the pinned deterministic schedule');
  }
  if (canonicalJson(validation.comparisonIdentity) !== canonicalJson(runState.provenance.comparisonIdentity)) {
    throw new Error('Run comparison identity does not match its pinned config');
  }
  const expectedRunIdentity = calculateRunIdentity(runState);
  if (runState.runIdentity !== expectedRunIdentity) {
    throw new Error('Run identity mismatch');
  }

  if (options.checkCurrent) {
    const currentImplementation = await currentImplementationProvenance();
    if (currentImplementation.identityHash !== runState.provenance.implementation.identityHash) {
      throw new Error('Benchmark implementation changed since run creation; start a new run');
    }
    for (const [variant, driver] of Object.entries(runState.config.drivers)) {
      let currentHash;
      try {
        currentHash = await sha256File(driver.commandFile);
      } catch (error) {
        throw new Error(`Could not verify drivers.${variant}.commandFile: ${error.message}`);
      }
      if (currentHash !== driver.commandFileSha256) {
        throw new Error(`Driver command file changed for ${variant}; start a new run`);
      }
      let currentRuntimeHash;
      try {
        const currentRuntime = await fs.realpath(driver.runtimeExecutable);
        if (currentRuntime !== driver.runtimeExecutable) {
          throw new Error('runtime executable resolves to a different file');
        }
        currentRuntimeHash = await sha256File(currentRuntime);
      } catch (error) {
        throw new Error(`Could not verify drivers.${variant}.runtimeExecutable: ${error.message}`);
      }
      if (currentRuntimeHash !== driver.runtimeExecutableSha256) {
        throw new Error(`Driver runtime executable changed for ${variant}; start a new run`);
      }
      if (environmentValueIdentity(driver.envNames ?? []) !== driver.envValueIdentityHash) {
        throw new Error(`Driver environment values changed for ${variant}; start a new run`);
      }
      if (driver.kind === 'agent') {
        for (const [hashField, sourceField] of [
          ['agentConfigHash', 'agentConfigFile'],
          ['baseInstructionHash', 'baseInstructionFile'],
          ['samplingHash', 'samplingFile']
        ]) {
          let sourceHash;
          try {
            sourceHash = await sha256File(driver[sourceField]);
          } catch (error) {
            throw new Error(`Could not verify drivers.${variant}.${sourceField}: ${error.message}`);
          }
          if (sourceHash !== driver[hashField]) {
            throw new Error(`Driver provenance source changed for ${variant}.${sourceField}`);
          }
        }
      }
    }
  }
  return validation;
}

function assertTrialMatchesRun(trial, entry, runState) {
  const expectedTrialId = `${runState.runId}-${String(entry.index).padStart(4, '0')}-${entry.variant}`;
  const driver = runState.config.drivers[entry.variant];
  if (trial.trialId !== expectedTrialId || trial.variant !== entry.variant) {
    throw new Error(`Trial identity does not match schedule index ${entry.index}`);
  }
  if (trial.model !== driver.model) {
    throw new Error(`Trial model does not match pinned model at schedule index ${entry.index}`);
  }
  if (trial.driver?.kind !== driver.kind) {
    throw new Error(`Trial driver kind does not match pinned driver at schedule index ${entry.index}`);
  }
  const expectedName = driver.name ?? path.basename(driver.command);
  if (trial.driver?.name !== expectedName) {
    throw new Error(`Trial driver name does not match pinned driver at schedule index ${entry.index}`);
  }
  for (const [field, expected] of Object.entries(runState.provenance.implementation.details)) {
    if (canonicalJson(trial.implementation?.[field]) !== canonicalJson(expected)) {
      throw new Error(`Trial implementation.${field} does not match run provenance`);
    }
  }
  const trialProvenance = trial.driver?.provenance;
  const expectedProvenance = {
    provider: driver.provider,
    model: driver.model,
    capabilityProfile: driver.capabilityProfile,
    agentConfigHash: driver.agentConfigHash,
    baseInstructionHash: driver.baseInstructionHash,
    samplingHash: driver.samplingHash,
    commandFile: driver.commandFile,
    commandFileSha256: driver.commandFileSha256,
    adapterBuildHash: driver.adapterBuildHash,
    runtimeExecutable: driver.runtimeExecutable,
    runtimeExecutableSha256: driver.runtimeExecutableSha256,
    envValueIdentityHash: driver.envValueIdentityHash,
    argsHash: sha256(JSON.stringify(driver.args ?? [])),
    explicitCwd: driver.cwd ?? null
  };
  for (const [field, expected] of Object.entries(expectedProvenance)) {
    if (canonicalJson(trialProvenance?.[field]) !== canonicalJson(expected)) {
      throw new Error(`Trial driver provenance.${field} does not match run provenance`);
    }
  }
  if (driver.kind !== 'agent' && trial.publishable === true) {
    throw new Error(`Non-agent driver produced a publishable trial at schedule index ${entry.index}`);
  }
  return expectedTrialId;
}

async function doctor() {
  const runtimeDir = await createRuntimeDir('acp-benchmark-doctor-');
  let app;
  try {
    app = await startBenchmarkApp({ runtimeDir, headless: true });
    const identity = await implementationIdentity(appRoot);
    return {
      ok: evaluateInitialSnapshot(app.initialSnapshot).success,
      checkedAt: new Date().toISOString(),
      surface: {
        actions: app.description.actions.length,
        state: app.description.state.length,
        events: app.description.events.length
      },
      fixture: evaluateInitialSnapshot(app.initialSnapshot),
      appLaunchReadyMs: app.appLaunchReadyMs,
      implementation: identity,
      warning: identity.appWorkingTreeClean
        ? null
        : 'Working tree is dirty; trial records would be marked non-publishable.'
    };
  } finally {
    await stopBenchmarkApp(app).catch(() => {});
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
}

async function runOne(options, passthrough) {
  const variant = options.variant;
  if (!VARIANTS.includes(variant)) throw new Error(`--variant must be one of: ${VARIANTS.join(', ')}`);
  if (!passthrough.length) {
    throw new Error('Provide a driver command after -- (for example: -- node benchmark/drivers/scripted-acp.js)');
  }
  const output = path.resolve(options.output ?? path.join(appRoot, 'benchmark-results', runIdNow()));
  await createExclusiveRunDirectory(output);
  const artifactDir = path.join(output, 'trials', `0001-${variant}`);
  const explicitDriverCwd = options['driver-cwd'] ? path.resolve(options['driver-cwd']) : undefined;
  const result = await runTrial({
    appRoot,
    artifactDir,
    variant,
    model: options.model,
    driver: {
      command: passthrough[0],
      args: passthrough.slice(1),
      ...(explicitDriverCwd ? { cwd: explicitDriverCwd } : {}),
      name: options['driver-name'],
      kind: options['driver-kind'] ?? 'agent',
      env: Object.fromEntries(
        String(options['env-names'] ?? '')
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean)
          .filter((name) => process.env[name] !== undefined)
          .map((name) => [name, process.env[name]])
      )
    },
    headless: booleanOption(options, 'headless', false),
    timeoutMs: numberOption(options, 'timeout-ms', 180_000),
    renderDelayMs: numberOption(options, 'render-delay-ms', 0)
  });
  result.measurementEligible = false;
  result.publishable = false;
  result.publicationReasons = [
    ...new Set([
      ...(Array.isArray(result.publicationReasons) ? result.publicationReasons : []),
      'run_one_is_diagnostic_only',
      ...(explicitDriverCwd ? ['explicit_driver_cwd'] : [])
    ])
  ];
  assertTrialRecord(result);
  await writeJson(path.join(artifactDir, 'trial.json'), result);
  await writeJson(path.join(output, 'summary.json'), summarizeTrials([result], {
    expectedVariants: [variant]
  }));
  return { output, result };
}

async function executeSchedule(runDir, runState, config) {
  await assertSafeTrialsRoot(runDir, { create: true });
  await reconcilePreservationJournal(runDir, runState);
  await discoverUntrackedTrialDirectories(runDir, runState);
  await assertStoredRunProvenance(runDir, runState, { checkCurrent: true });
  const completed = await reconcileRecordedTrials(runDir, runState);
  if (completed.size === runState.schedule.length && runState.status === 'complete') {
    return summarizeRun(runDir, runState);
  }
  const session = {
    sessionId: randomUUID(),
    startedAt: new Date().toISOString(),
    startingRecordedTrials: completed.size
  };
  runState.sessions ??= [];
  runState.sessions.push(session);
  runState.status = 'running';
  await writeRunState(runDir, runState);

  for (const entry of runState.schedule) {
    if (completed.has(entry.index)) continue;
    await assertStoredRunProvenance(runDir, runState, { checkCurrent: true });
    const driverConfig = resolveDriver(config.drivers[entry.variant]);
    const artifactName = artifactNameForEntry(entry);
    const artifactDir = path.join(runDir, 'trials', artifactName);
    const existingTrialFile = path.join(artifactDir, 'trial.json');
    try {
      const safeExistingTrialFile = await safeRecordedTrialFile(
        runDir,
        artifactRelativeForEntry(entry),
        entry
      );
      const existing = JSON.parse(await fs.readFile(safeExistingTrialFile, 'utf8'));
      assertTrialRecord(existing);
      await verifyArtifactManifest(path.dirname(safeExistingTrialFile), existing.artifactIntegrity);
      assertTrialMatchesRun(existing, entry, runState);
      const trialSha256 = await sha256File(safeExistingTrialFile);
      runState.interruptedAttempts ??= [];
      runState.interruptedAttempts.push({
        ...entry,
        artifact: `trials/${artifactName}`,
        reason: 'recovered completed trial that was not durably recorded in the run ledger',
        status: 'recovered_unledgered_trial',
        discoveredAt: new Date().toISOString()
      });
      runState.trials.push({
        ...entry,
        trialId: existing.trialId,
        outcome: existing.outcome,
        artifact: `trials/${artifactName}/trial.json`,
        trialSha256,
        runIdentity: runState.runIdentity,
        configHash: runState.provenance.configHash,
        driverConfigHash: runState.config.drivers[entry.variant].driverConfigHash,
        implementationIdentityHash: runState.provenance.implementation.identityHash,
        sessionId: session.sessionId,
        completedAt: new Date().toISOString(),
        recoveredOnResume: true
      });
      await writeRunState(runDir, runState);
      continue;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        await preserveScheduledDirectory(runDir, runState, entry, error.message, 'invalid');
      } else {
        try {
          await fs.lstat(artifactDir);
          await preserveScheduledDirectory(
            runDir,
            runState,
            entry,
            'partial artifact directory without trial.json',
            'interrupted'
          );
        } catch (directoryError) {
          if (directoryError.code !== 'ENOENT') throw directoryError;
        }
      }
    }
    const result = await runTrial({
      appRoot,
      artifactDir,
      trialId: `${runState.runId}-${artifactName}`,
      variant: entry.variant,
      model: driverConfig.model,
      driver: driverConfig,
      timeoutMs: config.timeoutMs ?? 180_000,
      renderDelayMs: config.renderDelayMs ?? 0,
      window: config.window,
      headless: config.headless ?? false
    });
    await assertStoredRunProvenance(runDir, runState, { checkCurrent: true });
    assertTrialMatchesRun(result, entry, runState);
    await verifyArtifactManifest(artifactDir, result.artifactIntegrity);
    const trialSha256 = await sha256File(existingTrialFile);
    runState.trials.push({
      ...entry,
      trialId: result.trialId,
      outcome: result.outcome,
      artifact: `trials/${artifactName}/trial.json`,
      trialSha256,
      runIdentity: runState.runIdentity,
      configHash: runState.provenance.configHash,
      driverConfigHash: runState.config.drivers[entry.variant].driverConfigHash,
      implementationIdentityHash: runState.provenance.implementation.identityHash,
      sessionId: session.sessionId,
      completedAt: new Date().toISOString()
    });
    await writeRunState(runDir, runState);
  }

  session.completedAt = new Date().toISOString();
  session.endingRecordedTrials = runState.trials.length;
  runState.status = 'complete';
  runState.completedAt = session.completedAt;
  runState.updatedAt = runState.completedAt;
  await writeJson(path.join(runDir, 'run.json'), runState);
  return summarizeRun(runDir, runState);
}

async function reconcileRecordedTrials(runDir, runState) {
  const valid = [];
  const completed = new Set();
  for (const record of runState.trials ?? []) {
    const entry = runState.schedule.find((candidate) => candidate.index === record.index);
    try {
      if (completed.has(record.index)) throw new Error(`duplicate recorded schedule index ${record.index}`);
      if (!entry) throw new Error(`recorded schedule index ${record.index} does not exist`);
      const trialFile = await safeRecordedTrialFile(runDir, record.artifact, entry);
      assertSha256(record.trialSha256, `recorded trial ${record.index} digest`);
      if (await sha256File(trialFile) !== record.trialSha256) {
        throw new Error(`recorded trial digest mismatch at schedule index ${record.index}`);
      }
      const trial = JSON.parse(await fs.readFile(trialFile, 'utf8'));
      assertTrialRecord(trial);
      await verifyArtifactManifest(path.dirname(trialFile), trial.artifactIntegrity);
      const expectedTrialId = assertTrialMatchesRun(trial, entry, runState);
      if (
        record.variant !== entry.variant
        || record.trialId !== expectedTrialId
        || record.runIdentity !== runState.runIdentity
        || record.configHash !== runState.provenance.configHash
        || record.driverConfigHash !== runState.config.drivers[entry.variant].driverConfigHash
        || record.implementationIdentityHash !== runState.provenance.implementation.identityHash
      ) {
        throw new Error(`recorded trial provenance does not match schedule index ${record.index}`);
      }
      completed.add(record.index);
      valid.push(record);
    } catch (error) {
      runState.interruptedAttempts ??= [];
      const expectedArtifact = entry ? artifactRelativeForEntry(entry) : null;
      const alreadyJournaled = runState.interruptedAttempts.some(
        (attempt) => attempt.index === record.index && attempt.sourceArtifact === path.dirname(expectedArtifact ?? '')
      );
      if (!alreadyJournaled && entry && !completed.has(record.index) && record.artifact === expectedArtifact) {
        try {
          await preserveScheduledDirectory(
            runDir,
            runState,
            entry,
            error.message,
            'invalid-recorded'
          );
        } catch (preserveError) {
          if (preserveError.code !== 'ENOENT') throw preserveError;
          runState.interruptedAttempts.push({
            ...record,
            artifact: null,
            reason: error.message,
            status: 'missing',
            preservedAt: new Date().toISOString()
          });
        }
      } else if (!alreadyJournaled) {
        runState.interruptedAttempts.push({
          ...record,
          artifact: null,
          reason: error.message,
          status: 'invalid_record',
          preservedAt: new Date().toISOString()
        });
      }
    }
  }
  if (valid.length !== (runState.trials ?? []).length) {
    runState.trials = valid;
    runState.updatedAt = new Date().toISOString();
    await writeJson(path.join(runDir, 'run.json'), runState);
  }
  return completed;
}

async function startRun(options) {
  if (!options.config) throw new Error('--config is required');
  const { config, resolved, sourceSha256 } = await readConfig(options.config);
  const {
    variants,
    trialsPerVariant,
    minimumPublishableTrialsPerVariant
  } = validateRunConfig(config);
  const runId = validateRunId(config.runId ?? runIdNow());
  const runDir = path.resolve(options.output ?? config.output ?? path.join(appRoot, 'benchmark-results', runId));
  const schedule = createSchedule(variants, trialsPerVariant, config.seed ?? runId);
  const driverEntries = await Promise.all(
    variants.map(async (variant) => [variant, await safeDriver(config.drivers[variant], variant)])
  );
  const pinnedConfig = {
    variants,
    trialsPerVariant,
    minimumPublishableTrialsPerVariant,
    seed: config.seed ?? runId,
    timeoutMs: config.timeoutMs ?? 180_000,
    renderDelayMs: config.renderDelayMs ?? 0,
    window: config.window,
    headless: config.headless ?? false,
    drivers: Object.fromEntries(driverEntries)
  };
  if (!sanitizeJsonRecord(pinnedConfig).clean) {
    throw new Error('Run config contains a secret-shaped value; pass credentials only through envNames');
  }
  const pinnedValidation = validateRunConfig(pinnedConfig, { requirePins: true });
  const implementation = await currentImplementationProvenance();
  const runState = {
    schemaVersion: 1,
    runId,
    status: 'created',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    configSource: path.basename(resolved),
    config: pinnedConfig,
    provenance: {
      sourceConfigSha256: sourceSha256,
      configHash: sha256(canonicalJson(pinnedConfig)),
      pinnedConfigArtifact: 'config.pinned.json',
      scheduleSha256: sha256(canonicalJson(schedule)),
      comparisonIdentity: pinnedValidation.comparisonIdentity,
      implementation
    },
    schedule,
    trials: []
  };
  runState.runIdentity = calculateRunIdentity(runState);
  await createExclusiveRunDirectory(runDir);
  await writeJson(path.join(runDir, 'config.pinned.json'), pinnedConfig);
  await writeJson(path.join(runDir, 'schedule.json'), schedule);
  await writeJson(path.join(runDir, 'run.json'), runState);
  return executeSchedule(runDir, runState, runState.config);
}

async function resumeRun(options) {
  if (!options.run) throw new Error('--run is required');
  const runDir = path.resolve(options.run);
  const runState = JSON.parse(await fs.readFile(path.join(runDir, 'run.json'), 'utf8'));
  await assertStoredRunProvenance(runDir, runState, { checkCurrent: true });
  return executeSchedule(runDir, runState, runState.config);
}

async function summarizeRun(runDir, runState = null) {
  const state = runState ?? JSON.parse(await fs.readFile(path.join(runDir, 'run.json'), 'utf8'));
  await assertSafeTrialsRoot(runDir);
  await reconcilePreservationJournal(runDir, state);
  await discoverUntrackedTrialDirectories(runDir, state);
  const validation = await assertStoredRunProvenance(runDir, state);
  const trials = [];
  const seenScheduleIndices = new Set();
  for (const record of state.trials ?? []) {
    if (seenScheduleIndices.has(record.index)) {
      throw new Error(`Duplicate trial record for schedule index ${record.index}`);
    }
    const entry = state.schedule?.find((candidate) => candidate.index === record.index);
    if (!entry) {
      throw new Error(`Trial identity mismatch while summarizing ${record.artifact}`);
    }
    const trialFile = await safeRecordedTrialFile(runDir, record.artifact, entry);
    assertSha256(record.trialSha256, `recorded trial ${record.index} digest`);
    if (await sha256File(trialFile) !== record.trialSha256) {
      throw new Error(`Trial digest mismatch while summarizing ${record.artifact}`);
    }
    const trial = JSON.parse(await fs.readFile(trialFile, 'utf8'));
    assertTrialRecord(trial);
    await verifyArtifactManifest(path.dirname(trialFile), trial.artifactIntegrity);
    const expectedTrialId = assertTrialMatchesRun(trial, entry, state);
    if (
      record.trialId !== expectedTrialId
      || record.runIdentity !== state.runIdentity
      || record.configHash !== state.provenance.configHash
      || record.driverConfigHash !== state.config.drivers[entry.variant].driverConfigHash
      || record.implementationIdentityHash !== state.provenance.implementation.identityHash
    ) throw new Error(`Trial provenance mismatch while summarizing ${record.artifact}`);
    seenScheduleIndices.add(record.index);
    // Pair from the verified, pinned schedule rather than trusting ledger or raw-trial metadata.
    trials.push({ ...trial, block: entry.block });
  }
  const summary = summarizeTrials(trials, {
    expectedVariants: validation.variants,
    minimumTrialsPerVariant: validation.minimumPublishableTrialsPerVariant,
    comparisonIdentity: validation.comparisonIdentity,
    bootstrapSeed: state.runIdentity
  });
  summary.run = {
    runId: state.runId,
    runIdentity: state.runIdentity,
    status: state.status,
    scheduledTrials: state.schedule?.length ?? 0,
    recordedTrials: trials.length,
    incompleteTrials: Math.max(0, (state.schedule?.length ?? 0) - seenScheduleIndices.size),
    interruptedAttempts: state.interruptedAttempts?.length ?? 0,
    sessions: state.sessions?.length ?? 0,
    configHash: state.provenance.configHash,
    sourceConfigSha256: state.provenance.sourceConfigSha256,
    implementationIdentityHash: state.provenance.implementation.identityHash
  };
  const recordsByIndex = new Map((state.trials ?? []).map((record) => [record.index, record]));
  const blocks = new Map();
  for (const entry of state.schedule ?? []) {
    if (!blocks.has(entry.block)) blocks.set(entry.block, []);
    blocks.get(entry.block).push(entry);
  }
  const blockSessionViolations = [];
  for (const [block, entries] of blocks) {
    const sessionIds = new Set(entries.map((entry) => recordsByIndex.get(entry.index)?.sessionId).filter(Boolean));
    if (entries.every((entry) => recordsByIndex.has(entry.index)) && sessionIds.size !== 1) {
      blockSessionViolations.push(block);
    }
  }
  const completedTimes = (state.trials ?? [])
    .map((record) => Date.parse(record.completedAt))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  summary.run.blockSessionViolations = blockSessionViolations;
  summary.run.maxInterTrialGapMs = completedTimes.length < 2
    ? null
    : Math.max(...completedTimes.slice(1).map((value, index) => value - completedTimes[index]));
  summary.run.recordsMissingSessionEvidence = (state.trials ?? []).filter(
    (record) => typeof record.sessionId !== 'string' || !record.sessionId || !Number.isFinite(Date.parse(record.completedAt))
  ).length;
  const runEvidenceEligible = state.status === 'complete'
    && summary.run.incompleteTrials === 0
    && summary.run.interruptedAttempts === 0
    && summary.run.blockSessionViolations.length === 0
    && summary.run.recordsMissingSessionEvidence === 0
    && state.provenance.implementation.details.appWorkingTreeClean === true
    && Object.values(state.config.drivers).every((driver) => driver.kind === 'agent')
    && Object.values(state.config.drivers).every((driver) => !driver.cwd);
  if (!runEvidenceEligible) {
    summary.datasetEligible = false;
    summary.publishable = false;
  }
  if (state.status !== 'complete') summary.datasetIneligibleReasons.push('run_not_complete');
  if (summary.run.incompleteTrials > 0) summary.datasetIneligibleReasons.push('incomplete_trials');
  if (summary.run.interruptedAttempts > 0) summary.datasetIneligibleReasons.push('interrupted_attempts');
  if (summary.run.blockSessionViolations.length > 0) {
    summary.datasetIneligibleReasons.push('comparison_block_spans_execution_sessions');
  }
  if (summary.run.recordsMissingSessionEvidence > 0) {
    summary.datasetIneligibleReasons.push('missing_execution_session_evidence');
  }
  if (state.provenance.implementation.details.appWorkingTreeClean !== true) {
    summary.datasetIneligibleReasons.push('dirty_implementation_at_run_creation');
  }
  if (Object.values(state.config.drivers).some((driver) => driver.kind !== 'agent')) {
    summary.datasetIneligibleReasons.push('non_agent_driver_configured');
  }
  if (Object.values(state.config.drivers).some((driver) => driver.cwd)) {
    summary.datasetIneligibleReasons.push('explicit_driver_cwd');
  }
  summary.datasetIneligibleReasons = [...new Set(summary.datasetIneligibleReasons)];
  summary.nonPublishableReasons = summary.datasetIneligibleReasons;
  await writeJson(path.join(runDir, 'summary.json'), summary);
  const estimateWithInterval = (metric, name) => {
    if (metric[name] === null) return '—';
    const interval = metric.confidenceIntervals95?.[name];
    if (interval?.low === null || interval?.high === null) return metric[name].toFixed(1);
    return `${metric[name].toFixed(1)} [${interval.low.toFixed(1)}, ${interval.high.toFixed(1)}]`;
  };
  const rateWithInterval = (data) => {
    const interval = data.successRate95CI;
    const point = (data.successRate * 100).toFixed(1);
    if (interval?.low === null || interval?.high === null) return `${point}%`;
    return `${point}% [${(interval.low * 100).toFixed(1)}, ${(interval.high * 100).toFixed(1)}]`;
  };
  const headlineRows = Object.entries(summary.variants).map(([variant, data]) =>
    `| ${variant} | ${data.successes}/${data.trials} | ${rateWithInterval(data)} | ${estimateWithInterval(data.endToEndMs, 'median')} | ${estimateWithInterval(data.endToEndMs, 'p95')} |`
  );
  const diagnosticRows = Object.entries(summary.diagnosticVariants).map(([variant, data]) =>
    `| ${variant} | ${data.successes}/${data.trials} | ${rateWithInterval(data)} | ${estimateWithInterval(data.endToEndMs, 'median')} | ${estimateWithInterval(data.endToEndMs, 'p95')} |`
  );
  const comparisonWithInterval = (estimate, interval, options = {}) => {
    if (!Number.isFinite(estimate)) return '—';
    const scale = options.scale ?? 1;
    const digits = options.digits ?? 1;
    const suffix = options.suffix ?? '';
    const point = (estimate * scale).toFixed(digits);
    if (!Number.isFinite(interval?.low) || !Number.isFinite(interval?.high)) {
      return `${point}${suffix}`;
    }
    return `${point}${suffix} [${(interval.low * scale).toFixed(digits)}, ${(interval.high * scale).toFixed(digits)}]`;
  };
  const pairedRows = summary.pairedComparisons.map((comparison) => {
    const latency = comparison.endToEndMs;
    return `| ${comparison.leftVariant} vs ${comparison.rightVariant} | ${comparison.blocks.complete} | ${latency.leftFiniteLatencyTrials}/${latency.rightFiniteLatencyTrials} | ${comparisonWithInterval(
      comparison.successRateDifference.estimate,
      comparison.successRateDifference.confidenceInterval95,
      { scale: 100, suffix: ' pp' }
    )} | ${comparisonWithInterval(
      latency.median.differenceMs,
      latency.median.confidenceIntervals95.differenceMs
    )} | ${comparisonWithInterval(
      latency.median.ratio,
      latency.median.confidenceIntervals95.ratio,
      { digits: 3 }
    )} | ${comparisonWithInterval(
      latency.p95.differenceMs,
      latency.p95.confidenceIntervals95.differenceMs
    )} | ${comparisonWithInterval(
      latency.p95.ratio,
      latency.p95.confidenceIntervals95.ratio,
      { digits: 3 }
    )} |`;
  });
  const pairedSection = pairedRows.length ? [
    '',
    '## Paired whole-block comparisons',
    '',
    'Differences are left minus right; ratios are left divided by right. Latency contrasts use successful trials in complete blocks.',
    '',
    '| Pair (left vs right) | Complete blocks | Finite successful latency n (L/R) | Success-rate difference [95% CI] | Median difference ms [95% CI] | Median ratio [95% CI] | p95 difference ms [95% CI] | p95 ratio [95% CI] |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...pairedRows
  ] : [];
  const markdown = [
    `# Benchmark summary: ${state.runId}`,
    '',
    `Run evidence gate: **${summary.datasetEligible ? 'PASS' : 'FAIL'}**.`,
    ...(!summary.datasetEligible ? ['', `Reasons: ${summary.datasetIneligibleReasons.join(', ')}.`] : []),
    '',
    'This automated gate qualifies this run dataset; it does not establish global project or publication readiness.',
    '',
    '## Dataset-eligible metrics',
    '',
    '| Variant | Successes | Success rate [95% CI] | Median E2E ms [95% CI] | p95 E2E ms [95% CI] |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...headlineRows,
    '',
    `These metrics contain ${summary.datasetEligibleTrials} dataset-eligible records. At least ${summary.minimumTrialsPerVariant} are required per compared variant.`,
    ...pairedSection,
    '',
    '## Diagnostic metrics (all retained records)',
    '',
    '| Variant | Successes | Success rate [95% CI] | Median E2E ms [95% CI] | p95 E2E ms [95% CI] |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...diagnosticRows,
    '',
    `Generated from ${summary.totalTrials} retained trial records (${summary.datasetIneligibleTrials} excluded from the eligible dataset).`,
    '',
    `Run status: ${state.status}; incomplete scheduled trials: ${summary.run.incompleteTrials}; preserved interrupted attempts: ${summary.run.interruptedAttempts}.`,
    '',
    'Protocol-only timings are not used as end-to-end results.',
    ''
  ].join('\n');
  await writeText(path.join(runDir, 'summary.md'), markdown);
  return { runDir, summary };
}

function usage() {
  return `ACP benchmark harness

Commands:
  npm run benchmark -- doctor
  npm run benchmark -- run-one --variant <variant> --model <model> --output <dir> -- <driver> [args...]
  npm run benchmark -- run --config benchmark/configs/pilot.json [--output <dir>]
  npm run benchmark -- resume --run <run-dir>
  npm run benchmark -- summarize --run <run-dir>

Variants: ${VARIANTS.join(', ')}
`;
}

async function main() {
  const { command, options, passthrough } = parseArgs(process.argv.slice(2));
  let result;
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(usage());
    return;
  }
  if (command === 'doctor') result = await doctor();
  else if (command === 'run-one') result = await runOne(options, passthrough);
  else if (command === 'run') result = await startRun(options);
  else if (command === 'resume') result = await resumeRun(options);
  else if (command === 'summarize') {
    if (!options.run) throw new Error('--run is required');
    result = await summarizeRun(path.resolve(options.run));
  } else throw new Error(`Unknown command: ${command}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  doctor,
  main,
  parseArgs,
  resumeRun,
  runOne,
  startRun,
  summarizeRun,
  validateRunId,
  validateRunConfig
};
