---
name: debug
description: Investigate Symphony runtime issues by querying structured rotating logs and diagnostics endpoints.
---

# Symphony Debug Skill

Use this skill when diagnosing runtime behavior, dispatch issues, retries, or Codex session failures.

## Primary Evidence Sources
1. Rotating runtime logs at `<logs_root>/symphony.log*`.
2. Dashboard API diagnostics and state:
   - `GET /api/v1/diagnostics`
   - `GET /api/v1/state`
   - `GET /api/v1/history`

## Log Discovery Workflow
1. Resolve active log root from diagnostics:
```bash
curl -sS http://127.0.0.1:<port>/api/v1/diagnostics | jq '.logging'
```
2. Search by issue/session correlation keys:
```bash
rg -n "issue_identifier=\"ABC-123\"|issue_id=\"<uuid>\"|session_id=\"<thread-turn>\"" <logs_root>/symphony.log*
```
3. Narrow to lifecycle failures:
```bash
rg -n "orchestration\.dispatch\.spawn\.failed|orchestration\.retry\.scheduled|codex\.startup\.failed|codex\.turn\.failed" <logs_root>/symphony.log*
```

## No-HTTP Workflow (Port Disabled or API Unavailable)
1. Resolve log root from workflow path:
```bash
WORKFLOW_PATH=/abs/path/to/WORKFLOW.md
WORKFLOW_DIR="$(dirname "$WORKFLOW_PATH")"
LOG_ROOT="$WORKFLOW_DIR/.symphony/log"
```
2. If runtime was started with `--logs-root`, use that directory directly as `LOG_ROOT`.
3. Run the same `rg` correlation queries against `"$LOG_ROOT"/symphony.log*`.
4. If files are absent, inspect runtime stderr output from the foreground process.

## Fallback Behavior
If file sink is unavailable:
1. Check diagnostics (`/api/v1/diagnostics.logging.sinks`) to confirm active sinks.
2. Use stderr output from the runtime process as temporary fallback.
3. Treat missing file sink as a runtime misconfiguration and capture `/api/v1/diagnostics` evidence.

## Debugging Notes
- All log payloads are redacted by runtime policy; do not expect raw secrets in logs.
- Use canonical keys `issue_id`, `issue_identifier`, and `session_id` for correlation.
- Prefer querying recent lifecycle events before inspecting full payloads.
