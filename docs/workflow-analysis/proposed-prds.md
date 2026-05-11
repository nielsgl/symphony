# Proposed PRDs And Issue Ideas

These are draft PRD/issue ideas translated from the corrected ticket-level analysis. They are not created in Linear or GitHub.

Expanded local PRD documents now live under `docs/workflow-analysis/prd/`:

- `PRD-001-ticket-level-orchestration-ledger.md`
- `PRD-002-phase-aware-validation-ledger.md`
- `PRD-003-phase-handoff-packet.md`
- `PRD-004-repair-loop-escalation-policy.md`
- `PRD-005-governed-submit-merge-preflight.md`
- `PRD-006-simple-task-fast-path.md`

## PRD 1: Ticket-Level Orchestration Ledger

Problem: Symphony currently records runs as separate Codex threads, while the real unit of work is a ticket with multiple phase iterations. Evidence: the corrected cohort contains 50 tickets but 195 run iterations. `NIE-121` is one ticket with implementation and review iterations; `NIE-78` is one ticket with multiple implementation/review/merge iterations.

Scope:

- Persist a ledger keyed by tracker identifier.
- Append every run iteration with phase, status, thread id, tokens, duration, validation evidence, PR state, outcome, and next action.
- Expose ticket-level totals and phase breakdown through API/dashboard.

Acceptance:

- A ticket table shows one row per `NIE-*` with phase iteration counts.
- A ticket detail view shows full phase flow and per-run evidence.
- Metrics no longer require offline grouping by issue id.

## PRD 2: Phase-Aware Validation Ledger

Problem: Validation repeats across phase iterations without structured reuse. Evidence: 255 `npm test`, 217 `npm run build`, 153 `git diff --check`, and 132 `npm run check:meta` calls across the 50-ticket cohort.

Scope:

- Store validation results by command, tree hash, environment hash, artifact hash, and phase.
- Allow later review/merge iterations to cite still-valid validation evidence.
- Require explicit invalidation reason before rerunning full validation.

Acceptance:

- Review and merge iterations can reuse implementation validation when no relevant change occurred.
- Validation reuse appears in PR/handoff summaries.
- Metrics show reduced validation repeats per ticket.

## PRD 3: Phase Handoff Packet

Problem: Each phase iteration repeatedly rediscovers workflow context. Evidence: discovery-category commands total 5934 across 195 iterations.

Scope:

- Write a signed/hashable handoff packet after every phase.
- Include issue state, branch/PR state, validation ledger, evidence artifacts, known blockers, workflow rules, and next action.
- Load handoff packet before broad repo/skill discovery.

Acceptance:

- Consecutive phase iterations avoid rereading unchanged skills/playbooks.
- Packet invalidation is based on source hashes and tracker/PR drift.
- Dashboard shows latest handoff packet per ticket.

## PRD 4: Repair Loop And Escalation Policy

Problem: Repeated phase loops can become expensive without an explicit escalation threshold. Evidence: `NIE-81` has 16 iterations, `NIE-87` has 13, and `NIE-103` / `NIE-84` each have 10.

Scope:

- Track repeated phase transitions by ticket.
- Require a typed repair reason for each return from review to implementation.
- Add thresholds for token spend, iteration count, and repeated failed checks.

Acceptance:

- Tickets over threshold are marked for explicit intervention or narrowed repair plan.
- Review-to-implementation transitions include structured blocker categories.
- Reports show iteration loops by ticket and phase.

## PRD 5: Governed Submit And Merge Preflight

Problem: Merge and PR operations still use repeated shell probes and retry-prone wrappers.

Scope:

- Provide one governed preflight returning structured JSON.
- Check git config writability, branch tracking, PR identity, PR body source, labels, status checks, mergeability, and template availability.
- Feed submit/merge steps from preflight output.

Acceptance:

- Missing PR body or git config issues fail before expensive validation.
- Merge retries cite the preflight field that changed.
- Failed shell command count drops in merge iterations.

## PRD 6: Simple Task Fast Path

Problem: Small changes can still run through full expensive orchestration. Evidence: `NIE-121` is a color-change ticket with two iterations and 7,835,268 tokens.

Scope:

- Detect narrow docs/style/test-only change classes.
- Choose scoped discovery and validation by class.
- Escalate to full validation only on touched-path or governance triggers.

Acceptance:

- Styling-only tickets still publish UI evidence but avoid broad source rediscovery.
- Docs-only tickets avoid runtime/UI validation unless touched paths require it.
- Handoff explains scoped validation sufficiency.
