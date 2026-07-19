const { createHash } = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const ALLOWED_EVENT_TYPES = new Set([
  'driver.ready',
  'model.turn',
  'observation',
  'tool.start',
  'tool.end',
  'tool.error',
  'recovery',
  'usage',
  'final'
]);

const EVENT_POLICIES = Object.freeze({
  screenshot: Object.freeze({ observations: ['screenshot'], tools: ['ui'] }),
  accessibility: Object.freeze({ observations: ['accessibility', 'screenshot'], tools: ['ui'] }),
  acp: Object.freeze({ observations: [], tools: ['acp'] }),
  hybrid: Object.freeze({ observations: ['screenshot'], tools: ['acp', 'ui'] })
});

const REQUEST_ID_HASH_PATTERN = /^[a-f0-9]{64}$/;
const SECRET_PATTERNS = Object.freeze([
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /((?:authorization|api[_-]?key|access[_-]?token)["'\s:=]+(?:Bearer\s+)?)[A-Za-z0-9._-]{12,}/gi
]);

function normalizedSecrets(knownSecrets) {
  return [...new Set(
    knownSecrets.filter((value) => typeof value === 'string' && value.length >= 6)
  )].sort((left, right) => right.length - left.length);
}

function redactText(value, secrets) {
  let text = value;
  let replacements = 0;
  for (const secret of secrets) {
    if (!text.includes(secret)) continue;
    replacements += text.split(secret).length - 1;
    text = text.split(secret).join('[REDACTED]');
  }
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, (match, prefix = '') => {
      replacements += 1;
      return `${prefix}[REDACTED]`;
    });
  }
  return { text, replacements };
}

function validateAgentEvidence(events, expected) {
  const errors = [];
  const turns = events.filter((event) => event?.type === 'model.turn');
  const usageEvents = events.filter((event) => event?.type === 'usage');
  const seenRequestIds = new Set();
  const turnRequestIds = new Set();

  if (expected?.kind && expected.kind !== 'agent') {
    return {
      valid: true,
      required: false,
      errors,
      modelTurns: turns.length,
      providerUsageRecords: usageEvents.length
    };
  }
  if (typeof expected?.provider !== 'string' || expected.provider.length === 0) {
    errors.push('agent evidence validation requires a pinned provider');
  }
  if (typeof expected?.model !== 'string' || expected.model.length === 0) {
    errors.push('agent evidence validation requires a pinned model');
  }
  if (turns.length === 0) errors.push('agent trial did not retain a model.turn event');

  for (const [index, turn] of turns.entries()) {
    if (turn.turn !== index + 1) {
      errors.push(`model.turn ${index} must use consecutive one-based turn numbering`);
    }
    if (turn.provider !== expected?.provider) {
      errors.push(`model.turn ${index} provider does not match pinned provider`);
    }
    if (turn.model !== expected?.model) {
      errors.push(`model.turn ${index} model does not match pinned model`);
    }
    if (!REQUEST_ID_HASH_PATTERN.test(turn.requestIdHash ?? '')) {
      errors.push(`model.turn ${index} requestIdHash is not a lowercase SHA-256 digest`);
      continue;
    }
    if (seenRequestIds.has(turn.requestIdHash)) {
      errors.push(`model.turn ${index} repeats a requestIdHash`);
      continue;
    }
    seenRequestIds.add(turn.requestIdHash);
    turnRequestIds.add(turn.requestIdHash);

    const matchingUsage = usageEvents.filter(
      (usage) => usage.requestIdHash === turn.requestIdHash
    );
    if (matchingUsage.length !== 1) {
      errors.push(
        `model.turn ${index} must have exactly one matching provider usage event; received ${matchingUsage.length}`
      );
      continue;
    }
    const [usage] = matchingUsage;
    if (usage.source !== 'provider') {
      errors.push(`model.turn ${index} usage is not provider-reported`);
    }
    if (usage.provider !== expected?.provider) {
      errors.push(`model.turn ${index} usage provider does not match pinned provider`);
    }
    if (usage.model !== expected?.model) {
      errors.push(`model.turn ${index} usage model does not match pinned model`);
    }
    const inputTokens = usage.inputTokens;
    const outputTokens = usage.outputTokens;
    if (
      !Number.isFinite(inputTokens)
      || inputTokens < 0
      || !Number.isFinite(outputTokens)
      || outputTokens < 0
      || inputTokens + outputTokens <= 0
    ) {
      errors.push(`model.turn ${index} usage lacks nonzero provider token evidence`);
    }
  }

  for (const [index, usage] of usageEvents.entries()) {
    if (!REQUEST_ID_HASH_PATTERN.test(usage.requestIdHash ?? '')) {
      errors.push(`usage event ${index} requestIdHash is not a lowercase SHA-256 digest`);
    } else if (!turnRequestIds.has(usage.requestIdHash)) {
      errors.push(`usage event ${index} does not match a unique model.turn`);
    }
  }

  return {
    valid: errors.length === 0,
    required: true,
    errors,
    modelTurns: turns.length,
    providerUsageRecords: usageEvents.length
  };
}

