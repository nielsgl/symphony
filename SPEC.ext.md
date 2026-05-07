# Symphony Extension Specification

Status: v1 reference extension

Purpose: Define Symphony-local extensions to the base service contract in
`SPEC.md`.

## 1. Scope and Authority

This repository implements the base Symphony service specification in
`SPEC.md` plus the local extensions documented in this file.

`SPEC.md` remains the upstream/reference contract. This file is normative only
for behavior that is intentionally local to this repository and intentionally
outside the base contract.

Conflict rules:

- If `SPEC.md` defines a base behavior and this file does not mention it, the
  base behavior applies unchanged.
- If this file extends a base concept, the extension applies only to the named
  Symphony-local field, invariant, or lifecycle rule.
- If this file and `SPEC.md` appear to conflict, implementations must preserve
  the `SPEC.md` base behavior unless this file explicitly names the override.
- Extension fields must not silently change runtime behavior outside the
  lifecycle semantics documented here.

This extension defines workflow-config metadata and runtime semantics for
role-aware handoff states and fresh-dispatch states. The v1 reference
implementation covers typed config resolution, validation, local-worker
state-refresh handling, orchestrator retry/dispatch behavior, and terminal
cleanup separation.

## 2. Domain Model Extensions

### 2.1 Handoff State

A `Handoff State` is a tracker state where responsibility leaves the current
automation role without treating the issue as complete.

Normative meaning:

- A handoff state is a role boundary.
- A handoff state is not a terminal state.
- A handoff state is not a cleanup state.
- A successful run may intentionally end by moving an issue into a handoff
  state.
- The issue, branch, pull request, workpad, and workspace remain available for
  the next role unless another base-spec rule independently removes them.

Examples include states such as `Agent Review` or `Human Review`, where the
next actor must inspect the prior work before the issue can proceed.

### 2.2 Fresh Dispatch State

A `Fresh Dispatch State` is a handoff state where the next automation role must
start as a new run boundary rather than continuing the previous agent context.

Normative meaning:

- A fresh-dispatch state is always a handoff state.
- A fresh-dispatch state is always an active dispatch candidate state.
- Fresh dispatch preserves repository and tracker artifacts, but the next
  automation role must not inherit the previous agent conversation as its own
  execution context.
- Fresh dispatch is intended for independent role transitions, especially
  implementation-to-review boundaries.

Fresh dispatch does not imply workspace deletion. Workspace cleanup remains
controlled by terminal-state cleanup in the base spec.

## 3. Workflow Config Fields

The workflow front matter accepts the extension fields below under `tracker`.
The Config Layer must parse them into typed effective workflow config values so
runtime components can consume them without re-reading raw YAML.

### 3.1 `tracker.handoff_states`

Type: list of strings.

Default: `[]`.

`tracker.handoff_states` names tracker states that are handoff states for this
workflow.

Validation:

- The field is optional.
- When provided, the value must be a list.
- Each list entry must be a non-empty string.
- A state listed in `tracker.handoff_states` must not also be listed in
  `tracker.terminal_states`.
- Invalid shapes or unsafe overlaps must fail config validation before runtime
  dispatch uses the config.

Lifecycle semantics:

- When an issue reaches a handoff state, the current role must not treat that
  state as terminal completion.
- A local worker that refreshes its issue into a handoff state after a turn
  must stop continuation turns and report `handoff_state_reached`.
- Handoff preserves the workspace and surrounding review artifacts for the next
  role.
- Handoff must not schedule same-context continuation retries for the role that
  just handed off.
- Handoff does not require a fresh agent context unless the same state is also
  listed in `tracker.fresh_dispatch_states`.
- Handoff does not alter the base candidate-selection rule by itself. Dispatch
  eligibility still starts from `tracker.active_states`.

### 3.2 `tracker.fresh_dispatch_states`

Type: list of strings.

Default: `[]`.

`tracker.fresh_dispatch_states` names handoff states that require the next
automation role to start as a fresh run boundary.

Validation:

- The field is optional.
- When provided, the value must be a list.
- Each list entry must be a non-empty string.
- Every state listed in `tracker.fresh_dispatch_states` must also be listed in
  `tracker.handoff_states`.
- Every state listed in `tracker.fresh_dispatch_states` must also be listed in
  `tracker.active_states`.
- A state listed in `tracker.fresh_dispatch_states` must not also be listed in
  `tracker.terminal_states`.
- Invalid shapes, missing handoff membership, missing active-state membership,
  or unsafe terminal overlap must fail config validation before runtime
  dispatch uses the config.

Lifecycle semantics:

- Fresh dispatch is a new role/run boundary.
- The next role may inspect persisted artifacts from the prior run, including
  the issue, workpad, branch, pull request, commits, and workspace files.
