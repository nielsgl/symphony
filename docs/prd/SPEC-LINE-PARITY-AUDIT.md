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
- Implemented ranges: **62**
- Partially implemented ranges: **12**
- Missing ranges: **2**
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
| EP-CONFIG-PARITY | `src/workflow/resolver.ts`, `src/workflow/validator.ts` | `tests/workflow/resolver.test.ts`, `tests/workflow/validator.test.ts` | startup validation + dispatch preflight health projection |
| EP-DOMAIN-PARITY | `src/orchestrator/types.ts`, `src/api/types.ts`, `src/api/snapshot-service.ts` | `tests/orchestrator/core.test.ts`, `tests/api/snapshot-service.test.ts` | token/session fields in `/api/v1/state` and issue projections |
| EP-TELEMETRY-PARITY | `src/codex/runner.ts`, `src/orchestrator/core.ts` | `tests/codex/runner.test.ts`, `tests/orchestrator/core.test.ts` | codex totals/rate-limit fields in state snapshot |
| EP-HTTP-PARITY | `src/api/server.ts`, `src/runtime/bootstrap.ts`, `scripts/start-dashboard.js` | `tests/api/server.test.ts`, `tests/runtime/bootstrap.test.ts`, `tests/runtime/desktop-launcher.test.ts` | root dashboard + `/api/v1/state` + `/api/v1/refresh` + diagnostics endpoints |
| EP-FAILURE-PARITY | `src/workflow/*`, `src/orchestrator/core.ts`, `src/runtime/bootstrap.ts` | `tests/workflow/*.test.ts`, `tests/orchestrator/core.test.ts`, `tests/runtime/bootstrap.test.ts` | failed-dispatch health, retry logs, and startup/runtime warning logs |
| EP-SECURITY-HARDENING | `src/security/redaction.ts`, `src-tauri/src/main.rs`, `src/api/dashboard-assets.ts` | `tests/security/redaction.test.ts`, desktop smoke tests | CSP/sanitization/host-hardening observability currently incomplete for full spec guidance |
| EP-INTEGRATION-GAP | N/A | N/A | N/A |
| EP-CONFORMANCE | Cross-cutting Section 18 claims over core modules | Cross-cutting Section 17 profile tests | Cross-cutting API/log/state signals in Section 13 |

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
| 4.1 | SPEC-4.1-1..SPEC-4.1-87 | 87 | partially_implemented | EP-DOMAIN-PARITY | Partial triad: at least one required evidence anchor class is incomplete. | P9d |
| 4.2 | SPEC-4.2-1..SPEC-4.2-11 | 11 | implemented | EP-ORCH | Triad satisfied via mapped evidence profile. | N/A |
| 5.1 | SPEC-5.1-1..SPEC-5.1-6 | 6 | implemented | EP-WORKFLOW | Triad satisfied via mapped evidence profile. | N/A |
| 5.2 | SPEC-5.2-1..SPEC-5.2-14 | 14 | implemented | EP-WORKFLOW | Triad satisfied via mapped evidence profile. | N/A |
| 5.3 | SPEC-5.3-1..SPEC-5.3-97 | 97 | implemented | EP-WORKFLOW | Triad satisfied via mapped evidence profile. | N/A |
| 5.4 | SPEC-5.4-1..SPEC-5.4-16 | 16 | implemented | EP-WORKFLOW | Triad satisfied via mapped evidence profile. | N/A |
| 5.5 | SPEC-5.5-1..SPEC-5.5-9 | 9 | implemented | EP-WORKFLOW | Triad satisfied via mapped evidence profile. | N/A |
| 6.1 | SPEC-6.1-1..SPEC-6.1-11 | 11 | implemented | EP-WORKFLOW | Triad satisfied via mapped evidence profile. | N/A |
| 6.2 | SPEC-6.2-1..SPEC-6.2-16 | 16 | implemented | EP-WORKFLOW | Triad satisfied via mapped evidence profile. | N/A |
| 6.3 | SPEC-6.3-1..SPEC-6.3-16 | 16 | implemented | EP-WORKFLOW | Triad satisfied via mapped evidence profile. | N/A |
| 6.4 | SPEC-6.4-1..SPEC-6.4-31 | 31 | partially_implemented | EP-CONFIG-PARITY | Partial triad: at least one required evidence anchor class is incomplete. | P9d |
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
| 13.5 | SPEC-13.5-1..SPEC-13.5-23 | 23 | partially_implemented | EP-TELEMETRY-PARITY | Partial triad: at least one required evidence anchor class is incomplete. | P9d |
| 13.6 | SPEC-13.6-1..SPEC-13.6-4 | 4 | partially_implemented | EP-TELEMETRY-PARITY | Partial triad: at least one required evidence anchor class is incomplete. | P9d |
| 13.7 | SPEC-13.7-1..SPEC-13.7-48 | 48 | implemented | EP-HTTP-PARITY | Triad satisfied via CLI/runtime HTTP control updates and deterministic tests/logging evidence. | N/A |
| 14.1 | SPEC-14.1-1..SPEC-14.1-26 | 26 | partially_implemented | EP-FAILURE-PARITY | Partial triad: at least one required evidence anchor class is incomplete. | P9c |
| 14.2 | SPEC-14.2-1..SPEC-14.2-14 | 14 | partially_implemented | EP-FAILURE-PARITY | Partial triad: at least one required evidence anchor class is incomplete. | P9c |
| 14.3 | SPEC-14.3-1..SPEC-14.3-8 | 8 | partially_implemented | EP-FAILURE-PARITY | Partial triad: at least one required evidence anchor class is incomplete. | P9c |
| 14.4 | SPEC-14.4-1..SPEC-14.4-8 | 8 | partially_implemented | EP-FAILURE-PARITY | Partial triad: at least one required evidence anchor class is incomplete. | P9c |
| 15.1 | SPEC-15.1-1..SPEC-15.1-8 | 8 | implemented | EP-SECURITY | Triad satisfied via mapped evidence profile. | N/A |
| 15.2 | SPEC-15.2-1..SPEC-15.2-8 | 8 | implemented | EP-SECURITY | Triad satisfied via mapped evidence profile. | N/A |
| 15.3 | SPEC-15.3-1..SPEC-15.3-3 | 3 | implemented | EP-SECURITY | Triad satisfied via mapped evidence profile. | N/A |
| 15.4 | SPEC-15.4-1..SPEC-15.4-6 | 6 | implemented | EP-SECURITY | Triad satisfied via mapped evidence profile. | N/A |
| 15.5 | SPEC-15.5-1..SPEC-15.5-21 | 21 | partially_implemented | EP-SECURITY-HARDENING | Partial triad: at least one required evidence anchor class is incomplete. | P9c |
| 17 | SPEC-17-1..SPEC-17-10 | 10 | not_applicable | N/A | Section preface only; concrete requirements are in 17.1-17.8. | N/A |
| 17.1 | SPEC-17.1-1..SPEC-17.1-18 | 18 | implemented | EP-TESTMATRIX | Triad satisfied via mapped evidence profile. | N/A |
| 17.2 | SPEC-17.2-1..SPEC-17.2-13 | 13 | implemented | EP-TESTMATRIX | Triad satisfied via mapped evidence profile. | N/A |
| 17.3 | SPEC-17.3-1..SPEC-17.3-9 | 9 | implemented | EP-TESTMATRIX | Triad satisfied via mapped evidence profile. | N/A |
| 17.4 | SPEC-17.4-1..SPEC-17.4-16 | 16 | implemented | EP-TESTMATRIX | Triad satisfied via mapped evidence profile. | N/A |
| 17.5 | SPEC-17.5-1..SPEC-17.5-26 | 26 | implemented | EP-TESTMATRIX | Triad satisfied via mapped evidence profile. | N/A |
| 17.6 | SPEC-17.6-1..SPEC-17.6-8 | 8 | implemented | EP-TESTMATRIX | Triad satisfied via mapped evidence profile. | N/A |
| 17.7 | SPEC-17.7-1..SPEC-17.7-6 | 6 | implemented | EP-TESTMATRIX | Triad satisfied via positional workflow-path support, lifecycle semantics coverage, and startup diagnostics evidence. | N/A |
| 17.8 | SPEC-17.8-1..SPEC-17.8-9 | 9 | missing | EP-INTEGRATION-GAP | No acceptable triad currently exists for this unit range. | P9b |
| 18 | SPEC-18-1..SPEC-18-4 | 4 | partially_implemented | EP-CONFORMANCE | Partial triad: at least one required evidence anchor class is incomplete. | P9d |
| 18.1 | SPEC-18.1-1..SPEC-18.1-18 | 18 | partially_implemented | EP-CONFORMANCE | Partial triad: at least one required evidence anchor class is incomplete. | P9d |
| 18.2 | SPEC-18.2-1..SPEC-18.2-10 | 10 | partially_implemented | EP-CONFORMANCE | Partial triad: at least one required evidence anchor class is incomplete. | P9d |
| 18.3 | SPEC-18.3-1..SPEC-18.3-4 | 4 | missing | EP-INTEGRATION-GAP | No acceptable triad currently exists for this unit range. | P9b |
| A.A | SPEC-A.A-1..SPEC-A.A-43 | 43 | not_applicable | N/A | Optional SSH extension appendix; explicitly outside core conformance scope. | N/A |

