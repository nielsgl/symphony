# SWP-001 Protocol Hardening Integration Audit

Status: Complete
Date: 2026-05-11
Parent PRD: NIE-122, Codex App Server Protocol Hardening

## Scope

This audit verifies the final SWP-001 integration state after the protocol
hardening slices landed. It is a regression matrix and evidence record, not a
new feature expansion.

Source requirements:

- NIE-122 parent PRD decisions and out-of-scope list.
- NIE-128 approval allowlist.
- NIE-129 DynamicTool containment.
- NIE-130 lifecycle and payload generated-shape tests.
- NIE-131 telemetry signal normalization.
- NIE-132 fail-closed safety-sensitive server requests.
- NIE-133 Workspace Provisioning Boundary.
- NIE-134 runner/API evidence projection.
- `CONTEXT.md` glossary decisions for Codex App Server, Codex Runner,
  Effective Model, Linear Attachment Upload, and Workspace Provisioning
  Boundary.

## Validation Baseline

Commands run before this audit document was authored:

```bash
npm run check:codex-app-server-contract
npm test -- tests/codex/runner.test.ts tests/codex/dynamic-tools.test.ts tests/api/snapshot-service.test.ts tests/api/thread-diagnostics.test.ts tests/orchestrator/core.test.ts tests/workspace/workspace-manager.test.ts
```

Observed results:

- Contract drift harness: `PASS`, `groups=8`, `schema_definitions=39`,
  `ts_exports=39`, `method_discriminants=21`, `schema_refs=4`.
- Focused regression suite: `PASS`, 6 files, 285 tests.

## Integration Matrix

| Surface | Current source of truth | Regression evidence | Result |
| --- | --- | --- | --- |
| Generated-contract drift harness | `scripts/check-codex-app-server-contract.js`; `docs/analysis/codex-app-server-contract-drift-harness.md` | Harness covers approval/server-request, dynamic-tool, lifecycle, sandbox, token, rate-limit, warning, and model-reroute groups. Local run passed with 8 groups and 39 generated schema definitions. | Pass |
| Approval allowlist | `src/codex/runner.ts` `approvalResponse` exact method checks | `tests/codex/runner.test.ts`: allowlisted command/file/legacy approval methods receive method-specific decisions; unknown `approval/request` does not receive `{ approved: true }` and emits `unsupported_approval_server_request`. | Pass |
| Permission/auth/account fail-closed behavior | `src/codex/runner.ts` `unsupportedServerRequestClassification` | `tests/codex/runner.test.ts`: permission, auth, account token, and credential request methods return structured unsupported payloads, emit `codex.protocol.unsupported_request`, and terminate as `turn_input_required`. | Pass |
| DynamicTool containment | `src/codex/dynamic-tools.ts`; `src/codex/runner.ts` tool-call dispatch | `tests/codex/dynamic-tools.test.ts`: only `linear_graphql` is advertised; malformed args, missing auth, missing endpoint, and unsupported tool names return structured failures. `tests/codex/runner.test.ts` covers supported execution and capability mismatch events. | Pass |
| Lifecycle, sandbox, approval policy, resume, and cwd payloads | `src/codex/runner.ts`; generated contract fixture under `tests/fixtures/codex-app-server-contract/good` | `tests/codex/runner.test.ts`: startup sends `initialize`, `initialized`, `thread/start`, `turn/start`, and `thread/read`; generated payload checks cover `InitializeParams`, `ThreadStartParams`, `TurnStartParams`, `ThreadResumeParams`, and sandbox/approval fields. | Pass |
| Telemetry signal normalization | `src/codex/runner.ts` `UsageTracker`, rate-limit extraction, protocol warning extraction, model reroute extraction | `tests/codex/runner.test.ts`: generated token/rate-limit/warning/model-reroute notification shapes normalize into usage, `rate_limits`, `protocol_warnings`, `requested_model`, and `effective_model`; malformed fields preserve last valid state. | Pass |
| Runner events and operator/API projections | `src/orchestrator/core.ts`; `src/api/snapshot-service.ts`; `src/api/thread-diagnostics.ts`; `src/api/types.ts` | `tests/orchestrator/core.test.ts`, `tests/api/snapshot-service.test.ts`, and `tests/api/thread-diagnostics.test.ts`: unsupported requests, protocol warnings, rate limits, Effective Model, and dynamic-tool capability warnings survive runner callbacks into runtime snapshots and issue diagnostics. | Pass |
| Workspace Provisioning Boundary | `CONTEXT.md`; `SPEC.md` Section 9.6; `src/codex/runner.ts` cwd guards; workspace manager | `tests/codex/runner.test.ts`: local and remote cwd validation runs before app-server launch; recovery uses `thread/resume` plus recovery `turn/start` in the same provisioned cwd and never `thread/fork`. `tests/workspace/workspace-manager.test.ts` covers workspace ownership and containment. | Pass |
| Deferred app-server surfaces | NIE-122 out-of-scope list; `docs/analysis/codex-app-server-api-matrix.md` as broad surface inventory | Runtime only advertises `linear_graphql`; tests cover unsupported dynamic tools and unknown server requests. No plugin/app/marketplace, realtime, filesystem/process dynamic APIs, native review, or turn/steer implementation was added by SWP-001. | Pass |

## Scenario Matrix

| Scenario | Expected mode | Expected reason | Expected status | Evidence |
| --- | --- | --- | --- | --- |
| Primary path | App-server protocol sends supported lifecycle, approval, DynamicTool, and telemetry shapes | Codex Runner handles exact allowlisted methods and normalized notifications | Pass | `tests/codex/runner.test.ts` startup, approval, dynamic tool, telemetry, and projection handoff tests |
| Fallback path | `thread/start` with `dynamicTools` is rejected because the app-server requires experimental capability behavior | Runner retries `thread/start` without `dynamicTools` while preserving lifecycle payload requirements | Pass | `tests/codex/runner.test.ts` dynamicTools retry regression |
| Mismatch path | Generated app-server output drops a critical type, method discriminant, or schema ref | Contract drift harness fails with an actionable missing-shape line | Pass | `scripts/check-codex-app-server-contract.js`; local harness run passed current generated output |
| Validation-failure path | Unsupported approval, permission, auth, account, dynamic tool, or safety-sensitive request arrives | Runtime returns structured unsupported evidence and either continues only when safe or blocks as `turn_input_required` | Pass | `tests/codex/runner.test.ts`; `tests/codex/dynamic-tools.test.ts`; projection tests in API/orchestrator suites |

## Deferred Surfaces

The following remain explicitly deferred and should not be inferred as SWP-001
support:

- Plugin, app, and marketplace APIs.
- Realtime APIs.
- Filesystem and process APIs exposed through app-server dynamic behavior.
- Broad DynamicTool expansion beyond `linear_graphql`.
- Native review via `review/start`.
- Active operator steering via `turn/steer`.
- Full App Server Event Ledger persistence, Conversation Archive, and durable
  Project Execution History ingestion.

Existing broad inventory is in `docs/analysis/codex-app-server-api-matrix.md`.
That document is a surface inventory; this audit is the final SWP-001
acceptance record for implemented protocol hardening.

## Follow-Up Issues

No new follow-up issue was created from this audit. The remaining surfaces found
during review are already the explicit NIE-122 deferred scope or belong to later
Workflow Platform PRDs recorded in `CONTEXT.md`.

If a later ticket expands any deferred app-server surface, it must add its own
allowlist, generated-shape coverage, fail-closed behavior, and operator/API
projection evidence instead of relying on SWP-001's narrow hardening boundary.
