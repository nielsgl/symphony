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
SYMPHONY_OFFLINE=1 npm run test:e2e:desktop
```

Expected result:

- build succeeds
- unit/integration tests pass
- web e2e tests pass
- desktop e2e tests pass

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
