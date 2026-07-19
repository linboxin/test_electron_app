const { createHash } = require('crypto');

const VARIANTS = Object.freeze(['screenshot', 'accessibility', 'acp', 'hybrid']);
const MIN_DATASET_ELIGIBLE_TRIALS_PER_VARIANT = 20;
const MIN_PUBLISHABLE_TRIALS_PER_VARIANT = MIN_DATASET_ELIGIBLE_TRIALS_PER_VARIANT;
const DEFAULT_BOOTSTRAP_SAMPLES = 10_000;
const BOOTSTRAP_CONFIDENCE_LEVEL = 0.95;
const COMPARISON_IDENTITY_HASH_FIELDS = Object.freeze([
  'agentConfigHash',
  'baseInstructionHash',
  'samplingHash'
]);
const CAPABILITY_PROFILES = Object.freeze({
  screenshot: Object.freeze(['keyboard', 'pointer', 'screenshot', 'text']),
  accessibility: Object.freeze(['accessibility', 'keyboard', 'pointer', 'screenshot', 'text']),
  acp: Object.freeze(['acp']),
  hybrid: Object.freeze(['acp', 'keyboard', 'pointer', 'screenshot', 'text'])
});

function normalizeCapabilities(capabilities) {
  return [...new Set(Array.isArray(capabilities) ? capabilities : [])].sort();
}

function validateCapabilities(variant, capabilities) {
  const expected = CAPABILITY_PROFILES[variant];
  if (!expected) throw new Error(`Unknown benchmark variant: ${variant}`);
  const declared = Array.isArray(capabilities) ? capabilities : [];
  const actual = normalizeCapabilities(capabilities);
  return {
    valid: declared.every((value) => typeof value === 'string')
      && declared.length === actual.length
      && expected.length === actual.length
      && expected.every((value, index) => value === actual[index]),
    expected: [...expected],
    actual
  };
}

function numericSeed(seed) {
  const digest = createHash('sha256').update(String(seed)).digest();
  return digest.readUInt32LE(0);
}

function createRandom(seed) {
  let value = numericSeed(seed);
  return () => {
    value += 0x6D2B79F5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function createSchedule(variants, trialsPerVariant, seed) {
  if (!Array.isArray(variants) || variants.length === 0) throw new Error('At least one variant is required');
  if (!Number.isInteger(trialsPerVariant) || trialsPerVariant < 1) {
    throw new Error('trialsPerVariant must be a positive integer');
  }
  for (const variant of variants) {
    if (!VARIANTS.includes(variant)) throw new Error(`Unknown benchmark variant: ${variant}`);
  }
  if (new Set(variants).size !== variants.length) throw new Error('Variants must be unique');

  const random = createRandom(seed);
  const schedule = [];
  const counts = Object.fromEntries(variants.map((variant) => [variant, 0]));
  for (let block = 1; block <= trialsPerVariant; block++) {
    for (const variant of shuffle(variants, random)) {
      counts[variant] += 1;
      schedule.push({
        index: schedule.length + 1,
        block,
        variant,
        trialWithinVariant: counts[variant]
      });
    }
  }
  return schedule;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)];
}

function bootstrapSampleCount(value = DEFAULT_BOOTSTRAP_SAMPLES) {
  const samples = Number(value);
  if (!Number.isInteger(samples) || samples < 1) {
    throw new Error('bootstrapSamples must be a positive integer');
  }
  return samples;
}

