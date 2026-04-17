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
| Config/workflow schema | Ecto embedded schema with runtime policy resolution and String-or-map approval policy (`config/schema.ex`, `config.ex`) | Typed resolver/validator with strict error codes, including GitHub state validation and worker host cap validation (`src/workflow/resolver.ts`, `src/workflow/validator.ts`) | `functionally-equivalent` core fields; differing policy value shapes | `spec-required` | Low risk if value normalization remains explicit at protocol boundary | Keep current model; add policy-shape compatibility table (`XR-02`) |
| Workflow reload/store | GenServer-based workflow cache and poll-based reload preserving last known good (`workflow_store.ex`) | File watcher + effective config store with version hashing and last-known-good semantics (`src/workflow/watcher.ts`, `src/workflow/store.ts`) | `functionally-equivalent` | `spec-required` | Low | Keep current approach; align error telemetry language (`XR-09`) |
| Orchestrator core lifecycle | GenServer state, message handlers, retry scheduling, reconcile-before-dispatch (`orchestrator.ex`) | In-process orchestrator class with explicit tick/reconcile/retry and health state (`src/orchestrator/core.ts`) | `functionally-equivalent` | `spec-required` | Low | Keep; no must-change delta (`XR-00`) |
| Worker execution model | `AgentRunner` owns multi-turn continuation and can run on remote worker host via SSH (`agent_runner.ex`) | `LocalRunnerBridge` + `CodexRunner` local process execution only (`src/orchestrator/local-runner-bridge.ts`, `src/codex/runner.ts`) | `different-safe` for core; `missing-in-ours` for remote worker runtime | `extension` (SSH appendix scope) | Medium for teams needing remote isolation/capacity | Optional SSH-host execution story (`XR-04`) |
| Codex app-server protocol | Deep approval/tool/elicitation handling; dynamic tool integration; remote port start (`codex/app_server.ex`) | Strong JSON-line protocol client with timeout/error mapping, unsupported request rejection, elicitation cancel path (`src/codex/runner.ts`) | `functionally-equivalent` core; dynamic tool path differs | `spec-required` core + `extension` tooling | Medium for advanced tool workflows | Add optional dynamic-tool adapter seam (`XR-05`) |
| Tracker adapter strategy | Behavior contract + Linear adapter focus (`tracker.ex`, `linear/*`) | Adapter seam with Linear v1 + GitHub Issues phase-2 + typed factory/validation (`src/tracker/*.ts`) | `different-safe`; ours broader | `extension` | Positive (broader product scope) | Preserve ours; no regression to Linear-only (`XR-00`) |
| Workspace lifecycle + path safety | Local/remote path validation + hook semantics + cleanup resilience (`workspace.ex`, `path_safety.ex`) | Strict local containment/cwd invariants + hook timeout/failure model (`src/workspace/manager.ts`) | `functionally-equivalent` local semantics | `spec-required` | Low | Keep; optionally add remote-aware path policy docs (`XR-04`) |
| HTTP API contract | Phoenix router/controller/presenter for `/`, `/api/v1/state`, `/api/v1/refresh`, `/api/v1/:issue_identifier` | Local HTTP server with same core endpoints plus diagnostics/history/ui-state endpoints (`src/api/server.ts`) | `different-safe`; ours superset | `spec-required` + `extension` | Low | Preserve superset and maintain envelope compatibility (`XR-03`) |
| UI/observability surface | Terminal status dashboard + Phoenix LiveView, rich TPS/rate-limit rendering (`status_dashboard.ex`, `dashboard_live.ex`) | Browser dashboard + Tauri host integration + local observability APIs (`src/api/dashboard-assets.ts`, `src-tauri/src/main.rs`) | `different-safe` | `extension` | Medium UX/ops tradeoff | Evaluate selective terminal dashboard parity and richer KPIs (`XR-06`) |
| Security/policy defaults | Safer-by-default approval object + explicit guardrail CLI acknowledgment (`cli.ex`, `config/schema.ex`) | Balanced profile defaults (`on-request`, workspace-write) with startup profile diagnostics (`src/security/profiles.ts`, `src/runtime/bootstrap.ts`) | `different-risky` safety posture delta | `divergence` (policy-hardening intent) | High in less-trusted environments | Introduce strict profile + opt-in startup guardrail acknowledgment mode (`XR-01`) |
| Persistence/continuity | No dedicated durable run history/ui continuity store | SQLite durable history + ui-state + retention/integrity diagnostics (`src/persistence/store.ts`) | `missing-in-ref` (ours stronger for this requirement) | `spec-required` in our roadmap decisions | Low, favorable for ours | Preserve and treat as product baseline (`XR-00`) |
| Runtime/CLI lifecycle | Escript CLI with workflow arg, guardrail flag, `--logs-root`, `--port` and clean halt behavior (`cli.ex`) | Node CLI with positional/flag/env precedence and host lifecycle tests (`src/runtime/cli.ts`, `tests/cli/lifecycle.test.ts`) | `different-safe` core, guardrail UX differs | `spec-required` + `extension` | Medium operator behavior difference | Add optional “acknowledge risky mode” CLI compatibility (`XR-07`) |
| Test harness and quality gates | Extensive ExUnit surface + live e2e + snapshot fixtures + Mix QA tasks (`test/**/*.exs`, `mix/tasks/*.ex`) | Extensive Vitest + Playwright + integration profile scripts + parity matrices (`tests/**/*.ts`, `scripts/validate-real-integration-profile.js`) | `functionally-equivalent` with different strengths | `spec-required` | Medium (meta-quality guard gap) | Add TS meta-checks for exported API contract and docs quality gates (`XR-08`) |

