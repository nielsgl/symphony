# OrchestratorCore Coordinator Extraction Pattern

## Scope

NIE-197 defines the phase-two extraction pattern for moving full workflow
ownership out of `src/orchestrator/core.ts` without changing runtime behavior.
This is a planning and scaffolding ticket: it intentionally does not extract
`onWorkerExit`, `onRetryTimerOnce`, `dispatchIssue`, or `tickOnce`.

The current reproduction signal is:

| Workflow | Current owner | Approximate size |
| --- | --- | --- |
| Tick dispatch loop | `OrchestratorCore.tickOnce` | 144 lines |
| Worker exit coordination | `OrchestratorCore.onWorkerExit` | 495 lines |
| Retry timer coordination | `OrchestratorCore.onRetryTimerOnce` | 334 lines |
| Dispatch coordination | `OrchestratorCore.dispatchIssue` | 322 lines |

The phase-two goal is to move these workflows as workflows, not to move only
small pure helpers. `OrchestratorCore` should become the public shell that owns
serialization, construction, snapshots, runtime config, and public API methods.
Focused collaborators should own the workflow bodies.

## Coordinator Context

Future workflow coordinators should receive a narrow context object, not an
`OrchestratorCore` instance:

```ts
interface OrchestratorCoordinatorContext {
  readonly state: OrchestratorState;
  readonly config: OrchestratorOptions['config'];
  readonly ports: OrchestratorOptions['ports'];
  readonly persistence: OrchestratorOptions['persistence'];
  readonly logger: StructuredLogger | undefined;
  readonly nowMs: () => number;
  readonly hooks: OrchestratorCoordinatorHooks;
}
```

The context is intentionally explicit:

- `state` is the mutable orchestration state. Coordinators may mutate it because
  the moved workflows already mutate it today.
- `config`, `ports`, `persistence`, `logger`, and `nowMs` are direct
  dependencies that the existing workflows already use.
- `hooks` are the callback seams back into shell-owned or shared behavior.
  Hooks must be named in the domain language already used by `core.ts`, such as
  `scheduleRetry`, `scheduleBlockedInput`, `emitPhaseMarker`, and
  `persistExecutionGraphStateTransition`.

Do not pass `this`, a bound `OrchestratorCore`, or a catch-all service locator.
If a follow-up extraction needs a new hook, add the hook with the narrowest
signature that matches the existing private method and explain why the
coordinator needs it.

## Shell Ownership

`OrchestratorCore` should retain:

- constructor wiring and default config normalization
- public methods and exported surface
- operation serialization through `runSerializedOperation`
- runtime config application
- snapshot cloning and public state snapshot shape
- shared context construction

Public entrypoints should become thin delegators:

```ts
async onRetryTimer(issue_id: string): Promise<void> {
  await this.runSerializedOperation(() =>
    retryCoordinator.onRetryTimerOnce(issue_id)
  );
}
```

This preserves public behavior while making the coordinator own the full retry
timer workflow.

## Hook Boundaries By Workflow

### Worker Exit Coordinator

Worker exit should move first because it is the largest method and already has
clear domain phases:

- ignore stale exits
- apply worker lineage
- finalize normal completion
- route terminal, continuation, blocked-input, workspace-conflict, and retry
  outcomes
- emit phase markers, runtime events, durable graph transitions, and observer
  notifications

Expected context dependencies:

- `state.running`, `state.completed`, `state.claimed`, and
  `state.released_workers`
- `config.inactive_worker_pid_ttl_ms`
- `persistence.recordSession`
- `ports.terminateWorker` and `ports.notifyObservers`
- `logger` and `nowMs`

Expected hooks:

- `normalStopForWorkerCompletion`
- `completeRunRecord`
- `scheduleRetry`
- `scheduleBlockedInput`
- `scheduleRecoveryStartFailedBlock`
- `persistExecutionGraphStateTransition`
- `emitPhaseMarker`
- `recordRuntimeEvent`
- `addRuntimeSecondsFromEntry`
- `recordBudgetUsageSample`
- `inferStopReasonCode`
- `inferInputRequiredDetail`
- `inferWorkspaceConflictContext`

Follow-up extraction shape:

1. Create `src/orchestrator/core/worker-exit-coordinator.ts`.
2. Move the full `onWorkerExit` body into a coordinator function or class.
3. Keep `OrchestratorCore.onWorkerExit` as the public delegator.
4. Move only the worker-exit-specific private helpers after the full workflow
   body is already outside `core.ts`.

### Retry Timer Coordinator

Retry timer should move as the complete retry-decision workflow:

- blocked-input and missing retry guards
- retry entry removal
- tracker-refresh retry special case
- candidate refresh and fetch-failure retry
- active/terminal state cleanup
- redispatch eligibility and slot handling
- dispatch backpressure
- fresh dispatch, residue resume, no-progress gate, and circuit breaker routing

Expected context dependencies:

- `state.blocked_inputs`, `state.retry_attempts`, `state.claimed`,
  `state.running`, `state.health`, `state.redispatch_progress`, and
  `state.circuit_breakers`
