# Endpoint Catalog

Base URL default:
- http://127.0.0.1:18731/api

## Health and Refresh
- GET /health
  - Purpose: API readiness and latest run metadata.
- POST /refresh
  - Purpose: Trigger pipeline refresh run.

## Dashboard Metrics
- GET /kpis
  - Params: from, to, project, include_silent
- GET /timeseries
  - Params: metric (tokens|estimated_cost|reported_cost|error_rate), grain (day|week|month), from, to, project, include_silent

## Projects and Worktrees
- GET /projects
  - Params: include_silent
- GET /projects/{project_id}/threads
  - Params: from, to, sort (cost|tokens|updated), include_silent
- GET /projects/{project_id}/worktrees
  - Params: from, to, include_silent

## Threads
- GET /threads
  - Params:
    - project
    - project_name (case-insensitive exact project name, includes all matching project_ids)
    - from, to
    - min_tokens, max_tokens
    - min_turns, max_turns
    - sort (cost|tokens|turns|updated|created|project)
    - direction (asc|desc)
    - limit (1-500), offset (>=0)
    - include_silent
  - Notes:
    - Default sort=updated and direction=desc.
    - `project` and `project_name` are mutually exclusive; sending both returns 400.
- GET /threads/{thread_id}
  - Params: include_silent, include_unredacted
  - Notes:
    - Transcript is redacted by default.
    - include_unredacted may return 403 if backend guardrails are not satisfied.

## Models and Pricing
- GET /models/mix
  - Params: from, to, project
- GET /pricing/snapshots
- GET /pricing/snapshots/{snapshot_id}/models
- GET /pricing/model-timeline
  - Params: model
- POST /pricing/backfill
- GET /pricing/cost-diagnostics

## Billing Import
- POST /billing/import
  - Content type: multipart/form-data
  - Fields:
    - file (required)
    - source (optional)

## Returned Shape Patterns
- List endpoints typically return:
  - items: []
  - plus pagination context (for /threads: total, limit, offset)
- Detail endpoints typically return:
  - thread or object metadata
  - nested metric/timeline arrays
