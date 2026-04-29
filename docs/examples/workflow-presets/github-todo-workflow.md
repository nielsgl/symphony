---
tracker:
  kind: github
  endpoint: https://api.github.com/graphql
  api_key: $GITHUB_TOKEN
  owner: your-org
  repo: your-repo
  active_states:
    - Open
  terminal_states:
    - Closed
polling:
  interval_ms: 30000
workspace:
  root: ./tests/fixtures/todo-sample-app/.symphony/workspaces
  provisioner:
    type: worktree
    repo_root: ./tests/fixtures/todo-sample-app
    base_ref: origin/main
    branch_template: feature/{{ issue.identifier }}
    teardown_mode: remove_worktree
    allow_dirty_repo: false
    fallback_to_clone_on_worktree_failure: false
  copy_ignored:
    enabled: false
    include_file: .worktreeinclude
    from: primary_worktree
    conflict_policy: skip
    require_gitignored: true
    max_files: 10000
    max_total_bytes: 5368709120
    allow_patterns: []
    deny_patterns: []
hooks:
  after_create: |
    corepack enable && pnpm install --frozen-lockfile || npm ci
    git submodule update --init --recursive
    npm run build --if-present
  before_remove: |
    node /Users/niels.van.Galen.last/code/symphony/scripts/workspace-before-remove.js
  timeout_ms: 60000
agent:
  max_concurrent_agents: 2
  max_retry_backoff_ms: 300000
  max_turns: 20
codex:
  command: codex app-server
  thread_sandbox: danger-full-access
  turn_sandbox_policy: danger-full-access
  turn_timeout_ms: 1800000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
server:
  port: 3000
---
You are implementing issue {{ issue.identifier }} for the sample todo app.

Execution policy:
1. Work only inside the assigned workspace.
2. Make the smallest viable implementation change for the issue.
3. Add or update tests when behavior changes.
4. Run the relevant test command before completion.
5. Summarize changed files, test result, and follow-up risks.

GitHub notes:
- State model is Open/Closed.
- Prioritization should rely on labels and issue ordering.
- If tracker updates are needed, use approved tooling from your environment.

Attempt metadata:
- Attempt: {{ attempt }}
- Issue title: {{ issue.title }}
- Issue description: {{ issue.description }}
