# NIE-96 MCP-First Linear And Missing-Output Recovery Audit

## Scope

NIE-96 audits the completed NIE-88 implementation slices against the NIE-86
healthy MCP path and the NIE-87 missing-output failure path. This audit covered
workflow docs, skills, runtime code, tests, persistence, API projections,
dashboard rendering, and forensics behavior.

Intentional scope decisions:

- This audit does not remove `linear_graphql`; NIE-88 keeps it as a low-level
  GraphQL-only escape hatch.
- This audit does not replace the script-backed UI evidence publisher; rich
  Linear media remains the intentional GraphQL-only exception.
- This audit does not add new recovery behavior beyond the existing
  same-thread guarded continuation path.
- No follow-up issue was filed from this audit because no material gap was
  found that was too large or risky for this slice.

## Audit Matrix

| Surface | Evidence | Result |
| --- | --- | --- |
| MCP-first workflow and skills | `WORKFLOW.md`, `SPEC.md`, `.codex/skills/linear-graphql/SKILL.md`, `.codex/skills/linear-ui-evidence/SKILL.md`, `docs/playbooks/linear-workflow-playbook.md` | Pass. Routine Linear issue/comment/state/link work is MCP-first; raw GraphQL is limited to private uploads, rich `bodyData`, verification, introspection, and rare unsupported operations. |
| UI evidence boundary | `.codex/skills/linear-ui-evidence/scripts/publish-linear-ui-evidence.js`, `tests/cli/linear-ui-evidence-publisher.test.ts`, `tests/cli/meta-check-scripts.test.ts` | Pass. Publishing is script-backed, validates before network calls, uploads private media, writes rich `bodyData`, and verifies media nodes after comment save. |
| Tool-call ledger | `src/orchestrator/types.ts`, `src/orchestrator/core.ts`, `tests/codex/runner.test.ts`, `tests/orchestrator/core.test.ts` | Pass. Ledger records call id, tool name, thread, turn, session, issue/run identity, evidence source, timestamps, and completion status from worker, app-server, raw response, and transcript evidence. |
| Missing-output classification | `src/orchestrator/core.ts`, `src/observability/reason-codes.ts`, `tests/orchestrator/core.test.ts` | Pass. Classification is based on unmatched active-owned call age; waiting heartbeats do not reset the missing-output timer; matching outputs clear or prevent blockers. |
| NIE-87-shaped transcript failure | `tests/orchestrator/core.test.ts` cases for transcript-derived `linear_graphql` function calls without matching output | Pass. Unmatched transcript function calls produce `missing_tool_output` blockers with tool/call/lineage evidence. |
| NIE-86 healthy MCP path | `tests/orchestrator/core.test.ts` healthy MCP case | Pass. MCP-style Linear activity is not misclassified as dynamic GraphQL missing-output evidence. |
| Manual resume attribution | `TranscriptToolCallLineage` in `src/orchestrator/types.ts`, lineage classification in `src/orchestrator/core.ts`, transcript diagnostic tests | Pass. External/manual and stale transcript entries remain diagnostic and do not clear active-owned blockers unless Symphony intentionally adopts a replacement turn. |
| Guarded recovery | `src/orchestrator/core.ts`, `src/orchestrator/local-runner-bridge.ts`, `src/codex/runner.ts`, recovery tests | Pass. Recovery interrupts/cancels the old turn, starts a tracked same-thread replacement turn, uses an indeterminate-outcome prompt, and avoids blind tool replay. |
| Persistence/API/dashboard/forensics | `src/persistence/store.ts`, `src/api/missing-tool-output-recovery.ts`, `src/api/snapshot-service.ts`, `src/api/dashboard-assets.ts`, `src/api/forensics.ts`, related tests | Pass. Recovery state, ownership, interrupt result, replacement turn, guarded prompt dispatch, final outcome, and missing-output evidence are surfaced for operators and forensics. |
| Review guardrails | `WORKFLOW.md`, `docs/playbooks/PR-REVIEW-CHECKLIST.md`, `tests/cli/linear-ui-evidence-guidance.test.ts` | Pass after NIE-96. Agent Review and behavior-first checklist both cover avoidable raw GraphQL usage and rendered rich-media UI evidence blockers. |

## Validation Requirements

Required validation for this ticket remains:

- `npm test`
- `npm run build`
- `npm run check:meta`
- `git diff --check`
