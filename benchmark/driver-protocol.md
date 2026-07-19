# Benchmark driver protocol v1

The harness uses a provider-neutral subprocess protocol so model/provider integration is separate from benchmark semantics. Transport is JSON Lines: one JSON object per line on stdin/stdout. Driver diagnostics go to stderr.

## Lifecycle

1. Harness starts the driver with no prompt or target app id/pid and gives it a fresh empty working directory and an empty `ACP_HOME`.
2. Driver initializes only its wrapper/provider transport and emits `driver.ready`; it must not create the tested conversation, inspect the app, or discover app-specific tools yet.
3. Harness validates the capability profile.
4. Harness starts its monotonic timer and sends `start` with the prompt and controlled target; only ACP/hybrid receives the live ACP home path.
5. Driver runs one fresh conversation and emits events as work happens.
6. The independent state evaluator and the structured final event both reach success, the driver becomes terminal, or the timeout expires.
7. Harness sends `stop` and terminates the owned driver if it does not exit promptly.

Each process handles exactly one trial.

## Driver to harness

### `driver.ready` — required, exactly once

```json
{
  "type": "driver.ready",
  "schemaVersion": 1,
  "name": "provider-adapter-name",
  "kind": "agent",
  "model": "pinned-model-id",
  "capabilityProfile": "acp",
  "conversationCreated": false,
  "appInspected": false,
  "capabilities": ["acp"]
}
```

The name, kind, model id, capability profile, and capability list must exactly match the run configuration. `capabilityProfile` is the variant name, not a free-form label. `conversationCreated` and `appInspected` must both be false. Wrapper/process initialization before this event is excluded from end-to-end task time; fresh conversation creation, MCP/tool discovery, and every app observation happen after `start` and are included. The declaration is validated as protocol evidence, but the adapter is still trusted to enforce its tool boundary.

The harness resolves the configured adapter `commandFile`, computes `adapterBuildHash` from its SHA-256, and requires the same build across compared variants. The driver does not invent or supply that hash. Use one adapter entrypoint whose behavior is selected by `capabilityProfile`; separate unpinned wrapper builds are not comparable.

## Evidence trust model

The harness does not call the model provider to verify these events. Provider and model names, request-id hashes, `capabilityProfile` and observation/tool modality, and usage values are authored by the adapter and checked for protocol validity and internal consistency. Even when `usage.source` is `provider`, the record means that the trusted adapter attests it copied provider-reported values; it is not a provider signature or independent provider proof. File-type validation can confirm that a referenced screenshot is a PNG or an accessibility artifact is JSON, but it cannot prove what the model was actually allowed to see.

Production evidence therefore needs more than a well-formed event stream: use an audited adapter boundary that enforces the declared tools, retain redacted provider receipts or equivalent provider-origin records reconciled to each `requestIdHash`, and pin a reviewed runtime/build manifest for the adapter's dependencies, wrapper resources, interpreter/runtime, lockfile, and launch configuration. `adapterBuildHash` currently covers the entrypoint bytes only.

### `model.turn`

```json
{"type":"model.turn","turn":1,"provider":"provider-id","model":"pinned-model-id","requestIdHash":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}
```

Emit once per provider inference request. `provider` and `model` must equal the pinned run identity. `requestIdHash` is lowercase SHA-256 of the exact provider request id encoded as UTF-8; never retain the raw provider request id. Turn numbers start at 1 and increase by one. An evidence-eligible agent trial needs at least one `model.turn`, and request-id hashes must not be reused across distinct provider requests.

### `observation`

```json
{"type":"observation","kind":"screenshot","artifact":"screenshots/0001.png"}
```

`kind` is `screenshot` or `accessibility`. `artifact` is relative to the `artifactDirectory` supplied in `start` (the retained `driver-artifacts/` directory); absolute paths, traversal outside that directory, symlinks, missing files, and empty files are rejected. Screenshots must be valid PNG files and accessibility trees must be valid JSON. Accepted files are hashed and recorded with their byte count and media metadata. Do not embed large base64 content in the transcript.

### `tool.start`, `tool.end`, and `tool.error`

```json
{"type":"tool.start","toolKind":"acp","tool":"set_theme"}
{"type":"tool.end","toolKind":"acp","tool":"set_theme","durationMs":8.2,"hostDurationMs":1}
{"type":"tool.error","toolKind":"ui","tool":"click","error":"target not found"}
```

`toolKind` is `acp` or `ui`. Every start must have a matching end or error, and the declared profile determines which tool and observation kinds are legal. ACP/hybrid attempts are cross-checked against the app's action audit log; screenshot/accessibility profiles must not create ACP audit records. Do not log secrets in arguments or results.

### `recovery`

```json
{"type":"recovery","reason":"prior click did not change state"}
```

A recovery is a corrective observation/action sequence after the agent detects or suspects an unsuccessful or uncertain earlier action. Tool errors are counted separately.

### `usage`

```json
{"type":"usage","source":"provider","provider":"provider-id","model":"pinned-model-id","requestIdHash":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","inputTokens":1200,"outputTokens":180,"estimatedCostUsd":0.0123}
```

