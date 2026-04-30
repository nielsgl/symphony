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