## Backlog Extraction (All Missing/Partial Units Mapped)
| Story ID | Subsystem bundle | SPEC unit ranges | Gap statement | Acceptance criteria | Required test anchors | Required observability signals |
|---|---|---|---|---|---|---|
| P9a | CLI/host lifecycle + HTTP control parity | SPEC-13.7-1..SPEC-13.7-48, SPEC-17.7-1..SPEC-17.7-6 | CLI workflow-path and server-port precedence/lifecycle expectations are not fully covered end-to-end. | Implement and validate CLI lifecycle semantics from Section 17.7 and HTTP extension precedence behaviors required by Section 13.7 contracts. | `tests/runtime/bootstrap.test.ts`, new `tests/cli/*.test.ts`, `tests/api/server.test.ts` | startup argument resolution logs, bind/port diagnostics, `/api/v1/state` health consistency |
| P9b | Real integration and operational validation profile | SPEC-17.8-1..SPEC-17.8-9, SPEC-18.3-1..SPEC-18.3-4 | Production-recommended real integration profile is not codified as executable validation artifacts. | Add documented repeatable integration profile evidence and gate artifacts for tracker+agent credentials, networked runs, and restart/cleanup verification. | integration profile harness (new), smoke/e2e scripts | runbook-linked evidence logs, soak summary artifacts, integration gate report |
| P9c | Failure-model/security hardening closure | SPEC-14.1-1..SPEC-14.1-26, SPEC-14.2-1..SPEC-14.2-14, SPEC-14.3-1..SPEC-14.3-8, SPEC-14.4-1..SPEC-14.4-8, SPEC-15.5-1..SPEC-15.5-21 | Failure-class and hardening guidance are only partially represented in deterministic checks and operator controls. | Close explicit failure-injection coverage and hardening controls per sections 14.x/15.5 without regressing current runtime behavior. | `tests/orchestrator/core.test.ts`, `tests/runtime/bootstrap.test.ts`, new failure-injection tests | failure-class specific logs, hardened-mode diagnostics, policy-violation counters |
| P9d | Domain/config/telemetry conformance closure | SPEC-4.1-1..SPEC-4.1-87, SPEC-6.4-1..SPEC-6.4-31, SPEC-13.5-1..SPEC-13.5-23, SPEC-13.6-1..SPEC-13.6-4, SPEC-18-1..SPEC-18-4, SPEC-18.1-1..SPEC-18.1-18, SPEC-18.2-1..SPEC-18.2-10 | Some domain-model fields, config cheat-sheet claims, token/session summary details, and checklist-level conformance statements still require strict parity closure. | Provide explicit parity matrix updates and targeted implementation/test deltas to satisfy all Section 18 core conformance assertions at sentence-level fidelity. | `tests/api/snapshot-service.test.ts`, `tests/codex/runner.test.ts`, `tests/workflow/resolver.test.ts`, `tests/workflow/validator.test.ts` | API schema parity snapshots, token/session telemetry parity output, conformance gate report |

## Completeness Checks
- All extracted unit ranges are classified exactly once.
- Every `missing` or `partially_implemented` range is mapped to exactly one backlog story.
- No backlog story exists without linked `SPEC-*` ranges.