function bootstrapMetricIntervals(values, options = {}) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  const samples = bootstrapSampleCount(options.bootstrapSamples);
  const seed = createHash('sha256')
    .update(String(options.bootstrapSeed ?? 'acp-benchmark-bootstrap-v1'))
    .digest('hex');
  if (!finite.length) {
    return {
      method: 'seeded_percentile_bootstrap',
      confidenceLevel: BOOTSTRAP_CONFIDENCE_LEVEL,
      samples,
      seed,
      median: { low: null, high: null },
      p95: { low: null, high: null }
    };
  }

  const random = createRandom(seed);
  const medianEstimates = [];
  const p95Estimates = [];
  for (let iteration = 0; iteration < samples; iteration++) {
    const sample = Array.from(
      { length: finite.length },
      () => finite[Math.floor(random() * finite.length)]
    );
    medianEstimates.push(median(sample));
    p95Estimates.push(percentile(sample, 0.95));
  }
  const tail = (1 - BOOTSTRAP_CONFIDENCE_LEVEL) / 2;
  return {
    method: 'seeded_percentile_bootstrap',
    confidenceLevel: BOOTSTRAP_CONFIDENCE_LEVEL,
    samples,
    seed,
    median: {
      low: percentile(medianEstimates, tail),
      high: percentile(medianEstimates, 1 - tail)
    },
    p95: {
      low: percentile(p95Estimates, tail),
      high: percentile(p95Estimates, 1 - tail)
    }
  };
}

function summarizeMetric(values, options = {}) {
  const finite = values.filter(Number.isFinite);
  return {
    count: finite.length,
    median: median(finite),
    p95: percentile(finite, 0.95),
    min: finite.length ? Math.min(...finite) : null,
    max: finite.length ? Math.max(...finite) : null,
    confidenceIntervals95: bootstrapMetricIntervals(finite, options)
  };
}

function wilsonInterval(successes, total, z = 1.96) {
  if (total === 0) return { low: null, high: null };
  const proportion = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (proportion + (z * z) / (2 * total)) / denominator;
  const margin = (
    z * Math.sqrt((proportion * (1 - proportion) / total) + (z * z) / (4 * total * total))
  ) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function summarizeVariantGroups(trials, expectedVariants = [], options = {}) {
  const groups = Object.fromEntries(expectedVariants.map((variant) => [variant, []]));
  for (const trial of trials) {
    if (!groups[trial.variant]) groups[trial.variant] = [];
    groups[trial.variant].push(trial);
  }

  const variants = {};
  for (const [variant, records] of Object.entries(groups)) {
    const outcomes = {};
    for (const record of records) outcomes[record.outcome] = (outcomes[record.outcome] ?? 0) + 1;
    const successes = records.filter((record) => record.outcome === 'success');
    const models = [...new Set(records.map((record) => record.model))].sort();
    const datasetEligibleTrials = records.filter(trialIsDatasetEligible).length;
    const metric = (name, values) => summarizeMetric(values, {
      bootstrapSamples: options.bootstrapSamples,
      bootstrapSeed: `${options.bootstrapSeed ?? 'acp-benchmark-summary-v1'}:${variant}:${name}`
    });
    variants[variant] = {
      trials: records.length,
      successes: successes.length,
      datasetEligibleTrials,
      datasetIneligibleTrials: records.length - datasetEligibleTrials,
      publishableTrials: datasetEligibleTrials,
      nonPublishableTrials: records.length - datasetEligibleTrials,
      models,
      mixedModels: models.length > 1,
      successRate: records.length ? successes.length / records.length : 0,
      successRate95CI: wilsonInterval(successes.length, records.length),
      outcomes,
      endToEndMs: metric('endToEndMs', successes.map((record) => record.timing?.endToEndMs)),
      agentFinalMs: metric('agentFinalMs', successes.map((record) => record.timing?.agentFinalMs)),
      modelTurns: metric('modelTurns', successes.map((record) => record.metrics?.modelTurns)),
      observations: metric('observations', successes.map((record) => record.metrics?.observations)),
      screenshotObservations: metric('screenshotObservations', successes.map((record) => record.metrics?.screenshotObservations)),
      accessibilityObservations: metric('accessibilityObservations', successes.map((record) => record.metrics?.accessibilityObservations)),
      uiActionAttempts: metric('uiActionAttempts', successes.map((record) => record.metrics?.uiActionAttempts)),
      acpCallAttempts: metric('acpCallAttempts', successes.map((record) => record.metrics?.acpCallAttempts)),
      uiActions: metric('uiActions', successes.map((record) => record.metrics?.uiActions)),
      acpCalls: metric('acpCalls', successes.map((record) => record.metrics?.acpCalls)),
      toolErrors: metric('toolErrors', successes.map((record) => record.metrics?.toolErrors)),
      toolDurationMs: metric('toolDurationMs', successes.map((record) => record.metrics?.toolDurationMs)),
      hostDurationMs: metric('hostDurationMs', successes.map((record) => record.metrics?.hostDurationMs)),
      recoveryLoops: metric('recoveryLoops', successes.map((record) => record.metrics?.recoveryLoops)),
      inputTokens: metric('inputTokens', successes.map((record) => record.metrics?.inputTokens)),
      outputTokens: metric('outputTokens', successes.map((record) => record.metrics?.outputTokens)),
      estimatedCostUsd: metric('estimatedCostUsd', successes.map((record) => record.metrics?.estimatedCostUsd))
    };
  }
  return variants;
}

function ratioOrNull(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }
  const ratio = numerator / denominator;
  return Number.isFinite(ratio) ? ratio : null;
}

