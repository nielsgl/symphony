# Symphony Linear Workflow Playbook

This guide is the end-to-end operator playbook for running Symphony against Linear.
It covers setup, configuration, runtime behavior, observability, recovery, and day-to-day workflow operation.

The recommended practical path is to run this playbook with:

- Tutorial: `docs/tutorials/todo-app-end-to-end.md`
- Sample app fixture: `tests/fixtures/todo-sample-app`
- Seed backlog: `tests/fixtures/tracker-seeds/linear-todo-issues.json`
- Workflow preset: `docs/examples/workflow-presets/linear-todo-workflow.md`

## 1. What You Get

When configured for Linear, Symphony provides:

- Tracker polling and issue normalization from Linear GraphQL.
- Deterministic dispatch decisions with blocker and concurrency gates.
- Per-issue workspace lifecycle with hook execution.
- Codex worker execution with timeout, stall, and retry control.
- Local HTTP API plus dashboard UI.
- Optional desktop shell that runs the same backend.
- Security profile resolution and redaction in API/log outputs.
- Durable run history and UI state persistence.

## 2. Prerequisites

- Node.js and npm installed.
- Linear API key with access to the target project.
- A valid workflow file at repository root or a custom path.

Install and validate once:

```bash
npm install
npm run build
npm test
```

## 3. Configure Environment

Create a local env file:

```bash
cp .env.example .env
```

Set at minimum:

```dotenv
LINEAR_API_KEY=your_linear_api_key
SYMPHONY_OFFLINE=0
SYMPHONY_PORT=3000
SYMPHONY_WORKFLOW_PATH=./WORKFLOW.md
```

Notes:

- Startup scripts load .env automatically.
- Set SYMPHONY_ENV_FILE to use a non-default env file path.
- For local UI-only runs, set SYMPHONY_OFFLINE=1.

## 4. Build an End-to-End Linear Workflow

1. Create issues in Linear from `tests/fixtures/tracker-seeds/linear-todo-issues.json`.
2. Copy `docs/examples/workflow-presets/linear-todo-workflow.md` into your local `WORKFLOW.md` and adjust project slug.
3. Start Symphony and observe dispatch for active issue states.
4. Verify generated changes and tests in the issue workspace.
5. Move completed issues to terminal states and confirm reconciliation.

Bootstrap helper command:

```bash
npm run bootstrap:tracker-seeds:linear
```

Automatic issue creation commands:

```bash
export LINEAR_PROJECT_SLUG=SYMPHONY
npm run seed:linear
npm run seed:linear:apply
```

For multi-team projects, set team key explicitly:

```bash
export LINEAR_TEAM_KEY=SYM
npm run seed:linear:apply
```

Important:

- Symphony does not create issues directly; issue creation is tracker-side.
- Tracker writes are performed via your workflow tooling and agent behavior.

## 5. Configure WORKFLOW.md

Use Linear tracker settings in front matter:

```yaml
---
tracker:
  kind: linear
  endpoint: https://api.linear.app/graphql
  api_key: $LINEAR_API_KEY
  project_slug: SYMPHONY
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Canceled
polling:
  interval_ms: 30000
workspace:
  root: ./.symphony/workspaces
hooks:
  timeout_ms: 60000
agent:
  max_concurrent_agents: 2
  max_retry_backoff_ms: 300000
  max_turns: 20
codex:
  command: codex app-server
  thread_sandbox: danger-full-access
  turn_sandbox_policy: danger-full-access
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
server:
  port: 3000
---
```

Important behavior:

- tracker.api_key supports env token syntax like $LINEAR_API_KEY.
- tracker.project_slug is required for Linear.
- If server.port is omitted and no CLI/env port is provided, HTTP API is disabled.
- Prompt template body below front matter is rendered per issue and attempt.
- If you use `workspace.provisioner.type: worktree`, both sandbox values must be `danger-full-access`.

## 6. Start Symphony (CLI and Desktop)

Run dashboard and API (recommended):

```bash
npm run start:dashboard -- --i-understand-that-this-will-be-running-without-the-usual-guardrails
```

Useful variants:

```bash
npm run start:dashboard -- --port=0 --i-understand-that-this-will-be-running-without-the-usual-guardrails
npm run start:dashboard -- --workflow=./WORKFLOW.md --i-understand-that-this-will-be-running-without-the-usual-guardrails
npm run start:dashboard -- ./WORKFLOW.md --i-understand-that-this-will-be-running-without-the-usual-guardrails
SYMPHONY_PORT=5050 npm run start:dashboard -- --i-understand-that-this-will-be-running-without-the-usual-guardrails
SYMPHONY_WORKFLOW_PATH=./WORKFLOW.md npm run start:dashboard -- --i-understand-that-this-will-be-running-without-the-usual-guardrails
SYMPHONY_OFFLINE=1 npm run start:dashboard -- --i-understand-that-this-will-be-running-without-the-usual-guardrails
```

