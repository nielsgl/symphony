# Symphony GitHub Workflow Playbook

This guide is the end-to-end operator playbook for running Symphony against GitHub Issues.
It covers setup, configuration, runtime behavior, observability, recovery, and day-to-day workflow operation.

The recommended practical path is to run this playbook with:

- Tutorial: `docs/tutorials/todo-app-end-to-end.md`
- Sample app fixture: `tests/fixtures/todo-sample-app`
- Seed backlog: `tests/fixtures/tracker-seeds/github-todo-issues.json`
- Workflow preset: `docs/examples/workflow-presets/github-todo-workflow.md`

## 1. Status and Scope

GitHub tracker support exists in the codebase and can be used in workflow configuration.
Use this playbook for current supported behavior, with explicit limitations listed in section 10.

## 2. What You Get

When configured for GitHub, Symphony provides:

- Tracker polling from GitHub GraphQL for one owner and one repository.
- Normalized issue model with repository-scoped identifiers.
- Linked pull request metadata extraction from cross-referenced events.
- The same orchestrator dispatch, retry, workspace, and worker lifecycle as other trackers.
- Local HTTP API and dashboard UX.
- Optional desktop shell with the same backend.
- Security profile resolution, redaction, and persistence features.

## 3. Prerequisites

- Node.js and npm installed.
- GitHub token with issue read access for the target repository.
- A valid workflow file at repository root or a custom path.

Install and validate once:

```bash
npm install
npm run build
npm test
```

## 4. Configure Environment

Create a local env file:

```bash
cp .env.example .env
```

Set at minimum:

```dotenv
GITHUB_TOKEN=your_github_token
SYMPHONY_OFFLINE=0
SYMPHONY_PORT=3000
SYMPHONY_WORKFLOW_PATH=./WORKFLOW.md
```

Notes:

- Startup scripts load .env automatically.
- Set SYMPHONY_ENV_FILE to use a non-default env file path.
- For local UI-only runs, set SYMPHONY_OFFLINE=1.

## 5. Build an End-to-End GitHub Workflow

1. Create issues in your GitHub repository from `tests/fixtures/tracker-seeds/github-todo-issues.json`.
2. Copy `docs/examples/workflow-presets/github-todo-workflow.md` into your local `WORKFLOW.md` and set owner/repo.
3. Start Symphony and observe dispatch for Open issues.
4. Verify generated changes and tests in the issue workspace.
5. Close completed issues and confirm reconciliation in dashboard and API.

Bootstrap helper command:

```bash
npm run bootstrap:tracker-seeds:github
```

Important:

- Symphony does not create issues directly; issue creation is tracker-side.
- Current GitHub workflow should treat tracker updates as external/agent-driven operations.

## 6. Configure WORKFLOW.md for GitHub

Use GitHub tracker settings in front matter:

```yaml
---
tracker:
  kind: github
  endpoint: https://api.github.com/graphql
  api_key: $GITHUB_TOKEN
  owner: nielsgl
  repo: symphony
  active_states:
    - Open
  terminal_states:
    - Closed
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
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
server:
  port: 3000
---
```

Important behavior:

- tracker.owner and tracker.repo are required for GitHub.
- tracker.active_states must include at least Open or Closed.
- tracker.api_key supports env token syntax like $GITHUB_TOKEN.
- If server.port is omitted and no CLI/env port is provided, HTTP API is disabled.

## 7. Start Symphony (CLI and Desktop)

Run dashboard and API (recommended):

```bash
npm run start:dashboard
```

Useful variants:

```bash
npm run start:dashboard -- --port=0
npm run start:dashboard -- --workflow=./WORKFLOW.md
npm run start:dashboard -- ./WORKFLOW.md
SYMPHONY_PORT=5050 npm run start:dashboard
SYMPHONY_WORKFLOW_PATH=./WORKFLOW.md npm run start:dashboard
SYMPHONY_OFFLINE=1 npm run start:dashboard
```

Desktop mode:

```bash
npm run start:desktop
```

Packaged desktop build:

