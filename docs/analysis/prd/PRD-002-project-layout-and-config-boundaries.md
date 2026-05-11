# PRD-002 Project Layout and Config Boundaries

## Problem Statement

Symphony currently uses `.symphony/workspaces` in this repository, and the root
`.gitignore` ignores all of `.symphony/`. That is safe for runtime state, but it
blocks a clean future where project-owned Symphony skills or prompt fragments
can live under `.symphony/` and be versioned.

From the user's perspective, Symphony needs a simple answer to "what should be
committed?" and "what is local runtime state?" The answer must preserve the
root `WORKFLOW.md` contract while making runtime files, logs, and databases
clearly untracked.

## Solution

Keep `WORKFLOW.md` in the project root as the only MVP project configuration
file and canonical runtime contract. Move runtime-owned state under
`.symphony/system/`, and make setup/init ensure that `.symphony/system/` is
ignored. Reserve `.symphony/skills/` and `.symphony/prompts/` for later
versioned customization, but do not require them in the MVP.

Do not introduce project-local `.symphony/config.yaml` in the MVP. Put runtime
policy in `WORKFLOW.md` and user-specific preferences in user-local state.

## User Stories

1. As a project operator, I want `WORKFLOW.md` in the repository root, so that
   the workflow contract is obvious during review.
2. As a project operator, I want one project runtime contract, so that I do not
   debug precedence between multiple project config files.
3. As a project operator, I want workspaces, logs, and runtime databases ignored,
   so that generated state is not accidentally committed.
4. As a project operator, I want setup to add the right gitignore entry, so that
   runtime state remains local.
5. As a project operator, I want project secrets to stay out of committed files,
   so that setup does not create unsafe defaults.
6. As a project operator, I want optional future project skills to have a clear
   versioned home, so that team-specific behavior can be reviewed.
7. As a project operator, I want optional future prompt fragments to have a
   clear versioned home, so that workflow text can be organized without hidden
   runtime inheritance.
8. As a Symphony maintainer, I want `.symphony/system/` to replace the current
   `.symphony/workspaces` convention, so that versioned and generated content
   are separated.
9. As a Symphony maintainer, I want the migration to be low-risk, so that the
   current self-hosting workflow keeps working while the layout changes.
10. As a Symphony maintainer, I want `doctor` to report old layout usage, so
    that local repos can migrate intentionally.
11. As a Symphony maintainer, I want workflow-relative defaults to point to
    `.symphony/system/`, so that local use produces predictable paths.
12. As a Symphony maintainer, I want logs and persistence paths to be visible in
    diagnostics, so that operators can find local state.
13. As a project reviewer, I want any project-owned Symphony customization to be
    reviewable in git, so that agent behavior changes are visible.
14. As a project reviewer, I want user-local trust choices excluded from the
    repo, so that trust remains machine/user specific.

## Implementation Decisions

- Keep root `WORKFLOW.md` as the canonical project/runtime configuration
  surface.
- Do not add project-local `.symphony/config.yaml` in the MVP.
- Introduce `.symphony/system/` as the default runtime-owned state root for
  local project use.
- Default per-project workspaces move to `.symphony/system/workspaces/`.
- Default per-project logs move to `.symphony/system/logs/`.
- Default per-project persistence moves to `.symphony/system/runtime.sqlite`.
- Setup/init ensures `.symphony/system/` is present in the project's gitignore
  unless the user explicitly opts out.
- `.symphony/skills/` and `.symphony/prompts/` are reserved as future versioned
  project-owned directories.
- The current Symphony repository can migrate from ignoring all `.symphony/` to
  ignoring `.symphony/system/` when project-owned directories are introduced.
- `doctor` reports whether runtime paths are using the new layout, the old
  layout, or user-specified paths.
- User-local state stores local checkout paths, trust consent, and personal
  preferences outside the project repository.

## Testing Decisions

- Tests should verify layout behavior from generated files and resolved runtime
  paths, not private directory-building helpers.
- Unit tests cover default path resolution for workspaces, logs, and
  persistence.
- Unit tests cover gitignore insertion when no relevant ignore entry exists.
- Unit tests cover preserving existing gitignore content and avoiding duplicate
  entries.
- Unit tests cover detection of broad `.symphony/` ignores and the resulting
  warning or migration guidance.
- Integration tests cover init/setup in a temporary git repository and assert
  that `.symphony/system/` is ignored.
- Regression tests cover existing workflow-relative path behavior.

## Out of Scope

- Storing project config in `.symphony/config.yaml`.
- Implementing full project-local skill loading.
- Moving user-local config into the project.
- Automatically deleting old `.symphony/workspaces` directories.
- Public distribution packaging.

## Further Notes

The migration cost is low because Symphony has only been used in a small number
of local repositories. This is the right time to establish the layout boundary.
