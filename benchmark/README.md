# Reproducible computer-use benchmark

This directory turns the Electron test bench into a controlled target for comparing visual computer use with App Context Protocol (ACP). It implements deterministic reset, an evaluator outside the tested agent surface, a provider-neutral agent-driver contract, retained raw trial records, interleaved scheduling, and summary generation.

It does **not** yet include production adapters for Codex, Claude, or another model provider. Existing agents do not need to be rewritten to use ACP, but a benchmark adapter must start a fresh agent conversation, give it exactly the allowed tools, and translate its transcript into the JSON Lines driver protocol described below.

## Current status

Implemented and tested:

- ACP attaches before the renderer window is created, eliminating the registration race.
- A fresh process exposes exactly 11 actions, 5 state keys, and `activity.logged` at readiness.
- Benchmark mode restores the same tasks, table, settings, page, counters, and window bounds.
- UI and ACP mutations notify all exposed mutable state keys.
- `delete_task` is both destructive and confirmation-gated.
- Raw semantic state is written atomically through benchmark-only IPC.
- The independent evaluator checks the exact final state, including the five matching Chen employee ids.
- The trial runner validates driver attestations, capability use, protocol events, ACP audit correspondence, and required observation artifacts before classifying every outcome.
- `doctor`, `run-one`, `run`, `resume`, and `summarize` are available.

Still required before a headline comparison:

- one controlled agent adapter that supports both the screenshot baseline and ACP-augmented hybrid profile;
- a five-trial-per-variant pilot of that additive-tool comparison;
- 20–30 trials per primary variant for publication;
- robustness runs and clean-machine reproduction;
- screenshot/video capture integration and model usage/cost reporting from each adapter.

