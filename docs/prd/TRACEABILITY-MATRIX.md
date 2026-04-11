# Symphony PRD Traceability Matrix

## Coverage Rule
Every Core Conformance item (SPEC 18.1) must map to:
- Owning PRD
- At least one acceptance test area (SPEC 17.x)
- At least one observability signal

## Matrix
| SPEC 18.1 Requirement | Owning PRD | Test Coverage Anchor | Observability Signal |
|---|---|---|---|
| Workflow path selection precedence | PRD-002 | 17.1 | startup validation log |
| WORKFLOW loader and prompt split | PRD-002 | 17.1 | workflow load/reload events |
| Typed config + defaults + `$` resolution | PRD-002 | 17.1 | config validation diagnostics |
| Dynamic workflow watch/reload/re-apply | PRD-002 | 17.1 | reload success/failure counters |
| Polling orchestrator with single-authority state | PRD-001 | `tests/orchestrator/core.test.ts` (`dispatches in priority->created_at->identifier order`, `tracks running and claimed bookkeeping on dispatch`) | tick lifecycle logs |
| Tracker client candidate/state/terminal fetch | PRD-001 | `tests/tracker/linear-adapter.test.ts` (`uses project slugId + active-state filter and preserves pagination order`, `issues state-refresh query with GraphQL [ID!] variable typing`, `returns empty for fetch_issues_by_states([]) without issuing API calls`) | tracker request/error metrics |
| Workspace manager with sanitized paths | PRD-003 | `tests/workspace/workspace-manager.test.ts` (`derives deterministic workspace key and path from issue identifier`, `replaces non-allowed identifier characters with underscore`, `fails fast when workspace path collides with non-directory entry`) | workspace safety checks in logs |
| Workspace lifecycle hooks | PRD-003 | `tests/workspace/workspace-manager.test.ts` (`enforces per-hook failure and timeout semantics`, `runs after_create hook only on new workspace creation`) | hook start/fail/timeout logs |
| Hook timeout config | PRD-003 | `tests/workspace/workspace-manager.test.ts` (`enforces per-hook failure and timeout semantics`) | hook duration telemetry |
| Codex app-server client JSON line protocol | PRD-004 | `tests/codex/runner.test.ts` (`launches with bash command/cwd and performs ordered startup handshake`, `supports continuation turns on the same thread within one process`, `accepts compatible payload variants for nested ids`, `maps process exit to port_exit`, `auto-approves approval requests and rejects unsupported tool calls without stalling`, `fails hard on user-input-required signals from compatible payload shapes`, `extracts usage/rate-limit telemetry from compatible payload variants`, `handles a bounded high-volume stream deterministically`) | session lifecycle logs (`session_started`, terminal reason), approval/tool policy logs, token/rate-limit extraction logs |
| Codex launch command config | PRD-004 + PRD-002 | 17.1 + 17.5 | startup config diagnostics |
| Strict prompt rendering (`issue`, `attempt`) | PRD-002 | 17.1 | template render error logs |
| Exponential retry + continuation retry | PRD-001 | `tests/orchestrator/core.test.ts` (`schedules continuation retry with attempt=1 and 1000ms delay on normal exit`, `schedules exponential failure retries with cap on abnormal exits`) | retry queue and reason logs |
| Retry backoff cap config | PRD-001 + PRD-002 | `tests/orchestrator/core.test.ts` (`schedules exponential failure retries with cap on abnormal exits`) | retry delay telemetry |
| Reconciliation stop on terminal/non-active states | PRD-001 | `tests/orchestrator/core.test.ts` (`stops running worker without cleanup when state becomes non-active and non-terminal`, `stops running worker with cleanup when state becomes terminal`) | reconcile action logs |
| Workspace cleanup on terminal issues | PRD-003 + PRD-001 | `tests/orchestrator/local-runner-bridge.test.ts` (`invokes workspace cleanup helper when terminateWorker requests cleanup`) + `tests/orchestrator/core.test.ts` (`stops running worker with cleanup when state becomes terminal`) | cleanup outcome logs |
| Structured logs with issue/session fields | PRD-005 | `tests/observability/logger.test.ts` (`renders stable key=value logs with context fields`, `continues logging when one sink fails and emits a sink warning`) + `tests/orchestrator/core.test.ts` (`aggregates worker event usage and turn counts deterministically`) | structured runtime logs (`worker_event`, `log_sink_failure`) with `issue_id`, `issue_identifier`, `session_id` context |
| Local API state/issue/refresh contracts with stable error envelope | PRD-005 | `tests/api/server.test.ts` (`serves GET /api/v1/state with required baseline fields`, `serves GET /api/v1/:issue_identifier projection and returns 404 for unknown issue`, `returns 405 for unsupported methods on defined routes`, `accepts refresh requests and coalesces bursts`, `serves embedded dashboard HTML at root path`, `returns failed health semantics for UI health banner rendering`) + `tests/api/snapshot-service.test.ts` (`projects orchestrator state into API state contract and includes active runtime seconds`, `projects failed health state and issue recent events for diagnostics`, `throws issue_not_found for unknown issue projection`) + `tests/api/refresh-coalescer.test.ts` (`coalesces burst requests into one manual refresh tick`, `schedules a later tick after the coalescing window has elapsed`) + `tests/runtime/bootstrap.test.ts` (`starts live runtime and serves orchestrator-backed state endpoint`, `maps refresh endpoint to orchestrator manual refresh tick`) + `tests/runtime/desktop-launcher.test.ts` (`parses dashboard startup URL from launcher output`, `builds backend launch config with explicit workflow path`) | loopback observability surface via `/`, `/api/v1/state`, `/api/v1/:issue_identifier`, `/api/v1/refresh` with typed error envelope and health semantics |

## Extension Tracking
| Extension Area | Owning PRD | Status |
|---|---|---|
| Required local HTTP API for product | PRD-005 | v1 required |
| Security profiles + minimal persistence | PRD-006 | v1 required product decision |
| GitHub Issues + PR metadata | PRD-007 | Phase 2 |
| Delivery roadmap and gates | PRD-008 | v1 required |

## Audit Checklist
- [x] All matrix rows have at least one concrete test implementation reference.
- [x] All matrix rows have at least one runtime/API observability output.
- [ ] No core requirement has multiple conflicting owners.
- [ ] Phase 2 rows do not weaken v1 core conformance obligations.
