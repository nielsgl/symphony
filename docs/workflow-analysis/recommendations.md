# Recommendations

Ranked by expected impact first, then implementation effort. These recommendations are based on the corrected ticket-level cohort: 50 tickets, 195 run iterations, and 945,655,203 recorded tokens.

| Rank | Recommendation | Impact | Effort | Evidence |
|---:|---|---|---|---|
| 1 | Add a per-ticket orchestration ledger with phases, iterations, cumulative tokens, validation state, PR state, handoff state, and outcome. | Very high | Medium | The 50 tickets expand to 195 run iterations. `NIE-87` has 13 iterations / 61,875,458 tokens; `NIE-81` has 16 iterations / 43,827,750 tokens. |
| 2 | Add a validation-result cache keyed by repo tree hash, command, environment, and evidence artifact. | Very high | Medium | Across 195 iterations: `npm test` 210 calls, `npm run build` 221, `git diff --check` 176, `check:meta` 135. |
| 3 | Generate compact ticket phase handoff packets. | High | Low/Medium | Discovery-category commands total 5934; repeated skill/playbook reads persist across implementation, review, and merge iterations. |
| 4 | Add phase-aware routing and repair-loop limits. | High | Medium | Multi-iteration flows are common: 50 of 50 tickets have more than one iteration; `NIE-119` has flow `implementation -> review -> implementation -> review -> implementation -> review -> merge`. |
| 5 | Harden merge/PR preflight and governed-submit wrappers. | High | Medium | Merge phase has 42 iterations, 99,556,387 tokens, and 28 failed shell commands; repeated PR/merge commands remain visible. |
| 6 | Introduce a simple-task fast path with scoped validation and explicit escalation. | Medium/High | Medium | `NIE-121` is one color-change ticket with implementation + review, 7,835,268 tokens, and repeated validation. |
| 7 | Add structured run outcome, retry, and abort telemetry. | Medium | Low/Medium | Outcome still requires inference from lifecycle events and final text; the 50-ticket cohort has 52 iterations without `task_complete`. |

## Detail

The red-team pass in `strategy-red-team.md` tightened the implementation order: build the ticket ledger and safe validation cache before relying heavily on simple-task fast paths. The fast path is useful, but without ledger and cache safety it can hide coupling or skip evidence too aggressively.

### 1. Per-Ticket Orchestration Ledger

Persist one issue-level record that accumulates every run iteration by phase. It should show flow, cumulative tokens, iteration count per phase, validation evidence, PR URL, final state transition, blockers, and next action. This directly addresses the ticket-vs-thread confusion that made `NIE-121` and `NIE-78` look like duplicate tickets.

### 2. Validation-Result Cache

Record validation command, cwd, git tree hash, environment fingerprint, result, output summary, and artifact references. Review and merge iterations should reuse validation when no relevant tree/environment/artifact changed.

### 3. Ticket Phase Handoff Packets

At each phase transition, write a compact handoff packet with issue facts, branch/PR state, validation ledger, artifacts, workflow rules already read, blockers, and the next allowed phase. The next iteration should read that packet first and verify only drift-prone facts.

### 4. Phase-Aware Routing And Repair-Loop Limits

A ticket should have explicit limits or escalation thresholds for repeated phase transitions such as `implementation -> review -> implementation -> review`. When the same phase repeats, require a short reason and expected invalidation/repair scope.

### 5. Merge/PR Preflight

Use a structured preflight before governed submit and merge. It should check git config writability, branch tracking, PR identity, PR body input, labels, status checks, and mergeability once, then feed later steps with JSON.
