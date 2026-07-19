const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  crossCheckAcpAudit,
  inspectDriverArtifacts,
  sanitizeArtifactTree,
  sanitizeJsonRecord,
  validateAgentEvidence,
  validateDriverEvents,
  validateDriverReady
} = require('../benchmark/trial-validation');

function received(event, at) {
  return { ...event, harnessReceivedMonotonicMs: at };
}

test('driver attestation and lifecycle reject work before the timed start', () => {
  const ready = received({
    type: 'driver.ready',
    schemaVersion: 1,
    name: 'adapter',
    kind: 'agent',
    model: 'model-snapshot',
    conversationCreated: false,
    appInspected: false,
    capabilities: ['acp']
  }, 10);
  assert.equal(validateDriverReady(ready, {
    name: 'adapter', kind: 'agent', model: 'model-snapshot'
  }).success, true);

  const events = [
    ready,
    received({ type: 'model.turn', turn: 1 }, 20),
    received({ type: 'tool.start', toolKind: 'acp', tool: 'set_theme' }, 25),
    received({ type: 'tool.end', toolKind: 'acp', tool: 'set_theme' }, 30),
    received({ type: 'final', completed: true, reportedMatchCount: 5 }, 35)
  ];
  assert.equal(validateDriverEvents(events, {
    variant: 'acp', taskStartedAt: 15, complete: true
  }).valid, true);
  const contaminated = validateDriverEvents(events, {
    variant: 'acp', taskStartedAt: 22, complete: true
  });
  assert.equal(contaminated.valid, false);
  assert.match(contaminated.errors.join(' '), /before start/);
});

test('capability event validation rejects undeclared observations and tools', () => {
  const events = [
    received({ type: 'driver.ready' }, 1),
    received({ type: 'observation', kind: 'accessibility', artifact: 'tree.json' }, 3),
    received({ type: 'tool.start', toolKind: 'acp', tool: 'set_theme' }, 4),
    received({ type: 'tool.end', toolKind: 'acp', tool: 'set_theme' }, 5)
  ];
  const result = validateDriverEvents(events, {
    variant: 'screenshot', taskStartedAt: 2, complete: true
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /undeclared accessibility observation/);
  assert.match(result.errors.join(' '), /undeclared acp tool/);
});

test('agent evidence binds every model turn to matching provider usage', () => {
  const firstRequest = 'a'.repeat(64);
  const secondRequest = 'b'.repeat(64);
  const expected = { kind: 'agent', provider: 'provider-1', model: 'model-1' };
  const valid = validateAgentEvidence([
    { type: 'model.turn', turn: 1, provider: 'provider-1', model: 'model-1', requestIdHash: firstRequest },
    { type: 'usage', source: 'provider', provider: 'provider-1', model: 'model-1', requestIdHash: firstRequest, inputTokens: 10, outputTokens: 2 },
    { type: 'model.turn', turn: 2, provider: 'provider-1', model: 'model-1', requestIdHash: secondRequest },
    { type: 'usage', source: 'provider', provider: 'provider-1', model: 'model-1', requestIdHash: secondRequest, inputTokens: 8, outputTokens: 0 }
  ], expected);
  assert.equal(valid.valid, true);
  assert.equal(valid.modelTurns, 2);
  assert.equal(valid.providerUsageRecords, 2);

  const invalid = validateAgentEvidence([
    { type: 'model.turn', turn: 1, provider: 'wrong-provider', model: 'model-1', requestIdHash: firstRequest },
    { type: 'model.turn', turn: 2, provider: 'provider-1', model: 'wrong-model', requestIdHash: firstRequest },
    { type: 'usage', source: 'estimated', provider: 'provider-1', model: 'model-1', requestIdHash: firstRequest, inputTokens: 0, outputTokens: 0 },
    { type: 'usage', source: 'provider', provider: 'provider-1', model: 'model-1', requestIdHash: 'not-a-hash', inputTokens: 1, outputTokens: 1 }
  ], expected);
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join(' '), /provider does not match/);
  assert.match(invalid.errors.join(' '), /model does not match/);
  assert.match(invalid.errors.join(' '), /repeats a requestIdHash/);
  assert.match(invalid.errors.join(' '), /not provider-reported/);
  assert.match(invalid.errors.join(' '), /nonzero provider token evidence/);
  assert.match(invalid.errors.join(' '), /lowercase SHA-256/);
});