function differenceOrNull(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) ? left - right : null;
}

function pairedBlockStatistics(blocks, leftVariant, rightVariant) {
  const leftTrials = blocks.map((block) => block[leftVariant]);
  const rightTrials = blocks.map((block) => block[rightVariant]);
  const leftSuccesses = leftTrials.filter((trial) => trial.outcome === 'success');
  const rightSuccesses = rightTrials.filter((trial) => trial.outcome === 'success');
  const finiteSuccessfulLatency = (records) => records
    .map((trial) => trial.timing?.endToEndMs)
    .filter(Number.isFinite);
  const leftLatencies = finiteSuccessfulLatency(leftSuccesses);
  const rightLatencies = finiteSuccessfulLatency(rightSuccesses);
  const latencyStatistic = (statistic) => {
    const leftMs = statistic(leftLatencies);
    const rightMs = statistic(rightLatencies);
    return {
      leftMs,
      rightMs,
      differenceMs: differenceOrNull(leftMs, rightMs),
      ratio: ratioOrNull(leftMs, rightMs)
    };
  };
  const leftSuccessRate = blocks.length ? leftSuccesses.length / blocks.length : null;
  const rightSuccessRate = blocks.length ? rightSuccesses.length / blocks.length : null;

  return {
    successRateDifference: {
      leftSuccesses: leftSuccesses.length,
      rightSuccesses: rightSuccesses.length,
      trialsPerVariant: blocks.length,
      leftRate: leftSuccessRate,
      rightRate: rightSuccessRate,
      estimate: differenceOrNull(leftSuccessRate, rightSuccessRate)
    },
    endToEndMs: {
      population: 'successful_trials_in_complete_blocks',
      leftSuccessfulTrials: leftSuccesses.length,
      rightSuccessfulTrials: rightSuccesses.length,
      leftFiniteLatencyTrials: leftLatencies.length,
      rightFiniteLatencyTrials: rightLatencies.length,
      median: latencyStatistic(median),
      p95: latencyStatistic((values) => percentile(values, 0.95))
    }
  };
}

function comparisonInterval(estimates, pointEstimate) {
  const finite = estimates.filter(Number.isFinite).sort((a, b) => a - b);
  if (!Number.isFinite(pointEstimate) || !finite.length) {
    return { low: null, high: null, validSamples: finite.length };
  }
  const tail = (1 - BOOTSTRAP_CONFIDENCE_LEVEL) / 2;
  return {
    low: percentile(finite, tail),
    high: percentile(finite, 1 - tail),
    validSamples: finite.length
  };
}

