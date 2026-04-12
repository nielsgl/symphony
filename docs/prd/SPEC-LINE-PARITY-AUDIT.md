# SPEC Line Parity Audit (P8)

Date: 2026-04-12
Owner role: orchestration planning
Audit scope: sentence/bullet unit parity between [SPEC.md](/Users/niels.van.Galen.last/code/symphony/SPEC.md) and the current codebase/tests/observability surfaces.

## Method
- Parsed SPEC into deterministic atomic units (every non-empty markdown content line under section context; headings and separators excluded).
- Unit ID scheme: `SPEC-<section>-<unit_index>`.
- Status classes per unit range: `implemented`, `partially_implemented`, `missing`, `not_applicable`.
- Strict triad rule for implemented claims: each mapped evidence profile provides at least one code anchor, one test anchor, and one runtime/observability anchor.

## Coverage Summary
- Total units classified: **1240**
- Section ranges classified: **81**
- Implemented ranges: **76**
- Partially implemented ranges: **0**
- Missing ranges: **0**
- Not applicable ranges: **5**

## Evidence Profiles (Triad Anchors)
| Profile | Code anchors | Test anchors | Runtime/observability anchors |
|---|---|---|---|
| EP-STACK | `src/index.ts`, `src/runtime/bootstrap.ts` | `tests/runtime/bootstrap.test.ts` | `runtime_started`/`runtime_stopped` logs + `/api/v1/state` |
| EP-WORKFLOW | `src/workflow/*` | `tests/workflow/*.test.ts` | workflow reload and dispatch-validation health via `/api/v1/state` |
| EP-ORCH | `src/orchestrator/*` | `tests/orchestrator/core.test.ts`, `tests/orchestrator/local-runner-bridge.test.ts` | orchestrator tick/retry/reconcile logs + `/api/v1/state` counters |
| EP-WORKSPACE | `src/workspace/manager.ts` | `tests/workspace/workspace-manager.test.ts` | workspace/hook log events + orchestrator cleanup outcomes |
| EP-CODEX | `src/codex/runner.ts`, `src/orchestrator/local-worker-runner.ts` | `tests/codex/runner.test.ts` | codex session/turn telemetry in state + structured logs |
| EP-TRACKER | `src/tracker/*.ts` | `tests/tracker/*.test.ts` | tracker request/error logs + state projection in orchestrator snapshots |
| EP-OBS | `src/observability/logger.ts`, `src/api/server.ts` | `tests/observability/logger.test.ts`, `tests/api/*.test.ts` | `/api/v1/*` endpoints + structured log sink events |
| EP-SECURITY | `src/security/*.ts`, `src/persistence/store.ts` | `tests/security/*.test.ts`, `tests/persistence/store.test.ts` | `security_profile_active` + `/api/v1/diagnostics` |
| EP-TESTMATRIX | Code paths referenced by Section 17 profiles | `tests/workflow`, `tests/workspace`, `tests/tracker`, `tests/orchestrator`, `tests/codex`, `tests/api` | test-validated API/log/state signals referenced in Section 13 and STATUS evidence |
| EP-CONFIG-PARITY | `src/workflow/resolver.ts`, `src/workflow/validator.ts`, `src/workflow/types.ts` | `tests/workflow/resolver.test.ts`, `tests/workflow/validator.test.ts` | startup validation + dispatch preflight health projection + config error envelopes |
| EP-DOMAIN-PARITY | `src/orchestrator/types.ts`, `src/orchestrator/core.ts`, `src/api/types.ts`, `src/api/snapshot-service.ts` | `tests/orchestrator/core.test.ts`, `tests/api/snapshot-service.test.ts`, `tests/api/server.test.ts` | session/thread/turn/pid parity fields in `/api/v1/state` and `/api/v1/:issue_identifier` projections |
| EP-TELEMETRY-PARITY | `src/codex/runner.ts`, `src/orchestrator/core.ts`, `src/runtime/bootstrap.ts` | `tests/codex/runner.test.ts`, `tests/orchestrator/core.test.ts`, `tests/api/snapshot-service.test.ts` | codex totals/rate-limit fields + humanized event summaries in state snapshot/logs |
| EP-HTTP-PARITY | `src/api/server.ts`, `src/runtime/bootstrap.ts`, `scripts/start-dashboard.js` | `tests/api/server.test.ts`, `tests/runtime/bootstrap.test.ts`, `tests/runtime/desktop-launcher.test.ts` | root dashboard + `/api/v1/state` + `/api/v1/refresh` + diagnostics endpoints |
| EP-FAILURE-PARITY | `src/workflow/*`, `src/orchestrator/core.ts`, `src/runtime/bootstrap.ts` | `tests/workflow/*.test.ts`, `tests/orchestrator/core.test.ts`, `tests/runtime/bootstrap.test.ts` | `dispatch_validation_failed`, `dispatch_validation_recovered`, `tracker_candidate_fetch_failed`, `tracker_state_refresh_failed`, `tracker_retry_fetch_failed`, `startup_orchestrator_state_initialized`, `startup_terminal_cleanup_completed` |
| EP-SECURITY-HARDENING | `src/security/profiles.ts`, `src/security/redaction.ts`, `src/workspace/manager.ts`, `src/runtime/bootstrap.ts` | `tests/security/profiles.test.ts`, `tests/security/redaction.test.ts`, `tests/workspace/workspace-manager.test.ts`, `tests/runtime/bootstrap.test.ts` | startup `security_profile_active` + `/api/v1/diagnostics.active_profile` + startup cleanup/state diagnostics markers |
| EP-REAL-INTEGRATION | `scripts/validate-real-integration-profile.js`, `docs/prd/P9B-REAL-INTEGRATION-PROFILE.md` | `tests/cli/integration-profile-script.test.ts` | deterministic `P9B_*` evidence markers and required-mode pass/fail semantics |
| EP-CONFORMANCE | Cross-cutting Section 18 claims over `src/orchestrator`, `src/workflow`, `src/codex`, `src/api`, `src/runtime` | Cross-cutting Section 17 profile tests + `tests/orchestrator/core.test.ts`, `tests/api/snapshot-service.test.ts`, `tests/workflow/resolver.test.ts`, `tests/workflow/validator.test.ts` | Cross-cutting API/log/state signals in Section 13 including `worker_event.event_summary`, `/api/v1/state.health.*`, and issue projection parity fields |

