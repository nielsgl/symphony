# Desktop QA Checklist

This checklist is the repeatable validation flow for the Tauri desktop host and
shared operator dashboard.

## Preconditions

- Run from repository root.
- Dependencies installed: `npm install`.
- Rust toolchain installed for Tauri host checks.
- Recommended local mode for deterministic runs:
  - `SYMPHONY_OFFLINE=1`

## Fast Scripted Run

Use this one-liner to run the full scripted suite:

```bash
SYMPHONY_OFFLINE=1 npm run build && \
SYMPHONY_OFFLINE=1 npm test && \
SYMPHONY_OFFLINE=1 npm run test:e2e:web && \
SYMPHONY_OFFLINE=1 npm run test:e2e:desktop-runtime && \
SYMPHONY_OFFLINE=1 npm run test:desktop:native-smoke
```

Expected result:

- build succeeds
- unit/integration tests pass
- web e2e tests pass
- desktop-runtime e2e tests pass
- native desktop smoke automation passes

Native visibility policy:

- On macOS, `npm run test:desktop:native-smoke` now requires the Symphony
  window to become visible by default.
- If a CI or remote environment cannot expose desktop windows, set
  `SYMPHONY_ALLOW_WINDOW_VISIBILITY_SKIP=1` explicitly to bypass only that
  visibility assertion.

## Native Host Validation

1. Validate Rust host compilation:

```bash
cd src-tauri
cargo check
cd ..
```

Expected result:

- `cargo check` completes with no errors

2. Launch desktop app (interactive smoke):

```bash
SYMPHONY_OFFLINE=1 npm run start:desktop
```

Expected result:

- Tauri host starts
- local runtime starts
- dashboard loads
- no hard exit on startup failure paths

Packaging check:

- `npm run build:desktop` succeeds and includes bundled `symphony-backend`
  sidecar in desktop app resources.

3. Verify runtime endpoint from another terminal:

```bash
curl -s http://127.0.0.1:3000/api/v1/state | head -c 200
```

Expected result:

- JSON payload with baseline fields

## Manual Interaction Checklist

In the desktop window:

- Open overview dashboard and confirm health banner is visible.
- Click "Refresh now" and confirm refresh flow completes.
- Enter unknown issue id (for example `ABC-404`) and confirm graceful error.
- Press `/` and confirm running-filter input receives focus.
- Close desktop app and confirm backend process terminates.

## Artifact Capture

Store screenshots and snapshots in:

- `output/playwright/`

Suggested naming:

- `interactive-dashboard.png`
- `interactive-initial-snapshot.yml`
- `interactive-error-snapshot.yml`

## Troubleshooting

- If startup fails due to tracker credentials, use `SYMPHONY_OFFLINE=1`.
- If startup appears stalled, check `tauri dev` output for compile activity.
- If API requests fail, verify `SYMPHONY_DESKTOP_PORT` and `SYMPHONY_PORT` are aligned.

## P6 Security and Persistence Validation

1. Verify active profile diagnostics:

```bash
curl -s http://127.0.0.1:3000/api/v1/diagnostics
```

Expected result:

- `active_profile.name` is present (default `balanced`)
- `active_profile.approval_policy` is present
- `persistence.integrity_ok` is `true`

2. Verify durable history and restart continuity:

```bash
curl -s http://127.0.0.1:3000/api/v1/history
```

Expected result:

- Historical runs remain available after process restart
- `api/v1/state` still reports no restored running/retrying entries after restart unless newly dispatched

3. Verify UI continuity state persistence:

```bash
curl -s -X POST http://127.0.0.1:3000/api/v1/ui-state \
  -H 'content-type: application/json' \
  -d '{"state":{"selected_issue":"ABC-1","filters":{"status":"running","query":"ABC"},"panel_state":{"issue_detail_open":true}}}'
curl -s http://127.0.0.1:3000/api/v1/ui-state
```

Expected result:

- Saved state is returned by `GET /api/v1/ui-state`

4. Verify redaction behavior in diagnostics/logs:

- Secret-like values (for example `token=...`, `api_key=...`) are masked as `***REDACTED***` in logs and API payloads.