```bash
npm run build:desktop
```

## 8. GitHub Runtime Behavior

Polling and normalization:

- Fetches issues by state via GitHub GraphQL.
- Supports pagination with configurable page size.
- Normalizes issue identifiers to owner/repo#number.
- Adds tracker metadata including repository and linked PR references.

Dispatch and execution:

- Uses standard orchestration rules for concurrency and retries.
- Sorts by priority, created time, then identifier.
- Priority is null for GitHub issues, so created time and identifier dominate ordering.
- Workspace and hook lifecycle behavior is unchanged from Linear mode.

## 9. Operate via Dashboard and HTTP API

Default dashboard URL:

- http://127.0.0.1:3000/

Core API endpoints:

- GET /api/v1/state
- GET /api/v1/{issue_identifier}
- POST /api/v1/refresh

Operational endpoints:

- GET /api/v1/diagnostics
- GET /api/v1/history?limit=50
- GET /api/v1/ui-state
- POST /api/v1/ui-state

Manual refresh example:

```bash
curl -sS -X POST http://127.0.0.1:3000/api/v1/refresh
```

Issue details example:

```bash
curl -sS http://127.0.0.1:3000/api/v1/nielsgl%2Fsymphony%2317
```

## 10. Security, Redaction, and Persistence

Security profile:

- Effective codex approval and sandbox settings are resolved at startup.

Redaction:

- API responses and persisted event messages are redacted.
- Keep tokens and secrets out of prompt templates and hooks.

Persistence:

- Enabled by default unless explicitly disabled.
- Persists run history and dashboard UI state.
- Prunes old records based on retention_days.

## 11. Known Limitations and Rollout Notes

Current limitations to plan around:

- State model is constrained to Open and Closed mapping.
- Issue priority is not provided by GitHub adapter normalization.
- Blocker relationships are not modeled for GitHub issues.
- branch_name is not populated from GitHub issue data.
- Orchestrator-native issue writeback is not part of current tracker adapter behavior.
- Single repository scope per runtime instance.

Practical impact:

- Use labels or project conventions for prioritization.
- Do not rely on blocker gating behavior for GitHub issues.
- Use issue and PR metadata for visibility, not automated writeback.

## 12. Troubleshooting

Startup validation errors:

- missing_tracker_api_key: set GITHUB_TOKEN or tracker.api_key.
- missing_tracker_owner: set tracker.owner for GitHub.
- missing_tracker_repo: set tracker.repo for GitHub.
- invalid_tracker_active_states_for_github: include Open or Closed.

Runtime symptoms:

- No issues fetched: verify owner, repo, token scope, and endpoint reachability.
- Dispatch blocked: inspect /api/v1/state health.dispatch_validation.
- API disabled unexpectedly: ensure port is set by CLI, env, or server.port.

## 13. Daily Operator Workflow

1. Pull latest workflow and code changes.
2. Seed or groom tracker issues for small, atomic implementation tasks.
3. Validate token, owner/repo, and active states.
4. Start dashboard mode.
5. Observe runtime and issue detail state via dashboard/API.
6. Trigger manual refresh after external issue state changes.
7. Validate generated code and tests in workspace before closing issues.
8. Review run history and diagnostics for drift.
9. Stop with Ctrl+C and retain persistence for next session.

## 14. References

- README.md
- WORKFLOW.md
- SPEC.md
- docs/prd/PRD-007-phase2-github-issues-pr-metadata.md
- docs/prd/PRD-005-observability-local-api-desktop-ui.md
- docs/prd/PRD-006-security-approval-profiles-persistence.md
- docs/tutorials/todo-app-end-to-end.md
- docs/playbooks/integrate-your-application.md
- docs/playbooks/operations-runbook.md
- docs/examples/workflow-presets/github-todo-workflow.md
- tests/fixtures/todo-sample-app/README.md
- src/tracker/github-adapter.ts
- src/workflow/validator.ts
- src/runtime/cli.ts
- src/runtime/cli-runner.ts
- src/api/server.ts
