# Symphony PRD Traceability Matrix

## Coverage Rule
Every Core Conformance item (SPEC 18.1) must map to:
- Owning PRD
- At least one acceptance test area (SPEC 17.x)
- At least one observability signal

## Matrix
| SPEC 18.1 Requirement | Owning PRD | Accountable owner role | Test Coverage Anchor | Observability Signal |
|---|---|---|---|---|
| Workflow path selection precedence | PRD-002 | orchestration planning | `tests/workflow/loader.test.ts` (`prefers explicit path over cwd default`, `uses WORKFLOW.md in cwd by default`) | `/api/v1/state` health projection (`health.dispatch_validation`, `health.last_error`) + startup warning event (`runtime_startup_validation_bypassed`) |
| WORKFLOW loader and prompt split | PRD-002 | orchestration planning | `tests/workflow/loader.test.ts` (`parses YAML front matter and prompt body`, `supports files without YAML front matter`) | `/api/v1/state` health projection (`health.dispatch_validation`, `health.last_error`) + startup warning event (`runtime_startup_validation_bypassed`) |
| Typed config + defaults + `$` resolution | PRD-002 | orchestration planning | `tests/workflow/resolver.test.ts` (`applies defaults when optional fields are absent`, `resolves $VAR for tracker.api_key and workspace.root`, `expands ~ for path-intended fields`) | `/api/v1/state` health projection (`health.dispatch_validation`, `health.last_error`) + startup warning event (`runtime_startup_validation_bypassed`) |
| Dynamic workflow watch/reload/re-apply | PRD-002 | orchestration planning | `tests/workflow/watcher.test.ts` (`loads startup config and emits version hash`) | `/api/v1/state` health projection (`health.dispatch_validation`, `health.last_error`) + startup warning event (`runtime_startup_validation_bypassed`) |
| Polling orchestrator with single-authority state | PRD-001 | orchestration planning | `tests/orchestrator/core.test.ts` (`dispatches in priority->created_at->identifier order`, `tracks running and claimed bookkeeping on dispatch`) | tick lifecycle logs |
| Tracker client candidate/state/terminal fetch | PRD-001 | orchestration planning | `tests/tracker/linear-adapter.test.ts` (`uses project slugId + active-state filter and preserves pagination order`, `issues state-refresh query with GraphQL [ID!] variable typing`, `returns empty for fetch_issues_by_states([]) without issuing API calls`) | tracker request/error metrics |
| Workspace manager with sanitized paths | PRD-003 | orchestration planning | `tests/workspace/workspace-manager.test.ts` (`derives deterministic workspace key and path from issue identifier`, `replaces non-allowed identifier characters with underscore`, `fails fast when workspace path collides with non-directory entry`) | workspace safety checks in logs |
| Workspace lifecycle hooks | PRD-003 | orchestration planning | `tests/workspace/workspace-manager.test.ts` (`enforces per-hook failure and timeout semantics`, `runs after_create hook only on new workspace creation`) | hook start/fail/timeout logs |
| Hook timeout config | PRD-003 | orchestration planning | `tests/workspace/workspace-manager.test.ts` (`enforces per-hook failure and timeout semantics`) | hook duration telemetry |
| Codex app-server client JSON line protocol | PRD-004 | orchestration planning | `tests/codex/runner.test.ts` (`launches with bash command/cwd and performs ordered startup handshake`, `supports continuation turns on the same thread within one process`, `accepts compatible payload variants for nested ids`, `maps process exit to port_exit`, `auto-approves approval requests and rejects unsupported tool calls without stalling`, `fails hard on user-input-required signals from compatible payload shapes`, `extracts usage/rate-limit telemetry from compatible payload variants`, `handles a bounded high-volume stream deterministically`) | session lifecycle logs (`session_started`, terminal reason), approval/tool policy logs, token/rate-limit extraction logs |
| Codex launch command config | PRD-004 + PRD-002 | orchestration planning | `tests/workflow/resolver.test.ts` (`preserves codex.command as a shell command string`) + `tests/codex/runner.test.ts` (`launches with bash command/cwd and performs ordered startup handshake`) | `/api/v1/state` health projection (`health.dispatch_validation`, `health.last_error`) + startup warning event (`runtime_startup_validation_bypassed`) |
| Strict prompt rendering (`issue`, `attempt`) | PRD-002 | orchestration planning | `tests/workflow/template-engine.test.ts` (`fails render on unknown variable in strict mode`, `fails compile for invalid template syntax`) | `/api/v1/state` health projection (`health.dispatch_validation`, `health.last_error`) |
| Exponential retry + continuation retry | PRD-001 | orchestration planning | `tests/orchestrator/core.test.ts` (`schedules continuation retry with attempt=1 and 1000ms delay on normal exit`, `schedules exponential failure retries with cap on abnormal exits`) | retry queue and reason logs |
| Retry backoff cap config | PRD-001 + PRD-002 | orchestration planning | `tests/orchestrator/core.test.ts` (`schedules exponential failure retries with cap on abnormal exits`) | retry delay telemetry |
| Reconciliation stop on terminal/non-active states | PRD-001 | orchestration planning | `tests/orchestrator/core.test.ts` (`stops running worker without cleanup when state becomes non-active and non-terminal`, `stops running worker with cleanup when state becomes terminal`) | reconcile action logs |
| Workspace cleanup on terminal issues | PRD-003 + PRD-001 | orchestration planning | `tests/orchestrator/local-runner-bridge.test.ts` (`invokes workspace cleanup helper when terminateWorker requests cleanup`) + `tests/orchestrator/core.test.ts` (`stops running worker with cleanup when state becomes terminal`) | cleanup outcome logs |
| Structured logs with issue/session fields | PRD-005 | orchestration planning | `tests/observability/logger.test.ts` (`renders stable key=value logs with context fields`, `continues logging when one sink fails and emits a sink warning`) + `tests/orchestrator/core.test.ts` (`aggregates worker event usage and turn counts deterministically`) | structured runtime logs (`worker_event`, `log_sink_failure`) with `issue_id`, `issue_identifier`, `session_id` context |
| Local API state/issue/refresh contracts with stable error envelope | PRD-005 | orchestration planning | `tests/api/server.test.ts` (`serves GET /api/v1/state with required baseline fields`, `serves GET /api/v1/:issue_identifier projection and returns 404 for unknown issue`, `returns 405 for unsupported methods on defined routes`, `accepts refresh requests and coalesces bursts`, `serves embedded dashboard HTML at root path`, `returns failed health semantics for UI health banner rendering`) + `tests/api/snapshot-service.test.ts` (`projects orchestrator state into API state contract and includes active runtime seconds`, `projects failed health state and issue recent events for diagnostics`, `throws issue_not_found for unknown issue projection`) + `tests/api/refresh-coalescer.test.ts` (`coalesces burst requests into one manual refresh tick`, `schedules a later tick after the coalescing window has elapsed`) + `tests/runtime/bootstrap.test.ts` (`starts live runtime and serves orchestrator-backed state endpoint`, `maps refresh endpoint to orchestrator manual refresh tick`) + `tests/runtime/desktop-launcher.test.ts` (`parses dashboard startup URL from launcher output`, `builds backend launch config with explicit workflow path`) | loopback observability surface via `/`, `/api/v1/state`, `/api/v1/:issue_identifier`, `/api/v1/refresh` with typed error envelope and health semantics |
| Security profile precedence + active profile diagnostics | PRD-006 | orchestration planning | `tests/security/profiles.test.ts` (`uses balanced safe defaults when workflow does not override`, `applies workflow overrides on top of defaults`) + `tests/runtime/bootstrap.test.ts` (`exposes diagnostics profile and persistence status endpoints`) + `tests/workflow/validator.test.ts` (`rejects unsupported codex approval policy values`) | startup `security_profile_active` log + `/api/v1/diagnostics` active profile payload |
| Secret redaction for logs/API/persistence outputs | PRD-006 | orchestration planning | `tests/security/redaction.test.ts` (`redacts sensitive context keys and inline message secrets`, `recursively redacts nested API/persistence payloads`) + `tests/observability/logger.test.ts` (`redacts secrets in message and context`) | redacted structured logs + redacted API envelopes/payloads |
| Minimal durable persistence + restart continuity + retention/integrity | PRD-006 | orchestration planning | `tests/persistence/store.test.ts` (`persists append-only run/session history across restart`, `persists UI continuity state`, `applies retention pruning and reports integrity`) + `tests/runtime/bootstrap.test.ts` (`restores durable history on restart without restoring running or retry state`) | `/api/v1/history`, `/api/v1/ui-state`, `/api/v1/diagnostics` persistence health (`integrity_ok`, `retention_days`, `run_count`) |

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
- [x] No core requirement has multiple conflicting owners.
  Evidence: every SPEC 18.1 core row has one accountable owner role
  (`orchestration planning`) with no conflicting owner assignments.
- [x] Phase 2 rows do not weaken v1 core conformance obligations.
  Evidence: Phase 2 scope is isolated to extension tracking (`PRD-007`), while
  all SPEC 18.1 core conformance rows remain mapped to required v1 PRDs,
  concrete tests, and observability outputs.
