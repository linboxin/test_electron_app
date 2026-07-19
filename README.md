# Computer-Use Test Bench

A basic Electron app with varied pages and interactive components, built as a target
for testing computer-use / UI-automation capabilities.

## Run

```bash
npm ci
npm start
```

## Pages

| Page | What's on it |
|------|--------------|
| **Dashboard** | Stat cards, quick-action buttons, live activity log of everything you do |
| **Forms** | Text/email/password/date/url inputs, select, radios, checkboxes, range slider, textarea, validation, submit → JSON result |
| **Tasks** | Todo list: add with priority, complete, delete, filter (All / Active / Completed) |
| **Data Table** | 50-row employee table: sortable columns, live search, pagination |
| **Widgets** | Tabs, accordion, counter, animated progress bar, toggle switches, modal dialog, toasts, drag-to-reorder list |
| **Settings** | Light/dark theme, font size, display name (persisted via localStorage), native message box / file dialog / notification, clipboard copy-paste, app version info |

## Notes for automation

- Every interactive element has a stable `id` (e.g. `#nav-forms`, `#btn-add-task`, `#input-email`).
- Navigation is client-side; all six pages live in one window.
- The Dashboard activity log records navigation and actions, useful for verifying an agent actually performed a step.

## Drive it with ACP

This app embeds the [App Context Protocol](https://github.com/linboxin/appcontextprotocol): 11 semantic actions, 5 state keys, and an event stream, registered mostly from the renderer (`renderer/app.js`, `initAcp()`).

```bash
# from the appcontextprotocol repo, with this app running:
node packages/cli/dist/bin.js ls
node packages/cli/dist/bin.js describe com.linboxin.test-bench
node packages/cli/dist/bin.js call com.linboxin.test-bench add_task --args '{"title":"Hello","priority":"high"}'
node packages/cli/dist/bin.js call com.linboxin.test-bench fill_profile_form --args '{"name":"Ada","email":"ada@example.com","password":"hunter2xx","submit":true}'
node packages/cli/dist/bin.js watch com.linboxin.test-bench   # then click around the UI
```

ACP packages are vendored as tarballs in `vendor/` until they're published to npm.

## Deterministic benchmark mode

Benchmark mode is opt-in and resets the app on every launch or renderer reload:

```bash
ACP_BENCHMARK=1 npm start
```

It fixes the default window at `1200×800` at `(100, 80)`, clears persisted renderer settings, and restores the canonical fixture:

- dashboard active, zero recorded clicks and form submissions;
- the original three tasks, with task 2 incomplete;
- employee table query empty, id ascending, page 1;
- light theme, 16 px font, and no display name.

The benchmark harness supplies a fresh Chromium profile, runtime, and driver working directory for every trial, waits for the exact 11-action/5-state/1-event surface, and evaluates raw application state through a benchmark-only IPC snapshot that is not exposed over ACP. The controlled target is withheld until a driver has attested readiness and exact capabilities; timed success then requires both correct independent state and a structured final report. Provider, model, modality, request, and usage records are trusted-adapter attestations checked for internal consistency, not independent proof from a model provider.

```bash
npm test
npm run test:integration
npm run benchmark -- doctor
```

See [`benchmark/README.md`](benchmark/README.md) for the canonical prompt, driver contract, trial commands, artifact validation, timing boundaries, provenance pins, and fail-closed publication rules. The included scripted ACP driver is a harness smoke test only; it is deliberately marked non-publishable and is not evidence of agent speed.
