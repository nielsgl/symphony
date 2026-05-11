# PRD-001 Ticket-Level Orchestration Ledger

## Problem Statement

Symphony currently treats local Codex threads as the easiest observable unit, but the real work unit is a tracker ticket that can move through implementation, review, repair, handoff, and merge iterations. This makes a ticket like `NIE-121` look like multiple tickets when it is really one ticket with implementation and review stages, and it makes costly tickets like `NIE-78` hard to understand without offline reconstruction.

From the user's perspective, this hides systemic cost. The workflow can look locally successful per run while the ticket as a whole burns excessive tokens, repeats validation, rediscovers context, or loops through phases too many times.

## Solution

Create a ticket-level orchestration ledger keyed by tracker identifier. The ledger records every Run Attempt for a ticket, grouped by phase and iteration, with cumulative token usage, duration, validation state, PR state, tracker state, outcome, blockers, evidence references, and next action.

The user should be able to inspect one ticket and see its complete orchestration story: phase flow, repeated iterations, total cost, validation reuse, repair reasons, and final handoff or merge status.

## User Stories

1. As an operator, I want one row per tracker ticket, so that I can reason about the real unit of work instead of individual Codex threads.
2. As an operator, I want to see the full phase flow for a ticket, so that I can spot implementation-review loops.
3. As an operator, I want cumulative tokens per ticket, so that expensive tickets are visible before they become runaway costs.
4. As an operator, I want tokens broken down by phase, so that I can see whether implementation, review, or merge is responsible for cost.
5. As an operator, I want validation state attached to the ticket, so that later phases can reuse prior evidence when safe.
6. As an operator, I want PR state attached to the ticket, so that merge and review runs do not rediscover the same PR metadata.
7. As an operator, I want blocker reasons recorded per phase, so that repeated repairs are explainable.
8. As an agent, I want a compact ticket ledger summary at run start, so that I do not reread every old thread.
9. As an agent, I want unresolved next actions in the ledger, so that I can start from the current ticket state.
10. As a reviewer, I want the ledger to distinguish initial implementation from repair implementation, so that review feedback loops are visible.
11. As a reviewer, I want to see which validation evidence belongs to which phase, so that I can judge whether a handoff is properly supported.
12. As a maintainer, I want ticket-level metrics to be queryable through the local API, so that dashboards and reports share the same source of truth.
13. As a maintainer, I want the ledger to survive process restarts, so that long-running ticket workflows remain reconstructable.
14. As a maintainer, I want source provenance for imported Codex thread evidence, so that local-only data can be distinguished from durable orchestration state.
15. As a product owner, I want ticket-level trend reports, so that workflow changes can be measured across comparable cohorts.

## Implementation Decisions

- Build a deep `Ticket Orchestration Ledger` module that owns ticket-level aggregation behind a small append/read interface.
- The ledger records immutable run-iteration entries rather than rewriting historical phase records.
- Run iterations include tracker identifier, phase, phase iteration number, thread id, token usage, duration, validation summary, PR summary, outcome, blockers, evidence references, and next action.
- The Orchestrator appends ledger records at run start, phase transition, run completion, abort, and handoff.
- Persistence stores the ledger independently of local Codex client session files.
- The Local API exposes ticket summaries and ticket detail projections.
- The dashboard consumes ticket-level summaries rather than reconstructing from raw run state.
- Tracker adapters provide stable tracker identifiers and tracker status snapshots.
- Existing Run Attempt terminology remains intact; the ledger groups Run Attempts under tickets.
- Historical local Codex imports are explicitly marked as imported evidence, not canonical runtime state.

## Testing Decisions

- Tests should verify externally observable ledger behavior, not internal storage layout.
- Unit tests cover append-only ledger semantics, phase grouping, token aggregation, and imported evidence provenance.
- Integration tests cover Orchestrator writes on run start, phase transition, completion, abort, and handoff.
- API tests cover ticket summary and ticket detail projections.
- Dashboard tests cover one-ticket-per-row behavior and phase breakdown rendering.
- Regression tests should use examples equivalent to one ticket with implementation plus review, and one ticket with implementation-review-repair-review-merge.

## Out of Scope

- Changing tracker workflow status names.
- Replacing existing Run Attempt lifecycle semantics.
- Publishing Linear or GitHub issues.
- Implementing validation reuse itself; that is covered by PRD-002.
- Implementing repair-loop policy itself; that is covered by PRD-004.

## Further Notes

This PRD is local only and was not published to any issue tracker. It should be the first implementation priority because later recommendations depend on a durable ticket-level source of truth.