## Section Range Classification
| Section | Unit range | Unit count | Status | Evidence profile | Rationale | Backlog story |
|---|---|---:|---|---|---|---|
| 0 | SPEC-0-1..SPEC-0-2 | 2 | not_applicable | N/A | Document metadata only; not runtime behavior. | N/A |
| 1 | SPEC-1-1..SPEC-1-20 | 20 | not_applicable | N/A | Problem-context narrative; validated via design intent, not executable behavior. | N/A |
| 2.1 | SPEC-2.1-1..SPEC-2.1-8 | 8 | implemented | EP-ORCH | Triad satisfied via mapped evidence profile. | N/A |
| 2.2 | SPEC-2.2-1..SPEC-2.2-8 | 8 | not_applicable | N/A | Non-goal statements define excluded scope rather than required implementation behavior. | N/A |
| 3.1 | SPEC-3.1-1..SPEC-3.1-33 | 33 | implemented | EP-STACK | Triad satisfied via mapped evidence profile. | N/A |
| 3.2 | SPEC-3.2-1..SPEC-3.2-15 | 15 | implemented | EP-STACK | Triad satisfied via mapped evidence profile. | N/A |
| 3.3 | SPEC-3.3-1..SPEC-3.3-5 | 5 | implemented | EP-STACK | Triad satisfied via mapped evidence profile. | N/A |
| 4.1 | SPEC-4.1-1..SPEC-4.1-87 | 87 | implemented | EP-DOMAIN-PARITY | Triad satisfied via P9d domain-model field parity in runtime state and API projections. | N/A |
| 4.2 | SPEC-4.2-1..SPEC-4.2-11 | 11 | implemented | EP-ORCH | Triad satisfied via mapped evidence profile. | N/A |
| 5.1 | SPEC-5.1-1..SPEC-5.1-6 | 6 | implemented | EP-WORKFLOW | Triad satisfied via mapped evidence profile. | N/A |
| 5.2 | SPEC-5.2-1..SPEC-5.2-14 | 14 | implemented | EP-WORKFLOW | Triad satisfied via mapped evidence profile. | N/A |
| 5.3 | SPEC-5.3-1..SPEC-5.3-97 | 97 | implemented | EP-WORKFLOW | Triad satisfied via mapped evidence profile. | N/A |
| 5.4 | SPEC-5.4-1..SPEC-5.4-16 | 16 | implemented | EP-WORKFLOW | Triad satisfied via mapped evidence profile. | N/A |
| 5.5 | SPEC-5.5-1..SPEC-5.5-9 | 9 | implemented | EP-WORKFLOW | Triad satisfied via mapped evidence profile. | N/A |
| 6.1 | SPEC-6.1-1..SPEC-6.1-11 | 11 | implemented | EP-WORKFLOW | Triad satisfied via mapped evidence profile. | N/A |
| 6.2 | SPEC-6.2-1..SPEC-6.2-16 | 16 | implemented | EP-WORKFLOW | Triad satisfied via mapped evidence profile. | N/A |
| 6.3 | SPEC-6.3-1..SPEC-6.3-16 | 16 | implemented | EP-WORKFLOW | Triad satisfied via mapped evidence profile. | N/A |
| 6.4 | SPEC-6.4-1..SPEC-6.4-31 | 31 | implemented | EP-CONFIG-PARITY | Triad satisfied via config cheat-sheet parity closures for resolver/validator defaults and worker extension fields. | N/A |
| 7 | SPEC-7-1..SPEC-7-2 | 2 | implemented | EP-ORCH | Triad satisfied via mapped evidence profile. | N/A |
| 7.1 | SPEC-7.1-1..SPEC-7.1-26 | 26 | implemented | EP-ORCH | Triad satisfied via mapped evidence profile. | N/A |
| 7.2 | SPEC-7.2-1..SPEC-7.2-13 | 13 | implemented | EP-ORCH | Triad satisfied via mapped evidence profile. | N/A |
| 7.3 | SPEC-7.3-1..SPEC-7.3-22 | 22 | implemented | EP-ORCH | Triad satisfied via mapped evidence profile. | N/A |
| 7.4 | SPEC-7.4-1..SPEC-7.4-5 | 5 | implemented | EP-ORCH | Triad satisfied via mapped evidence profile. | N/A |
| 8.1 | SPEC-8.1-1..SPEC-8.1-12 | 12 | implemented | EP-ORCH | Triad satisfied via mapped evidence profile. | N/A |
| 8.2 | SPEC-8.2-1..SPEC-8.2-13 | 13 | implemented | EP-ORCH | Triad satisfied via mapped evidence profile. | N/A |
| 8.3 | SPEC-8.3-1..SPEC-8.3-10 | 10 | implemented | EP-ORCH | Triad satisfied via mapped evidence profile. | N/A |
| 8.4 | SPEC-8.4-1..SPEC-8.4-20 | 20 | implemented | EP-ORCH | Triad satisfied via mapped evidence profile. | N/A |
| 8.5 | SPEC-8.5-1..SPEC-8.5-14 | 14 | implemented | EP-ORCH | Triad satisfied via mapped evidence profile. | N/A |
| 8.6 | SPEC-8.6-1..SPEC-8.6-5 | 5 | implemented | EP-ORCH | Triad satisfied via mapped evidence profile. | N/A |
| 9.1 | SPEC-9.1-1..SPEC-9.1-8 | 8 | implemented | EP-WORKSPACE | Triad satisfied via mapped evidence profile. | N/A |
| 9.2 | SPEC-9.2-1..SPEC-9.2-12 | 12 | implemented | EP-WORKSPACE | Triad satisfied via mapped evidence profile. | N/A |
| 9.3 | SPEC-9.3-1..SPEC-9.3-9 | 9 | implemented | EP-WORKSPACE | Triad satisfied via mapped evidence profile. | N/A |
| 9.4 | SPEC-9.4-1..SPEC-9.4-17 | 17 | implemented | EP-WORKSPACE | Triad satisfied via mapped evidence profile. | N/A |
| 9.5 | SPEC-9.5-1..SPEC-9.5-11 | 11 | implemented | EP-WORKSPACE | Triad satisfied via mapped evidence profile. | N/A |
| 10 | SPEC-10-1..SPEC-10-9 | 9 | implemented | EP-CODEX | Triad satisfied via mapped evidence profile. | N/A |
| 10.1 | SPEC-10.1-1..SPEC-10.1-11 | 11 | implemented | EP-CODEX | Triad satisfied via mapped evidence profile. | N/A |
| 10.2 | SPEC-10.2-1..SPEC-10.2-34 | 34 | implemented | EP-CODEX | Triad satisfied via mapped evidence profile. | N/A |
| 10.3 | SPEC-10.3-1..SPEC-10.3-19 | 19 | implemented | EP-CODEX | Triad satisfied via mapped evidence profile. | N/A |
| 10.4 | SPEC-10.4-1..SPEC-10.4-20 | 20 | implemented | EP-CODEX | Triad satisfied via mapped evidence profile. | N/A |
| 10.5 | SPEC-10.5-1..SPEC-10.5-50 | 50 | implemented | EP-CODEX | Triad satisfied via mapped evidence profile. | N/A |
| 10.6 | SPEC-10.6-1..SPEC-10.6-14 | 14 | implemented | EP-CODEX | Triad satisfied via mapped evidence profile. | N/A |
| 10.7 | SPEC-10.7-1..SPEC-10.7-9 | 9 | implemented | EP-CODEX | Triad satisfied via mapped evidence profile. | N/A |
| 11.1 | SPEC-11.1-1..SPEC-11.1-7 | 7 | implemented | EP-TRACKER | Triad satisfied via mapped evidence profile. | N/A |
| 11.2 | SPEC-11.2-1..SPEC-11.2-15 | 15 | implemented | EP-TRACKER | Triad satisfied via mapped evidence profile. | N/A |
| 11.3 | SPEC-11.3-1..SPEC-11.3-6 | 6 | implemented | EP-TRACKER | Triad satisfied via mapped evidence profile. | N/A |
| 11.4 | SPEC-11.4-1..SPEC-11.4-13 | 13 | implemented | EP-TRACKER | Triad satisfied via mapped evidence profile. | N/A |
| 11.5 | SPEC-11.5-1..SPEC-11.5-8 | 8 | implemented | EP-TRACKER | Triad satisfied via mapped evidence profile. | N/A |
| 12.1 | SPEC-12.1-1..SPEC-12.1-4 | 4 | implemented | EP-WORKFLOW | Triad satisfied via mapped evidence profile. | N/A |
| 12.2 | SPEC-12.2-1..SPEC-12.2-4 | 4 | implemented | EP-WORKFLOW | Triad satisfied via mapped evidence profile. | N/A |
| 12.3 | SPEC-12.3-1..SPEC-12.3-5 | 5 | implemented | EP-WORKFLOW | Triad satisfied via mapped evidence profile. | N/A |
| 12.4 | SPEC-12.4-1..SPEC-12.4-3 | 3 | implemented | EP-WORKFLOW | Triad satisfied via mapped evidence profile. | N/A |
| 13.1 | SPEC-13.1-1..SPEC-13.1-10 | 10 | implemented | EP-OBS | Triad satisfied via mapped evidence profile. | N/A |
| 13.2 | SPEC-13.2-1..SPEC-13.2-6 | 6 | implemented | EP-OBS | Triad satisfied via mapped evidence profile. | N/A |
| 13.3 | SPEC-13.3-1..SPEC-13.3-14 | 14 | implemented | EP-OBS | Triad satisfied via mapped evidence profile. | N/A |
| 13.4 | SPEC-13.4-1..SPEC-13.4-4 | 4 | implemented | EP-OBS | Triad satisfied via mapped evidence profile. | N/A |
| 13.5 | SPEC-13.5-1..SPEC-13.5-23 | 23 | implemented | EP-TELEMETRY-PARITY | Triad satisfied via deterministic token/rate-limit accounting and API projection parity assertions. | N/A |
| 13.6 | SPEC-13.6-1..SPEC-13.6-4 | 4 | implemented | EP-TELEMETRY-PARITY | Triad satisfied via optional humanized event summaries implemented as observability-only output. | N/A |
| 13.7 | SPEC-13.7-1..SPEC-13.7-48 | 48 | implemented | EP-HTTP-PARITY | Triad satisfied via CLI/runtime HTTP control updates and deterministic tests/logging evidence. | N/A |
| 14.1 | SPEC-14.1-1..SPEC-14.1-26 | 26 | implemented | EP-FAILURE-PARITY | Triad satisfied via deterministic failure-class tests and explicit failure markers across dispatch/retry/reconciliation paths. | N/A |
| 14.2 | SPEC-14.2-1..SPEC-14.2-14 | 14 | implemented | EP-FAILURE-PARITY | Triad satisfied via deterministic recovery-transition assertions and retry/reconcile failure handling signals. | N/A |
| 14.3 | SPEC-14.3-1..SPEC-14.3-8 | 8 | implemented | EP-FAILURE-PARITY | Triad satisfied via startup cold-state initialization diagnostics and startup terminal cleanup completion evidence. | N/A |
| 14.4 | SPEC-14.4-1..SPEC-14.4-8 | 8 | implemented | EP-FAILURE-PARITY | Triad satisfied via operator-facing dispatch/recovery/startup diagnostics plus existing workflow/state intervention contracts. | N/A |
| 15.1 | SPEC-15.1-1..SPEC-15.1-8 | 8 | implemented | EP-SECURITY | Triad satisfied via mapped evidence profile. | N/A |
| 15.2 | SPEC-15.2-1..SPEC-15.2-8 | 8 | implemented | EP-SECURITY | Triad satisfied via mapped evidence profile. | N/A |
| 15.3 | SPEC-15.3-1..SPEC-15.3-3 | 3 | implemented | EP-SECURITY | Triad satisfied via mapped evidence profile. | N/A |
| 15.4 | SPEC-15.4-1..SPEC-15.4-6 | 6 | implemented | EP-SECURITY | Triad satisfied via mapped evidence profile. | N/A |
| 15.5 | SPEC-15.5-1..SPEC-15.5-21 | 21 | implemented | EP-SECURITY-HARDENING | Triad satisfied via explicit hardening posture diagnostics, secret-redaction coverage, workspace safety invariants, and deterministic startup hardening signals. | N/A |
| 17 | SPEC-17-1..SPEC-17-10 | 10 | not_applicable | N/A | Section preface only; concrete requirements are in 17.1-17.8. | N/A |
| 17.1 | SPEC-17.1-1..SPEC-17.1-18 | 18 | implemented | EP-TESTMATRIX | Triad satisfied via mapped evidence profile. | N/A |
| 17.2 | SPEC-17.2-1..SPEC-17.2-13 | 13 | implemented | EP-TESTMATRIX | Triad satisfied via mapped evidence profile. | N/A |
| 17.3 | SPEC-17.3-1..SPEC-17.3-9 | 9 | implemented | EP-TESTMATRIX | Triad satisfied via mapped evidence profile. | N/A |
| 17.4 | SPEC-17.4-1..SPEC-17.4-16 | 16 | implemented | EP-TESTMATRIX | Triad satisfied via mapped evidence profile. | N/A |
| 17.5 | SPEC-17.5-1..SPEC-17.5-26 | 26 | implemented | EP-TESTMATRIX | Triad satisfied via mapped evidence profile. | N/A |
| 17.6 | SPEC-17.6-1..SPEC-17.6-8 | 8 | implemented | EP-TESTMATRIX | Triad satisfied via mapped evidence profile. | N/A |
| 17.7 | SPEC-17.7-1..SPEC-17.7-6 | 6 | implemented | EP-TESTMATRIX | Triad satisfied via positional workflow-path support, lifecycle semantics coverage, and startup diagnostics evidence. | N/A |
| 17.8 | SPEC-17.8-1..SPEC-17.8-9 | 9 | implemented | EP-REAL-INTEGRATION | Triad satisfied via explicit real-integration profile commands, deterministic skip/fail markers, and required-mode gating behavior. | N/A |
| 18 | SPEC-18-1..SPEC-18-4 | 4 | implemented | EP-CONFORMANCE | Triad satisfied via explicit checklist crosswalk anchored by P9d code/test/observability closures. | N/A |
| 18.1 | SPEC-18.1-1..SPEC-18.1-18 | 18 | implemented | EP-CONFORMANCE | Triad satisfied via explicit owner/test/observability mappings in traceability matrix and updated conformance anchors. | N/A |
| 18.2 | SPEC-18.2-1..SPEC-18.2-10 | 10 | implemented | EP-CONFORMANCE | Triad satisfied via explicit extension mapping/evidence anchors and operator-visible observability contracts. | N/A |
| 18.3 | SPEC-18.3-1..SPEC-18.3-4 | 4 | implemented | EP-REAL-INTEGRATION | Triad satisfied via operational validation command set and evidence markers covering hooks, workflow path resolution, and optional HTTP checks. | N/A |
| A.A | SPEC-A.A-1..SPEC-A.A-43 | 43 | not_applicable | N/A | Optional SSH extension appendix; explicitly outside core conformance scope. | N/A |

