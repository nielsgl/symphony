# Symphony

Symphony is a long-running orchestration service that polls an issue tracker,
manages per-issue workspaces, and runs coding-agent sessions with deterministic
retry and reconciliation behavior.

This repository is driven by SPEC and PRD artifacts. The current implementation
includes workflow loading/validation, orchestrator runtime logic, local worker
execution, and a local observability API with an embedded dashboard.

## Current Status

- Core implementation and parity hardening phases are merged on `main`.
- Canonical requirements and governance evidence live in `SPEC.md` and `docs/prd/`.

## Quick Start

1. Install dependencies:

	```bash
	npm install
	```

2. Build:

	```bash
	npm run build
	```

3. Run tests:

	```bash
	npm test
	```

## Workflow Learning Path

Start here for a practical end-to-end workflow:

1. Todo app tutorial (issue backlog -> Codex execution -> verification):
	`docs/tutorials/todo-app-end-to-end.md`
2. Linear workflow playbook:
	`docs/playbooks/linear-workflow-playbook.md`
3. GitHub workflow playbook:
	`docs/playbooks/github-workflow-playbook.md`
4. Integrate with your own application:
	`docs/playbooks/integrate-your-application.md`
5. Monitoring and recovery runbook:
	`docs/playbooks/operations-runbook.md`

Workflow preset examples for prompt and tracker configuration:

- `docs/examples/workflow-presets/linear-todo-workflow.md`
- `docs/examples/workflow-presets/github-todo-workflow.md`

Tracker seed examples for bootstrapping issue backlogs:

- `tests/fixtures/tracker-seeds/linear-todo-issues.json`
- `tests/fixtures/tracker-seeds/github-todo-issues.json`

Generate import-ready payloads from seed files:

```bash
npm run bootstrap:tracker-seeds:linear
npm run bootstrap:tracker-seeds:github
```

Automatically create Linear issues from seed data:

```bash
export LINEAR_PROJECT_SLUG=SYMPHONY
npm run seed:linear
npm run seed:linear:apply
```

## Run Dashboard and API

The dashboard and API are served by the same local process.

### Standard Start

```bash
npm run start:dashboard -- --i-understand-that-this-will-be-running-without-the-usual-guardrails
```

Default bind:

- Host: `127.0.0.1`
- Port: `3000`

Open:

- Dashboard: `http://127.0.0.1:3000/`

### Dynamic Port

```bash
npm run start:dashboard -- --port=0 --i-understand-that-this-will-be-running-without-the-usual-guardrails
```

or

```bash
SYMPHONY_PORT=5050 npm run start:dashboard -- --i-understand-that-this-will-be-running-without-the-usual-guardrails
```

### Project Wrapper (Recommended for Multi-Project)

Use the wrapper to run Symphony against another repository's `WORKFLOW.md`
without remembering full startup flags:

```bash
npm run start:project-dashboard -- ../symphony-todo-app
```

Optional flags:

```bash
npm run start:project-dashboard -- ../symphony-todo-app --port 3001
npm run start:project-dashboard -- ../symphony-todo-app --offline
```

Behavior:

- Defaults to `--workflow=<app-repo>/WORKFLOW.md`
- Uses `--port=0` by default to avoid port collisions
- Always includes the required guardrail acknowledgment flag

### Script Aliases

These aliases intentionally launch the same local API/dashboard surface:

- `npm run start:api`
- `npm run start:web`

## Run Desktop App (macOS)

`start:desktop` launches a Tauri host that starts the same runtime-backed
dashboard backend and opens it in a native desktop window.

```bash
npm run start:desktop
```

Desktop packaging status:

```bash
npm run build:desktop
```

`build:desktop` now bundles a platform sidecar backend executable
(`symphony-backend`) into the Tauri app resources so packaged desktop artifacts
do not depend on a local repository checkout or Node installation.

Native desktop smoke automation:

```bash
npm run test:desktop:native-smoke
```

Desktop QA checklist:

- `docs/DESKTOP-QA.md`

Notes:

- The backend startup/shutdown is managed natively by the Tauri Rust host.
- Packaged desktop apps launch a bundled backend sidecar executable.
- Dev mode (`npm run start:desktop`) can still fall back to repo launcher behavior.
- The desktop shell targets local runtime URL `http://127.0.0.1:3000/`.
- Default workflow path is repository root `WORKFLOW.md`.
- Set `SYMPHONY_WORKFLOW_PATH` to point at a non-default workflow file if needed.
- Set `SYMPHONY_DESKTOP_PORT` (or `SYMPHONY_PORT`) to override desktop backend port.
- Export `LINEAR_API_KEY` before startup so tracker validation passes.
- For local UI-only startup without Linear credentials, set `SYMPHONY_OFFLINE=1`.
- `.env` is loaded automatically for startup scripts (or `SYMPHONY_ENV_FILE` for a custom file path).
- If backend startup fails, the desktop window now stays open and displays an actionable boot error instead of exiting hard.

