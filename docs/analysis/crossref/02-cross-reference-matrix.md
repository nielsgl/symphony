# Cross-Reference Matrix: Symphony vs Symphony-Ref

## Classification Legend
- `spec-required`: needed to satisfy `SPEC.md`
- `extension`: additional capability beyond spec minimum
- `divergence`: contract/behavior mismatch with spec intent or risky incompatibility

## Parity Status Legend
- `equivalent`
- `functionally-equivalent`
- `different-safe`
- `different-risky`
- `missing-in-ours`
- `missing-in-ref`

## Subsystem Matrix
| Subsystem | Reference Design Summary | Our Design Summary | Contract Parity Result | Spec Classification | Risk / Impact | Recommendation |
|---|---|---|---|---|---|---|
| Config/workflow schema | Ecto embedded schema with runtime policy resolution and String-or-map approval policy (`config/schema.ex`, `config.ex`) | Typed resolver/validator with strict error codes, including GitHub state validation, worker host cap validation, and string-or-object approval policy normalization (`src/workflow/resolver.ts`, `src/workflow/validator.ts`) | `equivalent` for policy-shape compatibility and core fields | `spec-required` | Low | Keep; XR-02 closed in P11 |
| Workflow reload/store | GenServer-based workflow cache and poll-based reload preserving last known good (`workflow_store.ex`) | File watcher + effective config store with version hashing and last-known-good semantics (`src/workflow/watcher.ts`, `src/workflow/store.ts`) | `functionally-equivalent` | `spec-required` | Low | Keep current approach; align error telemetry language (`XR-09`) |
| Orchestrator core lifecycle | GenServer state, message handlers, retry scheduling, reconcile-before-dispatch (`orchestrator.ex`) | In-process orchestrator class with explicit tick/reconcile/retry and health state (`src/orchestrator/core.ts`) | `functionally-equivalent` | `spec-required` | Low | Keep; no must-change delta (`XR-00`) |
| Worker execution model | `AgentRunner` owns multi-turn continuation and can run on remote worker host via SSH (`agent_runner.ex`) | Host-aware orchestrator scheduling with per-host cap, local+SSH execution paths, and worker-host observability threading (`src/orchestrator/core.ts`, `src/orchestrator/local-runner-bridge.ts`, `src/codex/runner.ts`) | `functionally-equivalent` with implementation/runtime differences only | `extension` (SSH appendix scope) | Low-Medium | Keep; XR-04 closed in P11 |
| Codex app-server protocol | Deep approval/tool/elicitation handling; dynamic tool integration; remote port start (`codex/app_server.ex`) | Strong JSON-line protocol client with timeout/error mapping, unsupported request rejection, elicitation cancel path, plus default dynamic-tool registry/execution (`src/codex/runner.ts`, `src/codex/dynamic-tools.ts`) | `equivalent` for required protocol path; `functionally-equivalent` for tooling internals | `spec-required` core + `extension` tooling | Low | Keep; XR-05 closed in P11 |
| Tracker adapter strategy | Behavior contract + Linear adapter focus (`tracker.ex`, `linear/*`) | Adapter seam with Linear v1 + GitHub Issues phase-2 + typed factory/validation (`src/tracker/*.ts`) | `different-safe`; ours broader | `extension` | Positive (broader product scope) | Preserve ours; no regression to Linear-only (`XR-00`) |
| Workspace lifecycle + path safety | Local/remote path validation + hook semantics + cleanup resilience (`workspace.ex`, `path_safety.ex`) | Strict local containment/cwd invariants + hook timeout/failure model (`src/workspace/manager.ts`) | `functionally-equivalent` local semantics | `spec-required` | Low | Keep; remote-aware parity requirements are closed in P11 |
| HTTP API contract | Phoenix router/controller/presenter for `/`, `/api/v1/state`, `/api/v1/refresh`, `/api/v1/:issue_identifier` and LiveView-driven push updates | Local HTTP server with matching core endpoints plus `GET /api/v1/events` SSE, typed snapshot error payloads, and diagnostics/history/ui-state endpoints (`src/api/server.ts`, `src/api/types.ts`) | `different-safe`; ours superset with explicit stream contract | `spec-required` + `extension` | Low | Preserve superset and maintain envelope compatibility (`XR-03`) |
| UI/observability surface | Terminal status dashboard + Phoenix LiveView, rich TPS/rate-limit rendering (`status_dashboard.ex`, `dashboard_live.ex`) | Browser dashboard + Tauri host integration + local observability APIs; runtime seconds tick per-second and snapshot degradation keeps last-known-good data visible (`src/api/dashboard-assets.ts`, `src-tauri/src/main.rs`) | `different-safe` | `extension` | Medium UX/ops tradeoff | Keep current parity gains; evaluate selective terminal dashboard parity and throughput drilldowns (`XR-06`) |
| Security/policy defaults | Safer-by-default approval object + explicit guardrail CLI acknowledgment (`cli.ex`, `config/schema.ex`) | Strict-by-default profile (`approval_policy=never`, read-only sandbox) and mandatory startup acknowledgment flag with deterministic block event (`src/security/profiles.ts`, `src/runtime/cli.ts`, `src/runtime/cli-runner.ts`) | `equivalent` safety posture intent | `spec-required` | Low | Keep strict defaults; XR-01/XR-07 closed in P11 |
| Persistence/continuity | No dedicated durable run history/ui continuity store | SQLite durable history + ui-state + retention/integrity diagnostics (`src/persistence/store.ts`) | `missing-in-ref` (ours stronger for this requirement) | `spec-required` in our roadmap decisions | Low, favorable for ours | Preserve and treat as product baseline (`XR-00`) |
| Runtime/CLI lifecycle | Escript CLI with workflow arg, guardrail flag, `--logs-root`, `--port` and clean halt behavior (`cli.ex`) | Node CLI with positional/flag/env precedence, mandatory guardrail ack flag, and deterministic lifecycle tests (`src/runtime/cli.ts`, `tests/cli/lifecycle.test.ts`) | `functionally-equivalent` | `spec-required` + `extension` | Low | Keep; guardrail parity closed in P11 |
| Test harness and quality gates | Extensive ExUnit surface + live e2e + snapshot fixtures + Mix QA tasks (`test/**/*.exs`, `mix/tasks/*.ex`) | Extensive Vitest + Playwright + integration profile scripts + parity matrices + meta quality gate scripts (`tests/**/*.ts`, `scripts/check-meta.js`, `scripts/check-api-contract.js`, `scripts/check-pr-governance.js`) | `functionally-equivalent` with aligned governance gates | `spec-required` | Low | Keep; XR-08 closed in P11 |

