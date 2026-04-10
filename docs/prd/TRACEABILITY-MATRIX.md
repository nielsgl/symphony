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
| Polling orchestrator with single-authority state | PRD-001 | 17.4 | tick lifecycle logs |
| Tracker client candidate/state/terminal fetch | PRD-001 | 17.3 | tracker request/error metrics |
| Workspace manager with sanitized paths | PRD-003 | 17.2 | workspace safety checks in logs |
| Workspace lifecycle hooks | PRD-003 | 17.2 | hook start/fail/timeout logs |
| Hook timeout config | PRD-003 | 17.2 | hook duration telemetry |
| Codex app-server client JSON line protocol | PRD-004 | 17.5 | session protocol event logs |
| Codex launch command config | PRD-004 + PRD-002 | 17.1 + 17.5 | startup config diagnostics |
| Strict prompt rendering (`issue`, `attempt`) | PRD-002 | 17.1 | template render error logs |
| Exponential retry + continuation retry | PRD-001 | 17.4 | retry queue and reason logs |
| Retry backoff cap config | PRD-001 + PRD-002 | 17.4 | retry delay telemetry |
| Reconciliation stop on terminal/non-active states | PRD-001 | 17.4 | reconcile action logs |
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