The full project-level evidence policy lives in the canonical [ACP benchmark methodology](https://github.com/linboxin/appcontextprotocol/blob/main/docs/benchmark.md). That documentation is a merge dependency for this harness branch.

## Canonical task

Every tested system receives exactly this prompt:

> In the Computer-Use Test Bench, add a high-priority task titled “Prepare launch checklist,” mark “Sort the data table by salary” complete, search the employee table for “Chen” and report the number of matches, then switch the application to dark mode. Tell me when all four steps are complete.

The independent state evaluator requires:

- exactly one new task, id 4, titled `Prepare launch checklist`, priority `high`, incomplete;
- task 2 complete and the other original tasks unchanged;
- table query semantically equal to `Chen` after trimming and case normalization, with count 5 and employee ids `3, 13, 23, 33, 43`;
- stored and rendered themes both `dark`;
- no modal overlay open.

The driver must also emit exactly one valid structured final event with `completed: true` and `reportedMatchCount: 5`. End-to-end success requires both the independent state evaluation and that structured final report. An agent saying it succeeded in free-form text is never proof of success.

## Quick verification

```bash
npm ci
npm test
npm run test:integration
npm run benchmark -- doctor
```

`doctor` launches a hidden, isolated Electron process and checks the fixture and the complete ACP surface. It warns when the Git working tree is dirty because uncommitted trials are dataset-ineligible.

To exercise the complete artifact pipeline with the included deterministic script:

```bash
npm run benchmark -- run-one \
  --variant acp \
  --model scripted-smoke \
  --driver-kind scripted-smoke \
  --headless \
  --timeout-ms 10000 \
  --output benchmark-results/scripted-smoke \
  -- node "$PWD/benchmark/drivers/scripted-acp.js"
```

This validates the harness only. The result contains `publishable: false`, zero model turns, and no token usage. Its timing must never be compared against an agent-run computer-use result.

## Trial isolation and reset

For every trial, the harness:

1. creates a mode-`0700` temporary runtime directory;
2. creates fresh Chromium user data and `ACP_HOME` subdirectories;
3. starts Electron with `ACP_BENCHMARK=1` and fixed window bounds;
4. waits for a ready atomic state snapshot;
5. polls `acp/describe` until 11 actions, 5 state keys, and 1 event are present;
6. independently verifies the canonical initial fixture;
7. starts the driver in a fresh, empty working directory, without the target app id, pid, or live `ACP_HOME`;
8. validates `driver.ready`, including model/kind attestation and the exact declared capability profile;
9. rechecks that the fixture and ACP audit are untouched, starts the monotonic timer, and sends the prompt and target in `start`;
10. records when independent state first succeeds, but ends successfully only after both state success and a valid structured final event;
11. validates the event stream, ACP audit correspondence, and required observation artifacts;
12. terminates only the Electron and driver processes it created, retains the inspected evidence, and removes the token-bearing runtime directory.

There is no ACP `reset_benchmark` action. The tested agent cannot reset or query the evaluator through its semantic tool surface.

## Capability profiles

The driver must declare exactly one of these allowlists in `driver.ready`:

| Variant | Role | Allowed capabilities |
| --- | --- | --- |
| `screenshot` | Primary controlled baseline | `screenshot`, `pointer`, `keyboard`, `text` |
| `hybrid` | Primary ACP-augmented treatment | baseline capabilities plus `acp` |
| `accessibility` | Secondary non-ACP ablation | baseline capabilities plus `accessibility` |
| `acp` | Diagnostic protocol-sufficiency ablation | `acp` only |

The headline experiment compares `screenshot` with `hybrid`: the same model, prompt, base instructions, sampling controls, adapter build, and ordinary computer-use capabilities, with ACP as the sole addition. The adapter may expose several UI tools or action types under the `ui` event kind; this is not a single-tool-agent comparison. Unrestricted shell, DOM, filesystem, evaluator, and other bypass paths remain outside both profiles so they cannot solve the fixture through application internals.

The harness rejects a mismatched or stronger declaration before timing starts. It then rejects event streams containing undeclared observation or tool kinds, malformed/unpaired tool events, work before `start`, or unexpected events after `final`. ACP/hybrid tool attempts are cross-checked by count and action name against the app's ACP audit log; visual-only profiles must leave that audit empty.

These checks make honest adapter mistakes visible. The driver remains trusted measurement infrastructure and is responsible for enforcing that the model receives no shell, DOM, filesystem, evaluator, or undeclared tools; capability declarations are not a hostile-process sandbox.

Provider and model identifiers, request-id hashes, the capability profile/modality, observation kinds, and usage values all originate in that trusted adapter. The harness checks them against the pinned configuration and against one another, but it does not contact the provider or authenticate a provider-signed response. They are therefore adapter attestations, not independent proof of which provider or model ran, which modality the model could access, or what usage the provider billed. The ACP audit cross-check independently confirms app-side ACP action names and counts only; it does not establish model or provider identity.

Before production adapters support a headline comparison, their tool-boundary enforcement must be reviewed and auditable, and each inference must retain a redacted provider receipt or equivalent provider-origin record that can be reconciled to the request-id hash. Production provenance must also pin a reviewed runtime/build manifest covering the adapter dependency closure, wrapper resources, interpreter/runtime, lockfile, and relevant launch configuration. The current entrypoint hash is useful, but by itself it does not pin that complete execution environment.

Do not add an ACP-preference instruction to the primary `hybrid` profile. The model must discover and choose ACP from the added tool surface. An ACP-informed policy can be studied in a separately labelled run, but changing the instructions makes that run ineligible for aggregation with the primary additive-tool comparison.

## Driver protocol

Drivers communicate with the harness as newline-delimited JSON over stdin/stdout. Diagnostic output belongs on stderr.

The driver first emits this before creating the tested conversation or inspecting the app. `capabilityProfile` is the configured variant name; `adapterBuildHash` is computed by the harness from the resolved adapter entrypoint and is not a user-authored placeholder:

```json
{"type":"driver.ready","schemaVersion":1,"name":"my-driver","kind":"agent","model":"pinned-model-id","capabilityProfile":"hybrid","conversationCreated":false,"appInspected":false,"capabilities":["screenshot","pointer","keyboard","text","acp"]}
```

Only after validating `driver.ready` does the timed `start` message supply the prompt, variant, pinned model id, fixture, driver artifact directory, and target app id/pid. ACP/hybrid drivers also receive the live ACP home path in `start`; the pre-ready `ACP_HOME` is an empty isolated directory. The message never contains the evaluator or raw-state path.

Drivers should emit structured events:

- `model.turn` with the attested provider, model, and a SHA-256 hash of the provider request id
- `observation` with `kind: screenshot` or `kind: accessibility`
- `tool.start`
- `tool.end` with `toolKind: ui` or `toolKind: acp`
- `tool.error`
- `recovery`
- `usage` with the same provider/model/request-id hash plus input/output tokens and optional cost attested by the adapter as provider-reported
- `final` with `completed: true` and `reportedMatchCount: 5`

See [`driver-protocol.md`](driver-protocol.md) for the full contract.

## Single trial

```bash
npm run benchmark -- run-one \
  --variant hybrid \
  --model pinned-model-id \
  --driver-name my-agent-adapter \
  --driver-kind agent \
  --timeout-ms 180000 \
  --output benchmark-results/hybrid-one \
  -- /absolute/path/to/driver --profile hybrid
```

The primary timer starts only after `driver.ready`, when the harness writes the `start` event containing the target. Fresh conversation creation and app-specific MCP/tool discovery must occur after that event. A successful end-to-end measurement ends only after both independent state success and a valid structured final event. `stateSatisfiedMs` records the earlier state-only milestone when present; `agentFinalMs` records final-event arrival, and app launch/readiness remains separate as `appLaunchReadyMs`.

## Interleaved pilot or evidence run

Copy the example config and replace every driver command, absolute `commandFile` and provenance source file, pinned model/provider id, and SHA-256 identity field:

```bash
cp benchmark/configs/pilot.example.json benchmark/configs/pilot.json
npm run benchmark -- run --config benchmark/configs/pilot.json \
  --output benchmark-results/pilot-20260718
```

As checked in, the example schedules 20 trials for each primary variant (40 total across `screenshot` and `hybrid`), the minimum dataset-evidence run. For a diagnostic pilot, set only `trialsPerVariant` to 5 while leaving `minimumPublishableTrialsPerVariant` at 20; that produces 10 total trials and its evidence gate must fail. Every block contains one run of each variant in seeded random order, reducing drift from model service conditions and machine state. Use 20–30 trials per primary variant for the evidence dataset; 30 is preferred when service variance is high. Run `accessibility` and ACP-only ablations separately so they cannot be mistaken for the headline treatment. The config key `minimumPublishableTrialsPerVariant` is retained for schema compatibility, but its precise meaning is the minimum dataset-eligible attempt count; it cannot be set below 20 and does not grant project-level publication approval.

All compared variants must declare exactly the same `model`, `provider`, `agentConfigHash`, `baseInstructionHash`, and `samplingHash`. They must use the same adapter entrypoint bytes: the harness resolves `commandFile`, computes `adapterBuildHash` from its SHA-256, and requires that build identity to match across variants. Each driver config supplies a `capabilityProfile` equal to its variant (`screenshot`, `accessibility`, `acp`, or `hybrid`); that profile is the only intentional tool-surface difference and is excluded from `agentConfigHash`. The primary example deliberately configures only `screenshot` and `hybrid`.

The three config-authored hashes have canonical inputs and absolute source-file fields:

- `agentConfigFile` contains UTF-8 canonical JSON for the common agent configuration, including provider endpoint mode, wrapper options, and agent settings, but excluding `capabilityProfile`; `agentConfigHash` is the SHA-256 of that file's exact bytes;
- `baseInstructionFile` is the retained common base-instruction artifact (or a canonical JSON manifest of path plus file SHA-256 when instructions span multiple files); `baseInstructionHash` is the SHA-256 of its exact bytes;
- `samplingFile` contains UTF-8 canonical JSON for all sampling and reasoning controls, including temperature, top-p, reasoning effort, maximum output, seed, and provider-specific flags; `samplingHash` is the SHA-256 of that file's exact bytes.

For these fields, canonical JSON means recursively sorted object keys, array order preserved, omitted `undefined` values, and compact `JSON.stringify` output encoded as UTF-8 with no trailing newline. The harness resolves the three absolute source files, verifies their byte hashes at creation and resume, and pins their paths; preserve and publish reviewed copies with the run evidence. All-zero digests, example values, hashes of undocumented inputs, and placeholders such as `replace-me` are not valid evidence.

Each adapter entrypoint must be an absolute `commandFile`, and that same absolute file must be invoked directly as `command` or appear in `args`. For example, a Node adapter uses an absolute Node executable (or `node` from the pinned environment), the absolute adapter file as the first argument, and then `--profile hybrid`. Do not configure a driver `cwd` for an evidence run: the harness creates a new empty working directory for every trial.

`adapterBuildHash` currently hashes only the resolved entrypoint file. For a production evidence run, retain and hash the fuller runtime/build manifest described above and bind it to the run identity; do not interpret entrypoint equality as dependency-closure or runtime equality.

Resume an interrupted run or regenerate its summary:

```bash
npm run benchmark -- resume --run benchmark-results/pilot-20260718
npm run benchmark -- summarize --run benchmark-results/pilot-20260718
```

Do not place API keys directly in config files or command arguments. The driver receives a small platform-compatibility environment allowlist plus harness-owned variables. List each additional required environment-variable name in `envNames`; the harness passes only those current values and records the names, not the values, in pinned config artifacts.

At creation, the harness writes `config.pinned.json` and records hashes for the source config, normalized executable config, randomized schedule, implementation/worktree state, and adapter build. Those hashes form the run identity. `resume` refuses to continue if the implementation, config, schedule, run identity, or adapter file has changed.

The automated **run/dataset evidence gate** is fail-closed. A trial is excluded for failed attestation or protocol validation, missing adapter-attested provider/model/request records, missing/invalid required observations, ACP audit mismatch, redaction findings, infrastructure failure, headless mode, dirty source, a non-agent driver, an explicit driver `cwd`, or missing provenance pins. A single well-formed but incorrect final report is a measured task failure—not an exclusion—so it remains in the eligible success-rate denominator; a missing, duplicate, or protocol-invalid final event is infrastructure-invalid evidence. At run level, every retained record must be eligible, every configured adapter must be an agent using the isolated working directory, the same adapter build and common configuration must be used across variants, all eligible records must share one recorded environment fingerprint, provenance must remain consistent, the schedule must be complete without preserved interrupted attempts, and every compared variant must have at least 20 eligible attempts. Passing this gate establishes internal consistency under the trusted-adapter assumption; it does not upgrade adapter attestations into provider-origin proof.

`measurementEligible` is the canonical raw-record field for “eligible for this dataset”; `publishable` remains a compatibility alias with the same value. A CLI gate result means only that one run satisfies the automated evidence checks. It is not approval for a public ACP speed claim. Project-level publication also requires the separate robustness experiment, clean-machine reproduction, representative recording, raw-result review, and claim review defined in the canonical ACP benchmark methodology linked above.

## Artifacts

Each trial retains:

```text
trials/0001-acp/
  trial.json
  artifact-manifest.json
  transcript.jsonl
  evaluator.json
  initial-state.json
  final-state.json
  environment.json
  app.stdout.log
  app.stderr.log
  driver.stderr.log
  audit.sanitized.json
  prompt.txt
  driver-artifacts/
    screenshots/0001.png
    accessibility/0001.json
```

The exact contents of `driver-artifacts/` depend on the profile. Every `observation.artifact` must be a relative path contained within that directory and resolve to a non-symlink regular file. Screenshot observations must be non-empty valid PNG files; accessibility observations must be non-empty valid JSON files. The trial record stores each accepted artifact's relative path, byte count, SHA-256, and applicable media metadata. Screenshot/accessibility/hybrid trials require a screenshot, and accessibility trials also require an accessibility-tree artifact.

At finalization, `artifact-manifest.json` records the path, byte count, and SHA-256 of each retained trial artifact other than itself and `trial.json`; `trial.json` records the manifest digest, file count, and total bytes. Resume and summarize verify this file set. This detects accidental truncation, loss, corruption, or an incomplete copy after finalization. It is not hostile-tamper resistance: an attacker able to rewrite the trial directory can replace an artifact, the manifest, and the co-located trial/run metadata together. Tamper-resistant publication requires an authenticated external anchor such as a signed run index, transparency log, or write-once evidence store.

The current runner bounds driver-controlled evidence at 256 KiB per stdout JSONL line, 16 MiB total stdout, 10,000 event records, 4 MiB stderr, 32 MiB per artifact file, 128 MiB total artifacts, and 2,000 artifact files. The artifact monitor rejects symlinks, non-regular files, and multiply linked files, scans during execution, and performs a final scan; exceeding a limit terminates the driver and makes the trial an infrastructure failure. These caps protect parsing, memory, and retained-evidence storage. They do not cap CPU, process memory, network access, or arbitrary filesystem access and are not a hostile-driver sandbox.

The trial record follows [`trial.schema.json`](trial.schema.json). The audit artifact deliberately excludes action arguments because ACP audit records can contain secrets. The discovery bearer token, raw live `ACP_HOME`, evaluator control path, and temporary Chromium profile are deleted with the runtime directory.

Before final classification, the harness scans retained textual files for the known ACP token, explicitly allowlisted environment values, and a small set of common API-key/token patterns. Matches are replaced and make the trial dataset-ineligible. This is a limited leakage safety net, not proof that every secret format or binary artifact is sanitized. Trusted adapters must keep credentials and sensitive tool arguments out of events and artifacts in the first place; review retained evidence before sharing it.

Terminal outcomes are retained as one of:

- `success`
- `incorrect_result`
- `partial`
- `timeout`
- `infrastructure_failure`

The harness never silently retries or discards a completed failure. On resume, it schema-checks and reconciles every recorded trial. Partial or invalid artifact directories are renamed and retained as interrupted attempts before a fresh scheduled attempt is created; their presence makes the aggregate dataset evidence gate fail until reviewed.

## Timing and reporting

Primary end-to-end time starts when the full prompt and controlled target are delivered to the ready driver. A successful timer stops only when both the independent state evaluator has passed and the driver's structured final event has passed (`completed: true`, `reportedMatchCount: 5`); the later timestamp is used. It includes fresh conversation creation, app-specific discovery, model reasoning, observations, tool choice, UI or ACP calls, recovery, application execution, and the required result report.

These remain separate:

- app launch/readiness time;
- `stateSatisfiedMs`, the state-only success milestone;
- agent-final response time;
- ACP call wall time emitted by a driver;
- host-reported action-handler duration;
- human confirmation wait time.

Summaries split evidence-eligible metrics from diagnostics. The primary `variants` dataset contains only eligible agent trials; `diagnosticVariants` contains every retained record, including scripted smoke runs and dirty-working-tree runs. Success rate uses every eligible attempt and is reported with a 95% Wilson interval. Median and p95 end-to-end latency use successful eligible trials only and include seeded 95% bootstrap percentile intervals: resample the successful latencies with replacement at the original successful-sample size, compute both statistics for at least 10,000 resamples, and take the 2.5th and 97.5th percentiles. Derive and retain the bootstrap seed before examining results (for example, from the pinned run identity plus variant and metric), and record the seed, resample count, and method in the summary. Timeouts and infrastructure failures remain visible in outcome counts. Scripted drivers are intrinsically ineligible.

The summary also reports ordered `pairedComparisons` for the eligible dataset and `diagnosticPairedComparisons` for all retained records. Pairing comes from the verified block number in the pinned schedule; raw trial or run-ledger copies of block metadata are not trusted. For each ordered pair, only blocks containing both variants enter the comparison. A single seeded bootstrap draw resamples those complete blocks with replacement and uses the same selected blocks for both variants. The paired success-rate estimate is left minus right. Successful-run median and p95 latency contrasts retain the same per-variant success-conditioned estimand as the headline metrics and report both left-minus-right milliseconds and left-divided-by-right ratios. A latency contrast is `null` when either side has no finite successful latency, and a ratio is `null` when its right-side estimate is not positive. Each interval reports the number of finite bootstrap replicates used, so undefined latency resamples are visible rather than serialized as `NaN` or infinity. The method, ordered pair, sample count, 95% confidence level, and SHA-256-derived seed are retained in `summary.json`; `summary.md` renders the eligible comparisons explicitly with their direction.

## Robustness controls

The harness already accepts fixed or varied window bounds and `startupRenderDelayMs`. That delay applies only before the renderer's initial benchmark snapshot; it does not inject latency into later renders, actions, or state updates. Additional driver/host controls should record display resolution and scale, partial occlusion, theme, restart state, and second-display placement. Change one factor at a time and report robustness separately from healthy-condition performance.

## Security boundary

- The raw evaluator snapshot is sent over a benchmark-only preload IPC method and written atomically by the main process into a fresh mode-`0700` control directory outside the app's token-bearing ACP runtime.
- The control directory and snapshot path are not passed in the driver environment or `start` message; they are also treated as secrets during retained-artifact scanning and removed during app teardown.
- Every driver starts with an isolated empty `ACP_HOME`; only after valid `driver.ready` do ACP and hybrid wrappers receive the running app's discovery directory in the timed `start` message.
- Every driver starts in a fresh empty working directory unless an explicit dataset-ineligible `cwd` is configured.
- Tested models must not receive shell, filesystem, DOM, or evaluator tools.
- Driver wrappers are trusted measurement infrastructure; they must not leak control paths into model prompts or tool descriptions.
- Observation artifacts are contained, type-checked, and hashed; the co-located artifact manifest detects accidental integrity failures, not coordinated hostile tampering, and textual redaction does not make arbitrary retained files safe to publish automatically.
- Only harness-owned temporary directories and child processes are cleaned up.

This boundary prevents accidental evaluator use. It is not a hostile sandbox against a malicious locally executing driver process.