## Interface-Level Parity
### Workflow/config schema and defaults
| Interface Area | Reference | Ours | Status | Classification | Recommendation |
|---|---|---|---|---|---|
| `worker.ssh_hosts` + `max_concurrent_agents_per_host` | Native runtime use for host scheduling and remote execution | Parsed/validated and now used for deterministic host scheduling with per-host cap and SSH launch path | `functionally-equivalent` | `extension` | Keep current activation model (XR-04 closed) |
| `codex.approval_policy` value shape | String or object map (Ecto custom type) | String or object policy supported, validated, normalized, and forwarded through `thread/start` + `turn/start` | `equivalent` | `spec-required` | Keep (XR-02 closed) |
| Turn sandbox policy | Runtime policy resolution can fail on unsafe root | Normalized policy values at protocol call site with explicit unsafe-root fail-fast diagnostics before spawn | `equivalent` | `spec-required` | Keep (XR-02 closed) |

### Session protocol fields/events
| Interface Area | Reference | Ours | Status | Classification | Recommendation |
|---|---|---|---|---|---|
| Session IDs and turn lifecycle | `<thread_id>-<turn_id>`, rich stream handling, auto approval routing | `<thread_id>-<turn_id>`, continuation handling, unsupported request rejection, elicitation cancel | `functionally-equivalent` | `spec-required` | Keep; add event harmonization glossary (`XR-09`) |
| Dynamic tool call support | Built-in `linear_graphql` dynamic tool | Built-in registry/executor with default `linear_graphql` dynamic tool; unsupported tools remain deterministic and non-stalling | `functionally-equivalent` | `extension` | Keep default-enabled tool path (XR-05 closed) |

### API endpoint semantics and error envelopes
| Interface Area | Reference | Ours | Status | Classification | Recommendation |
|---|---|---|---|---|---|
| Core endpoints (`/`, `/state`, `/refresh`, `/:issue`) | Implemented in Phoenix router/controller/presenter | Implemented in local HTTP server | `equivalent` | `spec-required` | Keep |
| Realtime state push | LiveView websocket push model with server-authoritative updates | `GET /api/v1/events` SSE with heartbeat, `state_snapshot`, health-change, and reconnect fallback polling | `functionally-equivalent` | `extension` | Keep SSE transport; preserve non-breaking REST behavior (`XR-03`) |
| Snapshot error semantics | Payload-level snapshot unavailable/timeout semantics in presenter/view flow | Typed payload-level snapshot error object for both `/api/v1/state` and SSE `state_snapshot` | `functionally-equivalent` | `spec-required` | Keep deterministic typed error envelope behavior (`XR-03`) |
| Unsupported methods | explicit 405 handling via router/controller | explicit 405 handling with structured error envelope | `equivalent` | `spec-required` | Keep |
| Extra diagnostics endpoints | minimal snapshot-focused API | diagnostics/history/ui-state endpoints | `missing-in-ref` | `extension` | Preserve as product differentiator (`XR-03`) |

### Retry and state transitions
| Interface Area | Reference | Ours | Status | Classification | Recommendation |
|---|---|---|---|---|---|
| Continuation retry + failure backoff | fixed 1s continuation + exponential failure backoff | fixed 1s continuation + exponential failure backoff | `equivalent` | `spec-required` | Keep |
| Stall and state-refresh behavior | tested restart on stalls and refresh semantics | tested stall handling and keep-running-on-refresh-failure | `equivalent` | `spec-required` | Keep |

## Key Cross-Repo Observations
1. Core SPEC conformance is mostly **functionally equivalent** despite language/runtime differences.
2. Previously high-priority parity deltas XR-01, XR-02, XR-04, XR-05, and XR-08 are now closed in P11.
3. Remaining deltas are largely product-level posture choices and optional UX depth (`XR-06`, `XR-09`).
4. Our implementation remains stronger in intentionally productized areas:
   - GitHub adapter,
   - SQLite persistence and UI continuity APIs,
   - desktop-native packaging path.
