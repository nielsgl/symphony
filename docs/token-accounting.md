# Token Accounting Contract

This document defines how Symphony interprets Codex token telemetry for runtime accounting, API reporting, and operator diagnostics.

## Canonical totals rule

Symphony treats only absolute thread totals as authoritative for accounting.

Accepted source precedence:
1. `thread/tokenUsage/updated.params.tokenUsage.total`
2. `params.info.total_token_usage` (or `params.info.totalTokenUsage`)
3. `params.total_token_usage`
4. `params.totalTokenUsage`

Rejected for totals:
- `tokenUsage.last`
- `last_token_usage`
- generic `params.usage`

Rationale:
- `usage` is event-scoped and can represent non-cumulative payloads.
- `last` fields are deltas, not durable totals.

## Aggregation behavior

Symphony maintains a high-water-mark absolute snapshot and computes monotonic deltas:
- initialize aggregate from first accepted absolute snapshot
- for subsequent snapshots, add `max(0, current - previous)` per token field
- never decrement totals on out-of-order or smaller snapshots

This applies to:
- `input_tokens`
- `output_tokens`
- `total_tokens`
- optional dimensions when present: `cached_input_tokens`, `reasoning_output_tokens`

`model_context_window` is tracked as latest observed context limit metadata and is not treated as spend.

## Optional token dimensions

When available in payloads, Symphony carries these additive fields end-to-end:
- `cached_input_tokens`
- `reasoning_output_tokens`
- `model_context_window`

Absence is valid and expected for older or variant payloads.

## Thread safety guard

At orchestrator aggregation time, usage snapshots are applied only when the worker event thread id matches the active running thread id (when both are present). This prevents cross-thread contamination.

## Diagnostics surface

`GET /api/v1/diagnostics` includes `token_accounting` metadata:
- mode (`strict_canonical`)
- source precedence
- explicit exclusion rules
- observed optional dimensions in current runtime state

## Troubleshooting

If token totals are not moving:
1. Check `/api/v1/diagnostics.token_accounting.observed_dimensions`.
2. Verify incoming protocol events include one of the accepted absolute sources.
3. Confirm thread ids are consistent for running issue events.
4. Confirm no dependency is assuming generic `usage` drives cumulative totals.

If payload shape changed:
1. Compare new event payload path with the canonical precedence list.
2. Add parser support only for explicit absolute totals.
3. Keep exclusion rules for `last` and generic `usage`.