- `config` active, terminal, handoff, fresh dispatch, backpressure, and
  redispatch settings
- `ports.tracker`, `ports.cancelRetryTimer`, `ports.getControlPlaneHealth`,
  `ports.getHostLoad`, and `ports.notifyObservers`
- `logger` and `nowMs`

Expected hooks:

- `onTrackerRefreshRetryTimer`
- `recordRetryCleared`
- `scheduleRetry`
- `delayRetryForBackpressure`
- `dispatchIssue`
- `workspaceAttemptResidueResumeContext`
- `scheduleBlockedInput`
- `upsertCircuitBreaker`
- `persistExecutionGraphRetryTransition`
- `recordRuntimeEvent`

Follow-up extraction shape:

1. Create `src/orchestrator/core/retry-timer-coordinator.ts`.
2. Move the full `onRetryTimerOnce` body into the coordinator.
3. Keep `OrchestratorCore.onRetryTimer` as the serialized public delegator.
4. Keep `onTrackerRefreshRetryTimer` as a hook initially unless the same ticket
   has enough room to move it without mixing behavior changes.

### Dispatch Coordinator

Dispatch should own the spawn lifecycle as one unit:

- duplicate runtime ownership guard
- claim and attempt initialization
- worker host selection and host-slot retry routing
- spawn failure retry routing
- running-entry construction
- run/attempt persistence
- post-spawn retry cleanup

Expected context dependencies:

- `state.running`, `state.claimed`, `state.completed`, `state.phase_timeline`,
  `state.health`, and `state.retry_attempts`
- `config.worker_hosts` and host-slot settings
- `ports.spawnWorker`, `ports.cancelRetryTimer`, and `ports.notifyObservers`
- `persistence`, `logger`, and `nowMs`

Expected hooks:

- `recordDuplicateDispatchSkipped`
- `emitPhaseMarker`
- `recordRuntimeEvent`
- `selectWorkerHost`
- `persistPreSpawnExecutionGraphAttempt`
- `scheduleRetry`
- `workerInstanceIdFromHandle`
- `computeBudgetProjection`
- `persistOperationalFactsForIssue`
- `recordHistoryWriteFailure`

Follow-up extraction shape:

1. Create `src/orchestrator/core/dispatch-coordinator.ts`.
2. Move the full `dispatchIssue` body into the coordinator.
3. Keep the core method as an internal delegator while retry and tick
   coordinators still call it.
4. After retry and tick use the dispatch coordinator directly, remove the
   delegator if no longer needed.

### Tick Coordinator

Tick should move after dispatch exists as a coordinator because tick delegates
to dispatch:

- reconcile running issues
- reconcile blocked inputs
- dispatch preflight and recovery
- candidate fetch
- sorted candidate loop
- GitHub-linking guard
- dispatch backpressure
- issue dispatch

Expected context dependencies:

- `state.health`, `state.running`, `state.blocked_inputs`,
  `state.circuit_breakers`, and `state.claimed`
- `config` active state, capacity, GitHub-linking, and backpressure settings
- `ports.dispatchPreflight`, `ports.tracker`, `ports.getControlPlaneHealth`,
  `ports.getHostLoad`, and `ports.notifyObservers`
- `logger` and `nowMs`

Expected hooks:

- `reconcileRunningIssues`
- `reconcileBlockedInputs`
- `recordRuntimeEvent`
- `recordDuplicateDispatchSkipped`
- `delayDispatchForBackpressure`
- `dispatchIssue`

Follow-up extraction shape:

1. Create `src/orchestrator/core/tick-coordinator.ts`.
2. Move the full `tickOnce` body into the coordinator.
3. Keep `OrchestratorCore.tick` as the serialized public delegator.
4. Once dispatch is a coordinator, call that coordinator directly instead of
   bouncing through `core.ts`.

## Extraction Rules

- Extract one workflow per ticket. Do not mix worker exit, retry timer, dispatch,
  and tick body movement in one implementation ticket.
- Move the whole workflow body before extracting secondary helpers. This prevents
  helper-only tickets that leave `core.ts` as the workflow owner.
- Preserve private helper names when they become hooks. Reviewers should be able
  to match old behavior to moved behavior by name.
- Keep the moved code structurally close to the old code until behavior tests
  are green. Refactoring inside a coordinator is a later step.
- Do not widen public exports from `src/orchestrator/index.ts` for these
  coordinators. They are internal implementation collaborators.
- Do not introduce generalized base coordinator classes. The useful abstraction
  is the explicit context and domain-specific hooks.

## Review Checklist For Follow-Ups

Reviewers should reject a follow-up extraction if:

- it passes `this` or the full `OrchestratorCore` instance into a collaborator
- it extracts only leaf helpers while the large workflow body remains in
  `core.ts`
- it combines workflow movement with semantic changes
- it changes public `OrchestratorCore` imports or exports
- it hides dependencies behind a generic service bag or unrelated abstraction
- it lacks before/after validation proving the moved workflow still compiles and
  existing behavior tests pass

Expected validation for each move-only follow-up:

- `npm run build`
- focused orchestrator tests for the moved workflow
- `npm test`
- `git diff --check`
