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
### XR-06 — Observability enrichment parity (terminal + throughput)
- Priority: `P2`
- Decision: `investigate`
- Delta:
  - Evaluate optional terminal dashboard parity mode and richer throughput drilldowns.

### XR-09 — Harmonize workflow reload and protocol event vocabulary
- Priority: `P2`
- Decision: `refine`
- Delta:
  - Normalize event naming/documentation to reduce cross-implementation operator confusion.

## Suggested Rollout Order (Post-P11)
1. `XR-00` and `XR-03` preservation checks (regression guard only)
2. `XR-06` optional observability enrichment
3. `XR-09` terminology/event harmonization

## Acceptance Criteria for This Plan
- `XR-01`, `XR-02`, `XR-04`, `XR-05`, and `XR-08` are marked closed with concrete code/test anchors.
- Open recommendations are only `XR-06` and `XR-09` plus explicit preservation items.
- No conflicting recommendation state across this file, `02-cross-reference-matrix.md`, and `appendix/subsystem-diff.json`.
