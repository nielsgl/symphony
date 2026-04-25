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

### XR-11 — Logging lifecycle/context parity alignment
- Priority: `P1`
- Decision: `adopted` (closed in `P14`)
- Delivered:
  - explicit orchestrator lifecycle logs for dispatch, retry scheduling, worker exits, terminal/non-active transitions, and stall handling,
  - canonical issue/session context-key normalization (`issue_id`, `issue_identifier`, `session_id`) across issue-related logs,
  - explicit AgentRunner boundary logs for attempt start/completion/failure,
  - reference-aligned local logging contract documentation in `docs/logging.md`.
- Anchors:
  - `/Users/niels.van.Galen.last/code/symphony/src/observability/events.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/orchestrator/core.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/orchestrator/local-runner-bridge.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/runtime/bootstrap.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/orchestrator/core.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/orchestrator/local-runner-bridge.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/observability/events-vocabulary.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/docs/logging.md`

### XR-12 — Logging substrate parity (durable file sink + logs-root diagnostics)
- Priority: `P1`
- Decision: `adopted` (closed in `P14b`, with intentional path-semantics divergence)
- Delivered:
  - rotating durable file sink (`symphony.log`, capped archive retention) while preserving default stderr sink visibility,
  - log-root precedence and startup resolution contract (CLI `--logs-root` > workflow `logging.root` > `<workflow_dir>/.symphony/log` default),
  - intentional divergence from Elixir path semantics: TypeScript `--logs-root` is the direct `symphony.log*` directory,
  - fail-fast typed startup error for non-writable log root (`invalid_logging_root`),
  - additive diagnostics logging block and debug-skill operator workflow alignment,
  - meta guard against non-canonical `identifier` context key in issue-scoped log context blocks.
- Anchors:
  - `/Users/niels.van.Galen.last/code/symphony/src/observability/logger.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/runtime/cli.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/runtime/bootstrap.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/api/server.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/api/types.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/observability/logger.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/runtime/bootstrap.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/cli/cli-args.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/scripts/check-log-context.js`
  - `/Users/niels.van.Galen.last/code/symphony/.codex/skills/debug/SKILL.md`

### XR-13 — Functional parity uplift bundle (tracker/runtime/api/workflow knobs)
- Priority: `P1`
- Decision: `adopted` (closed in `P15b`)
- Delivered:
  - tracker write-path parity (`create_comment`, `update_issue_state`) across Linear, GitHub, and memory adapters,
  - assignee-based tracker routing (`tracker.assignee`) with Linear `me` viewer resolution,
  - runtime workflow controls (`POST /api/v1/workflow/path`, `POST /api/v1/workflow/reload`) with last-known-good semantics,
  - configurable server host binding (`server.host` + CLI precedence),
  - retry projection enrichment (`worker_host`, `workspace_path`),
  - observability dashboard knobs (`dashboard_enabled`, `refresh_ms`, `render_interval_ms`),
  - deterministic default prompt fallback and diagnostics marker for empty workflow body.
- Anchors:
  - `/Users/niels.van.Galen.last/code/symphony/src/tracker/types.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/tracker/linear-adapter.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/tracker/github-adapter.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/tracker/memory-adapter.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/workflow/resolver.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/workflow/loader.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/runtime/cli.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/runtime/bootstrap.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/api/server.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/api/dashboard-assets.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/tracker/linear-adapter.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/tracker/github-adapter.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/tracker/memory-adapter.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/api/server.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/runtime/bootstrap.test.ts`

### XR-14 — Post-P15 protocol/runtime/api parity closure
- Priority: `P1`
- Decision: `adopted` (closed in `P16`)
- Delivered:
  - non-interactive `item/tool/requestUserInput` auto-answer behavior with deterministic approval-preference and fallback semantics,
  - method-specific approval response mapping (`acceptForSession`, `approved_for_session`) aligned to request method families,
  - state-aware continuation stop after each completed turn when issue leaves configured active states,
  - additive API projection parity for workspace/worker context across running/retrying/issue payloads,
  - resolvable-hostname support for `server.host` with deterministic `invalid_server_host` startup failure for unresolved hosts,
  - ops-helper parity scripts (`workspace-before-remove`, `check-public-api-contract`) wired into `check:meta`.
