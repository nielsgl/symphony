# Troubleshooting

## Connection failures
Symptoms:
- curl error from scripts/api_client.sh
- health check does not respond

Checks:
1. Ensure backend is running on 127.0.0.1:18731.
2. Verify base URL env values are correct:
   - CODEX_API_SCHEME
   - CODEX_API_HOST
   - CODEX_API_PORT
   - CODEX_API_BASE_PATH
3. Run:
   - scripts/health.sh

## HTTP 403 on include_unredacted
Cause:
- Backend denies unredacted transcript mode when local/config guardrails are not satisfied.

Action:
1. Retry without include_unredacted.
2. Report that redacted mode remains available.
3. Do not treat this as a fatal API outage.

## HTTP 404 for thread detail
Cause:
- Thread id not found or filtered by include_silent behavior.

Action:
1. Verify thread_id from /threads list.
2. Retry with include_silent=true.
3. Confirm data freshness and run refresh if needed.

## Empty metrics or thread lists
Possible causes:
- No recent ingestion data.
- Date filters too restrictive.

Action:
1. Remove date filters and test again.
2. Trigger refresh:
   - scripts/refresh.sh
3. Re-check:
   - scripts/kpis.sh
   - scripts/list_threads.sh

## Invalid query parameter values
Symptoms:
- 422 validation errors.
- 400 conflict errors for mutually exclusive filters.

Action:
1. Check allowed enums from references/endpoints.md.
2. Check numeric bounds:
   - threads limit: 1-500
   - offset: >= 0
3. For `/threads` and `/diagnostics/workflow/stalled-threads`, do not send both:
   - `project`
   - `project_name`

## Script-level failures
Symptoms:
- Unknown argument errors.

Action:
1. Run script without args to inspect usage where supported.
2. Pass endpoint query fields through supported flags only.
3. Fall back to scripts/api_client.sh for custom calls.