## API Endpoints

### GET `/api/v1/state`

Returns current runtime summary:

- running, retrying, and blocked counts
- running session telemetry
- aggregate token and runtime totals
- latest rate-limit snapshot
- health banner fields (`dispatch_validation`, `last_error`)
- workspace provisioning integrity (`workspace_provisioned`, `workspace_is_git_worktree`)
- phase progress for running issues (`current_phase`, `current_phase_at`,
  `phase_elapsed_ms`, `phase_detail`)
- last known phase context for retrying/blocked issues (`last_phase`,
  `last_phase_at`, `last_phase_detail`)

### GET `/api/v1/:issue_identifier`

Returns issue-specific runtime diagnostics:

- running or retrying status
- session fields and recent events
- retry metadata
- blocked-input metadata when status is `blocked`
- bounded execution timeline (`phase_timeline`) with per-attempt phase markers
- last known error

Unknown issue identifiers return `404` with typed error envelope.

### POST `/api/v1/refresh`

Queues manual poll and reconciliation trigger. Burst requests are coalesced.

### GET `/api/v1/events`

Server-Sent Events stream for realtime state snapshots and runtime health changes.

### GET `/api/v1/diagnostics`

Runtime diagnostics including logging, persistence health, runtime resolution, and workspace provisioner state.

Includes phase marker diagnostics:

- `phase_markers.enabled`
- `phase_markers.timeline_limit`
- `phase_markers.last_emit_error_code`

### POST `/api/v1/issues/:issue_identifier/resume`

Resumes an issue in blocked-input state and returns it to dispatch lifecycle.

## Project Structure

- `src/workflow/`: workflow loading, config resolution, validation, watching.
- `src/tracker/`: tracker adapter contracts and Linear implementation.
- `src/orchestrator/`: dispatch/retry/reconcile runtime state machine.
- `src/workspace/`: workspace creation, hooks, cleanup safety invariants.
- `src/codex/`: coding-agent app-server protocol client.
- `src/api/`: local HTTP server, snapshot projection, refresh coalescing.
- `src/observability/`: structured logging and sink failover behavior.
- `tests/`: deterministic coverage for all implemented subsystems.
- `docs/prd/`: PRD package, status tracker, traceability matrix.

## Development Commands

```bash
npm run build
npm test
npm run test:e2e:web
npm run check:meta
git --no-pager diff --check
```

### UI Evidence Gate (`check:meta`)

`npm run check:meta` now enforces a UI evidence rule when dashboard UI surfaces
change (`src/api/dashboard-assets.ts`, `desktop-static/`, or `src-tauri/src/`).

Profile selection:

- Default: `validation.ui_evidence_profile: baseline`
- Optional strict mode: `validation.ui_evidence_profile: strict`
- Override via env: `SYMPHONY_UI_EVIDENCE_PROFILE=baseline|strict`

When UI paths change, provide one of:

1. Playwright pass marker environment variable:

```bash
SYMPHONY_UI_E2E_PLAYWRIGHT_PASS=1 npm run test:e2e:web
npm run check:meta
```

2. Explicit evidence artifact marker file:

```bash
mkdir -p output/playwright
printf 'UI_E2E_EVIDENCE=PASS\n' > output/playwright/ui-e2e-evidence.txt
npm run check:meta
```

If evidence is missing, `check:meta` fails with a deterministic list of changed
UI paths and remediation commands.

In `strict` profile, the explicit artifact marker file is required and env-only
markers are not sufficient.

## Observability Notes

- Logs use stable `key=value` rendering with context fields.
- Log sink failures emit warning events and do not crash orchestration flow.
- Dashboard health reflects runtime validation/error semantics from orchestrator
  state, not direct mutation from UI actions.

## Contribution Notes

- Follow `AGENTS.md` repository rules for atomic commits and PRD-linked scope.
- Keep changes mapped to SPEC/PRD acceptance criteria.
- Update `docs/prd/STATUS.md` and `docs/prd/TRACEABILITY-MATRIX.md` when
  completing gated phase work.
