# Workflow Analysis Report

## Executive Findings

1. The corrected ticket-level cohort contains 50 tickets and 195 run iterations. The previous thread-level view counted phase handoffs as separate tickets; this version groups `implementation -> review -> implementation -> review -> merge` flows under one ticket.
2. The 50 tickets consumed 945,655,203 recorded tokens. Implementation is still the dominant phase: 765,625,124 tokens across 92 implementation iterations, or 81.0% of total cohort tokens.
3. Multi-iteration tickets are normal, not exceptional. 50 of 50 tickets have more than one run iteration. `NIE-81`, `NIE-87`, `NIE-103`, `NIE-84`, `NIE-95`, `NIE-100`, `NIE-79`, and `NIE-119` show especially high iteration counts.
4. Validation and context rediscovery remain systemic across stages: `npm test` appears 210 times, `npm run build` 221 times, `git diff --check` 176 times, and `npm run check:meta` 135 times across the 195 iterations. Discovery-category commands total 5934.
5. The expensive unit is the whole ticket flow, not a single run. Example: `NIE-121` is one ticket with two stages (`implementation -> review`), 2 iterations, and 7,835,268 tokens. `NIE-78` is one ticket with 6 iterations and 32,683,063 tokens.

## Data Quality Notes

The local data is strong enough to group tickets, phases, tokens, repeated commands, failed commands, and lifecycle events. It still lacks first-class `run_outcome`, `phase_started_at`, `phase_completed_at`, `failure_category`, `validation_intent`, and ticket-level orchestration summaries. Phase attribution is inferred from the starting Linear status embedded in each workflow prompt.

## Phase Breakdown

- `implementation`: 92 iterations across 50 tickets, 765,625,124 tokens, 1101.47 min, 2664 validation/git commands, 4059 discovery commands.
- `merge`: 42 iterations across 38 tickets, 99,556,387 tokens, 224.96 min, 859 validation/git commands, 709 discovery commands.
- `review`: 61 iterations across 27 tickets, 80,473,692 tokens, 189.98 min, 789 validation/git commands, 1166 discovery commands.

## Ticket Token Outliers

- `NIE-87`: 13 iterations, flow `implementation -> review -> implementation -> review -> implementation -> review -> implementation -> review -> merge`, 61,875,458 tokens, 101.07 min, evidence `~/.codex/sessions/2026/05/07/rollout-2026-05-07T17-42-50-019e031b-2267-7da1-8623-f02ef1337a85.jsonl:28`.
- `NIE-95`: 9 iterations, flow `implementation -> review -> implementation -> review -> implementation -> review -> implementation -> review -> merge`, 45,616,589 tokens, 70.79 min, evidence `~/.codex/sessions/2026/05/07/rollout-2026-05-07T21-24-38-019e03e6-31d6-77b3-bec2-9d30cb6f048a.jsonl:657`.
- `NIE-81`: 16 iterations, flow `implementation -> review -> implementation -> review -> implementation -> review -> implementation -> review -> implementation -> review -> merge -> implementation`, 43,827,750 tokens, 78.25 min, evidence `~/.codex/sessions/2026/05/07/rollout-2026-05-07T11-51-44-019e01d9-b00f-7bb3-bd3e-220bbcbd3323.jsonl:428`.
- `NIE-103`: 10 iterations, flow `implementation -> review -> implementation -> review -> implementation -> review -> implementation -> review -> implementation -> review`, 43,406,905 tokens, 66.2 min, evidence `~/.codex/sessions/2026/05/08/rollout-2026-05-08T12-04-11-019e070b-7466-75a1-a737-e35e72652f74.jsonl:577`.
- `NIE-100`: 8 iterations, flow `implementation -> review -> implementation -> review`, 36,219,424 tokens, 77.67 min, evidence `~/.codex/sessions/2026/05/08/rollout-2026-05-08T08-32-42-019e0649-d4ba-75b3-b850-35665d0060b0.jsonl:530`.
- `NIE-84`: 10 iterations, flow `implementation -> review -> implementation -> review -> implementation -> review -> implementation -> merge`, 33,700,403 tokens, 63.95 min, evidence `~/.codex/sessions/2026/05/07/rollout-2026-05-07T15-12-13-019e0291-3e19-7813-9026-f6d5111f3a50.jsonl:562`.
- `NIE-78`: 6 iterations, flow `implementation -> review -> implementation -> review -> merge`, 32,683,063 tokens, 43.94 min, evidence `~/.codex/sessions/2026/05/07/rollout-2026-05-07T11-27-40-019e01c3-a854-7c82-b9ff-90c3998f760e.jsonl:34`.
- `NIE-69`: 4 iterations, flow `implementation -> merge`, 26,562,076 tokens, 41.74 min, evidence `~/.codex/sessions/2026/05/06/rollout-2026-05-06T22-31-09-019dfefc-bab7-7e91-a257-784d1fb086aa.jsonl:449`.

