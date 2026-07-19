const fs = require('fs');
const path = require('path');
const Ajv2020 = require('ajv/dist/2020');

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'trial.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

function semanticFailures(record) {
  const failures = [];
  const timing = record?.timing ?? {};
  const completed = timing.completedWithinDeadline === true;
  const evaluationSucceeded = record?.evaluation?.success === true;
  const hasInfrastructureError = record?.infrastructureError !== null
    && record?.infrastructureError !== undefined;

  if (record?.measurementEligible !== record?.publishable) {
    failures.push('measurementEligible must equal the publishable compatibility alias');
  }
  if (record?.agentEvidence?.modelTurns !== record?.metrics?.modelTurns) {
    failures.push('agent evidence modelTurns must match metrics.modelTurns');
  }
  if (record?.agentEvidence?.providerUsageRecords !== record?.metrics?.usageRecords) {
    failures.push('agent evidence providerUsageRecords must match metrics.usageRecords');
  }
  if (completed !== evaluationSucceeded) {
    failures.push('evaluation.success must exactly match timing.completedWithinDeadline');
  }
  if (record?.evaluation?.assertions?.completedWithinDeadline !== completed) {
    failures.push('evaluation assertion must match timing.completedWithinDeadline');
  }
  if (
    record?.evaluation?.assertions?.finalResponseValid
    !== record?.finalEvaluation?.success
  ) {
    failures.push('evaluation finalResponseValid must match finalEvaluation.success');
  }
  if (completed) {
    for (const field of ['stateSatisfiedMs', 'agentFinalMs', 'endToEndMs']) {
      if (!Number.isFinite(timing[field])) failures.push(`completed trial requires finite timing.${field}`);
      else if (timing[field] > timing.timeoutMs) {
        failures.push(`completed trial timing.${field} exceeds timeoutMs`);
      }
    }
    if (record?.finalEvaluation?.success !== true) {
      failures.push('completed trial requires a successful final response evaluation');
    }
    if (record?.evaluation?.state?.success !== true) {
      failures.push('completed trial requires a successful state evaluation');
    }
    if (Number.isFinite(timing.endToEndMs)) {
      const expected = Math.max(timing.stateSatisfiedMs, timing.agentFinalMs);
      if (Number.isFinite(expected) && Math.abs(timing.endToEndMs - expected) > 0.001) {
        failures.push('endToEndMs must be the later of stateSatisfiedMs and agentFinalMs');
      }
    }
    if (
      Number.isFinite(timing.stateSatisfiedMs)
      && Number.isFinite(timing.agentFinalMs)
      && (
        !Number.isFinite(timing.evaluatorLagMs)
        || Math.abs(
          timing.evaluatorLagMs - (timing.stateSatisfiedMs - timing.agentFinalMs)
        ) > 0.001
      )
    ) {
      failures.push('evaluatorLagMs must equal stateSatisfiedMs minus agentFinalMs');
    }
  }

  if (record?.outcome === 'success') {
    if (!completed) failures.push('success outcome requires deadline-bounded completion');
    if (hasInfrastructureError) failures.push('success outcome cannot contain an infrastructure error');
  } else if (record?.outcome === 'timeout') {
    if (completed) failures.push('timeout outcome cannot be complete');
  } else if (record?.outcome === 'infrastructure_failure') {
    if (!hasInfrastructureError) failures.push('infrastructure_failure requires an infrastructure error');
  } else if (completed) {
    failures.push(`${record?.outcome} outcome cannot be deadline-complete`);
  }

  if (record?.publishable === true) {
    if (record.publicationReasons?.length !== 0) failures.push('eligible trial cannot have exclusion reasons');
    if (hasInfrastructureError) failures.push('eligible trial cannot have an infrastructure error');
    if (record?.implementation?.appWorkingTreeClean !== true) {
      failures.push('eligible trial requires a clean implementation worktree');
    }
    if (record?.driver?.kind !== 'agent') failures.push('eligible trial requires an agent driver');
    if (record?.driver?.attestation?.success !== true) failures.push('eligible trial requires driver attestation');
    if (record?.protocolValidation?.valid !== true) failures.push('eligible trial requires valid driver events');
    if (record?.agentEvidence?.valid !== true || record?.agentEvidence?.required !== true) {
      failures.push('eligible trial requires provider-backed agent evidence');
    }
    if (record?.auditValidation?.valid !== true) failures.push('eligible trial requires valid ACP audit evidence');
    if (record?.artifactValidation?.valid !== true) failures.push('eligible trial requires valid observations');
    if (record?.artifactValidation?.hygiene?.clean !== true) failures.push('eligible trial requires clean artifacts');
    if (record?.artifactIntegrity?.valid !== true) failures.push('eligible trial requires an artifact manifest');
    if (
      record?.cleanup?.runtimeRemoved !== true
      || record?.cleanup?.emptyAcpHomeRemoved !== true
      || record?.cleanup?.driverCwdRemoved !== true
    ) {
      failures.push('eligible trial requires successful runtime cleanup');
    }
    if (record?.perturbation?.headless !== false) failures.push('eligible trial cannot be headless');
    if (typeof record?.environmentFingerprint !== 'string') {
      failures.push('eligible trial requires an environment fingerprint');
    }
  } else if (!Array.isArray(record?.publicationReasons) || record.publicationReasons.length === 0) {
    failures.push('ineligible trial requires at least one exclusion reason');
  }

  return failures;
}

function assertTrialRecord(record) {
  if (!validate(record)) {
    const details = (validate.errors ?? [])
      .map((error) => `${error.instancePath || '/'} ${error.message}`)
      .join('; ');
    throw new Error(`Invalid benchmark trial record: ${details}`);
  }
  const semanticErrors = semanticFailures(record);
  if (semanticErrors.length) {
    throw new Error(`Invalid benchmark trial semantics: ${semanticErrors.join('; ')}`);
  }
  return record;
}

module.exports = {
  assertTrialRecord,
  schema,
  semanticFailures,
  validateTrialRecord: validate
};
