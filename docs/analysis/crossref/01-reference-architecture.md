# Reference Architecture Deep Dive (`symphony-ref/elixir`)

## Executive Overview
The reference implementation is an OTP-centric orchestrator with Phoenix observability surfaces. Its core shape is:
- process-supervised runtime (`Orchestrator` GenServer + workers),
- strict workflow/config parsing via Ecto embedded schemas,
- Codex app-server integration with protocol-level request handling,
- optional remote worker execution over SSH,
- dual observability surfaces (terminal status dashboard + web API/LiveView).

## High-Level Topology
### Main runtime services
- Orchestrator state machine: [`orchestrator.ex`](/Users/niels.van.Galen.last/code/symphony-ref/elixir/lib/symphony_elixir/orchestrator.ex)
- Agent execution and continuation loop: [`agent_runner.ex`](/Users/niels.van.Galen.last/code/symphony-ref/elixir/lib/symphony_elixir/agent_runner.ex)
- Tracker abstraction and Linear adapter:
  - [`tracker.ex`](/Users/niels.van.Galen.last/code/symphony-ref/elixir/lib/symphony_elixir/tracker.ex)
  - [`linear/adapter.ex`](/Users/niels.van.Galen.last/code/symphony-ref/elixir/lib/symphony_elixir/linear/adapter.ex)
  - [`linear/client.ex`](/Users/niels.van.Galen.last/code/symphony-ref/elixir/lib/symphony_elixir/linear/client.ex)
- Workflow caching + live reload: [`workflow_store.ex`](/Users/niels.van.Galen.last/code/symphony-ref/elixir/lib/symphony_elixir/workflow_store.ex)
- Workspace + path safety + SSH:
  - [`workspace.ex`](/Users/niels.van.Galen.last/code/symphony-ref/elixir/lib/symphony_elixir/workspace.ex)
  - [`path_safety.ex`](/Users/niels.van.Galen.last/code/symphony-ref/elixir/lib/symphony_elixir/path_safety.ex)
  - [`ssh.ex`](/Users/niels.van.Galen.last/code/symphony-ref/elixir/lib/symphony_elixir/ssh.ex)
- Codex protocol integration:
  - [`codex/app_server.ex`](/Users/niels.van.Galen.last/code/symphony-ref/elixir/lib/symphony_elixir/codex/app_server.ex)
  - [`codex/dynamic_tool.ex`](/Users/niels.van.Galen.last/code/symphony-ref/elixir/lib/symphony_elixir/codex/dynamic_tool.ex)
- Web observability:
  - [`http_server.ex`](/Users/niels.van.Galen.last/code/symphony-ref/elixir/lib/symphony_elixir/http_server.ex)
  - [`router.ex`](/Users/niels.van.Galen.last/code/symphony-ref/elixir/lib/symphony_elixir_web/router.ex)
  - [`observability_api_controller.ex`](/Users/niels.van.Galen.last/code/symphony-ref/elixir/lib/symphony_elixir_web/controllers/observability_api_controller.ex)
  - [`presenter.ex`](/Users/niels.van.Galen.last/code/symphony-ref/elixir/lib/symphony_elixir_web/presenter.ex)
  - [`dashboard_live.ex`](/Users/niels.van.Galen.last/code/symphony-ref/elixir/lib/symphony_elixir_web/live/dashboard_live.ex)
- Terminal observability dashboard: [`status_dashboard.ex`](/Users/niels.van.Galen.last/code/symphony-ref/elixir/lib/symphony_elixir/status_dashboard.ex)

## Low-Level Design Characteristics
### 1) Configuration and policy model
- Uses Ecto embedded schemas for type-safe runtime config composition and validation:
  - tracker/polling/workspace/worker/agent/codex/hooks/observability/server structs in [`config/schema.ex`](/Users/niels.van.Galen.last/code/symphony-ref/elixir/lib/symphony_elixir/config/schema.ex).
- `codex.approval_policy` supports string or map (`StringOrMap` custom type).
- Default safety posture is stricter than permissive defaults:
  - object-form rejection policy + `workspace-write` thread sandbox.
- Runtime turn sandbox policy resolution is explicit and can fail if workspace roots are unsafe:
  - `resolve_runtime_turn_sandbox_policy` in [`config/schema.ex`](/Users/niels.van.Galen.last/code/symphony-ref/elixir/lib/symphony_elixir/config/schema.ex).

### 2) Orchestration state machine and retries
- Stateful GenServer with explicit poll cycle and message handlers (`handle_info`) for:
  - tick execution,
  - poll cycle start,
  - worker `DOWN` handling,
  - codex update ingestion,
  - retry timer events.
- Retry semantics:
  - continuation delay fixed at 1s (`@continuation_retry_delay_ms`),
  - exponential retry base (`@failure_retry_base_ms`) with cap from config.
- Reconciliation and dispatch are coupled through `maybe_dispatch` and `reconcile_running_issues`.

### 3) Codex app-server protocol handling
- Session lifecycle is separated into `start_session`, `run_turn`, `stop_session` with explicit metadata enrichment (`codex_app_server_pid`, optional `worker_host`).
- Approval and tool request handling is integrated in stream processing:
  - explicit handling for auto-approval and tool-call responses,
  - non-interactive responses for elicitation/input prompts,
  - unsupported dynamic tool requests rejected without stalling.
- Remote worker mode is first-class at port-launch level via SSH.

### 4) Workspace and path safety model
- Workspace creation and cleanup support both local and remote hosts.
- Path canonicalization and containment are strict for local execution.
- Hook execution semantics include timeout enforcement and failure classification.
- Before-remove behavior is designed as best-effort for cleanup continuity.

### 5) Tracker model
- Core runtime is strongly Linear-first:
  - Tracker behavior contract is generic,
  - production adapter set in reference focuses on Linear.
- Linear client includes typed error pathways and pagination integrity handling (`linear_missing_end_cursor`).

### 6) Observability model
- Two layers:
  - web API/LiveView state projection via Presenter,
  - terminal dashboard with rich rendering, throughput graphs, and event humanization.
- Snapshot retrieval includes timeout/unavailable semantics and normalized API envelopes.

### 7) Test strategy and quality gates
- Very broad test surface:
  - core orchestration tests,
  - app-server protocol tests,
  - dashboard snapshot fixtures,
  - extension and API behavior tests,
  - SSH behavior tests,
  - live end-to-end tests with real Linear resources and worker execution.
- Additional engineering governance checks via Mix tasks:
  - public `@spec` conformance (`specs.check`),
  - PR body quality checks,
  - workspace pre-remove operational task behavior.

## Architectural Strengths (Reference)
- Strong process model for runtime supervision and message-driven orchestration.
- Deep protocol hardening around app-server stream behavior.
- Rich observability stack (terminal + web) with heavy snapshot testing.
- First-class remote worker/SSH execution path.
- Strong quality hygiene via meta-check tasks and live integration coverage.

## Architectural Tradeoffs (Reference)
- Linear-centric runtime assumptions in primary adapter path.
- No explicit local durable run/session persistence subsystem analogous to SQLite history/ui continuity.
- Web experience optimized for Phoenix LiveView rather than desktop-native shell packaging.
- CLI includes explicit guardrail acknowledgment flow that changes operator UX semantics.
