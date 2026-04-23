# Recommendations and Migration Plan

## Summary
This plan translates cross-reference findings into implementation-ready change bundles and records execution closure state.

Prioritization model:
- `P0`: required to reduce concrete safety/operational risk.
- `P1`: high-value capability uplift aligned with reference strengths.
- `P2`: quality/ergonomics improvements.

## Closed in P11
### XR-01 — Strict security profile and guardrail acknowledgment
- Priority: `P0`
- Decision: `adopted` (closed in `P11`)
- Delivered:
  - strict-by-default security posture (`approval_policy=never`, read-only sandboxes),
  - mandatory startup acknowledgment flag,
  - deterministic `startup_guardrail_ack_required` block event.
- Anchors:
  - `/Users/niels.van.Galen.last/code/symphony/src/security/profiles.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/runtime/cli.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/runtime/cli-runner.ts`

### XR-02 — Codex policy shape compatibility contract
- Priority: `P1`
- Decision: `adopted` (closed in `P11`)
- Delivered:
  - `codex.approval_policy` supports string/object policy forms,
  - strict shape validation and typed errors,
  - string/object policy forwarding through `thread/start` and `turn/start`,
  - explicit unsafe-root fail-fast diagnostics before worker spawn.
- Anchors:
  - `/Users/niels.van.Galen.last/code/symphony/src/workflow/types.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/workflow/resolver.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/workflow/validator.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/codex/runner.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/orchestrator/local-worker-runner.ts`

### XR-04 — Optional SSH worker execution path
- Priority: `P1`
- Decision: `adopted` (closed in `P11`)
- Delivered:
  - host-aware dispatch scheduling,
  - per-host concurrency cap enforcement,
  - SSH remote spawn path with remote cwd validation,
  - worker-host propagation in logs/state projections.
- Anchors:
  - `/Users/niels.van.Galen.last/code/symphony/src/orchestrator/core.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/orchestrator/local-runner-bridge.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/codex/runner.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/runtime/bootstrap.ts`

### XR-05 — Dynamic tool adapter seam (`linear_graphql`)
- Priority: `P1`
- Decision: `adopted` (closed in `P11`)
- Delivered:
  - dynamic tool registry/executor,
  - `dynamicTools` advertised by default on `thread/start`,
  - default-enabled built-in `linear_graphql` tool,
  - deterministic unsupported-tool path preserved.
- Anchors:
  - `/Users/niels.van.Galen.last/code/symphony/src/codex/dynamic-tools.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/codex/runner.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/runtime/bootstrap.ts`

### XR-08 — Add TypeScript meta-quality gates
- Priority: `P2`
- Decision: `adopted` (closed in `P11`)
- Delivered:
  - `check:api-contract`, `check:pr-governance`, and aggregate `check:meta` commands,
  - script-level tests for meta gate behavior,
  - gate included in closeout verification path.
- Anchors:
  - `/Users/niels.van.Galen.last/code/symphony/scripts/check-api-contract.js`
  - `/Users/niels.van.Galen.last/code/symphony/scripts/check-pr-governance.js`
  - `/Users/niels.van.Galen.last/code/symphony/scripts/check-meta.js`
  - `/Users/niels.van.Galen.last/code/symphony/package.json`
  - `/Users/niels.van.Galen.last/code/symphony/tests/cli/meta-check-scripts.test.ts`

### XR-06 — Observability enrichment parity (throughput + runtime event feed)
- Priority: `P2`
- Decision: `adopted` (closed in `P12`)
- Delivered:
  - throughput aggregation windows (`5s`, `60s`, `10m`) with deterministic snapshot projection,
  - additive API contract fields on `/api/v1/state`: `throughput` + `recent_runtime_events`,
  - dashboard throughput panel + runtime event feed with severity filter and UI-state continuity keys,
  - diagnostics contract kept stable with additive observability-only fields.
- Anchors:
  - `/Users/niels.van.Galen.last/code/symphony/src/observability/throughput.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/orchestrator/core.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/api/snapshot-service.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/api/server.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/api/dashboard-assets.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/observability/throughput.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/api/server.test.ts`

### XR-09 — Canonical event vocabulary harmonization
- Priority: `P2`
- Decision: `adopted` (closed in `P12`)
- Delivered:
  - centralized canonical event registry and explicit version marker (`event_vocabulary_version=v2`),
  - covered emitter migration (workflow/orchestrator/codex/runtime/api) to canonical names,
  - hard cutover decision: no `legacy_event` compatibility alias retained (no external users),
  - diagnostics endpoint includes `event_vocabulary_version`.
- Anchors:
  - `/Users/niels.van.Galen.last/code/symphony/src/observability/events.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/workflow/watcher.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/orchestrator/core.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/codex/runner.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/runtime/bootstrap.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/runtime/cli-runner.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/api/server.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/observability/events-vocabulary.test.ts`

### XR-10 — Token accounting semantics alignment
- Priority: `P1`
- Decision: `adopted` (closed in `P13`)
- Delivered:
  - strict-canonical token accounting precedence using absolute thread totals only,
  - exclusion of generic `usage` and `last` payloads from cumulative total accounting,
  - support for canonical v2 `tokenUsage.total`,
  - additive optional dimensions (`cached_input_tokens`, `reasoning_output_tokens`, `model_context_window`) projected through state and diagnostics.
- Anchors:
  - `/Users/niels.van.Galen.last/code/symphony/src/codex/runner.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/codex/types.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/orchestrator/core.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/api/snapshot-service.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/api/server.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/codex/runner.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/orchestrator/core.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/api/server.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/api/snapshot-service.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/docs/token-accounting.md`

## Intentional Divergences to Preserve
### XR-03 — Preserve diagnostics/history/ui-state API surface
- Priority: `P1`
- Decision: `preserve`
- Delta:
  - Keep `/api/v1/diagnostics`, `/api/v1/history`, `/api/v1/ui-state` as product-level extensions.

### XR-00 — Preserve broader product scope (GitHub adapter + persistence + Tauri)
- Priority: `P0`
- Decision: `preserve`
- Delta:
  - Continue treating GitHub adapter, SQLite continuity, and desktop packaging as first-class product commitments.

## Remaining Open Recommendations
- None. Parity recommendations are closed through `P13`.
- Intentional divergence guardrails remain tracked under `XR-00` and `XR-03`.

## Suggested Rollout Order (Post-P12)
1. `XR-00` and `XR-03` preservation checks (regression guard only)

## Acceptance Criteria for This Plan
- `XR-01`, `XR-02`, `XR-04`, `XR-05`, `XR-06`, `XR-08`, `XR-09`, and `XR-10` are marked closed with concrete code/test anchors.
- Open recommendations are none, except explicit preservation items.
- No conflicting recommendation state across this file, `02-cross-reference-matrix.md`, and `appendix/subsystem-diff.json`.