function validateDriverReady(ready, expected) {
  const assertions = {
    object: Boolean(ready) && typeof ready === 'object',
    eventType: ready?.type === 'driver.ready',
    schemaVersion: ready?.schemaVersion === 1,
    name: typeof ready?.name === 'string'
      && ready.name.length > 0
      && (!expected.name || ready.name === expected.name),
    kind: typeof ready?.kind === 'string'
      && ready.kind.length > 0
      && ready.kind === expected.kind,
    model: ready?.model === expected.model,
    capabilityProfile: !expected.capabilityProfile
      || ready?.capabilityProfile === expected.capabilityProfile,
    noConversationCreated: ready?.conversationCreated === false,
    noAppInspection: ready?.appInspected === false
  };
  return {
    success: Object.values(assertions).every(Boolean),
    assertions,
    observed: {
      name: ready?.name ?? null,
      kind: ready?.kind ?? null,
      model: ready?.model ?? null,
      capabilityProfile: ready?.capabilityProfile ?? null
    }
  };
}

function validateDriverEvents(events, options) {
  const errors = [];
  const policy = EVENT_POLICIES[options.variant];
  if (!policy) throw new Error(`Unknown benchmark variant: ${options.variant}`);
  const readyEvents = events.filter((event) => event.type === 'driver.ready');
  if (readyEvents.length !== 1) errors.push(`expected exactly one driver.ready, received ${readyEvents.length}`);
  if (events[0]?.type !== 'driver.ready') errors.push('driver.ready must be the first event');

  const outstanding = [];
  let finalEvent = null;
  let finalIndex = -1;
  for (const [index, event] of events.entries()) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      errors.push(`event ${index} is not an object`);
      continue;
    }
    if (!ALLOWED_EVENT_TYPES.has(event.type)) {
      errors.push(`event ${index} has unknown type ${String(event.type)}`);
      continue;
    }
    if (
      event.type !== 'driver.ready'
      && (options.taskStartedAt === null || options.taskStartedAt === undefined
        || event.harnessReceivedMonotonicMs < options.taskStartedAt)
    ) {
      errors.push(`event ${index} (${event.type}) occurred before start`);
    }
    if (finalIndex !== -1 && !['usage'].includes(event.type)) {
      errors.push(`event ${index} (${event.type}) occurred after final`);
    }
    if (event.type === 'observation') {
      if (!policy.observations.includes(event.kind)) {
        errors.push(`undeclared ${String(event.kind)} observation for ${options.variant}`);
      }
      if (typeof event.artifact !== 'string' || event.artifact.length === 0) {
        errors.push(`observation event ${index} is missing an artifact path`);
      }
    }
    if (event.type === 'tool.start') {
      if (!policy.tools.includes(event.toolKind)) {
        errors.push(`undeclared ${String(event.toolKind)} tool for ${options.variant}`);
      }
      if (typeof event.tool !== 'string' || event.tool.length === 0) {
        errors.push(`tool.start event ${index} is missing a tool name`);
      }
      outstanding.push({ toolKind: event.toolKind, tool: event.tool, index });
    }
    if (event.type === 'tool.end' || event.type === 'tool.error') {
      if (!policy.tools.includes(event.toolKind)) {
        errors.push(`undeclared ${String(event.toolKind)} tool for ${options.variant}`);
      }
      const match = outstanding.findIndex(
        (candidate) => candidate.toolKind === event.toolKind && candidate.tool === event.tool
      );
      if (match === -1) errors.push(`${event.type} event ${index} has no matching tool.start`);
      else outstanding.splice(match, 1);
    }
    if (event.type === 'usage') {
      for (const field of ['inputTokens', 'outputTokens', 'estimatedCostUsd']) {
        if (event[field] !== undefined && (!Number.isFinite(event[field]) || event[field] < 0)) {
          errors.push(`usage event ${index} has invalid ${field}`);
        }
      }
    }
    if (event.type === 'final') {
      if (finalEvent) errors.push('driver emitted more than one final event');
      finalEvent ??= event;
      finalIndex = index;
      if (outstanding.length) errors.push('driver emitted final while tool calls were still outstanding');
    }
  }
  if (options.complete && outstanding.length) {
    errors.push(`${outstanding.length} tool call(s) did not emit tool.end or tool.error`);
  }
  return { valid: errors.length === 0, errors, finalEvent };
}

