# Workspace-Conflict Respawn-Loop Closure Evidence

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

## Evidence Mapping

| Closure checklist item | Auditable artifact/link |
| --- | --- |
| 1. Deterministic repro scenario document | This playbook, section 1. Focused command: `npm test -- tests/orchestrator/core.test.ts -t "does not redispatch blocked workspace-conflict issues across repeated scheduler ticks until explicit resume"`. Source regression: `tests/orchestrator/core.test.ts`. |
| 2. Before/after runtime trace | This playbook, section 2. Before trace artifact: NIE-38 Linear workpad reproduction notes plus PR #42 hygiene commit `f5e6853b2cbbf8d03d46d5fc269b1eb857161a44`. After trace artifact: NIE-38 PR #42 commits `9cd3d6e2ed55828f6f51a1ecfd070f38929e0f0d` and `1ba8936775a8536911d12e0c3a55d1146bc4b787`, and the focused umbrella repro command above. |
| 3. Dashboard proof | NIE-37 Linear attachment `0ea6cd2a-ad83-4dfa-9c29-2d93cde21817`, title `NIE-37 operator proof screenshot contact sheet`. |
| 4. Operator remediation proof | NIE-37 Linear attachment `0ea6cd2a-ad83-4dfa-9c29-2d93cde21817`, plus section 4 request payloads and mocked API outcomes. |
| 5. Circuit-breaker/no-progress proof | NIE-42 PR #46, commit `13eb402f73206cc190e7144e2119746bf7b797ea`, and section 5 diagnostics fields. |
| 6. Governance/evidence pipeline proof | NIE-43 PR #50, commits `26dd8691a0d674974db7c32aff498e36a850446c`, `1aaf6bd793b4633ee97ddfba95687303d10d43fa`, and `5127e9ae09669cdcd6dd5656f7957457cdcd04c7`; scripts `scripts/submit-pr-with-governance.js`, `scripts/normalize-pr-body.js`, `scripts/check-meta.js`. |
| 7. Validation commands green | NIE-37 Linear attachment `40b887e3-5ac3-4ee2-89a9-db25cc4fd163`, title `NIE-37 validation command transcript`; required commands listed in section 7. |

## 1. Deterministic Repro Scenario

Workspace-conflict repro:

Preconditions:

- Runtime is on a clean issue branch.
- A tracked ephemeral artifact or mixed staged/unstaged drift is present before dispatch.
- Example conflict payload contains:
  - `output/playwright/demo.webm` with staged/tracked artifact status.
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

Before trace artifact:

- NIE-38 staff review recorded the missing regression proof for the historical
  loop shape: dispatch issue, emit workspace-conflict exit, run repeated
  scheduler ticks, verify no redispatch until manual resume. That was the
  failing behavior class to lock.
- PR #42 includes a concrete hygiene artifact, commit
  `f5e6853b2cbbf8d03d46d5fc269b1eb857161a44`, removing accidentally staged
  `output/playwright/*` UI evidence artifacts and incidental marker drift. This
  is the same artifact class called out in the NIE-37 repro precondition.
- NIE-41 staff review and workpad record the second root cause: meta-check tests
  mutated `src/api/dashboard-assets.ts`, copied `.git` into temp repos, and used
  production UI paths for strict evidence gates.

Before trace excerpt:

```text
attempt=1 issue=i-workspace-conflict-blocked
stop_reason_code=operator_action_required_workspace_conflict
detail=workspace_unprovisioned_conflict: worktree_branch_conflict
conflict_files=[{"path":"output/playwright/demo.webm","status":"staged"},
  {"path":"src/api/dashboard-assets.ts","status":"unstaged"}]
runtime_action=retry_scheduled_or_spawned

attempt=2 issue=i-workspace-conflict-blocked
stop_reason_code=operator_action_required_workspace_conflict
detail=workspace_unprovisioned_conflict: worktree_branch_conflict
conflict_files=[{"path":"output/playwright/demo.webm","status":"staged"},
  {"path":"src/api/dashboard-assets.ts","status":"unstaged"}]
runtime_action=retry_scheduled_or_spawned

attempt=3 issue=i-workspace-conflict-blocked
stop_reason_code=operator_action_required_workspace_conflict
detail=workspace_unprovisioned_conflict: worktree_branch_conflict
conflict_files=[{"path":"output/playwright/demo.webm","status":"staged"},
  {"path":"src/api/dashboard-assets.ts","status":"unstaged"}]
runtime_action=retry_scheduled_or_spawned
```

After trace:

- PR #42 added tests proving workspace-conflict abnormal exits enter durable blocked state without retry scheduling.
- PR #44 added preflight cleanup/conflict blocking for known artifact drift.
- Current umbrella focused repro on 2026-05-05 passed:

```text
Test Files  1 passed (1)
Tests       1 passed | 44 skipped (45)
```

After trace excerpt:

```text
attempt=1 issue=i-workspace-conflict-blocked
stop_reason_code=operator_action_required_workspace_conflict
blocked_inputs.has(issue)=true
requires_manual_resume=true
retry_attempts.has(issue)=false
scheduled_retry=false

tick=1 issue=i-workspace-conflict-blocked
dispatch_skipped_reason=blocked_input_present
spawned_count_delta=0

tick=2 issue=i-workspace-conflict-blocked
dispatch_skipped_reason=blocked_input_present
spawned_count_delta=0

manual_resume issue=i-workspace-conflict-blocked
result=ok
blocked_inputs.has(issue)=false
redispatch_allowed=true
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

Published Linear evidence:

- Attachment `40b887e3-5ac3-4ee2-89a9-db25cc4fd163`
- Title: `NIE-37 validation command transcript`

Transcript summary:

```text
npm test: 43 files passed, 397 tests passed
npm run build: passed
npm run check:meta: passed
git diff --check: passed with no output
```
