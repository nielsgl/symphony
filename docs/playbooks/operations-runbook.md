# Symphony Operations Runbook

Use this runbook for monitoring, failure handling, and recovery.

## Runtime Health Checks

1. State snapshot:

```bash
curl -sS http://127.0.0.1:3000/api/v1/state
```

2. Diagnostics snapshot:

```bash
curl -sS http://127.0.0.1:3000/api/v1/diagnostics
```

3. Recent run history:

```bash
curl -sS http://127.0.0.1:3000/api/v1/history?limit=50
```

Reference response cues:

- `/api/v1/state`: `counts.running`, `counts.retrying`, `health.dispatch_validation`
- `/api/v1/diagnostics`: `active_profile`, `persistence.enabled`, `persistence.integrity_ok`
- `/api/v1/history`: stable stream of terminal outcomes and session IDs

## Symptoms and Actions

### Dispatch Not Running

- Check `health.dispatch_validation` in `/api/v1/state`.
- Validate tracker credentials and required tracker fields.
- Confirm `codex.command` is valid.
- Trigger a manual refresh after fixing config:

```bash
curl -sS -X POST http://127.0.0.1:3000/api/v1/refresh
```

### Retry Queue Growth

- Inspect issue details endpoint for affected identifiers.
- Verify build/test stability in workspace hooks and Codex prompt expectations.
- Confirm terminal states are correct so completed issues are reconciled out.

Issue check example:

```bash
curl -sS http://127.0.0.1:3000/api/v1/SYM-101
```

### Console Resume Dynamic-Tool Capability Mismatch

Symphony-originated app sessions can advertise dynamic tools such as
`linear_graphql`. A console/TUI continuation is not equivalent when that
environment rejects dynamic tool execution.

Operator signal:

- Issue diagnostics: `capability_warnings[]`
- Stable reason code: `unsupported_dynamic_tool_console_resume`
- Source environment: `console_tui`
- Unsupported message: `Dynamic tool calls are not available in TUI yet.`
- Included identifiers: attempted tool name, call id when available, thread id,
  and turn id

Verification:

```bash
curl -sS http://127.0.0.1:3000/api/v1/issues/SYM-101/diagnostics
curl -sS http://127.0.0.1:3000/api/v1/issues/SYM-101/forensics/export
```

Expected recovery:

- Resume the session through the Symphony UI/API or another supported
  app-session path.
- Do not blindly retry `codex continue` in the console for dynamic-tool
  sessions; that can repeat the same capability mismatch.
- If the turn later succeeds through a fallback tool path, keep the capability
  warning in diagnostics and forensics so operators can see that console
  continuation was degraded.

### Workspace Copy-Ignored Failures

If provisioning succeeds but copy step fails:

- Check `/api/v1/diagnostics.workspace_copy_ignored`:
  - `last_status`
  - `last_error_code`
  - `last_error_message`
- Common failure classes:
  - `workspace_copy_ignored_invalid_config`
  - `workspace_copy_ignored_denied_path`
  - `workspace_copy_ignored_limits_exceeded`
  - `workspace_copy_ignored_source_not_found`
- Verify `.worktreeinclude` path is inside your workflow/repo root and contains only relative paths.
- Keep `conflict_policy: skip` for autonomous runs unless overwrite is explicitly required.

### Script Bootstrap Preview (Dry Run)

When using hook-based bootstrap (`scripts/worktree_bootstrap.py`), preview copy behavior without mutation:

```bash
python3 /Users/niels.van.Galen.last/code/symphony/scripts/worktree_bootstrap.py \
  --source /absolute/repo/root \
  --target /absolute/workspace/path \
  --dry-run
```

Output is structured JSON lines:

- `action=copy` with `reason=dry-run` for would-copy paths
- `action=skip` for existing/sensitive paths
- final `action=summary` with `selected`, `copied`, and `skipped_sensitive`

### Refresh Needed After External State Change

```bash
curl -sS -X POST http://127.0.0.1:3000/api/v1/refresh
```

If responses are frequently coalesced, reduce manual refresh bursts and rely on poll interval.

### API Unavailable

- Confirm startup used an HTTP port via CLI, env, or `server.port`.
- If using desktop mode, verify backend boot logs in host output.