function crossCheckAcpAudit(events, audit, variant) {
  const attempts = events.filter((event) => event.type === 'tool.start' && event.toolKind === 'acp');
  const completions = events.filter(
    (event) => ['tool.end', 'tool.error'].includes(event.type) && event.toolKind === 'acp'
  );
  const errors = [];
  if (!['acp', 'hybrid'].includes(variant) && audit.length) {
    errors.push(`${variant} trial produced ${audit.length} ACP audit record(s)`);
  }
  if (attempts.length !== audit.length) {
    errors.push(`ACP attempt/audit count mismatch: ${attempts.length} event(s), ${audit.length} audit record(s)`);
  }
  for (let index = 0; index < Math.min(attempts.length, audit.length); index++) {
    if (attempts[index].tool !== audit[index].action) {
      errors.push(`ACP attempt/audit action mismatch at index ${index}`);
    }
    const completion = completions[index];
    if (completion && completion.tool !== audit[index].action) {
      errors.push(`ACP completion/audit action mismatch at index ${index}`);
    }
    if (completion?.type === 'tool.end' && audit[index].status !== 'ok') {
      errors.push(`ACP successful completion has non-ok audit status at index ${index}`);
    }
    if (completion?.type === 'tool.error' && audit[index].status !== 'error') {
      errors.push(`ACP failed completion has non-error audit status at index ${index}`);
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    attempts: attempts.length,
    completions: completions.length,
    auditRecords: audit.length
  };
}

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function pngMetadata(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) return null;
  return { mime: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function inspectDriverArtifacts(events, driverOutputDir, variant) {
  const root = path.resolve(driverOutputDir);
  const errors = [];
  const artifacts = [];
  const observations = events.filter((event) => event.type === 'observation');
  for (const [index, event] of observations.entries()) {
    const relative = event.artifact;
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) {
      errors.push(`observation ${index} has an invalid relative artifact path`);
      continue;
    }
    const resolved = path.resolve(root, relative);
    if (!isInside(root, resolved)) {
      errors.push(`observation ${index} artifact escapes the driver output directory`);
      continue;
    }
    try {
      const stat = await fs.lstat(resolved);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        errors.push(`observation ${index} artifact is not a regular file`);
        continue;
      }
      const content = await fs.readFile(resolved);
      if (!content.length) {
        errors.push(`observation ${index} artifact is empty`);
        continue;
      }
      let metadata;
      if (event.kind === 'screenshot') {
        metadata = pngMetadata(content);
        if (!metadata || metadata.width < 1 || metadata.height < 1) {
          errors.push(`observation ${index} screenshot must be a valid PNG`);
          continue;
        }
      } else if (event.kind === 'accessibility') {
        try {
          JSON.parse(content.toString('utf8'));
          metadata = { mime: 'application/json' };
        } catch {
          errors.push(`observation ${index} accessibility artifact must be valid JSON`);
          continue;
        }
      }
      artifacts.push({
        eventIndex: events.indexOf(event),
        kind: event.kind,
        path: path.posix.join('driver-artifacts', relative.split(path.sep).join('/')),
        bytes: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
        ...metadata
      });
    } catch (error) {
      errors.push(`observation ${index} artifact is unavailable: ${error.message}`);
    }
  }

  const kinds = new Set(artifacts.map((artifact) => artifact.kind));
  if (['screenshot', 'accessibility', 'hybrid'].includes(variant) && !kinds.has('screenshot')) {
    errors.push(`${variant} trial did not retain a screenshot observation`);
  }
  if (variant === 'accessibility' && !kinds.has('accessibility')) {
    errors.push('accessibility trial did not retain an accessibility-tree observation');
  }
  return { valid: errors.length === 0, errors, artifacts };
}

function looksTextual(buffer) {
  if (buffer.length === 0) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return !sample.includes(0);
}

async function walkRegularFiles(root, directory = root) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const resolved = path.join(directory, entry.name);
    const stat = await fs.lstat(resolved);
    if (stat.isSymbolicLink()) throw new Error(`Artifact tree contains a symbolic link: ${resolved}`);
    if (stat.isDirectory()) files.push(...await walkRegularFiles(root, resolved));
    else if (stat.isFile()) files.push(resolved);
  }
  return files;
}

function sanitizeJsonRecord(record, knownSecrets = []) {
  const secrets = normalizedSecrets(knownSecrets).map(
    (secret) => JSON.stringify(secret).slice(1, -1)
  );
  const serialized = JSON.stringify(record);
  if (serialized === undefined) {
    throw new TypeError('JSON record must be serializable');
  }
  const { text, replacements } = redactText(serialized, secrets);
  return {
    clean: replacements === 0,
    value: JSON.parse(text),
    findings: replacements === 0
      ? []
      : [{ kind: 'json_record_redaction', replacements }]
  };
}

async function sanitizeArtifactTree(root, knownSecrets = []) {
  const secrets = normalizedSecrets(knownSecrets);
  const findings = [];
  for (const file of await walkRegularFiles(root)) {
    const buffer = await fs.readFile(file);
    if (!looksTextual(buffer)) continue;
    const { text, replacements } = redactText(buffer.toString('utf8'), secrets);
    if (replacements) {
      await fs.writeFile(file, text, { mode: 0o600 });
      await fs.chmod(file, 0o600);
      const safePath = redactText(path.relative(root, file), secrets).text;
      findings.push({ path: safePath, replacements });
    }
  }
  return { clean: findings.length === 0, findings };
}

module.exports = {
  crossCheckAcpAudit,
  inspectDriverArtifacts,
  sanitizeArtifactTree,
  sanitizeJsonRecord,
  validateAgentEvidence,
  validateDriverEvents,
  validateDriverReady
};