Emit usage attested by the adapter as provider-reported once for each inference request, with `source: "provider"` and the same `provider`, `model`, and `requestIdHash` as its `model.turn`. `inputTokens` and `outputTokens` must be finite, nonnegative, and nonzero in total. Do not estimate token counts from transcript text. The adapter must document which provider usage fields are included; `estimatedCostUsd` is optional and must document its price source. A provider that returns usage only after streaming completes emits the event then. Missing, estimated, zero-total, duplicate, or unmatched request attestations make the trial ineligible for the dataset gate. The `source` label remains an adapter assertion unless backed by the separately retained provider receipt described above.

### `final`

```json
{"type":"final","completed":true,"reportedMatchCount":5,"text":"All four steps are complete; Chen has 5 matches."}
```

Exactly one final event is required. `completed` must be the boolean `true`, `reportedMatchCount` must be the number `5`, and `error` must be absent or null. Free-form `text` is optional and is not parsed as proof. The independent state evaluator still determines whether the app is correct; a successful trial requires both checks. `stateSatisfiedMs` records state-only success, `agentFinalMs` records final-event arrival, and end-to-end time ends at the later successful milestone.

## Harness to driver

### `start`

```json
{
  "type": "start",
  "schemaVersion": 1,
  "prompt": "...",
  "promptHash": "sha256",
  "fixture": "canonical-v1",
  "variant": "acp",
  "model": "pinned-model-id",
  "capabilityProfile": "acp",
  "capabilities": ["acp"],
  "artifactDirectory": "/isolated/trial/driver-artifacts",
  "app": {
    "appId": "com.linboxin.test-bench",
    "pid": 12345,
    "windowTitle": "Computer-Use Test Bench",
    "acpHome": "/isolated/runtime/acp-home"
  }
}
```

The driver must now create a fresh conversation, initialize its declared tools, deliver the prompt without modification, and enforce only the declared tools. This is the first message containing the app id/pid and, for ACP/hybrid only, the live ACP home path. Screenshot/accessibility starts omit `app.acpHome` and retain their empty `ACP_HOME`. The app object never contains the ACP bearer token or evaluator path. The raw evaluator snapshot lives in a separate mode-`0700` harness control directory outside the ACP runtime, driver working directory, and driver artifact directory; neither its directory nor its environment variable is passed to the driver. Keep `app.acpHome` inside trusted adapter code; do not expose the path or manifest contents to the model. This is control-path isolation under a trusted adapter, not protection from a malicious local process that searches the host.

Write observation files beneath `artifactDirectory` and emit their relative paths. The harness also exposes that output directory as `ACP_BENCHMARK_ARTIFACT_DIR`, but an adapter must not treat it as permission to inspect other trial or evaluator files.

### `stop`

```json
{"type":"stop","reason":"evaluation_passed"}
```

The driver should cancel outstanding model/tool work, flush its transcript, and exit.

## Current resource limits

The harness accepts at most 256 KiB per stdout JSONL line, 16 MiB total stdout, 10,000 event records, and 4 MiB stderr. The driver artifact tree is limited to 32 MiB per file, 128 MiB total, and 2,000 files; symlinks, non-regular files, and multiply linked files are rejected. The harness monitors the tree during execution and scans it again during shutdown. A violation terminates the driver and, where the platform supports it, its owned process group, and makes the trial infrastructure-invalid. These are parser and retained-evidence budgets, not CPU, memory, network, or filesystem sandboxing.

## Adapter requirements

- Pin the exact model and sampling/reasoning configuration, and retain a hashed runtime/build manifest covering the adapter's dependency closure, wrapper resources, interpreter/runtime, lockfile, and launch configuration.
- Use the same adapter build, common agent configuration, base instructions, and sampling/reasoning configuration for all variants; only the declared `capabilityProfile` and its documented capability-specific policy may differ.
- Emit one `model.turn` and one matching adapter-attested, provider-reported `usage` event per provider inference request, with the pinned provider/model and hashed request id; retain a redacted provider-origin receipt that can be reconciled to that hash.
- Start a fresh conversation for every process/trial.
- Accept the harness-provided fresh working directory; configuring a reusable `cwd` makes the trial dataset-ineligible.
- Prevent the model from receiving shell, filesystem, DOM, source-code, evaluator, or undeclared tools, and make this enforcement boundary auditable rather than relying only on the capability declaration.
- Keep API credentials in the wrapper environment and out of events, command arguments, and artifacts. Run configs pass only named `envNames` in addition to the harness's platform-compatibility environment allowlist.
- Preserve provider errors as structured events and nonzero exits.
- Record screenshots and accessibility observations as separate artifacts where applicable.
- Invoke the same absolute `commandFile` in every compared profile. When an interpreter is the command, put the absolute adapter entrypoint in `args`; metadata that names a file without invoking it is rejected.

The harness applies a limited text scan for known runtime secrets, explicitly passed environment values, and common token shapes. A finding is redacted and makes the trial dataset-ineligible, but this is not universal secret detection and does not sanitize arbitrary binary artifacts. Adapter authors must review retained evidence before sharing it.
