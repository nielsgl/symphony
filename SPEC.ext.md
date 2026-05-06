# Symphony Extension Specification

This repository implements the base contract in `SPEC.md` plus the Symphony
extensions documented here. `SPEC.md` remains the upstream/reference
specification. This document is normative for local Symphony behavior that is
intentionally outside the base contract.

## 1. Workflow Config Extensions

The workflow front matter accepts the fields below under `tracker`. These fields
are parsed into the typed effective workflow config so runtime components can
consume them without re-parsing raw YAML.

### 1.1 `tracker.handoff_states`

`tracker.handoff_states` is an optional list of tracker state names.

Default: `[]`.

Validation:

- The value must be a list of non-empty strings when provided.
- A state listed in `tracker.handoff_states` must not also be listed in
  `tracker.terminal_states`.

Lifecycle meaning:

- A handoff state is a non-terminal state where the current implementation run
  should stop and leave issue handling to another role or workflow.
- Handoff states are not cleanup states. They preserve the issue and workspace
  context needed by the next role.
- Terminal states must not be used for workflow handoff because terminal
  cleanup may remove workspaces before the next role can inspect or continue
  the work.

Example:

```yaml
tracker:
  active_states:
    - Todo
    - In Progress
    - Agent Review
    - Merging
    - Rework
  handoff_states:
    - Agent Review
    - Human Review
```

### 1.2 `tracker.fresh_dispatch_states`

`tracker.fresh_dispatch_states` is an optional list of tracker state names.

Default: `[]`.

Validation:

- The value must be a list of non-empty strings when provided.
- Every state listed in `tracker.fresh_dispatch_states` must also be listed in
  `tracker.handoff_states`.
- A state listed in `tracker.fresh_dispatch_states` must not also be listed in
  `tracker.terminal_states`.

Lifecycle meaning:

- A fresh-dispatch state is a handoff state where the next automation role
  should start as a new run without inheriting the previous implementation
  context.
- Fresh dispatch is intended for role boundaries such as review automation,
  where independence matters more than continuation.
- This extension only defines and validates the config contract. Runtime
  dispatch behavior is implemented by later slices.

Example:

```yaml
tracker:
  handoff_states:
    - Agent Review
    - Human Review
  fresh_dispatch_states:
    - Agent Review
```