These are ticket-level costs, not duplicate tickets. Each includes all available local iterations for that `NIE-*` identifier.

## High-Cost Run Iterations Inside Tickets

- `NIE-87` `019e032a-67cb-77e1-b470-d3a946f26424` phase `implementation` iteration 3: 25,856,039 tokens, evidence `~/.codex/sessions/2026/05/07/rollout-2026-05-07T17-59-31-019e032a-67cb-77e1-b470-d3a946f26424.jsonl:911`.
- `NIE-78` `019e08cd-4873-7be1-92c2-af0b6fc02a99` phase `implementation` iteration 2: 22,893,291 tokens, evidence `~/.codex/sessions/2026/05/08/rollout-2026-05-08T20-15-31-019e08cd-4873-7be1-92c2-af0b6fc02a99.jsonl:759`.
- `NIE-77` `019e0132-b8ba-7962-a320-034dfbcb1ffe` phase `implementation` iteration 1: 21,554,148 tokens, evidence `~/.codex/sessions/2026/05/07/rollout-2026-05-07T08-49-21-019e0132-b8ba-7962-a320-034dfbcb1ffe.jsonl:674`.
- `NIE-95` `019e03e6-31d6-77b3-bec2-9d30cb6f048a` phase `implementation` iteration 1: 20,336,191 tokens, evidence `~/.codex/sessions/2026/05/07/rollout-2026-05-07T21-24-38-019e03e6-31d6-77b3-bec2-9d30cb6f048a.jsonl:656`.
- `NIE-102` `019e06e4-8d7f-7252-a4fb-33823b485624` phase `implementation` iteration 1: 19,563,425 tokens, evidence `~/.codex/sessions/2026/05/08/rollout-2026-05-08T11-21-42-019e06e4-8d7f-7252-a4fb-33823b485624.jsonl:6`.
- `NIE-114` `019e07c5-d144-7b11-ac8f-1c2fc83c09fc` phase `implementation` iteration 1: 18,885,902 tokens, evidence `~/.codex/sessions/2026/05/08/rollout-2026-05-08T15-27-45-019e07c5-d144-7b11-ac8f-1c2fc83c09fc.jsonl:655`.
- `NIE-115` `019e07db-585f-7da0-9fed-225f0b85088e` phase `implementation` iteration 1: 17,711,202 tokens, evidence `~/.codex/sessions/2026/05/08/rollout-2026-05-08T15-51-16-019e07db-585f-7da0-9fed-225f0b85088e.jsonl:625`.
- `NIE-101` `019e06a6-355a-77f2-a379-e277ce301046` phase `implementation` iteration 1: 16,693,466 tokens, evidence `~/.codex/sessions/2026/05/08/rollout-2026-05-08T10-13-36-019e06a6-355a-77f2-a379-e277ce301046.jsonl:595`.

The iteration outliers explain where the ticket-level totals came from. For example, `NIE-78` has multiple stages, but the high-cost implementation iteration dominates the ticket's total.

## Multi-Iteration Flows

- `NIE-81`: 16 iterations, flow `implementation -> review -> implementation -> review -> implementation -> review -> implementation -> review -> implementation -> review -> merge -> implementation`, 43,827,750 tokens.
- `NIE-87`: 13 iterations, flow `implementation -> review -> implementation -> review -> implementation -> review -> implementation -> review -> merge`, 61,875,458 tokens.
- `NIE-103`: 10 iterations, flow `implementation -> review -> implementation -> review -> implementation -> review -> implementation -> review -> implementation -> review`, 43,406,905 tokens.
- `NIE-84`: 10 iterations, flow `implementation -> review -> implementation -> review -> implementation -> review -> implementation -> merge`, 33,700,403 tokens.
- `NIE-95`: 9 iterations, flow `implementation -> review -> implementation -> review -> implementation -> review -> implementation -> review -> merge`, 45,616,589 tokens.
- `NIE-100`: 8 iterations, flow `implementation -> review -> implementation -> review`, 36,219,424 tokens.
- `NIE-79`: 8 iterations, flow `implementation -> review -> implementation -> review -> merge`, 16,110,434 tokens.
- `NIE-119`: 7 iterations, flow `implementation -> review -> implementation -> review -> implementation -> review -> merge`, 21,010,571 tokens.
- `NIE-78`: 6 iterations, flow `implementation -> review -> implementation -> review -> merge`, 32,683,063 tokens.
- `NIE-98`: 5 iterations, flow `implementation -> review -> implementation -> merge`, 24,283,514 tokens.