## Interface-Level Parity
### Workflow/config schema and defaults
| Interface Area | Reference | Ours | Status | Classification | Recommendation |
|---|---|---|---|---|---|
| `worker.ssh_hosts` + `max_concurrent_agents_per_host` | Native runtime use for host scheduling and remote execution | Parsed/validated but not yet used for remote execution | `different-safe` | `extension` | Implement optional execution path (`XR-04`) |
| `codex.approval_policy` value shape | String or object map (Ecto custom type) | String policy in effective config + security profile projection | `different-safe` | `spec-required` | Document shape compatibility bridge (`XR-02`) |
| Turn sandbox policy | Runtime policy resolution can fail on unsafe root | Normalized policy values at protocol call site | `functionally-equivalent` | `spec-required` | Add explicit unsafe-root diagnostic parity (`XR-02`) |

### Session protocol fields/events
| Interface Area | Reference | Ours | Status | Classification | Recommendation |
|---|---|---|---|---|---|
| Session IDs and turn lifecycle | `<thread_id>-<turn_id>`, rich stream handling, auto approval routing | `<thread_id>-<turn_id>`, continuation handling, unsupported request rejection, elicitation cancel | `functionally-equivalent` | `spec-required` | Keep; add event harmonization glossary (`XR-09`) |
| Dynamic tool call support | Built-in `linear_graphql` dynamic tool | No built-in dynamic tool executor in runner path | `missing-in-ours` | `extension` | Add optional tool adapter seam (`XR-05`) |

### API endpoint semantics and error envelopes
| Interface Area | Reference | Ours | Status | Classification | Recommendation |
|---|---|---|---|---|---|
| Core endpoints (`/`, `/state`, `/refresh`, `/:issue`) | Implemented in Phoenix router/controller/presenter | Implemented in local HTTP server | `equivalent` | `spec-required` | Keep |
| Unsupported methods | explicit 405 handling via router/controller | explicit 405 handling with structured error envelope | `equivalent` | `spec-required` | Keep |
| Extra diagnostics endpoints | minimal snapshot-focused API | diagnostics/history/ui-state endpoints | `missing-in-ref` | `extension` | Preserve as product differentiator (`XR-03`) |

### Retry and state transitions
| Interface Area | Reference | Ours | Status | Classification | Recommendation |
|---|---|---|---|---|---|
| Continuation retry + failure backoff | fixed 1s continuation + exponential failure backoff | fixed 1s continuation + exponential failure backoff | `equivalent` | `spec-required` | Keep |
| Stall and state-refresh behavior | tested restart on stalls and refresh semantics | tested stall handling and keep-running-on-refresh-failure | `equivalent` | `spec-required` | Keep |

## Key Cross-Repo Observations
1. Core SPEC conformance is mostly **functionally equivalent** despite language/runtime differences.
2. Largest practical deltas are **product posture decisions**:
   - security defaults and operator acknowledgment flow,
   - remote worker/SSH execution,
   - dynamic tool support,
   - observability UX depth.
3. Our implementation is stronger in productized areas intentionally added after baseline:
   - GitHub adapter,
   - SQLite persistence and UI continuity APIs,
   - desktop-native packaging path.
