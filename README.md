# Symphony

Symphony is a long-running orchestration service that polls an issue tracker,
manages per-issue workspaces, and runs coding-agent sessions with deterministic
retry and reconciliation behavior.

This repository is driven by SPEC and PRD artifacts. The current implementation
includes workflow loading/validation, orchestrator runtime logic, local worker
execution, and a local observability API with an embedded dashboard.

## Current Status

- P1-P5 delivery is implemented in the `p5-observability-ui` worktree branch.
- P6 and P7 are not started.
- Canonical requirements live in `SPEC.md` and `docs/prd/`.

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

## Run Dashboard and API

The dashboard and API are served by the same local process.

### Standard Start

```bash
npm run start:dashboard
```

Default bind:

- Host: `127.0.0.1`
- Port: `3000`

Open:

- Dashboard: `http://127.0.0.1:3000/`

### Dynamic Port

```bash
npm run start:dashboard -- --port=0
```

or

```bash
SYMPHONY_PORT=5050 npm run start:dashboard
```

### Script Aliases

These aliases intentionally launch the same local surface:

- `npm run start:api`
- `npm run start:web`
- `npm run start:desktop`

## API Endpoints

### GET `/api/v1/state`

Returns current runtime summary:

- running and retrying counts
- running session telemetry
- aggregate token and runtime totals
- latest rate-limit snapshot
- health banner fields (`dispatch_validation`, `last_error`)

### GET `/api/v1/:issue_identifier`

Returns issue-specific runtime diagnostics:

- running or retrying status
- session fields and recent events
- retry metadata
- last known error

Unknown issue identifiers return `404` with typed error envelope.

### POST `/api/v1/refresh`

Queues manual poll and reconciliation trigger. Burst requests are coalesced.

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
git --no-pager diff --check
```

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
