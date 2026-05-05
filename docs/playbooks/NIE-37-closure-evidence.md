# NIE-37 Closure Evidence

This is the umbrella closure packet for the workspace-conflict respawn-loop
program. It aggregates merged child-ticket evidence and fresh umbrella
verification only; it does not add runtime behavior under NIE-37.

## Implementation Record

- NIE-38: durable workspace-conflict blocked routing, PR #42.
- NIE-39: dashboard Action Required operator UX, PR #47.
- NIE-40: persisted respawn breaker and diagnostics hardening, PR #48.
- NIE-41: workspace preflight hygiene and meta-check isolation, PR #44.
- NIE-42: redispatch completion gate, no-progress breaker, resume/cancel paths, PR #46.
- NIE-43: governed PR body normalization and Linear UI evidence publication, PR #50.

All six child tickets were verified `Done` in Linear on 2026-05-05.

## 1. Deterministic Repro Scenario

Workspace-conflict repro:

Preconditions:

- Runtime is on a clean issue branch.
- A tracked ephemeral artifact or mixed staged/unstaged drift is present before dispatch.
- Example conflict payload contains:
  - `output/playwright/ui-evidence.json` with staged/tracked artifact status.
  - `src/api/dashboard-assets.ts` with unstaged source drift.

Command proof:

```sh
npm test -- tests/orchestrator/core.test.ts -t "does not redispatch blocked workspace-conflict issues across repeated scheduler ticks until explicit resume"
```

Expected stop reason:

```text
operator_action_required_workspace_conflict
```

Expected result:

- The issue is inserted into `blocked_inputs`.
- `requires_manual_resume` is true.
- `retry_attempts` does not contain the blocked issue.
- Repeated scheduler ticks do not redispatch until explicit resume.

## 2. Before/After Runtime Trace

Before signal:

- The original failure pattern was repeated workspace-conflict guardrail stops with the same blocking reason and new attempts.
- PR #42 includes a repo-hygiene commit removing accidentally staged UI evidence artifacts and marker drift from the NIE-38 branch, matching the historical `output/playwright/*` plus `src/api/dashboard-assets.ts` dirty-state pattern.
- PR #44 documents the follow-up root cause: meta-check tests mutating production-like paths and tracked artifact drift causing recurring guardrail stops.

After trace:

- PR #42 added tests proving workspace-conflict abnormal exits enter durable blocked state without retry scheduling.
- PR #44 added preflight cleanup/conflict blocking for known artifact drift.
- Current umbrella focused repro on 2026-05-05 passed:

```text
Test Files  1 passed (1)
Tests       1 passed | 44 skipped (45)
```

## 3. Dashboard Proof

Published Linear evidence:

- Attachment `0ea6cd2a-ad83-4dfa-9c29-2d93cde21817`
- Title: `NIE-37 operator proof screenshot contact sheet`

The contact sheet shows:

- Action Required banner visible.
- Workspace-conflict and no-progress blocked rows.
- Stop reason codes and details.
- Conflict file chips with staged/unstaged statuses.
- Operator actions: reply, resume, push-commit resume, cancel/backlog, copy, JSON.

## 4. Operator Remediation Proof

Published Linear evidence:

- Attachment `0ea6cd2a-ad83-4dfa-9c29-2d93cde21817`

Executed browser-proof paths:

- Resume path: clicked `Mark Acceptance Complete + Resume`; mocked API returned `202` and the dashboard refreshed to an active dispatch row.
- Cancel/backlog path: clicked `Cancel to Backlog`; mocked API returned `202` with `moved_to_state: Backlog`.

Captured request payloads:

```json
{
  "resume": [{}],
  "cancel": [
    {
      "cancel_reason": "operator_cancel_return_to_backlog"
    }
  ]
}
```

## 5. Circuit-Breaker/No-Progress Proof

Merged evidence:

- PR #46 implements `operator_action_required_no_progress_redispatch_blocked`, attempt-window payloads, required actions, and manual resume override semantics.
- PR #48 persists breaker and suppression metadata and restores them after restart.

Diagnostics payload fields represented in API/proof:

```json
{
  "breaker_active": true,
  "breaker_hit_count": 4,
  "breaker_window_minutes": 30,
  "suppression_active": true
}
```

Required projection fields are covered by API/snapshot tests:

- `attempt_count_window`
- `window_minutes`
- `last_known_commit_sha`
- `last_progress_checkpoint_at`
- `required_actions`
- `breaker_active`
- `breaker_hit_count`
- `breaker_first_hit_at`
- `breaker_last_hit_at`

## 6. Governance/Evidence Pipeline Proof

Merged evidence:

- PR #50 introduced shared markdown-body normalization and submit-boundary governance.
- `scripts/submit-pr-with-governance.js` enforces normalize -> PR governance -> meta checks -> `gh pr create/edit --body-file`.
- `npm run check:meta` enforces `ui_evidence_unpublished` when UI artifact references lack Linear publication references.

Published UI proof:

- The umbrella contact sheet was uploaded to Linear storage and linked to NIE-37 before review.
- Local UI evidence artifacts are not committed.

## 7. Validation Commands

Required commands for the final NIE-37 evidence PR:

```sh
npm test
npm run build
npm run check:meta
git diff --check
```

These commands must be green on the final evidence commit before moving NIE-37
to Human Review.