- Anchors:
  - `/Users/niels.van.Galen.last/code/symphony/src/codex/runner.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/orchestrator/local-worker-runner.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/orchestrator/local-runner-bridge.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/runtime/bootstrap.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/workflow/validator.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/api/snapshot-service.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/api/types.ts`
  - `/Users/niels.van.Galen.last/code/symphony/scripts/workspace-before-remove.js`
  - `/Users/niels.van.Galen.last/code/symphony/scripts/check-public-api-contract.js`
  - `/Users/niels.van.Galen.last/code/symphony/tests/codex/runner.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/orchestrator/local-runner-bridge.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/api/server.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/api/snapshot-service.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/runtime/bootstrap.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/workflow/validator.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/cli/workspace-before-remove.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/cli/public-api-contract-check.test.ts`

### XR-15 — Test-behavior parity closure (non-terminal-dashboard scope)
- Priority: `P1`
- Decision: `adopted` (closed in `P17`)
- Delivered:
  - canonical malformed protocol-line diagnostics for Codex stdout framing (`codex.protocol.malformed_line`),
  - canonical Codex stderr side-output diagnostics events (`codex.side_output`) with turn/session context when available,
  - deterministic SSH target normalization + command-shaping tests for host/port/user/IPv6 forms,
  - integration profile evidence uplift with explicit local + ssh lifecycle markers,
  - expanded ops/meta edge-case tests for workspace cleanup, public API contract, and aggregate meta failures.
- Anchors:
  - `/Users/niels.van.Galen.last/code/symphony/src/codex/runner.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/codex/ssh-target.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/observability/events.ts`
  - `/Users/niels.van.Galen.last/code/symphony/scripts/validate-real-integration-profile.js`
  - `/Users/niels.van.Galen.last/code/symphony/tests/codex/runner.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/codex/ssh-target.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/cli/integration-profile-script.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/cli/workspace-before-remove.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/cli/public-api-contract-check.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/cli/meta-check-scripts.test.ts`

### XR-16 — Workspace resolution + operator retry diagnostics clarity
- Priority: `P1`
- Decision: `adopted` (closed in `P18`)
- Delivered:
  - workflow-relative `workspace.root` resolution for path-like relative values,
  - explicit workspace resolution source metadata (`workspace.root_source`),
  - additive runtime diagnostics block (`runtime_resolution`) on `/api/v1/diagnostics`,
  - additive retry causality/thread lineage metadata in `/api/v1/state.retrying[]` and `/api/v1/:issue_identifier.retry`,
  - dashboard runtime-resolution panel and retry-cause/session/thread visibility + copy helpers.
- Anchors:
  - `/Users/niels.van.Galen.last/code/symphony/src/workflow/resolver.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/workflow/types.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/runtime/bootstrap.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/orchestrator/core.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/orchestrator/types.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/api/types.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/api/snapshot-service.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/api/server.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/api/dashboard-assets.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/workflow/resolver.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/runtime/bootstrap.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/orchestrator/core.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/api/server.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/api/snapshot-service.test.ts`

### XR-17 — First-class workspace provisioner parity (`worktree`/`clone`/`none`)
- Priority: `P1`
- Decision: `adopted` (closed in `P19`)
- Delivered:
  - typed `workspace.provisioner` workflow contract with deterministic defaults and validation.
  - first-class provisioner subsystem (`WorktreeProvisioner`, `CloneProvisioner`, `NoopProvisioner`) wired into workspace lifecycle while preserving hook order.
  - strict invariants for worktree mode (git-root checks, branch-template determinism, dirty-repo policy, conflict detection, idempotent reuse, safe teardown).
  - additive observability + diagnostics for provision/teardown lifecycle and last-result metadata.
  - additive running/retrying/issue projection context and dashboard visibility for branch/provision status.
