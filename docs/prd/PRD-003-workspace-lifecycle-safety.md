# PRD-003 Workspace Lifecycle and Safety

## Problem and Goals (SPEC Alignment)
Define deterministic workspace creation/reuse/cleanup and enforce non-bypassable safety invariants so coding-agent execution is confined to per-issue directories.

SPEC anchors:
- Workspace layout/lifecycle/hooks/safety invariants: Section 9
- Relevant failure classes and safety posture: Section 14.1, 15.2, 15.4
- Core checklist obligations: Section 18.1

Goals:
- Stable per-issue workspace mapping.
- Safe hook lifecycle with timeout semantics.
- Guaranteed workspace root containment and sanitized path keys.

## Scope
In scope:
- Workspace path derivation and identifier sanitization.
- Directory creation/reuse policy.
- Hook execution lifecycle (`after_create`, `before_run`, `after_run`, `before_remove`).
- Cleanup behavior for terminal issues.
- Temporary artifact cleanup policy before each run.

Out of scope:
- Mandatory built-in git bootstrap/sync behavior.
- Multi-host shared workspace semantics.

## Architecture and Ownership
`WorkspaceManager` responsibilities:
- `derive_workspace_key(issue.identifier)`.
- `ensure_workspace(issue.identifier)` returning `{path, workspace_key, created_now}`.
- `prepare_attempt(path)` for pre-run cleaning and optional implementation-defined population.
- `cleanup_workspace(issue.identifier)` with pre-remove hook.

Safety guard module responsibilities:
- Normalize and compare absolute paths.
- Enforce prefix containment.
- Validate launch `cwd == workspace_path` precondition.

## Public Interfaces and Data Contracts
Workspace contract:
```json
{
  "path": "/abs/workspace/root/ABC-123",
  "workspace_key": "ABC-123",
  "created_now": false
}
```

Hook execution result:
```json
{
  "hook": "before_run",
  "status": "failed",
  "duration_ms": 60123,
  "timed_out": true,
  "error": "hook timeout"
}
```

Sanitization rule:
- Allowed chars: `[A-Za-z0-9._-]`.
- Any other char replaced with `_`.

## State, Failure, and Recovery Behavior
Hook failure semantics:
- `after_create` failure/timeout: fatal to workspace creation.
- `before_run` failure/timeout: fatal to current attempt.
- `after_run` failure/timeout: log and ignore.
- `before_remove` failure/timeout: log and ignore; continue cleanup.

Cleanup semantics:
- Terminal issue transition and startup terminal sweep trigger cleanup.
- Non-terminal non-active state stops run without cleanup.
- Reused workspace must not be destructively reset by default.

## Security and Safety Requirements
Mandatory invariants:
- Agent launch must use resolved per-issue workspace as cwd.
- Workspace path must remain under configured root.
- Non-directory path collision at target workspace path handled safely per documented policy.

Hardening requirements:
- Hook output truncation in logs.
- Dedicated local workspace root with restrictive permissions recommended.

## Acceptance Criteria and Conformance Tests
Required tests:
- Deterministic mapping from issue identifier to workspace path.
- Creation vs reuse and `created_now` correctness.
- Sanitization with edge identifiers (`..`, slashes, unicode, shell metacharacters).
- Hook timeout behavior and per-hook failure semantics.
- Root containment and cwd equality enforcement pre-launch.
- Startup and reconciliation-triggered cleanup behavior.

Acceptance gates:
- Section 17.2 tests pass.
- No path traversal bypass found in adversarial identifier test suite.

## Operational Readiness and Rollout Gates
- Logs include workspace path, hook name, duration, and outcome.
- Operator diagnostics show current workspace root and cleanup failures.
- Workspace disk usage is observable in local dashboard/API.
