# Strategy Red-Team

## Confidence Boundary

I am confident in the revised strategy only under this bounded claim:

The next workflow improvements should optimize around a ticket-level lifecycle with phase iterations, not around isolated Codex threads. The first implementation priorities should be a ticket orchestration ledger, validation reuse, compact phase handoff packets, phase-aware repair-loop controls, and structured outcome telemetry.

That claim is supported by local Codex evidence from 50 tickets and 195 run iterations. It is not proof of exact future savings, because current local data lacks first-class phase spans, retry relations, validation cache keys, and normalized outcomes.

## Red-Team Loop 1: Data Loopholes

### Loophole: Local Codex data may be incomplete

The analysis uses local `~/.codex` data. It may miss runs from another machine, deleted logs, moved state, or tracker-side events that did not create local issue-workspace threads.

Fix:

- Persist a Symphony-owned issue orchestration ledger independent of local Codex client state.
- Include source provenance for every imported thread/run.
- Add a reconciliation check against tracker state and PR history.

Confidence gate:

- A ticket report can prove every included run came from a durable Symphony ledger or explicitly mark it as local-only evidence.

### Loophole: "Last 50 tickets" can mean several things

This analysis defines the cohort as the 50 most recent unique tickets by latest local issue-workspace run timestamp. That is not necessarily the last 50 created, completed, or updated Linear tickets.

Fix:

- Make cohort definition explicit in all reports.
- Add selectable cohort modes: latest local run, latest tracker update, latest created, latest completed, and latest merged.

Confidence gate:

- Reports show the cohort selector and the timestamp used to rank tickets.

### Loophole: Phase attribution is inferred

Phases are inferred from starting Linear status in the workflow prompt. A run can transition phase mid-thread, and the local data does not expose a canonical phase span.

Fix:

- Emit structured `phase_started`, `phase_completed`, and `phase_transition` events.
- Store phase on every run iteration in the ticket ledger.

Confidence gate:

- No report needs to infer phase from prompt text.

### Loophole: Token totals do not equal exact dollar cost or latency

The `tokens_used` value includes large cached input-token counts. In the 195-iteration cohort, most input tokens were cached, so token reduction, dollar reduction, and wall-clock reduction are related but not identical.

Fix:

- Track `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`, elapsed time, and command runtime separately.
- Rank recommendations by separate expected effects: token volume, billable cost, wall-clock time, and failure risk.

Confidence gate:

- Every recommendation states which cost surface it targets.

## Red-Team Loop 2: Strategy Loopholes

### Loophole: A ticket ledger could become more overhead

A verbose ledger could add more context and increase token usage.

Fix:

- Store the ledger as compact structured data.
- Load only the current ticket summary, current phase packet, validation cache summary, and unresolved blockers.
- Keep detailed historical rows available by reference, not pasted into every run.

Confidence gate:

- Starting prompt/context size decreases or stays flat after ledger adoption.

### Loophole: Validation reuse can be unsafe

Skipping tests based on stale or incomplete cache keys can hide regressions.

Fix:

- Key validation by git tree hash, command, working directory, dependency lockfile hash, environment fingerprint, generated artifact hash, and relevant evidence artifact hash.
- Fail closed when the cache key is missing or uncertain.
- Require explicit invalidation reasons.

Confidence gate:

- Reused validation records show the exact key and why no invalidator fired.

### Loophole: Handoff packets can go stale

A handoff packet can mislead later phases if PR state, tracker status, branch head, or evidence artifacts changed.

Fix:

- Include source hashes and observed tracker/PR/head identifiers in each packet.
- Run a small drift probe before trusting a packet.
- Invalidate only the stale sections instead of discarding the whole packet.

Confidence gate:

- Every loaded handoff packet has a `valid`, `partially_stale`, or `stale` state with reasons.

### Loophole: Repair-loop limits can block legitimate work

Some tickets need several implementation/review loops because the issue is genuinely hard or cross-cutting.

Fix:

- Use soft escalation thresholds, not automatic stops.
- Require structured blocker categories and a scoped repair plan after repeated loops.
- Escalate to human review or planning only when the loop repeats without new evidence.

Confidence gate:

- A repeated phase transition includes a reason, blocker category, changed files, and expected validation scope.

### Loophole: Simple-task fast paths can miss hidden coupling

A styling or docs change can still trigger governance, UI evidence, or cross-cutting checks.

Fix:

- Use a conservative allowlist and touched-path risk rules.
- Escalate to full validation when source paths, shared contracts, UI evidence gates, generated artifacts, or failing checks require it.

Confidence gate:

- Scoped validation decisions include the touched-path classifier and escalation checks.

### Loophole: Merge preflight can become another repeated ceremony

If preflight is bolted on without replacing ad hoc probes, it adds work instead of removing it.

Fix:

- Make governed submit and merge consume one structured preflight result.
- Remove duplicate shell probes once the preflight exists.
- Cache the preflight until branch head, PR head, labels, status checks, or body source changes.

Confidence gate:

- Merge iterations call one preflight and then consume its JSON instead of repeating independent `git`, `gh`, and file probes.

## Final Strategy After Red-Team

1. Build a compact ticket orchestration ledger first.
2. Add validation reuse keyed by tree/env/artifact identity.
3. Add phase handoff packets with drift detection.
4. Add repair-loop controls that escalate repeated phase transitions with evidence.
5. Add structured run outcome and phase telemetry so future analyses do not infer from prose.
6. Add simple-task fast paths only after ledger and validation safety are in place.
7. Harden merge/PR preflight and remove the duplicated probes it replaces.

## Remaining Non-Provable Areas

The current data cannot prove exact future token savings, exact wall-clock savings, or exact reduction in failed tickets. Those require implementing the instrumentation above and comparing before/after cohorts with the same cohort selector.
