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
| Workspace manager with sanitized paths | PRD-003 | 17.2 | workspace safety checks in logs |
| Workspace lifecycle hooks | PRD-003 | 17.2 | hook start/fail/timeout logs |
| Hook timeout config | PRD-003 | 17.2 | hook duration telemetry |
| Codex app-server client JSON line protocol | PRD-004 | 17.5 | session protocol event logs |
| Codex launch command config | PRD-004 + PRD-002 | 17.1 + 17.5 | startup config diagnostics |
| Strict prompt rendering (`issue`, `attempt`) | PRD-002 | 17.1 | template render error logs |
| Exponential retry + continuation retry | PRD-001 | `tests/orchestrator/core.test.ts` (`schedules continuation retry with attempt=1 and 1000ms delay on normal exit`, `schedules exponential failure retries with cap on abnormal exits`) | retry queue and reason logs |
| Retry backoff cap config | PRD-001 + PRD-002 | `tests/orchestrator/core.test.ts` (`schedules exponential failure retries with cap on abnormal exits`) | retry delay telemetry |
| Reconciliation stop on terminal/non-active states | PRD-001 | `tests/orchestrator/core.test.ts` (`stops running worker without cleanup when state becomes non-active and non-terminal`, `stops running worker with cleanup when state becomes terminal`) | reconcile action logs |
| Workspace cleanup on terminal issues | PRD-003 + PRD-001 | 17.2 + 17.4 | cleanup outcome logs |
| Structured logs with issue/session fields | PRD-005 | 17.6 | log schema checks |
| Operator-visible observability | PRD-005 | 17.6 | local dashboard + `/api/v1/state` |

## Extension Tracking
| Extension Area | Owning PRD | Status |
|---|---|---|
| Required local HTTP API for product | PRD-005 | v1 required |
| Security profiles + minimal persistence | PRD-006 | v1 required product decision |
| GitHub Issues + PR metadata | PRD-007 | Phase 2 |
| Delivery roadmap and gates | PRD-008 | v1 required |

## Audit Checklist
- [ ] All matrix rows have at least one concrete test implementation reference.
- [ ] All matrix rows have at least one runtime/API observability output.
- [ ] No core requirement has multiple conflicting owners.
- [ ] Phase 2 rows do not weaken v1 core conformance obligations.
