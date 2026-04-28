# Todo App End-to-End Tutorial

This tutorial shows a full Symphony workflow on a sample todo app.

## Goal

Use tracker issues as the source of truth, let Symphony dispatch Codex runs, and verify resulting implementation changes in a local sample repository.

## What Symphony Does and Does Not Do

- Symphony does: poll issues, decide dispatch eligibility, run Codex sessions, manage workspaces, expose monitoring APIs, and track retries.
- Symphony does not: create issues natively in tracker systems.
- Issue creation and state/comment updates are done in your tracker directly or by agent tools configured in workflow prompts.

## Prerequisites

1. Install dependencies:

```bash
npm install
npm run build
```

2. Export tracker credentials:

```bash
export LINEAR_API_KEY=your_linear_api_key
export GITHUB_TOKEN=your_github_token
```

3. Use sample app fixture:

- Path: `tests/fixtures/todo-sample-app`

## Step 1: Seed Tracker Backlog

Use seed templates:

- Linear: `tests/fixtures/tracker-seeds/linear-todo-issues.json`
- GitHub: `tests/fixtures/tracker-seeds/github-todo-issues.json`

Generate import-ready payloads with the bootstrap utility:

```bash
npm run bootstrap:tracker-seeds:linear
npm run bootstrap:tracker-seeds:github
```

Automatically create Linear issues from seed data (dry-run first):

```bash
export LINEAR_PROJECT_SLUG=SYMPHONY
npm run seed:linear
```

Apply creation in Linear:

```bash
export LINEAR_PROJECT_SLUG=SYMPHONY
npm run seed:linear:apply
```

Optional team targeting for multi-team projects:

```bash
export LINEAR_TEAM_KEY=SYM
npm run seed:linear:apply
```

Or write payload to a file:

```bash
npm run bootstrap:tracker-seeds -- --tracker=linear --input=tests/fixtures/tracker-seeds/linear-todo-issues.json --output=/tmp/linear-import.json
```

Create issues in your tracker from these seeds, then map states:

- Active: Todo/In Progress for Linear, Open for GitHub.
- Terminal: Done/Canceled for Linear, Closed for GitHub.

## Step 2: Choose Workflow Preset

- Linear preset: `docs/examples/workflow-presets/linear-todo-workflow.md`
- GitHub preset: `docs/examples/workflow-presets/github-todo-workflow.md`

Copy preset front matter and prompt template into your local `WORKFLOW.md`.

## Step 3: Start Symphony

```bash
npm run start:dashboard -- --workflow=./WORKFLOW.md --i-understand-that-this-will-be-running-without-the-usual-guardrails
```

Optional offline mode for UI-only validation:

```bash
npm run start:dashboard -- --offline --i-understand-that-this-will-be-running-without-the-usual-guardrails
```

## Step 4: Observe Dispatch and Runs

Monitor:

```bash
curl -sS http://127.0.0.1:3000/api/v1/state
```

Typical state snapshot shape:

```json
{
	"counts": {
		"running": 1,
		"retrying": 0
	},
	"health": {
		"dispatch_validation": "ok",
		"last_error": null
	}
}
```

Trigger manual poll:

```bash
curl -sS -X POST http://127.0.0.1:3000/api/v1/refresh
```

Typical refresh response:

```json
{
	"accepted": true,
	"coalesced": false
}
```

Inspect issue details:

```bash
curl -sS http://127.0.0.1:3000/api/v1/SYM-101
```

Typical issue detail shape:

```json
{
	"issue_identifier": "SYM-101",
	"running": {
		"session_id": "session_123",
		"attempt": 0
	},
	"retry": null
}
```

For GitHub-style identifiers, URL encode `owner/repo#number`.

## Step 5: Validate Changes in Workspace

During execution, Symphony creates per-issue workspaces and runs Codex in that directory.
For deterministic repository-backed workspaces, configure:

- `workspace.provisioner.type: worktree`
- `workspace.provisioner.repo_root: <your-repo-root>`
- `workspace.provisioner.branch_template: feature/{{ issue.identifier }}`
- `codex.thread_sandbox: danger-full-access`
- `codex.turn_sandbox_policy: danger-full-access`

Use your normal verification flow in the sample app:

```bash
cd tests/fixtures/todo-sample-app
npm test
```

## Step 6: Close Loop

- Move issues to terminal states once implementation and tests are complete.
- Symphony reconciliation will stop terminal work and clean up according to lifecycle hooks.
- Review run history:

```bash
curl -sS http://127.0.0.1:3000/api/v1/history?limit=20
```

Typical history entry shape:

```json
{
	"run_id": "run-uuid",
	"issue_identifier": "SYM-101",
	"terminal_status": "succeeded",
	"session_ids": ["session_123"]
}
```

## Common Failure Paths

- Missing tracker credentials: startup validation fails.
- Invalid workflow fields: dispatch preflight fails and appears in health status.
- Long-running stalled turn: governed by `codex.stall_timeout_ms`.

### Failure and Recovery Example

Scenario: dispatch validation fails after changing tracker configuration.

1. Confirm health status:

```bash
curl -sS http://127.0.0.1:3000/api/v1/state
```

2. Fix `WORKFLOW.md` tracker keys or credentials.
3. Trigger refresh:

```bash
curl -sS -X POST http://127.0.0.1:3000/api/v1/refresh
```

4. Recheck that `health.dispatch_validation` returns `ok`.

See `docs/playbooks/operations-runbook.md` for deep recovery procedures.