function summarizePairedComparisons(trials, expectedVariants = [], options = {}) {
  const variants = [...new Set(expectedVariants)];
  if (variants.length < 2) return [];
  const samples = bootstrapSampleCount(options.bootstrapSamples);
  const indexed = new Map();
  const unassignedTrials = Object.fromEntries(variants.map((variant) => [variant, 0]));

  for (const trial of trials) {
    if (!variants.includes(trial.variant)) continue;
    if (!Number.isInteger(trial.block) || trial.block < 1) {
      unassignedTrials[trial.variant] += 1;
      continue;
    }
    if (!indexed.has(trial.block)) indexed.set(trial.block, {});
    const block = indexed.get(trial.block);
    if (block[trial.variant]) {
      throw new Error(`Duplicate ${trial.variant} trial in benchmark block ${trial.block}`);
    }
    block[trial.variant] = trial;
  }

  const orderedBlocks = [...indexed.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, block]) => block);
  const comparisons = [];
  for (let leftIndex = 0; leftIndex < variants.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < variants.length; rightIndex++) {
      const leftVariant = variants[leftIndex];
      const rightVariant = variants[rightIndex];
      const completeBlocks = orderedBlocks.filter(
        (block) => block[leftVariant] && block[rightVariant]
      );
      const leftOnlyBlocks = orderedBlocks.filter(
        (block) => block[leftVariant] && !block[rightVariant]
      ).length;
      const rightOnlyBlocks = orderedBlocks.filter(
        (block) => !block[leftVariant] && block[rightVariant]
      ).length;
      const point = pairedBlockStatistics(completeBlocks, leftVariant, rightVariant);
      const seed = createHash('sha256')
        .update(`${options.bootstrapSeed ?? 'acp-benchmark-paired-v1'}:${leftVariant}:${rightVariant}`)
        .digest('hex');
      const estimates = {
        successRateDifference: [],
        medianDifferenceMs: [],
        medianRatio: [],
        p95DifferenceMs: [],
        p95Ratio: []
      };

      if (completeBlocks.length) {
        const random = createRandom(seed);
        for (let iteration = 0; iteration < samples; iteration++) {
          const resampledBlocks = Array.from(
            { length: completeBlocks.length },
            () => completeBlocks[Math.floor(random() * completeBlocks.length)]
          );
          const estimate = pairedBlockStatistics(resampledBlocks, leftVariant, rightVariant);
          estimates.successRateDifference.push(estimate.successRateDifference.estimate);
          estimates.medianDifferenceMs.push(estimate.endToEndMs.median.differenceMs);
          estimates.medianRatio.push(estimate.endToEndMs.median.ratio);
          estimates.p95DifferenceMs.push(estimate.endToEndMs.p95.differenceMs);
          estimates.p95Ratio.push(estimate.endToEndMs.p95.ratio);
        }
      }

      point.successRateDifference.confidenceInterval95 = comparisonInterval(
        estimates.successRateDifference,
        point.successRateDifference.estimate
      );
      point.endToEndMs.median.confidenceIntervals95 = {
        differenceMs: comparisonInterval(
          estimates.medianDifferenceMs,
          point.endToEndMs.median.differenceMs
        ),
        ratio: comparisonInterval(estimates.medianRatio, point.endToEndMs.median.ratio)
      };
      point.endToEndMs.p95.confidenceIntervals95 = {
        differenceMs: comparisonInterval(
          estimates.p95DifferenceMs,
          point.endToEndMs.p95.differenceMs
        ),
        ratio: comparisonInterval(estimates.p95Ratio, point.endToEndMs.p95.ratio)
      };
      comparisons.push({
        leftVariant,
        rightVariant,
        direction: {
          difference: 'left_minus_right',
          ratio: 'left_divided_by_right'
        },
        blocks: {
          complete: completeBlocks.length,
          leftOnly: leftOnlyBlocks,
          rightOnly: rightOnlyBlocks,
          unassignedTrials: {
            left: unassignedTrials[leftVariant],
            right: unassignedTrials[rightVariant]
          }
        },
        bootstrap: {
          method: 'seeded_paired_whole_block_percentile_bootstrap',
          confidenceLevel: BOOTSTRAP_CONFIDENCE_LEVEL,
          samples,
          seed
        },
        ...point
      });
    }
  }
  return comparisons;
}

function validComparisonIdentity(identity) {
  if (!identity || typeof identity !== 'object') return false;
  if (typeof identity.model !== 'string' || identity.model.length === 0) return false;
  if (typeof identity.provider !== 'string' || identity.provider.length === 0) return false;
  return COMPARISON_IDENTITY_HASH_FIELDS.every((field) =>
    typeof identity[field] === 'string' && /^[a-f0-9]{64}$/.test(identity[field])
  );
}

function trialIsDatasetEligible(trial) {
  const eligible = trial.measurementEligible ?? trial.publishable;
  return eligible === true && trial.driver?.kind === 'agent';
}

const trialIsPublicationEligible = trialIsDatasetEligible;

