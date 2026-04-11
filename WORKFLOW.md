---
tracker:
  kind: linear
  endpoint: https://api.linear.app/graphql
  api_key: $LINEAR_API_KEY
  project_slug: SYMPHONY
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Canceled
polling:
  interval_ms: 30000
workspace:
  root: ./.symphony/workspaces
hooks:
  timeout_ms: 60000
agent:
  max_concurrent_agents: 2
  max_retry_backoff_ms: 300000
  max_turns: 20
codex:
  command: codex app-server
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
server:
  port: 3000
---
You are Symphony running issue {{ issue.identifier }} (attempt {{ attempt }}).

Follow the repository specification and keep changes minimal, deterministic, and test-backed.
