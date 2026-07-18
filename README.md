# Computer-Use Test Bench

A basic Electron app with varied pages and interactive components, built as a target
for testing computer-use / UI-automation capabilities.

## Run

```bash
npm install
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
