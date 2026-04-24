# Integrate Symphony With Your Application

This guide maps the todo-app tutorial workflow to your own repository.

## 1. Select Tracker Strategy

- Linear track: best for richer state names and blocker-aware dispatch.
- GitHub track: use Open/Closed state mapping and repository-scoped issue identifiers.

## 2. Add Workflow File to Your Repo

Create a `WORKFLOW.md` with:

- Correct tracker block.
- Workspace root inside your repo.
- Codex command and timeout settings aligned with your build/test duration.
- Prompt template that references your repository conventions.

Start from:

- `docs/examples/workflow-presets/linear-todo-workflow.md`
- `docs/examples/workflow-presets/github-todo-workflow.md`

## 3. Model Backlog for Dispatch

Create issues that are:

- Small and atomic.
- Independently testable.
- State-tagged using active and terminal states expected by workflow config.

Avoid broad issues that exceed one agent attempt window.

## 4. Configure Workspace Provisioner

Use first-class workspace provisioning for deterministic per-issue workspaces:

- `workspace.provisioner.type: worktree` for repository-backed issue isolation.
- `workspace.provisioner.repo_root` set to your repository root.
- `workspace.provisioner.base_ref` usually `origin/main`.
- `workspace.provisioner.branch_template` usually `feature/{{ issue.identifier }}`.
- `workspace.provisioner.teardown_mode`:
  - `remove_worktree` for ephemeral workspaces.
  - `keep` for manual post-run debugging.
- Keep `allow_dirty_repo: false` in normal operation.

For diagnostics, verify:

- `/api/v1/diagnostics.runtime_resolution.provisioner_type`
- `/api/v1/diagnostics.workspace_provisioner.last_provision_result`
- `/api/v1/diagnostics.workspace_provisioner.last_error_code`

## 5. Configure Hooks Carefully

Use hooks to enforce setup and quality gates:

- `after_create`: one-time bootstrap for workspace dependencies.
- `before_run`: per-attempt preflight checks.
- `after_run`: collect diagnostics and artifacts.
- `before_remove`: non-blocking cleanup.

Keep hooks idempotent and bounded by `hooks.timeout_ms`.

Suggested hook patterns for Node repositories:

- `after_create`:
  - `corepack enable && pnpm install --frozen-lockfile || npm ci`
  - `git submodule update --init --recursive`
  - `npm run build --if-present`
- `before_remove`:
  - `node /Users/niels.van.Galen.last/code/symphony/scripts/workspace-before-remove.js`

## 6. Operational Rollout Pattern

1. Start with one active issue.
2. Observe dashboard and state endpoint.
3. Validate generated changes with project tests.
4. Increase concurrency after stable runs.

## 7. Production Hygiene

- Keep secrets in environment variables, not prompt templates.
- Use persistence and history endpoints for auditability.
- Keep tracker state naming aligned with workflow config.

## 8. Suggested Adoption Milestones

1. Local proof with 3-5 issues.
2. Team pilot with controlled concurrency.
3. Full backlog operation with runbook-based monitoring.