function summarizeTrials(trials, options = {}) {
  const expectedVariants = options.expectedVariants ?? [...new Set(trials.map((trial) => trial.variant))];
  const minimumTrialsPerVariant = Number(
    options.minimumTrialsPerVariant ?? MIN_PUBLISHABLE_TRIALS_PER_VARIANT
  );
  if (!Number.isInteger(minimumTrialsPerVariant) || minimumTrialsPerVariant < MIN_PUBLISHABLE_TRIALS_PER_VARIANT) {
    throw new Error(
      `minimumTrialsPerVariant must be an integer >= ${MIN_PUBLISHABLE_TRIALS_PER_VARIANT}`
    );
  }

  const bootstrapSamples = bootstrapSampleCount(options.bootstrapSamples);
  const bootstrapSeed = String(options.bootstrapSeed ?? 'acp-benchmark-summary-v1');
  const eligibleTrials = trials.filter(trialIsDatasetEligible);
  const diagnosticVariants = summarizeVariantGroups(trials, expectedVariants, {
    bootstrapSamples,
    bootstrapSeed: `${bootstrapSeed}:diagnostic`
  });
  const variants = summarizeVariantGroups(eligibleTrials, expectedVariants, {
    bootstrapSamples,
    bootstrapSeed: `${bootstrapSeed}:dataset-eligible`
  });
  const pairedComparisons = summarizePairedComparisons(eligibleTrials, expectedVariants, {
    bootstrapSamples,
    bootstrapSeed: `${bootstrapSeed}:dataset-eligible:paired`
  });
  const diagnosticPairedComparisons = summarizePairedComparisons(trials, expectedVariants, {
    bootstrapSamples,
    bootstrapSeed: `${bootstrapSeed}:diagnostic:paired`
  });

  const models = [...new Set(trials.map((trial) => trial.model))].sort();
  const eligibleModels = [...new Set(eligibleTrials.map((trial) => trial.model))].sort();
  const environmentFingerprints = [...new Set(
    eligibleTrials
      .map((trial) => trial.environmentFingerprint)
      .filter((value) => typeof value === 'string' && value.trim().length > 0)
  )].sort();
  const missingEnvironmentFingerprint = eligibleTrials.some(
    (trial) => typeof trial.environmentFingerprint !== 'string'
      || trial.environmentFingerprint.trim().length === 0
  );
  const mixedEnvironments = environmentFingerprints.length > 1;
  const environmentFingerprintValid = eligibleTrials.length > 0
    && !missingEnvironmentFingerprint
    && environmentFingerprints.length === 1;
  const datasetEligibleTrials = eligibleTrials.length;
  const insufficientVariants = expectedVariants.filter(
    (variant) => (variants[variant]?.trials ?? 0) < minimumTrialsPerVariant
  );
  const scriptedTrials = trials.filter((trial) => trial.driver?.kind !== 'agent').length;
  const comparisonIdentityValid = validComparisonIdentity(options.comparisonIdentity);
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    headlineDataset: 'dataset_eligible_trials_only',
    totalTrials: trials.length,
    datasetEligibleTrials,
    datasetIneligibleTrials: trials.length - datasetEligibleTrials,
    publishableTrials: datasetEligibleTrials,
    nonPublishableTrials: trials.length - datasetEligibleTrials,
    models,
    mixedModels: models.length > 1,
    eligibleModels,
    environmentFingerprints,
    mixedEnvironments,
    environmentFingerprintValid,
    minimumTrialsPerVariant,
    expectedVariants,
    comparisonIdentity: comparisonIdentityValid ? options.comparisonIdentity : null,
    bootstrap: {
      method: 'seeded_percentile_bootstrap',
      confidenceLevel: BOOTSTRAP_CONFIDENCE_LEVEL,
      samples: bootstrapSamples,
      seed: bootstrapSeed
    },
    variants,
    diagnosticVariants,
    pairedComparisons,
    diagnosticPairedComparisons
  };
  summary.datasetEligible = trials.length > 0
    && summary.nonPublishableTrials === 0
    && !summary.mixedModels
    && environmentFingerprintValid
    && insufficientVariants.length === 0
    && comparisonIdentityValid;
  summary.publishable = summary.datasetEligible;
  summary.datasetIneligibleReasons = [
    ...(trials.length === 0 ? ['no_trials'] : []),
    ...(summary.nonPublishableTrials > 0 ? ['non_publishable_trial_records'] : []),
    ...(scriptedTrials > 0 ? ['scripted_or_non_agent_driver_records'] : []),
    ...(summary.mixedModels ? ['mixed_models'] : []),
    ...(!environmentFingerprintValid ? ['missing_or_mixed_environment_fingerprint'] : []),
    ...(!comparisonIdentityValid ? ['missing_or_invalid_comparison_identity'] : []),
    ...insufficientVariants.map((variant) => `insufficient_trials:${variant}`)
  ];
  summary.nonPublishableReasons = summary.datasetIneligibleReasons;
  return summary;
}

