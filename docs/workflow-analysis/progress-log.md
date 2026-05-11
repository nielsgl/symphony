# Progress Log

## Checkpoints

- Revised the analysis from thread-level to ticket-level after clarification that a ticket may have multiple phase iterations.
- Rebuilt the cohort as the 50 most recent unique `NIE-*` tickets by latest local issue-workspace run.
- Included all available local run iterations for those 50 tickets, yielding 195 iterations.
- Grouped every iteration by phase using starting Linear status (`Todo`/`In Progress` = implementation, `Agent Review` = review, `Merging` = merge).
- Regenerated `metrics.json`, `tickets-analyzed.md`, `README.md`, `workflow-analysis-report.md`, `recommendations.md`, and `proposed-prds.md` from the corrected cohort.
- Added `strategy-red-team.md` after a loophole pass over data assumptions, strategy risks, mitigations, and confidence gates.
- Added reusable extraction code in `scripts/analyze_codex_workflows.py` plus rerun instructions in `reproduction.md`.
- Expanded the six proposed PRDs into individual local PRD documents under `docs/workflow-analysis/prd/` using the `to-prd` template, without publishing to Linear or GitHub.

## Assumptions

- A ticket is one unique `NIE-*` identifier.
- "Last 50 tickets" means the 50 most recent unique tickets by latest local issue-workspace Codex run timestamp.
- All available local runs for those selected tickets are included, even if older than the 50th most recent thread.
- Phase is inferred from the start status embedded in the workflow prompt because local Codex data does not expose a first-class phase field.

## Data Gaps

- No first-class ticket ledger exists; this analysis reconstructs one from thread cwd/title/prompt.
- No first-class retry relation exists between runs; ordering is chronological by ticket.
- No structured validation cache exists, so repeated validation is counted by shell command text.
- Outcome still requires inference from lifecycle events and final assistant text.

## Validation Notes

- Final validation from the ticket-level rewrite completed: required files exist, `metrics.json` parses, the cohort asserts as 50 tickets / 195 iterations, stale thread-level wording was checked, no trailing whitespace was found, `git diff --check` passed, and `git status --short` shows only `docs/workflow-analysis/`.

## Strategy Red-Team Validation

- Added loopholes, fixes, confidence gates, and remaining non-provable areas in `strategy-red-team.md`.
- Revalidated required files, JSON metrics consistency, stale wording checks, whitespace, and diff scope after the red-team update.

## Reproduction Script Validation

- `python3 docs/workflow-analysis/scripts/analyze_codex_workflows.py --mode tickets --limit 50 --current-thread-id 019e1651-a5f6-7a71-86e9-c559a536d1c0` reproduced 50 tickets, 195 run iterations, and 945,655,203 recorded tokens.
- `python3 docs/workflow-analysis/scripts/analyze_codex_workflows.py --mode threads --limit 50 --current-thread-id 019e1651-a5f6-7a71-86e9-c559a536d1c0` reproduced the original thread-level interpretation: 50 run iterations, 19 unique tickets, and 288,463,324 recorded tokens.
