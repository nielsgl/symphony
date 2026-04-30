# Workflow Configuration Guide (`WORKFLOW.example.md`)

This is a comprehensive reference for Symphony workflow configuration.
It documents:
- all supported config keys,
- defaults,
- allowed values,
- validation rules,
- runtime behavior,
- a full working example.

Use this as the baseline when creating or reviewing `WORKFLOW.md`.

## File format
A workflow file has two parts:
1. YAML front matter between leading and closing `---`
2. Prompt template body after the closing `---`

Example skeleton:

```markdown
---
# YAML config here
---
Prompt template here
```

## Complete example (all options)

```markdown
---
tracker:
  kind: linear
  endpoint: https://api.linear.app/graphql
  api_key: $LINEAR_API_KEY
  project_slug: SYMPHONY
  owner: ""            # github only (optional for linear)
  repo: ""             # github only (optional for linear)
  github_linking:
    mode: off          # off | warn | required
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
    - Done

polling:
  interval_ms: 30000

workspace:
  root: ~/.symphony/workspaces
  provisioner:
    type: none
    repo_root: ""
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
  after_create: ""
  before_run: ""
  after_run: ""
  before_remove: ""
  timeout_ms: 60000

agent:
  max_concurrent_agents: 10
  max_retry_backoff_ms: 300000
  max_turns: 20
  max_concurrent_agents_by_state:
    in_progress: 5
    todo: 3

codex:
  command: codex app-server
  security_profile: strict
  approval_policy: never
  # approval_policy also supports object form, for example:
  # approval_policy:
  #   reject:
  #     sandbox_approval: true
  #     rules: true
  #     mcp_elicitations: true
  thread_sandbox: read-only
  turn_sandbox_policy: read-only
  user_input_policy: fail_attempt
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000

persistence:
  enabled: true
  db_path: ~/.symphony/runtime.sqlite
  retention_days: 14

validation:
  ui_evidence_profile: baseline # baseline | strict

observability:
  dashboard_enabled: true
  refresh_ms: 4000
  render_interval_ms: 1000

worker:
  ssh_hosts:
    - build-host-1
    - build-host-2
  max_concurrent_agents_per_host: 2

server:
  port: 3000
---
You are Symphony running issue {{ issue.identifier }} (attempt {{ attempt }}).

Title: {{ issue.title }}
Description: {{ issue.description }}

Implement the smallest correct change.
Run relevant tests.
Return a concise summary with changed files and verification output.
```

## Defaults and allowed values

### `tracker`

| Key | Type | Default | Allowed values / notes | Required by validator |
|---|---|---|---|---|
| `tracker.kind` | string | `""` | `linear`, `github`, or `memory` | Yes |
| `tracker.endpoint` | string | by kind | `https://api.linear.app/graphql` (`linear`), `https://api.github.com/graphql` (`github`), `memory://local` (`memory`) | No |
| `tracker.api_key` | string | by kind env | `$LINEAR_API_KEY` (`linear`), `$GITHUB_TOKEN` (`github`), empty (`memory`) | Required except `memory` |
| `tracker.project_slug` | string | `""` | project key/slug | Required for `linear` |
| `tracker.assignee` | string | unset | optional assignee routing filter for `linear`; supports `me`/`viewer` | No |
| `tracker.owner` | string | `""` | GitHub org/user owner | Required for `github` |
| `tracker.repo` | string | `""` | GitHub repo name | Required for `github` |
| `tracker.github_linking.mode` | string | `off` | `off`, `warn`, `required`; `required` skips dispatch when issue has no linked GitHub issue | No |
| `tracker.active_states` | string[] | by kind | `linear`: `Todo`, `In Progress`; `github`: `Open` | No, but see github rule |
| `tracker.terminal_states` | string[] | by kind | `linear`: `Closed`, `Cancelled`, `Canceled`, `Duplicate`, `Done`; `github`: `Closed` | No |

GitHub-specific active state rule:
- For `tracker.kind: github`, `active_states` must include at least one state that maps to `Open` or `Closed`.
- If none map, validation fails (`invalid_tracker_active_states_for_github`).

Memory tracker note:
- `tracker.kind: memory` is for local/dev deterministic testing.
- It does not require remote credentials.
- Start with seeded issues in tests or write to it using tracker write-paths.

### `polling`

| Key | Type | Default | Allowed values / notes | Required |
|---|---|---|---|---|
| `polling.interval_ms` | integer | `30000` | integer milliseconds; positive values are recommended | No |

### `workspace`