function classifyEvaluation(evaluation, options = {}) {
  if (options.timedOut) return 'timeout';
  if (options.infrastructureFailure) return 'infrastructure_failure';
  if (evaluation?.success) return 'success';
  const substantive = [
    'exactlyOneTaskAdded',
    'targetTaskCompleted',
    'searchQueryApplied',
    'searchCountCorrect',
    'storedThemeIsDark',
    'renderedThemeIsDark'
  ];
  return substantive.some((name) => evaluation?.assertions?.[name]) ? 'partial' : 'incorrect_result';
}

function deriveMetrics(events) {
  const metrics = {
    modelTurns: 0,
    usageRecords: 0,
    observations: 0,
    screenshotObservations: 0,
    accessibilityObservations: 0,
    uiActionAttempts: 0,
    acpCallAttempts: 0,
    uiActions: 0,
    acpCalls: 0,
    toolErrors: 0,
    toolDurationMs: 0,
    hostDurationMs: 0,
    recoveryLoops: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0
  };

  for (const event of events) {
    if (event.type === 'model.turn') metrics.modelTurns += 1;
    if (event.type === 'observation') {
      metrics.observations += 1;
      if (event.kind === 'screenshot') metrics.screenshotObservations += 1;
      if (event.kind === 'accessibility') metrics.accessibilityObservations += 1;
    }
    if (event.type === 'recovery') metrics.recoveryLoops += 1;
    if (event.type === 'tool.start') {
      if (event.toolKind === 'acp') metrics.acpCallAttempts += 1;
      if (event.toolKind === 'ui') metrics.uiActionAttempts += 1;
    }
    if (event.type === 'tool.error') {
      metrics.toolErrors += 1;
      metrics.toolDurationMs += Number(event.durationMs) || 0;
    }
    if (event.type === 'tool.end') {
      if (event.toolKind === 'acp') metrics.acpCalls += 1;
      if (event.toolKind === 'ui') metrics.uiActions += 1;
      metrics.toolDurationMs += Number(event.durationMs) || 0;
      metrics.hostDurationMs += Number(event.hostDurationMs) || 0;
    }
    if (event.type === 'usage') {
      metrics.usageRecords += 1;
      metrics.inputTokens += Number(event.inputTokens) || 0;
      metrics.outputTokens += Number(event.outputTokens) || 0;
      metrics.estimatedCostUsd += Number(event.estimatedCostUsd) || 0;
    }
  }
  return metrics;
}

module.exports = {
  BOOTSTRAP_CONFIDENCE_LEVEL,
  CAPABILITY_PROFILES,
  COMPARISON_IDENTITY_HASH_FIELDS,
  DEFAULT_BOOTSTRAP_SAMPLES,
  MIN_DATASET_ELIGIBLE_TRIALS_PER_VARIANT,
  MIN_PUBLISHABLE_TRIALS_PER_VARIANT,
  VARIANTS,
  classifyEvaluation,
  bootstrapMetricIntervals,
  createSchedule,
  deriveMetrics,
  median,
  percentile,
  summarizeMetric,
  summarizePairedComparisons,
  summarizeTrials,
  trialIsDatasetEligible,
  trialIsPublicationEligible,
  validComparisonIdentity,
  validateCapabilities,
  wilsonInterval
};
