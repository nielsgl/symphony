# PRD-005 Observability, Local API, and Desktop UI

## Problem and Goals (SPEC Alignment)
Define required observability surfaces and the local HTTP API contract that the embedded desktop UI consumes for runtime visibility and operational control.

SPEC anchors:
- Logging and observability requirements: Section 13.1-13.6
- Optional HTTP server extension promoted to required in this product: Section 13.7
- Relevant checklist and tests: Section 17.6, 18.2 (adapted to required product scope)

Goals:
- Operator can inspect current system state and issue-specific diagnostics in real time.
- UI and API use a stable versioned contract.
- Observability is independent from orchestrator correctness.

## Scope
In scope:
- Structured logs with required context fields.
- Local loopback HTTP server.
- Required endpoints: `/api/v1/state`, `/api/v1/<issue_identifier>`, `/api/v1/refresh`.
- Embedded UI views: overview dashboard, issue detail, retry/running drilldown, validation/health banner.

Out of scope:
- Remote multi-user authenticated control plane.
- Browser-public API exposure by default.

## Architecture and Ownership
Modules:
- `LogEmitter`: structured key=value logs + sink failover behavior.
- `SnapshotService`: composes runtime snapshot from orchestrator state and metrics.
- `LocalApiServer`: route handling, validation, response envelopes, method guards.
- `DesktopUI`: Tauri-embedded web app consuming `/api/v1/*`.

Ownership boundaries:
- API is read-mostly; only `/refresh` triggers orchestration action.
- UI never mutates orchestrator internal structures directly.

## Public Interfaces and Data Contracts
`GET /api/v1/state` baseline shape (required fields):
```json
{
  "generated_at": "ISO-8601",
  "counts": {"running": 2, "retrying": 1},
  "running": [],
  "retrying": [],
  "codex_totals": {
    "input_tokens": 0,
    "output_tokens": 0,
    "total_tokens": 0,
    "seconds_running": 0
  },
  "rate_limits": null,
  "health": {"dispatch_validation": "ok", "last_error": null}
}
```

`GET /api/v1/<issue_identifier>` required sections:
- issue identity/status
- workspace path
- attempt/retry counters
- active running session details if present
- retry metadata if queued
- recent events
- last error

Error envelope:
```json
{"error":{"code":"issue_not_found","message":"Issue ABC-999 is not in runtime state"}}
```

`POST /api/v1/refresh` response contract:
```json
{"queued": true, "coalesced": false, "requested_at": "ISO-8601", "operations": ["poll", "reconcile"]}
```

Versioning:
- Non-breaking additions allowed in `v1`.
- Breaking changes require `v2` route namespace.

## Failure and Recovery Behavior
- Log sink failure should not crash service; emit warning on surviving sink.
- Snapshot generation timeout/unavailable returns typed API error.
- Unsupported methods return `405`.
- Repeated refresh requests may coalesce.

## Security Requirements
- Bind loopback by default.
- No secret values in API responses.
- CORS locked down to local desktop surface by default.
- Issue diagnostics endpoint must avoid exposing raw unbounded log payloads.

## Acceptance Criteria and Conformance Tests
Required tests:
- API schema validation for baseline fields.
- 404/405/error-envelope correctness.
- `/refresh` idempotent/coalescing behavior under burst.
- Token/runtime aggregates remain monotonic and correct.
- UI rendering from API-only state source.

Acceptance gates:
- Section 17.6 pass criteria met.
- Local operator can diagnose failed dispatch and stalled run without attaching debugger.

## Operational Readiness and Rollout Gates
- Health banner reflects startup validation and last reload state.
- Dashboard updates within 1 poll interval of runtime state changes.
- API latency and error rate telemetry exposed in local diagnostics.
