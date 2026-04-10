# PRD-006 Security Profiles, Approval Policy, and Minimal Persistence

## Problem and Goals (SPEC Alignment)
Define the v1 balanced-production safety posture, approval/sandbox profile behavior, and minimal durable local persistence for restart continuity of operator diagnostics.

SPEC anchors:
- Trust boundary and filesystem/secret/hook safety: Section 15
- Failure model and recovery: Section 14
- Restart behavior and optional persistence TODO context: Section 14.3, 18.2

Goals:
- Make safety posture explicit and configurable.
- Ensure predictable default behavior for approval and sandbox settings.
- Persist enough local history to support operator continuity after restart.

## Scope
In scope:
- Approval/sandbox profile definitions and precedence.
- Secrets handling and redaction policy.
- Local durability for run/session history and UI continuity state.
- Threat model for local desktop deployment.

Out of scope:
- Full durable scheduler restoration.
- Enterprise IAM policy engine.

## Architecture and Ownership
Security profile module:
- Resolves effective profile from defaults + workflow overrides.
- Produces Codex session and turn policy payloads.
- Emits startup diagnostics for active profile.

Local persistence module:
- Append-only run/session event history store.
- Bounded retention policy.
- UI state persistence (filters, selected issue, panel state).

Storage guidance (v1):
- Use local SQLite (or equivalent embedded DB) under app data directory.
- Keep scheduler claim/running/retry state ephemeral.

## Public Interfaces and Data Contracts
Approval profile contract:
```json
{
  "name": "balanced",
  "approval_policy": "on-request",
  "thread_sandbox": "workspace-write",
  "turn_sandbox_policy": {"type": "workspace"},
  "user_input_policy": "fail_attempt"
}
```

Durable run history record:
```json
{
  "run_id": "uuid",
  "issue_id": "abc123",
  "issue_identifier": "ABC-123",
  "started_at": "ISO-8601",
  "ended_at": "ISO-8601|null",
  "terminal_status": "succeeded|failed|timed_out|stalled|cancelled",
  "error_code": "string|null",
  "session_ids": ["thread-1-turn-1"]
}
```

## Failure, Retry, and Recovery Behavior
- Restart does not restore active sessions or retry timers.
- Restart does restore historical run timeline for operator diagnostics.
- Invalid profile config blocks new dispatch but keeps service process alive where possible.
- Secret resolution failures are surfaced as typed validation errors.

## Security Requirements
- Redact secrets in logs, API, and persisted records.
- Restrict filesystem permissions on local storage directory.
- Document threat assumptions for local untrusted issue content.
- Enforce workspace boundary checks regardless of selected profile.

## Acceptance Criteria and Conformance Tests
Required tests:
- Profile precedence and override behavior.
- Mapped Codex payload correctness per active profile.
- Secret redaction in logs/API/storage snapshots.
- Restart continuity for durable history records.
- Retention pruning behavior and DB integrity under abrupt shutdown.

Acceptance gates:
- No plaintext tokens found via secret scanner on sampled logs/persistence exports.
- Security runbook documents profile choices and operational consequences.

## Operational Readiness and Rollout Gates
- Startup prints active profile name and safety summary.
- Local diagnostics page exposes persistence health and retention stats.
- Security checklist approved before production pilot.
