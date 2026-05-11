# Reproducing The Workflow Analysis

The extraction code used for this analysis is now captured in:

`docs/workflow-analysis/scripts/analyze_codex_workflows.py`

It reads local Codex state from `~/.codex` and does not modify product code or Codex databases.

## Corrected Ticket-Level Analysis

Use this mode for the corrected analysis where one `NIE-*` identifier is one ticket and every available local run for that ticket is grouped by phase.

```bash
python3 docs/workflow-analysis/scripts/analyze_codex_workflows.py \
  --mode tickets \
  --limit 50 \
  --current-thread-id 019e1651-a5f6-7a71-86e9-c559a536d1c0
```

Expected summary for the current local data snapshot:

```json
{
  "mode": "tickets",
  "tickets": 50,
  "run_iterations": 195,
  "tokens_total": 945655203,
  "created_at_min": "2026-05-06T20:31:09.015000Z",
  "created_at_max": "2026-05-10T19:35:13.732000Z"
}
```

To write generated outputs for comparison without overwriting the curated report:

```bash
python3 docs/workflow-analysis/scripts/analyze_codex_workflows.py \
  --mode tickets \
  --limit 50 \
  --current-thread-id 019e1651-a5f6-7a71-86e9-c559a536d1c0 \
  --write
```

This writes:

- `docs/workflow-analysis/metrics.generated.json`
- `docs/workflow-analysis/tickets-analyzed.generated.md`

## Original Thread-Level Analysis

Use this mode to reproduce the first interpretation of the original request: the most recent 50 Symphony issue-workspace threads, regardless of whether multiple threads belong to the same ticket.

```bash
python3 docs/workflow-analysis/scripts/analyze_codex_workflows.py \
  --mode threads \
  --limit 50 \
  --current-thread-id 019e1651-a5f6-7a71-86e9-c559a536d1c0
```

Expected summary for the current local data snapshot:

```json
{
  "mode": "threads",
  "tickets": 19,
  "run_iterations": 50,
  "tokens_total": 288463324,
  "created_at_min": "2026-05-08T10:58:24.947000Z",
  "created_at_max": "2026-05-10T19:35:13.732000Z"
}
```

## Main Functions

- `load_issue_workspace_rows`: reads Symphony issue-workspace threads from `state_5.sqlite`.
- `group_rows_by_issue`: groups Codex threads into unique `NIE-*` tickets.
- `parse_rollout_jsonl`: extracts events, tool calls, command counts, token usage, failures, and evidence references from a rollout JSONL file.
- `build_run`: turns one Codex thread row plus JSONL evidence into one run-iteration record.
- `build_ticket_summaries`: aggregates run iterations into ticket-level phase summaries.
- `build_ticket_mode`: builds the corrected 50-ticket analysis.
- `build_thread_mode`: builds the original 50-thread analysis.
- `write_metrics` and `write_ticket_table`: write generated comparison artifacts when `--write` is passed.

## Caveats

- The script uses local `~/.codex` data only.
- Phase is inferred from the starting Linear status embedded in each run prompt.
- Outcome is inferred from lifecycle events and final assistant text.
- Token totals come from local Codex `threads.tokens_used` and final JSONL token events when present.