| Key | Type | Default | Allowed values / notes | Required |
|---|---|---|---|---|
| `workspace.root` | string | `<tmp>/symphony_workspaces` | absolute or relative path | No |
| `workspace.provisioner.type` | string | `none` | `none`, `worktree`, `clone` | No |
| `workspace.provisioner.repo_root` | string | unset | required when `type=worktree`; absolute or workflow-relative path | Conditional |
| `workspace.provisioner.base_ref` | string | `origin/main` | git ref used when provisioning new worktrees/clones | No |
| `workspace.provisioner.branch_template` | string | `feature/{{ issue.identifier }}` | for `worktree`, must include `{{ issue.identifier }}` | Conditional |
| `workspace.provisioner.teardown_mode` | string | `remove_worktree` | `remove_worktree` or `keep` | No |
| `workspace.provisioner.allow_dirty_repo` | boolean | `false` | if false, worktree provisioning fails on dirty repo | No |
| `workspace.provisioner.fallback_to_clone_on_worktree_failure` | boolean | `false` | reserved fallback toggle for clone fallback behavior | No |
| `workspace.copy_ignored.enabled` | boolean | `false` | enable built-in `.worktreeinclude` copy engine | No |
| `workspace.copy_ignored.include_file` | string | `.worktreeinclude` | absolute or workflow-relative include file path | No |
| `workspace.copy_ignored.from` | string | `primary_worktree` | `primary_worktree` or `repo_root` | No |
| `workspace.copy_ignored.conflict_policy` | string | `skip` | `skip`, `overwrite`, `fail` | No |
| `workspace.copy_ignored.require_gitignored` | boolean | `true` | require candidates to be gitignored in source repo | No |
| `workspace.copy_ignored.max_files` | integer | `10000` | safety cap on copied/skipped/blocked candidates | No |
| `workspace.copy_ignored.max_total_bytes` | integer | `5368709120` | safety cap on copied bytes | No |
| `workspace.copy_ignored.allow_patterns` | string[] | `[]` | optional additional allow filter for included candidates | No |
| `workspace.copy_ignored.deny_patterns` | string[] | `[]` | optional deny extensions (hard denylist always applies) | No |

### `hooks`

| Key | Type | Default | Allowed values / notes | Required |
|---|---|---|---|---|
| `hooks.after_create` | string | unset | shell command | No |
| `hooks.before_run` | string | unset | shell command | No |
| `hooks.after_run` | string | unset | shell command | No |
| `hooks.before_remove` | string | unset | shell command | No |
| `hooks.timeout_ms` | integer | `60000` | if `<= 0`, resolver resets to `60000` | No |

Hook-based `.worktreeinclude` bootstrap (alternative to built-in copy engine):

- Script: `/Users/niels.van.Galen.last/code/symphony/scripts/worktree_bootstrap.py`
- Typical `after_create`:
  - `python3 /Users/niels.van.Galen.last/code/symphony/scripts/worktree_bootstrap.py --source /absolute/repo/root`
- Features:
  - target defaults to current working directory (workspace)
  - `--dry-run` preview mode
  - skips existing files by default (`--force` to overwrite)
  - blocks sensitive-looking files unless `--allow-sensitive`

### `agent`

| Key | Type | Default | Allowed values / notes | Required |
|---|---|---|---|---|
| `agent.max_concurrent_agents` | integer | `10` | concurrency cap | No |
| `agent.max_retry_backoff_ms` | integer | `300000` | retry cap in ms | No |
| `agent.max_turns` | integer | `20` | max turns per run | No |
| `agent.max_concurrent_agents_by_state` | map<string,int> | `{}` | only positive integers kept; keys are normalized to lowercase | No |

### `codex`

| Key | Type | Default | Allowed values / notes | Required by validator |
|---|---|---|---|---|
| `codex.command` | string | `codex app-server` | non-empty command string | Yes |
| `codex.security_profile` | string | unset | `strict` or `balanced` are meaningful profiles | No |
| `codex.approval_policy` | string or object | unset | string: `never`, `on-request`; object form: `reject` booleans | No |
| `codex.thread_sandbox` | string | unset | `workspace-write`, `read-only`, `danger-full-access` | No |
| `codex.turn_sandbox_policy` | string | unset | `workspace`, `workspace-write`, `read-only`, `danger-full-access` | No |
| `codex.user_input_policy` | string | unset | only `fail_attempt` supported | No |
| `codex.turn_timeout_ms` | integer | `3600000` | turn timeout in ms | No |
| `codex.read_timeout_ms` | integer | `5000` | app-server read timeout in ms | No |
| `codex.stall_timeout_ms` | integer | `300000` | stall timeout in ms | No |

Security profile behavior:
- If `security_profile` is omitted, effective default baseline is `strict`.
- If `security_profile: balanced`, baseline policy becomes balanced.
- Explicit `approval_policy`, `thread_sandbox`, `turn_sandbox_policy`, `user_input_policy` override the baseline when valid.

`approval_policy` object form:

```yaml
codex:
  approval_policy:
    reject:
      sandbox_approval: true
      rules: true
      mcp_elicitations: true
```

Rules:
- `reject` is optional.
- allowed `reject` keys are exactly:
  - `sandbox_approval`
  - `rules`
  - `mcp_elicitations`
- each value must be boolean.

### `persistence`