Desktop mode (same backend, native shell):

```bash
npm run start:desktop
```

Packaged desktop build:

```bash
npm run build:desktop
```

Native desktop smoke test:

```bash
npm run test:desktop:native-smoke
```

## 7. Run Lifecycle and Dispatch Workflow

Each poll cycle:

1. Reconcile running issues against tracker state.
2. Run dispatch preflight validation.
3. Fetch candidate issues from Linear.
4. Sort candidates by priority, created time, then identifier.
5. Dispatch eligible issues up to concurrency limits.

Eligibility gates:

- Required fields present.
- State is in active_states and not in terminal_states.
- Not already running or claimed.
- Global and per-state concurrency limits allow dispatch.
- For Todo state, blockers must be terminal.

Worker lifecycle:

- Workspace resolved per issue identifier.
- Hook order: after_create, before_run, after_run, before_remove.
- Codex command runs inside workspace directory.
- Turn timeout and stall timeout enforce upper bounds.
- Abnormal exits schedule exponential retry.
- Normal completion schedules short continuation retry for re-check.

## 8. Operate via Dashboard and HTTP API

Default dashboard URL:

- http://127.0.0.1:3000/

Core API endpoints:

- GET /api/v1/state: aggregate runtime state, counts, health, rate limits.
- GET /api/v1/{issue_identifier}: issue-specific runtime details.
- POST /api/v1/refresh: manual poll trigger with coalescing.

Operational endpoints:

- GET /api/v1/diagnostics: active security profile and persistence health.
- GET /api/v1/history?limit=50: durable run history.
- GET /api/v1/ui-state: persisted dashboard UI state.
- POST /api/v1/ui-state: save dashboard UI state.

Manual refresh example:

```bash
curl -sS -X POST http://127.0.0.1:3000/api/v1/refresh
```

Issue details example:

```bash
curl -sS http://127.0.0.1:3000/api/v1/SYM-123
```

## 9. Security, Redaction, and Persistence

Security profile:

- Default profile resolves to strict.
- Effective codex approval and sandbox settings are derived at startup.

Redaction:

- API responses and persisted event messages are redacted through security redaction.
- Avoid writing secrets into prompt templates and hook scripts.

Persistence:

- Enabled by default unless persistence.enabled is false.
- Stores run history, sessions, events, and dashboard UI state.
- Prunes records older than retention_days on startup.

## 10. Troubleshooting

Startup validation errors:

- missing_tracker_api_key: set LINEAR_API_KEY or tracker.api_key.
- missing_tracker_project_slug: define tracker.project_slug for Linear.
- missing_codex_command: set codex.command.
- invalid tracker or codex policy values: adjust WORKFLOW.md.

Runtime symptoms:

- Dispatch blocked: inspect /api/v1/state health.dispatch_validation.
- No issues dispatched: verify active_states and project_slug match Linear project state names.
- Workspaces not cleaned: check terminal_states and hook behavior.
- API disabled unexpectedly: ensure a port is set by CLI, env, or server.port.

## 11. Daily Operator Workflow

1. Pull latest workflow and code changes.
2. Seed or groom tracker issues for small, atomic implementation tasks.
3. Validate env and workflow config.
4. Start dashboard mode.
5. Observe /api/v1/state and dashboard for running/retrying health.
6. Trigger /api/v1/refresh after state changes if needed.
7. Validate generated code and tests in workspace before closing issue.
8. Review /api/v1/history for outcomes and trends.
9. Stop with Ctrl+C and retain persistence for next session.

## 12. References

- README.md
- WORKFLOW.md
- SPEC.md
- docs/prd/PRD-001-orchestrator-core-linear.md
- docs/prd/PRD-005-observability-local-api-desktop-ui.md
- docs/prd/PRD-006-security-approval-profiles-persistence.md
- docs/tutorials/todo-app-end-to-end.md
- docs/playbooks/integrate-your-application.md
- docs/playbooks/operations-runbook.md
- docs/examples/workflow-presets/linear-todo-workflow.md
- tests/fixtures/todo-sample-app/README.md
- src/runtime/cli.ts
- src/runtime/cli-runner.ts
- src/tracker/linear-adapter.ts
- src/api/server.ts