## Backlog Extraction (Historical)
| Story ID | Subsystem bundle | SPEC unit ranges | Gap statement | Acceptance criteria | Required test anchors | Required observability signals |
|---|---|---|---|---|---|---|
| P9a | CLI/host lifecycle + HTTP control parity | SPEC-13.7-1..SPEC-13.7-48, SPEC-17.7-1..SPEC-17.7-6 | CLI workflow-path and server-port precedence/lifecycle expectations are not fully covered end-to-end. | Implement and validate CLI lifecycle semantics from Section 17.7 and HTTP extension precedence behaviors required by Section 13.7 contracts. | `tests/runtime/bootstrap.test.ts`, new `tests/cli/*.test.ts`, `tests/api/server.test.ts` | startup argument resolution logs, bind/port diagnostics, `/api/v1/state` health consistency |
| P9d | Domain/config/telemetry conformance closure | SPEC-4.1-1..SPEC-4.1-87, SPEC-6.4-1..SPEC-6.4-31, SPEC-13.5-1..SPEC-13.5-23, SPEC-13.6-1..SPEC-13.6-4, SPEC-18-1..SPEC-18-4, SPEC-18.1-1..SPEC-18.1-18, SPEC-18.2-1..SPEC-18.2-10 | Closed in P9d with strict triad evidence. | Implemented and validated with deterministic tests and updated conformance/traceability anchors. | `tests/api/snapshot-service.test.ts`, `tests/api/server.test.ts`, `tests/codex/runner.test.ts`, `tests/orchestrator/core.test.ts`, `tests/workflow/resolver.test.ts`, `tests/workflow/validator.test.ts` | API schema parity snapshots, structured `worker_event` summaries, token/session telemetry parity output |

## Completeness Checks
- All extracted unit ranges are classified exactly once.
- No `missing` or `partially_implemented` ranges remain.
- No backlog story exists without linked `SPEC-*` ranges.
