# Symphony Workflow Analysis

## Summary

This directory contains an evidence-based workflow analysis from local Codex data only. No product code, config, tests, prompts, PRs, or issues were modified or created.

Corrected cohort definition: a ticket is a unique `NIE-*` issue, not an individual Codex thread. The cohort is the 50 most recent unique Symphony tickets by latest local issue-workspace run. For those 50 tickets, every available local run iteration was included and grouped by phase.

High-level result: 50 tickets produced 195 run iterations and 945,655,203 recorded tokens. Implementation remains the expensive stage: 92 implementation iterations account for 765,625,124 tokens. Review has 61 iterations and merge has 42 iterations.

## Data Sources

- `~/.codex/state_5.sqlite`: primary thread ledger (`threads`) with cwd, title, rollout path, timestamps, and `tokens_used`.
- `~/.codex/sessions/**/*.jsonl`: active session events, tool calls, assistant/user messages, final `token_count` events, and lifecycle markers.
- `~/.codex/archived_sessions/*.jsonl`: archived session inventory; inspected as available local Codex history.
- `~/.codex/logs_2.sqlite`: supplemental runtime logs. It has 773,808 rows, 342,987 with a `thread_id`, but no normalized workflow phase/outcome schema.
- `~/.codex/sqlite/codex-dev.db`: inspected and found to contain automations/inbox/local app feature state rather than the run metrics needed here.

Inventory: 897 total local threads, 423 Symphony-cwd threads, 350 Symphony issue-workspace threads, 86 unique Symphony issue tickets, 745 active session JSONL files, and 165 archived JSONL files.

## Methodology

1. Query all local Symphony issue-workspace threads from `state_5.sqlite.threads`.
2. Extract the `NIE-*` identifier from cwd/title/prompt and group threads by ticket.
3. Select the 50 most recent unique tickets by latest run timestamp.
4. Include all available local run iterations for each selected ticket.
5. Attribute each run iteration to a phase from its starting Linear status: `Todo`/`In Progress` = implementation, `Agent Review` = review, and `Merging` = merge.
6. Parse each run's JSONL for token counts, tool calls, repeated commands, validation commands, discovery commands, shell failures, lifecycle events, and source line evidence.

## Files

- `metrics.json`: machine-readable ticket-level metrics, run iterations, phase breakdowns, aggregates, and evidence references.
- `tickets-analyzed.md`: one row per ticket plus per-ticket phase breakdown tables.
- `workflow-analysis-report.md`: detailed findings and examples.
- `recommendations.md`: ranked recommendations tied to evidence.
- `proposed-prds.md`: draft PRD/issue ideas derived from the recommendations.
- `strategy-red-team.md`: loopholes, mitigation fixes, and confidence gates for the recommended strategy.
- `reproduction.md`: commands and function map for rerunning the extraction.
- `scripts/analyze_codex_workflows.py`: reusable extraction script for ticket-level or thread-level analysis.
- `progress-log.md`: checkpoints, assumptions, blockers, and validation notes.
