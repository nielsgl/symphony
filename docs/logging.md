# Logging Contract

This document defines Symphony logging requirements and canonical lifecycle events.
It mirrors reference intent from `elixir/docs/logging.md` and records the
TypeScript implementation contract.

## Goals
- Keep logs searchable by issue/session across runtime and orchestrator paths.
- Keep lifecycle wording deterministic for dashboards, grep workflows, and alerts.
- Emit enough context to debug dispatch/retry/worker failures without reruns.

## Required Context Keys
For issue-related logs, emit both keys whenever issue identity exists:
- `issue_id`: tracker-internal stable ID.
- `issue_identifier`: human ticket key.

For session-related logs, emit:
- `session_id`: `<thread_id>-<turn_id>` when available.

Optional context for lifecycle debugging:
- `worker_host`, `retry_attempt`, `reason`, `error`, `due_at_ms`, `cleanup_workspace`.

## Canonical Lifecycle Events
Use canonical names from `src/observability/events.ts`.

Orchestrator lifecycle:
- `orchestration.dispatch.attempt.started`
- `orchestration.dispatch.spawn.succeeded`
- `orchestration.dispatch.spawn.failed`
- `orchestration.retry.scheduled`
- `orchestration.worker.exit.handled`
- `orchestration.worker.terminated`
- `orchestration.worker.stalled`
- `orchestration.worker.host_slots_exhausted`

Agent runner boundaries:
- `agent_runner.attempt.started`
- `agent_runner.attempt.completed`
- `agent_runner.attempt.failed`

Codex lifecycle (worker stream):
- `codex.session.started`
- `codex.turn.started`
- `codex.turn.completed`
- `codex.turn.failed`
- `codex.turn.cancelled`
- `codex.turn.input_required`
- `codex.startup.failed`

## Message and Formatting Rules
- Logs are rendered as deterministic key/value output by `MultiSinkLogger`.
- Messages should include explicit outcomes for recurring lifecycle events
  (`completed`, `failed`, `retrying`) and concise reason/error context.
- Avoid large payload dumps; API diagnostics/snapshots are the canonical detail
  surface.

## Log Transport and Retention
- Runtime uses dual sinks by default: `stderr` and rotating file sink.
- Default log root is workflow-scoped: `<workflow_dir>/.symphony/log`.
- Overrides:
  - CLI: `--logs-root=<path>` (or split form `--logs-root <path>`)
  - workflow config: `logging.root`
  - precedence: CLI > workflow > workflow-scoped default.
- Intentional divergence from Elixir reference:
  - TypeScript treats `--logs-root` as the direct directory containing `symphony.log*`,
  - Elixir treats `--logs-root` as parent root and writes under `<logs_root>/log/`.
- File naming and rotation:
  - active file: `symphony.log`
  - archives: `symphony.log.1`, `symphony.log.2`, ...
  - max size: `10MB` default (`logging.max_bytes` override)
  - max retained files: `5` default (`logging.max_files` override, active + archives)
- Diagnostics exposure:
  - `/api/v1/diagnostics.logging.root`
  - `/api/v1/diagnostics.logging.active_file`
  - `/api/v1/diagnostics.logging.rotation`
  - `/api/v1/diagnostics.logging.sinks`

## Safety and Reliability
- All logs flow through `redactLogInput`; secrets must not appear in message
  text or context values.
- Sink failures must never crash orchestration; `log_sink_failure` is emitted to
  fallback sink.
- Startup fails fast with typed config error `invalid_logging_root` when the
  configured log root is not writable.

## Implementation Anchors
- Logger and formatting: `src/observability/logger.ts`
- Canonical event registry: `src/observability/events.ts`
- Runtime log root resolution: `src/runtime/cli.ts`, `src/workflow/resolver.ts`, `src/runtime/bootstrap.ts`
- Orchestrator lifecycle emitters: `src/orchestrator/core.ts`
- Agent runner boundary emitters: `src/orchestrator/local-runner-bridge.ts`

## Verification Anchors
- `tests/observability/logger.test.ts`
- `tests/cli/cli-args.test.ts`
- `tests/runtime/bootstrap.test.ts`
- `tests/observability/events-vocabulary.test.ts`
- `tests/orchestrator/core.test.ts`
- `tests/orchestrator/local-runner-bridge.test.ts`