- The next role must start from the workflow prompt and tracker/repository
  state, not from private continuation context of the prior agent session.
- Fresh dispatch exists to make review or merge automation independent from the
  implementation run that handed off the issue.
- If a stale retry entry exists when the issue is later found in a
  fresh-dispatch state, the dispatcher must ignore inherited thread/session
  lineage and dispatch attempt `0` with no resume context.
- If a fresh-dispatch run routes the issue to a different workflow state, the
  worker must stop and report `fresh_dispatch_state_routed` unless the target
  state is itself a handoff state, in which case `handoff_state_reached` applies.

## 4. Invariants

Implementations must enforce the following invariants for the typed effective
workflow config:

1. Omitted extension fields resolve to `[]`.
2. Omitted extension fields preserve existing behavior compatibility.
3. `tracker.handoff_states` and `tracker.fresh_dispatch_states` contain only
   non-empty strings.
4. `tracker.handoff_states` must not overlap `tracker.terminal_states`.
5. `tracker.fresh_dispatch_states` must not overlap `tracker.terminal_states`.
6. `tracker.fresh_dispatch_states` must be a subset of
   `tracker.handoff_states`.
7. `tracker.fresh_dispatch_states` must be a subset of
   `tracker.active_states`.
8. Terminal states must not be used for workflow handoff because terminal
   cleanup may remove workspaces before the next role can inspect or continue
   the work.

These invariants are config-contract requirements and runtime preconditions.

## 5. Dispatch and Reconciliation Implications

The base `SPEC.md` candidate-selection model remains authoritative:

- Candidate issues are fetched from `tracker.active_states`.
- Terminal states remain cleanup states.
- Reconciliation stops active runs whose tracker state becomes terminal or
  non-active.
- Startup terminal cleanup may remove workspaces for terminal issues.

The extension adds role-boundary metadata that runtime components use:

- A handoff state signals that current-role continuation should stop at that
  state.
- A fresh-dispatch state signals that the next automation role should be
  dispatched independently.
- Because active states are the candidate source, every fresh-dispatch state
  must be active. Otherwise a config could describe a fresh run boundary that
  the dispatcher can never pick up.
- Because terminal states may trigger workspace cleanup, terminal states cannot
  safely serve as handoff states.

This extension does not make `Agent Review`, `Human Review`, or any other
state active by default. Workflows opt into those states by listing them in
`tracker.active_states` when runtime dispatch should consider them.

### 5.1 Local Worker State-Refresh Order

After each completed Codex turn, the local worker must refresh the issue state
and apply the first matching rule in this order:

1. Missing refreshed issue: stop normally with `issue_state_missing`; no
   workspace cleanup.
2. Refreshed state is in `tracker.terminal_states`: stop normally with
   `terminal_state_reached`; orchestrator terminal cleanup applies.
3. Refreshed state is in `tracker.handoff_states`: stop normally with
   `handoff_state_reached`; no workspace cleanup and no same-context retry.
4. Current state is in `tracker.fresh_dispatch_states` and refreshed state is a
   different state: stop normally with `fresh_dispatch_state_routed`; no
   workspace cleanup and no same-context retry.
5. Refreshed state is not in `tracker.active_states`: stop normally with
   `issue_left_active_states`; no workspace cleanup.
6. Refreshed state remains active and none of the above applies: continue on
   the same thread until normal max-turn behavior applies.

This order is intentional. Terminal cleanup must win over handoff metadata,
handoff states must stop the current role before same-thread continuation, and
fresh-dispatch routing is only meaningful when a fresh-dispatch role moves the
issue onward.

### 5.2 Orchestrator Dispatch and Retry Semantics

Candidate selection remains `tracker.active_states` plus existing eligibility
checks. For a configured fresh-dispatch state:

- A candidate in that state dispatches as a new attempt with no resume context.
- A stale retry timer that observes the issue in that state dispatches as a
  fresh attempt instead of applying no-progress redispatch gating.
- Fresh dispatch clears inherited retry graph lineage, previous thread/session
  IDs, worker host, and workspace metadata for the new role attempt.
- Running/claimed protection still prevents duplicate fresh runs for the same
  issue.
- Slot exhaustion may reschedule the fresh-dispatch candidate, but the
  rescheduled retry must retain the fresh boundary by keeping inherited
  context cleared.

### 5.3 Reconciliation and Cleanup Separation

Runtime reconciliation keeps the base cleanup contract:

- Terminal states stop active runs and clean the workspace.
- Non-active, non-terminal states stop active runs without workspace cleanup.
- Active states, including active handoff/fresh-dispatch states, remain
  dispatch candidates and are not treated as terminal cleanup states.
- Startup terminal cleanup only uses `tracker.terminal_states`.