| Key | Type | Default | Allowed values / notes | Required |
|---|---|---|---|---|
| `persistence.enabled` | boolean | `true` | `true` or `false` | No |
| `persistence.db_path` | string | `<workflow-dir>/.symphony/runtime.sqlite` | path to sqlite db | No |
| `persistence.retention_days` | integer | `14` | clamped to minimum `1` | No |

Runtime note:
- When the runtime is started with a workflow path, default persistence path is
  derived from that workflow file directory.
- Fallback outside that context remains `~/.symphony/runtime.sqlite`.

### `worker`

| Key | Type | Default | Allowed values / notes | Required |
|---|---|---|---|---|
| `worker.ssh_hosts` | string[] | unset | empty/whitespace entries removed | No |
| `worker.max_concurrent_agents_per_host` | integer | unset | must be positive if provided (`> 0`) | No |

### `observability`

| Key | Type | Default | Allowed values / notes | Required |
|---|---|---|---|---|
| `observability.dashboard_enabled` | boolean | `true` | when `false`, background dashboard stream/render loop is disabled | No |
| `observability.refresh_ms` | integer | `4000` | poll cadence in ms (resolver minimum `500`) | No |
| `observability.render_interval_ms` | integer | `1000` | runtime clock repaint cadence in ms (resolver minimum `250`) | No |

### `server`

| Key | Type | Default | Allowed values / notes | Required |
|---|---|---|---|---|
| `server.port` | integer | unset | explicit local API port (recommended valid TCP port) | No |

### `validation`

| Key | Type | Default | Allowed values / notes | Required |
|---|---|---|---|---|
| `validation.ui_evidence_profile` | string | `baseline` | `baseline` or `strict` | No |

## Resolution behavior (important)

### Environment variable interpolation
- Resolver interpolates when a string starts with `$`.
- Example: `api_key: $LINEAR_API_KEY`.
- Missing env var resolves to empty string, which can then fail validation.

### Path expansion and normalization
Path-like values support:
- `~` and `~/...` home expansion
- `$VAR` token first, then home expansion
- normalization for path-like strings

Applied to:
- `workspace.root`
- `persistence.db_path`

### Type coercion
- Integer fields accept numeric strings like `"30000"`.
- Boolean fields accept `"true"` / `"false"` strings.
- list fields keep only string entries.

## Validation failure codes

Workflow/file parse errors:
- `missing_workflow_file`
- `workflow_parse_error`
- `workflow_front_matter_not_a_map`
- `template_parse_error`
- `template_render_error`

Config validation errors:
- `missing_tracker_kind`
- `unsupported_tracker_kind`
- `missing_tracker_api_key`
- `missing_tracker_project_slug`
- `missing_tracker_owner`
- `missing_tracker_repo`
- `invalid_tracker_active_states_for_github`
- `missing_codex_command`
- `invalid_codex_approval_policy`
- `invalid_codex_approval_policy_shape`
- `invalid_codex_thread_sandbox`
- `invalid_codex_turn_sandbox_policy`
- `invalid_codex_user_input_policy`
- `invalid_worker_max_concurrent_agents_per_host`
- `invalid_validation_ui_evidence_profile`

## Prompt template context and strictness
Template rendering uses strict mode.

Available context:
- `issue` (tracker issue object)
- `attempt` (`number | null`)

Common fields used in prompts:
- `{{ issue.identifier }}`
- `{{ issue.title }}`
- `{{ issue.description }}`
- `{{ attempt }}`

Strict behavior:
- unknown variables fail render (`template_render_error`)
- invalid Liquid syntax fails parse (`template_parse_error`)

## Recommended presets

### Linear default preset
- `tracker.kind: linear`
- `tracker.endpoint: https://api.linear.app/graphql`
- `tracker.api_key: $LINEAR_API_KEY`
- `tracker.project_slug: <your-project>`
- active states: `Todo`, `In Progress`
- terminal states: `Closed`, `Cancelled`, `Canceled`, `Duplicate`, `Done`

### GitHub default preset
- `tracker.kind: github`
- `tracker.endpoint: https://api.github.com/graphql`
- `tracker.api_key: $GITHUB_TOKEN`
- `tracker.owner: <org-or-user>`
- `tracker.repo: <repo>`
- active states: `Open`
- terminal states: `Closed`

## Practical notes
- Keep `api_key` as `$ENV_VAR`, not plain text.
- Keep `codex.command` explicit if your environment needs a wrapper.
- Keep `hooks.*` unset unless you need lifecycle shell hooks.
- Prefer strict profile defaults unless you intentionally need balanced behavior.
- If you use GitHub tracker, always set `owner` and `repo`.

## Minimal valid examples

### Minimal Linear

```markdown
---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: SYMPHONY
codex:
  command: codex app-server
---
Work on {{ issue.identifier }} (attempt {{ attempt }}).
```

### Minimal GitHub

```markdown
---
tracker:
  kind: github
  api_key: $GITHUB_TOKEN
  owner: your-org
  repo: your-repo
codex:
  command: codex app-server
---
Work on {{ issue.identifier }} (attempt {{ attempt }}).
```
