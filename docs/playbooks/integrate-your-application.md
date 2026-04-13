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

## 4. Configure Hooks Carefully

Use hooks to enforce setup and quality gates:

- `after_create`: one-time bootstrap for workspace dependencies.
- `before_run`: per-attempt preflight checks.
- `after_run`: collect diagnostics and artifacts.
- `before_remove`: non-blocking cleanup.

Keep hooks idempotent and bounded by `hooks.timeout_ms`.

## 5. Operational Rollout Pattern

1. Start with one active issue.
2. Observe dashboard and state endpoint.
3. Validate generated changes with project tests.
4. Increase concurrency after stable runs.

## 6. Production Hygiene

- Keep secrets in environment variables, not prompt templates.
- Use persistence and history endpoints for auditability.
- Keep tracker state naming aligned with workflow config.

## 7. Suggested Adoption Milestones

1. Local proof with 3-5 issues.
2. Team pilot with controlled concurrency.
3. Full backlog operation with runbook-based monitoring.