test('agent evidence rejects missing turns, usage, and orphan usage records', () => {
  const expected = { kind: 'agent', provider: 'provider-1', model: 'model-1' };
  const request = 'c'.repeat(64);
  const missingTurn = validateAgentEvidence([], expected);
  assert.equal(missingTurn.valid, false);
  assert.match(missingTurn.errors.join(' '), /did not retain a model.turn/);

  const missingUsage = validateAgentEvidence([
    { type: 'model.turn', turn: 1, provider: 'provider-1', model: 'model-1', requestIdHash: request }
  ], expected);
  assert.equal(missingUsage.valid, false);
  assert.match(missingUsage.errors.join(' '), /exactly one matching provider usage/);

  const orphanUsage = validateAgentEvidence([
    { type: 'model.turn', turn: 1, provider: 'provider-1', model: 'model-1', requestIdHash: request },
    { type: 'usage', source: 'provider', provider: 'provider-1', model: 'model-1', requestIdHash: request, inputTokens: 1, outputTokens: 1 },
    { type: 'usage', source: 'provider', provider: 'provider-1', model: 'model-1', requestIdHash: 'd'.repeat(64), inputTokens: 1, outputTokens: 1 }
  ], expected);
  assert.equal(orphanUsage.valid, false);
  assert.match(orphanUsage.errors.join(' '), /does not match a unique model.turn/);
});

test('driver artifacts are path-contained, typed, and hashed', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-artifact-validation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlKzDMAAAAASUVORK5CYII=',
    'base64'
  );
  await fs.writeFile(path.join(root, 'screen.png'), png);
  const valid = await inspectDriverArtifacts([
    { type: 'observation', kind: 'screenshot', artifact: 'screen.png' }
  ], root, 'screenshot');
  assert.equal(valid.valid, true);
  assert.equal(valid.artifacts[0].mime, 'image/png');
  assert.equal(valid.artifacts[0].width, 1);
  assert.match(valid.artifacts[0].sha256, /^[a-f0-9]{64}$/);

  const escaped = await inspectDriverArtifacts([
    { type: 'observation', kind: 'screenshot', artifact: '../screen.png' }
  ], root, 'screenshot');
  assert.equal(escaped.valid, false);
  assert.match(escaped.errors.join(' '), /escapes/);
});

test('retained text artifacts redact known and key-shaped secrets', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-artifact-redaction-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sentinel = 'sentinel-provider-secret-12345';
  const keyShapedSecret = `sk-${'example1234567890'}`;
  await fs.writeFile(
    path.join(root, 'transcript.jsonl'),
    `${JSON.stringify({ leak: sentinel, authorization: `Bearer ${keyShapedSecret}` })}\n`
  );
  const report = await sanitizeArtifactTree(root, [sentinel]);
  assert.equal(report.clean, false);
  const retained = await fs.readFile(path.join(root, 'transcript.jsonl'), 'utf8');
  assert.doesNotMatch(retained, /sentinel-provider-secret/);
  assert.doesNotMatch(retained, /sk-example/);
  assert.match(retained, /\[REDACTED\]/);
});

test('JSON record sanitization scrubs in-memory driver fields without leaking findings', () => {
  const sentinel = 'sentinel-provider-secret-12345';
  const escapedSentinel = 'escaped-provider-"secret"\n987654321';
  const keyShapedSecret = `sk-${'jsonrecord1234567890'}`;
  const original = {
    finalEvaluation: { observed: { error: sentinel } },
    protocolValidation: {
      finalEvent: {
        error: sentinel,
        detail: escapedSentinel,
        authorization: `Bearer ${keyShapedSecret}`
      }
    }
  };
  const report = sanitizeJsonRecord(original, [sentinel, escapedSentinel]);
  const retained = JSON.stringify(report.value);
  assert.equal(report.clean, false);
  assert.doesNotMatch(retained, /sentinel-provider-secret/);
  assert.doesNotMatch(retained, /escaped-provider/);
  assert.doesNotMatch(retained, /sk-jsonrecord/);
  assert.match(retained, /\[REDACTED\]/);
  assert.doesNotMatch(
    JSON.stringify(report.findings),
    /sentinel-provider-secret|escaped-provider|sk-jsonrecord/
  );
  assert.equal(original.finalEvaluation.observed.error, sentinel);
});

test('ACP audit records are cross-checked against declared attempts', () => {
  const valid = crossCheckAcpAudit([
    { type: 'tool.start', toolKind: 'acp', tool: 'add_task' },
    { type: 'tool.end', toolKind: 'acp', tool: 'add_task' }
  ], [{ action: 'add_task', status: 'ok' }], 'acp');
  assert.equal(valid.valid, true);

  const invalid = crossCheckAcpAudit([], [{ action: 'set_theme' }], 'screenshot');
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join(' '), /produced 1 ACP audit/);
});

test('ACP audit status must match declared tool completion', () => {
  const events = [
    { type: 'tool.start', toolKind: 'acp', tool: 'set_theme' },
    { type: 'tool.end', toolKind: 'acp', tool: 'set_theme' }
  ];
  const result = crossCheckAcpAudit(events, [
    { action: 'set_theme', status: 'error' }
  ], 'acp');
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /non-ok audit status/);
});
