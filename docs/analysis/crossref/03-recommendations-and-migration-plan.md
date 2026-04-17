# Recommendations and Migration Plan

## Summary
This plan translates cross-reference findings into implementation-ready change bundles.

Prioritization model:
- `P0`: required to reduce concrete safety/operational risk.
- `P1`: high-value capability uplift aligned with reference strengths.
- `P2`: quality/ergonomics improvements.

## Must-Do for Spec/Safety Correctness
### XR-01 — Strict security profile and guardrail acknowledgment
- Priority: `P0`
- Decision: `adopt`
- Delta:
  - Add a stricter runtime profile (object-form rejection policy equivalent to reference safe mode).
  - Add optional startup guardrail acknowledgment mode for high-risk deployments.
- Target areas:
  - `/Users/niels.van.Galen.last/code/symphony/src/security/profiles.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/runtime/cli.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/runtime/cli-runner.ts`
- Tests:
  - add CLI tests for “missing ack => deterministic nonzero exit with banner/error”.
  - add profile resolution tests for strict defaults and override precedence.
- Observability:
  - emit `security_profile_active` with strict-mode marker.
  - emit explicit `startup_guardrail_ack_required` when blocked.
- Dependencies: none.

### XR-02 — Codex policy shape compatibility contract
- Priority: `P1`
- Decision: `refine`
- Delta:
  - Add explicit mapping/validation layer documenting and enforcing string/object policy compatibility at protocol boundary.
  - Add unsafe workspace-root diagnostics for turn sandbox policy resolution.
- Target areas:
  - `/Users/niels.van.Galen.last/code/symphony/src/workflow/validator.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/codex/runner.ts`
  - `/Users/niels.van.Galen.last/code/symphony/docs/prd/PRD-006-security-approval-profiles-persistence.md`
- Tests:
  - add compatibility tests for object-form approval policy rejection and mapping outcomes.
  - add invalid/unsafe policy diagnostic tests.
- Observability:
  - structured event for policy-shape normalization outcome.
- Dependencies: XR-01.

## Optional Extension Adoptions
### XR-04 — Optional SSH worker execution path
- Priority: `P1`
- Decision: `investigate`
- Delta:
  - Activate runtime use of `worker.ssh_hosts` and `max_concurrent_agents_per_host`.
  - Add remote worker spawn/termination and remote workspace command execution path.
- Target areas:
  - `/Users/niels.van.Galen.last/code/symphony/src/orchestrator/local-runner-bridge.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/workspace/manager.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/workflow/types.ts`
- Tests:
  - host-selection fairness/cap tests.
  - remote startup failure mapping tests.
  - remote hook lifecycle timeout/error tests.
- Observability:
  - add `worker_host` to worker lifecycle and retry logs.
  - add remote command timeout/failure counters.
- Dependencies: XR-02.

### XR-05 — Dynamic tool adapter seam (`linear_graphql`-style)
- Priority: `P1`
- Decision: `investigate`
- Delta:
  - Add optional, gated dynamic-tool execution interface for runner protocol requests.
  - Keep default as deny/unsupported for safety unless enabled.
- Target areas:
  - `/Users/niels.van.Galen.last/code/symphony/src/codex/runner.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/codex/types.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/runtime/bootstrap.ts`
- Tests:
  - supported tool success/failure shape tests.
  - unsupported tool non-stall tests remain required.
  - argument validation and redaction tests.
- Observability:
  - tool invocation event series with safe payload summaries.
- Dependencies: XR-02.

### XR-06 — Observability enrichment parity (terminal + throughput)
- Priority: `P2`
- Decision: `investigate`
- Delta:
  - Add optional terminal dashboard mode and richer throughput visualization semantics.
  - Keep web/Tauri path as primary product surface.
- Target areas:
  - `/Users/niels.van.Galen.last/code/symphony/src/observability/logger.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/api/dashboard-assets.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/runtime/bootstrap.ts`
- Tests:
  - deterministic snapshot tests for terminal rendering.
  - token throughput bucket math tests.
- Observability:
  - `tps_window` metrics and render-heartbeat events.
- Dependencies: none.

### XR-07 — CLI high-risk mode UX parity
- Priority: `P2`
- Decision: `adopt`
- Delta:
  - Add optional “explicit risky mode acknowledgment” UX similar to reference CLI.
  - Keep current operator flow as default in trusted local use.
- Target areas:
  - `/Users/niels.van.Galen.last/code/symphony/src/runtime/cli.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/runtime/cli-runner.ts`
- Tests:
  - argument precedence + acknowledgment gating tests.
- Observability:
  - startup event captures acknowledgment mode.
- Dependencies: XR-01.

## Intentional Divergences to Preserve
### XR-03 — Preserve diagnostics/history/ui-state API surface
- Priority: `P1`
- Decision: `preserve`
- Delta:
  - Keep `/api/v1/diagnostics`, `/api/v1/history`, `/api/v1/ui-state` as product-level extensions.
- Target areas: docs only unless regression found.
- Tests:
  - keep existing API contract tests green.
- Observability:
  - maintain persistence health and profile diagnostics signals.
- Dependencies: none.

### XR-00 — Preserve broader product scope (GitHub adapter + persistence + Tauri)
- Priority: `P0`
- Decision: `preserve`
- Delta:
  - Continue treating GitHub adapter, SQLite continuity, and desktop packaging as first-class product commitments.
- Target areas: roadmap/governance docs.
- Tests:
  - no regression in tracker factory, persistence, runtime desktop tests.
- Observability:
  - maintain current API/state parity guarantees.
- Dependencies: none.

## Quality and Governance Uplifts
### XR-08 — Add TypeScript meta-quality gates
- Priority: `P2`
- Decision: `adopt`
- Delta:
  - Add CI checks analogous to reference Mix tasks:
    - exported API contract lint/check,
    - PR body/changeset checklist conformance script.
- Target areas:
  - `/Users/niels.van.Galen.last/code/symphony/scripts/`
  - `/Users/niels.van.Galen.last/code/symphony/package.json`
  - CI workflow definitions.
- Tests:
  - script-level unit tests + CI dry-run verification.
- Observability:
  - CI check artifacts published per run.
- Dependencies: none.

### XR-09 — Harmonize workflow reload and protocol event vocabulary
- Priority: `P2`
- Decision: `refine`
- Delta:
  - Normalize event naming/documentation to reduce cross-implementation operator confusion.
- Target areas:
  - `/Users/niels.van.Galen.last/code/symphony/src/runtime/bootstrap.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/codex/runner.ts`
  - `/Users/niels.van.Galen.last/code/symphony/docs/prd/`
- Tests:
  - logger event assertion updates in runtime/codex suites.
- Observability:
  - backward-compatible event aliases during transition window.
- Dependencies: XR-02.

## Suggested Rollout Order
1. `XR-00` (preservation baseline guardrails)
2. `XR-01` (strict profile + optional guardrail acknowledgment)
3. `XR-02` (policy shape compatibility)
4. `XR-03` (explicitly preserve extension APIs)
5. `XR-04` and `XR-05` (remote workers + dynamic tool seam)
6. `XR-07` (CLI UX parity)
7. `XR-08` and `XR-09` (quality and terminology harmonization)
8. `XR-06` (optional observability enrichment)

## Acceptance Criteria for This Plan
- Every `different-risky` and `missing-in-ours` matrix row maps to an `XR-*` recommendation.
- Each recommendation has explicit targets, tests, and observability requirements.
- No recommendation requires implementer-side product decisions during execution.
