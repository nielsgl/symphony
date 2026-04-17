---
name: codex-api
description: Use when a task needs interaction with the codex-dashboard backend API, such as checking health, refreshing data, reading KPIs, listing latest threads, fetching thread details, querying projects, or investigating pricing diagnostics. Do not use for frontend-only styling work, database migrations, or unrelated shell automation.
compatibility: Requires curl and local network access to http://127.0.0.1:18731 by default.
metadata:
  owner: codex-dashboard
  version: "1.0"
---

# codex-api

## Goal
Provide a reliable workflow for agents to call the codex-dashboard backend API and return accurate, concise results.

## Use This Skill
Use this skill when the user asks to:
- call backend endpoints
- check service status
- refresh ingestion data
- get KPI and timeseries metrics
- list latest threads or fetch thread details
- triage stalled workflows and question-loops
- inspect project, worktree, model mix, or pricing diagnostics

Do not use this skill when the task is strictly frontend styling, repository policy editing, or non-API scripting.

## Preflight
1. Confirm backend endpoint base URL.
Default is http://127.0.0.1:18731/api.
2. If calls fail, run a health check first.
3. If health fails, report the issue clearly and include the failing endpoint.

## Primary Workflow
1. Pick the endpoint using the routing table in references/endpoints.md.
2. Build the call with scripts/api_client.sh.
3. Prefer explicit query params over hardcoded assumptions.
4. When user provides a human project name, prefer `project_name` filtering over requiring a project ID lookup.
5. For list endpoints, include sensible limit and offset values.
6. Return a concise summary plus key JSON fields.

## Endpoint Selection Shortcuts
- Service status: GET /health
- Trigger ingest refresh: POST /refresh
- Latest global threads: GET /threads (defaults sort=updated, direction=desc)
- Latest threads for named project: GET /threads?project_name=<name>
- Project groups/worktrees: GET /projects and GET /projects/{project_id}/worktrees
- Workflow diagnostics: GET /diagnostics/workflow/stalled-threads
- Thread detail: GET /threads/{thread_id}
- Project thread list: GET /projects/{project_id}/threads
- KPI summary: GET /kpis
- Pricing diagnostics: GET /pricing/cost-diagnostics

## Redaction and Sensitive Content Rules
- Transcript responses are redacted by default.
- include_unredacted=true may return 403 unless local and enabled by backend config.
- Never assume unredacted access is available.
- If unredacted request fails, retry with redacted defaults and report the guardrail behavior.

## Scripts
- scripts/api_client.sh: generic API caller with error handling and optional pretty JSON output.
- scripts/health.sh: health probe.
- scripts/refresh.sh: trigger refresh run.
- scripts/kpis.sh: KPI query helper.
- scripts/list_threads.sh: list latest threads with pagination/sorting.
- scripts/projects.sh: list projects/worktree groups with pagination.
- scripts/project_threads.sh: list threads for a project id with pagination.
- scripts/project_worktrees.sh: inspect worktree rollups and timeseries for one project id.
- scripts/workflow_diagnostics.sh: detect stalled/question-loop thread patterns.
- scripts/thread_detail.sh: fetch one thread detail.
- scripts/pricing_diagnostics.sh: query pricing diagnostics.

## Usage Examples
Health check:

```bash
scripts/health.sh
```

Latest threads:

```bash
scripts/list_threads.sh --limit 20 --offset 0 --sort updated --direction desc
```

Latest threads for project name:

```bash
scripts/list_threads.sh --project-name codex-dashboard --limit 20 --offset 0 --sort updated --direction desc
```

Project groups:

```bash
scripts/projects.sh --limit 25 --offset 0 --include-silent true
```

Workflow diagnostics:

```bash
scripts/workflow_diagnostics.sh --project-name symphony --limit 20 --offset 0 --include-silent false
```

Thread detail:

```bash
scripts/thread_detail.sh THREAD_ID
```

KPI window:

```bash
scripts/kpis.sh --from 2026-04-01 --to 2026-04-14 --include-silent true
```

## Output Expectations
When reporting API results:
1. State endpoint and parameters used.
2. Summarize top findings first.
3. Include key fields only, not full noisy payloads unless requested.
4. If there is an API error, include HTTP status and body snippet.

## Troubleshooting
Use references/troubleshooting.md for connection, 403, 404, and empty-data troubleshooting.

## Reference
- Endpoint catalog: references/endpoints.md
- Troubleshooting: references/troubleshooting.md
- Query recipes: references/examples.md
