# PRD-000 Master: Symphony v1 Product and System Contract

## Problem and Goals (SPEC Alignment)
Symphony must turn issue execution into a deterministic, operator-safe orchestration service with strong workspace isolation, controlled agent execution, and enough observability to run continuously in production-like team settings.

SPEC anchors:
- Problem, goals, boundaries: Section 1, 2, 3
- Required conformance baseline: Section 18.1
- Extension posture: Section 18.2

Primary goals:
- Deliver a macOS-first Tauri desktop product with an embedded operator UI and a local orchestrator daemon.
- Implement full Core Conformance for Linear-backed orchestration.
- Require local HTTP API for UI integration.
- Provide decision-complete subsystem contracts that can be independently implemented by parallel engineering workstreams.

## Scope
In scope (v1):
- Linear tracker read integration.
- Orchestrator state machine, polling, reconciliation, retries.
- Workflow/config parsing, reload, and strict prompt rendering.
- Workspace lifecycle + safety invariants + hooks.
- Codex app-server integration and session telemetry.
- Local HTTP state/debug API and embedded desktop UI integration contract.
- Configurable safety profiles and minimal durable local history.

Out of scope (v1):
- Multi-tenant SaaS control plane.
- Cross-platform desktop parity (macOS only for v1).
- Full durable scheduler state (claims/running/retry restoration).
- First-class tracker write APIs in orchestrator business layer.
- GitHub Issues runtime support (Phase 2 PRD only).

## Architecture and Ownership Boundaries
Subsystem ownership:
- `Orchestrator`: sole writer of scheduling state (`claimed`, `running`, `retry_attempts`).
- `TrackerAdapter`: read model normalization and query execution only.
- `WorkflowConfig`: parse, resolve, validate, hot-reload, expose typed settings.
- `WorkspaceManager`: path derivation, creation/reuse, hooks, cleanup safety.
- `CodexRunner`: app-server process lifecycle + protocol handshake/streaming.
- `Local API + UI`: read state, trigger refresh, render operator surfaces.
- `Security Profiles`: approval/sandbox defaults + override policy.
- `Local Store`: run/session history and UI continuity state.

Product topology (locked):
- Tauri desktop shell (Rust process host).
- Embedded web UI (operator dashboard).
- Local daemon process with internal module boundaries above.
- Local loopback HTTP API required for UI/runtime integration.

## Public Interfaces and Data Contracts
Normative interfaces:
- `TrackerAdapter` (v1 Linear, phase-2 GitHub):
  - `fetch_candidate_issues(): Issue[]`
  - `fetch_issues_by_states(states: string[]): Issue[]`
  - `fetch_issue_states_by_ids(ids: string[]): Issue[]`
- `WorkflowConfig`:
  - `load(path): WorkflowDefinition`
  - `resolve(definition): EffectiveConfig`
  - `validate_for_dispatch(config): ValidationResult`
  - `watch_and_reload(path, onChange)`
- `Orchestrator`:
  - `start()`, `stop()`
  - `tick()`
  - `dispatch(issue, attempt)`
  - `snapshot(): RuntimeSnapshot`
- `WorkspaceManager`:
  - `create_for_issue(identifier): Workspace`
  - `cleanup_for_issue(identifier)`
  - `run_hook(kind, workspace)`
- `CodexRunner`:
  - `start_session(params)`
  - `run_turn(session, input)`
  - `stop_session(session)`
- Local HTTP API:
  - `GET /api/v1/state`
  - `GET /api/v1/<issue_identifier>`
  - `POST /api/v1/refresh`

Canonical normalized `Issue` contract (required parity across adapters):
```json
{
  "id": "string",
  "identifier": "ABC-123",
  "title": "string",
  "description": "string|null",
  "priority": 1,
  "state": "In Progress",
  "branch_name": "string|null",
  "url": "string|null",
  "labels": ["backend"],
  "blocked_by": [{"id": "x", "identifier": "ABC-122", "state": "Done"}],
  "created_at": "ISO-8601|null",
  "updated_at": "ISO-8601|null"
}
```

## State, Failure, Retry, and Recovery Contract
- Internal orchestration states follow SPEC 7.1 (`Unclaimed`, `Claimed`, `Running`, `RetryQueued`, `Released`).
- Tick sequence follows SPEC 8.1 with reconciliation before dispatch.
- Continuation retry after normal exit is required (~1s).
- Failure retries follow capped exponential backoff with configured cap.
- Restart recovery is tracker + filesystem driven; no durable claims/running restoration in v1.
- Invalid workflow reload never crashes service; last-known-good config remains active.

## Security Posture and Abuse Resistance
Default posture: Balanced production profile.
- Strict workspace root containment and sanitized workspace keys.
- Configurable approval/sandbox profiles with explicit defaults and documented override precedence.
- Hook scripts treated as trusted config; timeout + log truncation required.
- Secrets resolved via `$VAR` and never logged.
- Loopback binding by default for local API.

## Acceptance Criteria and Conformance Test Obligations
Release requires:
- All Section 18.1 required items mapped to tests and acceptance checks.
- No unresolved contradictions across PRD subsystem contracts.
- Each subsystem PRD defines deterministic test vectors aligned to Section 17 profiles.
- Required local API endpoints implemented and consumed by desktop UI.

## Operational Readiness and Rollout Gates
Entry gates:
- Core conformance tests pass.
- Local integration smoke test on macOS passes.
- Operator-visible startup/validation failures confirmed.

Exit gates:
- Team-scale load validation (~50 active issues, ~10 concurrent agents).
- Runbook-ready behavior for workflow reload failures, tracker outages, and stalled sessions.
- Traceability matrix complete and signed off.
