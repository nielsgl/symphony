# Query Recipes

## Health

```bash
scripts/health.sh
```

## Refresh ingest pipeline

```bash
scripts/refresh.sh
```

## KPI snapshot for date window

```bash
scripts/kpis.sh --from 2026-04-01 --to 2026-04-14 --include-silent true
```

## Latest threads (global)

```bash
scripts/list_threads.sh --limit 25 --offset 0 --sort updated --direction desc
```

## Latest threads for one project name

```bash
scripts/list_threads.sh --project-name codex-dashboard --limit 25 --offset 0 --sort updated --direction desc
```

## Latest threads for one project ID

```bash
scripts/list_threads.sh --project PROJECT_ID --limit 25 --offset 0 --sort updated --direction desc
```

## Projects (paginated)

```bash
scripts/projects.sh --limit 25 --offset 0 --include-silent true
```

## Threads for one project ID (paginated)

```bash
scripts/project_threads.sh PROJECT_ID --sort updated --limit 25 --offset 0 --include-silent true
```

## Worktrees for one project ID

```bash
scripts/project_worktrees.sh PROJECT_ID --from 2026-04-01 --to 2026-04-14 --include-silent true
```

## Workflow stalled-thread diagnostics by project name

```bash
scripts/workflow_diagnostics.sh --project-name symphony --limit 20 --offset 0 --include-silent false
```

## Thread details by id

```bash
scripts/thread_detail.sh THREAD_ID
```

## Thread details with explicit include_silent

```bash
scripts/thread_detail.sh THREAD_ID --include-silent true
```

## Attempt unredacted thread detail (may be blocked)

```bash
scripts/thread_detail.sh THREAD_ID --include-unredacted true
```

## Pricing diagnostics

```bash
scripts/pricing_diagnostics.sh
```

## Custom endpoint call via generic client

```bash
scripts/api_client.sh GET /timeseries --query "metric=tokens&grain=day&from=2026-04-01&to=2026-04-14"
```