Handoff and fresh dispatch therefore preserve review evidence and workspaces.
Only terminal transitions may invoke terminal cleanup.

## 6. Failure Behavior

Invalid extension config must fail before runtime use with typed workflow config
errors.

Required error behavior:

- Malformed `tracker.handoff_states` values fail with an
  `invalid_tracker_handoff_states` config error.
- `tracker.handoff_states` terminal overlap fails with an
  `invalid_tracker_handoff_states` config error.
- Malformed `tracker.fresh_dispatch_states` values fail with an
  `invalid_tracker_fresh_dispatch_states` config error.
- `tracker.fresh_dispatch_states` terminal overlap, missing handoff
  membership, or missing active-state membership fails with an
  `invalid_tracker_fresh_dispatch_states` config error.

Implementations should include the invalid field name and offending state value
in the validation message when one offending value can be identified.

## 7. Compatibility Boundaries

Existing workflows that omit both extension fields must resolve exactly as they
did before this extension:

- `tracker.handoff_states` resolves to `[]`.
- `tracker.fresh_dispatch_states` resolves to `[]`.
- Candidate selection remains based on `tracker.active_states`.
- Terminal cleanup remains based on `tracker.terminal_states`.
- No runtime handoff or fresh-dispatch behavior is implied by omission.

This extension is additive. It must not require workflow authors to configure
handoff states unless their workflow needs role-aware handoff behavior.

## 8. Implemented Lifecycle Contract

The bundled `WORKFLOW.md` uses the following v1 lifecycle:

- Implementation runs in `Todo` or `In Progress`.
- Passing implementation work hands off by moving the issue to `Agent Review`.
- `Agent Review` is active, a handoff state, and a fresh-dispatch state, so the
  review role starts as an independent run.
- UI work, product judgment, unclear human intent, or blocked external input
  routes from `Agent Review` to `Human Review`.
- Non-UI passing review routes from `Agent Review` to `Merging`.
- Normal review findings route from `Agent Review` to `In Progress`.
- Reset-level failures route from `Agent Review` to `Rework`.
- `Merging` is active but not a handoff or fresh-dispatch state; merge handling
  follows the workflow land loop.
- `Done`, `Closed`, `Canceled`, and `Duplicate` are terminal cleanup states.

## 9. Implementation and Test Evidence

The v1 reference implementation evidence is:

- Config resolution: `src/workflow/resolver.ts` resolves
  `tracker.handoff_states` and `tracker.fresh_dispatch_states`; covered by
  `tests/workflow/resolver.test.ts`.
- Config validation: `src/workflow/validator.ts` enforces terminal overlap,
  handoff subset, and active subset invariants; covered by
  `tests/workflow/validator.test.ts`.
- Local worker stop/routing behavior: `src/orchestrator/local-worker-runner.ts`
  applies the state-refresh order in Section 5.1; covered by
  `tests/orchestrator/local-runner-bridge.test.ts`.
- Fresh dispatch and stale retry behavior: `src/orchestrator/core.ts` dispatches
  fresh-dispatch candidates without inherited context and bypasses no-progress
  retry gating for stale fresh-dispatch retries; covered by
  `tests/orchestrator/core.test.ts`.
- Terminal cleanup separation: `src/orchestrator/core.ts` cleans workspaces for
  terminal transitions and does not clean for handoff/fresh-dispatch exits;
  covered by `tests/orchestrator/core.test.ts` and
  `tests/orchestrator/local-runner-bridge.test.ts`.
- Workflow lifecycle instructions: `WORKFLOW.md` defines Agent Review, Human
  Review, Merging, and Rework routing; covered by
  `tests/workflow/workflow-command-examples.test.ts`.

Deferred or out-of-scope items:

- Programmatic verification that Linear-rendered UI evidence media is visible
  in review comments remains reviewer-enforced in `WORKFLOW.md`.
- Human judgment in `Human Review` is explicitly outside automation dispatch.
- This extension does not make `Human Review` active in the bundled workflow;
  it is a human/product review holding state.

## 10. Example

Example workflow shape:

```yaml
tracker:
  active_states:
    - Todo
    - In Progress
    - Agent Review
    - Merging
    - Rework

  handoff_states:
    - Agent Review
    - Human Review

  fresh_dispatch_states:
    - Agent Review
```

Interpretation:

- `Agent Review` is a handoff state and a fresh-dispatch state.
- `Agent Review` is listed in `active_states`, so review automation may
  discover it as a candidate and start a fresh run.
- `Human Review` is a handoff state but not a fresh-dispatch state in this
- example. Because it is not listed in `active_states`, automation does not
  dispatch it in this workflow.
- No terminal state is used for handoff.
- If the two extension fields are omitted, both resolve to `[]` and existing
  workflow behavior is preserved.
