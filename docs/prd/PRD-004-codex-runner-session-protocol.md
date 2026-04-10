# PRD-004 Codex Runner and Session Protocol

## Problem and Goals (SPEC Alignment)
Define the v1 coding-agent runtime integration against Codex app-server protocol, including startup handshake, streaming event handling, timeout/error mapping, and continuation turns.

SPEC anchors:
- Agent protocol and handshake: Section 10.1-10.4
- Approval/tool/user-input behavior: Section 10.5
- Timeouts/error mapping: Section 10.6
- Agent runner contract: Section 10.7

Goals:
- Protocol-correct, version-tolerant session lifecycle.
- Robust stream parsing and failure categorization.
- Reliable telemetry extraction for tokens and rate limits.

## Scope
In scope:
- Process launch via `bash -lc <codex.command>` with workspace cwd.
- Handshake ordering (`initialize`, `initialized`, `thread/start`, `turn/start`).
- Multi-turn continuation on same thread within worker lifetime.
- Event forwarding to orchestrator with normalized event types.
- Unsupported tool call handling and user-input-required fail behavior.

Out of scope:
- Non-Codex agent runtimes in v1.
- Protocol-independent plugin ecosystem.

## Architecture and Ownership
`CodexRunner` subcomponents:
- `ProcessHost`: spawn, monitor, stop app-server process.
- `ProtocolClient`: line framing, JSON decode, request/response correlation.
- `TurnController`: turn start/completion loop and continuation logic.
- `EventNormalizer`: map protocol variants to normalized runtime events.
- `UsageTracker`: absolute token aggregation and delta safety.

Ownership boundary:
- CodexRunner does not mutate scheduler claim state directly; it reports events/outcomes to orchestrator.

## Public Interfaces and Data Contracts
Session start contract:
```ts
startSession(input: {
  workspaceCwd: string
  approvalPolicy: string
  threadSandbox: string
  turnSandboxPolicy: Record<string, unknown>
  title: string
}): Promise<{threadId: string, sessionPid: number}>
```

Turn result contract:
```json
{
  "status": "completed",
  "thread_id": "thread-1",
  "turn_id": "turn-7",
  "session_id": "thread-1-turn-7",
  "last_event": "turn_completed"
}
```

Normalized event example:
```json
{
  "event": "approval_auto_approved",
  "timestamp": "2026-04-10T10:15:00Z",
  "codex_app_server_pid": 4242,
  "usage": {"input_tokens": 1200, "output_tokens": 800, "total_tokens": 2000}
}
```

## State, Failure, Retry, and Recovery Behavior
Timeouts:
- `read_timeout_ms`: startup/sync request timeout.
- `turn_timeout_ms`: end-to-end turn timeout.
- `stall_timeout_ms`: orchestrator-driven inactivity timeout.

Failure mappings:
- `codex_not_found`
- `invalid_workspace_cwd`
- `response_timeout`
- `turn_timeout`
- `response_error`
- `turn_failed`
- `turn_cancelled`
- `turn_input_required`

Rules:
- Unsupported dynamic tool call returns structured failure and session continues.
- User input requirement fails the attempt (hard-fail policy for v1 default).
- Process stderr never parsed as protocol stream.

## Security Requirements
- Enforce workspace cwd from validated WorkspaceManager path only.
- Approval/sandbox values must originate from effective config/profile resolution.
- Tool extension surface is explicit allowlist.
- Session logs redact secrets from command/env payloads.

## Acceptance Criteria and Conformance Tests
Required tests:
- Handshake ordering and required payload presence.
- Nested id parsing for thread/turn/session ids.
- Partial stdout line buffering and JSON framing.
- stderr isolation and parser stability under noisy stderr.
- timeout/stall behaviors and mapped error codes.
- usage/rate-limit extraction from compatible payload variants.
- unsupported tool call non-stall behavior.

Acceptance gates:
- Section 17.5 tests pass.
- 24-hour soak test with repeated turn streams completes without descriptor leaks.

## Operational Readiness and Rollout Gates
- Emit session lifecycle logs with `session_id` and terminal reason.
- Track aggregate token/runtime totals and latest rate-limit payload in snapshot API.
- Surface per-session diagnostics paths in issue-specific API response.