## Safe Stop Procedure

1. Send Ctrl+C to process.
2. Confirm process exits cleanly.
3. Restart and verify `/api/v1/state` and `/api/v1/history`.

## Security Checklist

- Secrets only via env vars.
- Verify redaction in API and log outputs.
- Use conservative codex approval and sandbox settings by default.

## Recovery Escalation

1. Reproduce with one issue only.
2. Enable verbose local diagnostics in prompt and hooks.
3. Capture history and issue-specific snapshots.
4. Adjust workflow and retry with reduced concurrency.

Concrete escalation sequence:

1. Set `agent.max_concurrent_agents: 1` in `WORKFLOW.md`.
2. Run one seed issue and capture `/api/v1/state` before and after refresh.
3. Verify sample app tests in `tests/fixtures/todo-sample-app`.
4. Re-enable baseline concurrency only after one successful issue cycle.

## Upstream Parity Delta Review Cadence

Run once weekly and before release-gate handoff.

1. Advisory scan (always safe for local iteration):

```bash
npm run check:upstream-parity -- --mode advisory
```

2. Enforced release gate (fails on untriaged `spec_required`/`behavioral_risk`):

```bash
SYMPHONY_UPSTREAM_PARITY_ENABLED=1 SYMPHONY_UPSTREAM_PARITY_BLOCKING=1 npm run check:meta
```

3. Explicit local bypass for fast iteration (prints warning, never use in release sign-off):

```bash
SYMPHONY_UPSTREAM_PARITY_ENABLED=1 SYMPHONY_UPSTREAM_PARITY_BLOCKING=1 SYMPHONY_UPSTREAM_PARITY_BYPASS=1 npm run check:meta
```

4. Accept new baseline after triage (auditable SHA + timestamp + reviewer update):

```bash
# update docs/analysis/crossref/upstream-parity.json:
# - last_reviewed_sha
# - reviewed_at
# - reviewed_by
npm run check:upstream-parity -- --mode advisory
```

## Backlog And Repository Hygiene

Run backlog hygiene weekly before planning and before release-gate handoff.

1. Human-readable stale ticket report:

```bash
npm run hygiene:backlog -- --project-slug symphony --team-key NIE --format table
```

Expected output is a compact table with these columns:

```text
ID      Status   Priority  Days  Action      Title
------  -------  --------  ----  ----------  ----------------
NIE-42  Todo     2         45    prioritize  Example stale item
```

2. Machine-readable stale ticket report:

```bash
npm run hygiene:backlog -- --project-slug symphony --team-key NIE --format json
```

Expected output is a JSON array with one object per stale issue:

```json
[
  {
    "id": "NIE-42",
    "title": "Example stale item",
    "status": "Todo",
    "priority": 2,
    "days_since_update": 45,
    "recommended_action": "prioritize"
  }
]
```

Stale policy: status is `Backlog` or `Todo`, issue has not been updated for at least 30 days, and issue is not archived, canceled, or completed.

Use `recommended_action` during triage:

- `prioritize`: high-priority stale item that should be moved forward or explicitly de-prioritized.
- `re-scope`: stale `Todo` item that needs a clearer current execution shape.
- `defer`: stale `Backlog` item that can remain parked with an updated rationale.
- `close`: item no longer worth retaining when policy is expanded to include closure candidates.

Repository hygiene is enforced by the pre-merge meta gate:

```bash
npm run check:meta
```

Expected pass cue:

```text
Meta checks passed.
```

Expected blocked artifact diagnostic includes a typed code and remediation:

```text
hygiene_repo_artifact_tracked_forbidden: tracked UI evidence artifacts are not allowed under output/playwright/ and provision artifacts are not allowed at repository root.
Remediation: Publish review artifacts externally, unstage/remove forbidden files, or intentionally bypass with SYMPHONY_REPO_HYGIENE_ALLOW_TRACKED=1.
```

Blocked artifact classes:

- `output/playwright/*`
- `.symphony-provision.json`

Only use `SYMPHONY_REPO_HYGIENE_ALLOW_TRACKED=1` for intentional local diagnostics. Do not use it for release sign-off or pre-merge validation.
