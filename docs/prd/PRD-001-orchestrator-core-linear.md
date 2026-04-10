# PRD-001 Orchestrator Core (Linear)

## Problem and Goals (SPEC Alignment)
Define the authoritative orchestration loop for Linear-backed v1 that guarantees deterministic dispatch, bounded concurrency, safe retry behavior, and reconciliation-driven cancellation.

SPEC anchors:
- State machine: Section 7
- Polling/selection/retry/reconciliation: Section 8
- Tracker integration requirements: Section 11.1-11.4
- Reference algorithms: Section 16.2, 16.3, 16.4, 16.6

Goals:
- Single-writer orchestration state.
- Strict eligibility rules and dispatch ordering.
- Retry semantics that prevent duplicate execution.
- Clean failure handling when tracker/config are degraded.

## Scope
In scope:
- Poll-and-dispatch tick loop.
- Candidate selection and sort order.
- Global + per-state concurrency controls.
- Retry queue management and timers.
- Active-run reconciliation and stop behavior.
- Startup terminal workspace cleanup trigger.

Out of scope:
- Tracker writes and business workflow semantics.
- UI rendering decisions.
- SSH worker scheduling (extension-only; not implemented in v1 core).

## Architecture and Ownership
Owned by orchestrator module:
- In-memory runtime state:
  - `poll_interval_ms`
  - `max_concurrent_agents`
  - `running: Map<issue_id, RunningEntry>`
  - `claimed: Set<issue_id>`
  - `retry_attempts: Map<issue_id, RetryEntry>`
  - aggregate token/runtime counters
- Mutation discipline: all state writes occur on orchestrator event loop thread.

Collaborators:
- `TrackerAdapter` for reads.
- `WorkspaceManager` and `CodexRunner` via worker attempts.
- `Observability` for logs and snapshot publication.

## Public Interfaces and Data Contracts
Orchestrator public contract:
```ts
interface Orchestrator {
  start(): Promise<void>
  stop(): Promise<void>
  tick(reason: 'startup'|'interval'|'manual_refresh'|'retry_timer'): Promise<void>
  getSnapshot(): RuntimeSnapshot
}
```

Internal decisions:
- `shouldDispatch(issue, state): EligibilityResult`
- `scheduleRetry(issue, attempt, reason, delayType)`
- `reconcileRunningIssues(state)`

`RetryEntry` contract:
```json
{
  "issue_id": "string",
  "identifier": "ABC-123",
  "attempt": 3,
  "due_at_ms": 123456789,
  "error": "no available orchestrator slots"
}
```

## State Machine and Failure Behavior
Dispatch eligibility (all required):
- Required fields present (`id`, `identifier`, `title`, `state`).
- In active states and not in terminal states.
- Not already `running` or `claimed`.
- Slots available globally and for issue state.
- `Todo` blockers must all be terminal.

Sort order:
1. Priority ascending (null last).
2. `created_at` oldest first.
3. `identifier` lexical tie-breaker.

Transition rules:
- Worker normal exit: remove running entry, update metrics, schedule continuation retry attempt 1.
- Worker abnormal exit: remove running entry, schedule exponential retry.
- Retry timer fire:
  - re-fetch candidates,
  - release claim if issue no longer eligible,
  - requeue if no slot,
  - dispatch with retry attempt if eligible.
- Reconciliation:
  - terminal -> stop worker + cleanup workspace
  - active -> update tracked issue state
  - non-active/non-terminal -> stop worker without cleanup

Failure handling:
- Candidate fetch failure: skip dispatch, keep service alive.
- Reconciliation refresh failure: keep workers running.
- Config preflight failure: skip dispatch for tick, still reconcile.

## Security and Safety Requirements
- Prevent duplicate dispatch via `claimed` + `running` checks.
- Never launch worker without valid workspace-root containment checks from `WorkspaceManager`.
- Ensure manual refresh endpoint cannot bypass validation/eligibility logic.

## Acceptance Criteria and Conformance Tests
Required tests:
- Dispatch ordering and tie-break behavior.
- `Todo` blocker gate (terminal vs non-terminal).
- Concurrency gates (global + per-state).
- Retry schedule correctness (continuation vs exponential backoff with cap).
- Reconciliation stop semantics for terminal and non-active states.
- Tracker failure modes do not crash service.

Acceptance gates:
- No duplicate worker for same `issue_id` across 10k simulated ticks.
- Retry queue invariants preserved under rapid state churn.
- All Section 17.4 tests pass.

## Operational Readiness and Rollout Gates
- Structured logs emit `issue_id`, `issue_identifier`, state transition reason, and retry reason.
- Manual `POST /api/v1/refresh` trigger coalesces bursts and remains idempotent.
- Team-scale simulation meets target cadence without starvation.