The compact phase flow intentionally collapses consecutive duplicate phases. The full per-run sequence is preserved in `tickets-analyzed.md` and `metrics.json.tickets[].phase_flow`.

## Repeated Validation And Rediscovery

Top repeated commands across the 50-ticket / 195-iteration cohort include:

- `git status --short --branch`: 256 calls.
- `npm test`: 210 calls.
- `npm run build`: 221 calls.
- `git diff --check`: 176 calls.
- `npm run check:meta`: 135 calls.

This reinforces the main recommendation: a ticket-level validation ledger should allow later review/merge iterations to reuse still-valid evidence instead of rerunning full checks by default.

## Failed Shell Commands And Preventable Loops

- `NIE-86` `019e032d-871a-7d30-b540-65efa5a61f0b` phase `implementation`: 7 failed shell commands; sample `rg -n "interface OrchestratorOptions|inactive_worker|config:" src/orchestrator/types.ts src/config* src -g '*.ts'` at `~/.codex/sessions/2026/05/07/rollout-2026-05-07T18-02-55-019e032d-871a-7d30-b540-65efa5a61f0b.jsonl:88`.
- `NIE-119` `019e0822-2aaf-76a0-b0f3-60fcecc9e909` phase `implementation`: 6 failed shell commands; sample `git config rerere.enabled true` at `~/.codex/sessions/2026/05/08/rollout-2026-05-08T17-08-37-019e0822-2aaf-76a0-b0f3-60fcecc9e909.jsonl:89`.
- `NIE-81` `019e0207-9317-7541-b881-b7047b7c1e07` phase `implementation`: 6 failed shell commands; sample `git config rerere.enabled true` at `~/.codex/sessions/2026/05/07/rollout-2026-05-07T12-41-51-019e0207-9317-7541-b881-b7047b7c1e07.jsonl:67`.
- `NIE-74` `019dff00-e3ee-78e0-a7cd-e908f0ba2967` phase `implementation`: 6 failed shell commands; sample `git config rerere.autoupdate true` at `~/.codex/sessions/2026/05/06/rollout-2026-05-06T22-35-41-019dff00-e3ee-78e0-a7cd-e908f0ba2967.jsonl:128`.
- `NIE-96` `019e08cd-44dd-7573-a2e8-b36b851cb99d` phase `implementation`: 4 failed shell commands; sample `git config rerere.enabled true` at `~/.codex/sessions/2026/05/08/rollout-2026-05-08T20-15-30-019e08cd-44dd-7573-a2e8-b36b851cb99d.jsonl:79`.
- `NIE-118` `019e0822-2aaf-7942-9dd6-2812c8ce226d` phase `implementation`: 4 failed shell commands; sample `git config rerere.enabled true` at `~/.codex/sessions/2026/05/08/rollout-2026-05-08T17-08-37-019e0822-2aaf-7942-9dd6-2812c8ce226d.jsonl:98`.

Failures still cluster around git preflight/config, missing template/file probes, and generated shell snippets for commit or PR bodies. These should be converted into structured preflight checks and deterministic helper commands.

## Instrumentation Gaps

- Missing ticket-level orchestration ledger: grouping currently requires offline reconstruction by `NIE-*`.
- Missing phase/outcome records: phase is inferred from Linear start status and outcome from lifecycle/final text.
- Missing validation cache key: repeated validation cannot be safely reused without tree/env/artifact identity.
- Missing retry relationship: iterations are grouped by ticket, but the system does not explicitly encode whether a run is initial implementation, repair, review, merge, abort recovery, or manual handoff.

## Strategy Confidence After Red-Team

The strategy is now bounded more tightly: optimize Symphony around a ticket-level lifecycle with phase iterations, then reduce duplicated work through validation reuse, compact handoff packets, repair-loop controls, and structured outcome telemetry.

The red-team pass found that the current data cannot prove exact future savings. It can prove the current shape of waste: repeated phase iterations, repeated validations, repeated discovery, and missing ticket-level memory. See `strategy-red-team.md` for loopholes, fixes, and confidence gates.