- Anchors:
  - `/Users/niels.van.Galen.last/code/symphony/src/workflow/types.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/workflow/resolver.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/workflow/validator.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/workspace/provisioner.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/workspace/manager.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/runtime/bootstrap.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/orchestrator/core.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/orchestrator/local-runner-bridge.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/api/server.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/api/snapshot-service.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/api/dashboard-assets.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/workspace/provisioner.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/workspace/workspace-manager.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/orchestrator/local-runner-bridge.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/api/server.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/api/snapshot-service.test.ts`

### XR-18 — Non-interactive blocked-input operator control parity
- Priority: `P1`
- Decision: `adopted` (closed in `P20`, strengthened in `P20b`)
- Delivered:
  - known non-interactive MCP elicitation approval prompts auto-answer with session-scoped decisions,
  - unknown/unparseable input-required prompts transition to first-class blocked-input state (no retry churn),
  - additive API blocked projections and manual resume endpoint,
  - dashboard blocked-input panel with stop-reason and resume actions.
- Anchors:
  - `/Users/niels.van.Galen.last/code/symphony/src/codex/runner.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/orchestrator/core.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/orchestrator/types.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/api/server.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/api/snapshot-service.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/api/types.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/api/dashboard-assets.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/codex/runner.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/orchestrator/core.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/api/server.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/api/snapshot-service.test.ts`

### XR-19 — MCP reliability and provisioning integrity closure
- Priority: `P1`
- Decision: `adopted` (closed in `P20b`)
- Delivered:
  - unified permissive non-interactive input handling for both `item/tool/requestUserInput` and `mcpServer/elicitation/request`, with explicit decision-mode classification (`approval_option_exact`, `approval_option_permissive`, `non_interactive_fallback`, `input_required_unanswerable`),
  - blocked-input stop-reason detail taxonomy enriched from runner classifications for clearer operator diagnosis,
  - atomic cleanup rollback for freshly created workspace dirs on provision failure,
  - strict existing-dir verification before reuse for `worktree`/`clone`, with typed hard-fail conflict (`workspace_unprovisioned_conflict`) when path is unsafe to reuse,
  - deterministic provisioning sentinel metadata (`.symphony-provision.json`) and additive state/issue integrity signals (`workspace_provisioned`, `workspace_is_git_worktree`),
  - additive diagnostics for provision verification and cleanup outcomes.
- Anchors:
  - `/Users/niels.van.Galen.last/code/symphony/src/codex/runner.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/codex/types.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/orchestrator/core.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/orchestrator/local-worker-runner.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/workspace/manager.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/workspace/provisioner.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/workspace/errors.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/runtime/bootstrap.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/api/types.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/api/snapshot-service.ts`
  - `/Users/niels.van.Galen.last/code/symphony/src/api/dashboard-assets.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/codex/runner.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/orchestrator/core.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/workspace/workspace-manager.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/workspace/provisioner.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/api/server.test.ts`
  - `/Users/niels.van.Galen.last/code/symphony/tests/api/snapshot-service.test.ts`

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
- None. Parity recommendations are closed through `P20b`.
- Intentional divergence guardrails remain tracked under `XR-00` and `XR-03`.

## Suggested Rollout Order (Post-P12)
1. `XR-00` and `XR-03` preservation checks (regression guard only)

## Acceptance Criteria for This Plan
- `XR-01`, `XR-02`, `XR-04`, `XR-05`, `XR-06`, `XR-08`, `XR-09`, `XR-10`, `XR-11`, `XR-12`, `XR-13`, `XR-14`, `XR-15`, `XR-16`, `XR-17`, `XR-18`, and `XR-19` are marked closed with concrete code/test anchors.
- Open recommendations are none, except explicit preservation items.
- No conflicting recommendation state across this file, `02-cross-reference-matrix.md`, and `appendix/subsystem-diff.json`.
