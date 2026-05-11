# PRD-004 Init and Safe Materialization

## Problem Statement

Projects that do not already have a `WORKFLOW.md` need a safe bootstrap path.
Today, users must copy examples and hand-edit tracker settings, hooks, states,
workspace paths, and prompt text. That makes local adoption slower and increases
the risk that generated project workflow is either too Symphony-specific or
missing important runtime policy.

From the user's perspective, `symphony init` should propose a complete,
readable workflow and any supporting files, show what will change, and avoid
overwriting existing project files unless explicitly requested.

## Solution

Implement `symphony init` as a safe materialization command backed by the
composable profile registry. It detects project context, resolves packs or
bundles, renders a complete root `WORKFLOW.md`, optionally writes supporting
files, updates gitignore for `.symphony/system/`, and validates the generated
workflow before claiming success.

The MVP does not create project-local `.symphony/config.yaml`; project runtime
policy lives in root `WORKFLOW.md`.

## User Stories

1. As a project operator, I want `symphony init --dry-run`, so that I can review
   proposed files before writing them.
2. As a project operator, I want `symphony init` to detect my git root, so that
   generated paths are project-relative.
3. As a project operator, I want tracker selection prompts, so that I can choose
   Linear, GitHub, or memory when not specified.
4. As a project operator, I want pack and bundle flags, so that setup can be
   terse or explicit.
5. As a project operator, I want generated `WORKFLOW.md` to be complete, so that
   the runtime contract is inspectable.
6. As a project operator, I want generated workflow comments to identify chosen
   packs, so that defaults are reviewable.
7. As a project operator, I want existing files preserved by default, so that
   init cannot destroy hand-written workflow policy.
8. As a project operator, I want `--force` or explicit confirmation for
   overwrites, so that intentional rewrites are possible.
9. As a project operator, I want `.env.example` generated when credentials are
   needed, so that required environment variables are documented without
   committing secrets.
10. As a project operator, I want `.worktreeinclude` generated only when the
    workspace strategy needs it, so that projects do not get unnecessary files.
11. As a project operator, I want `.gitignore` updated with `.symphony/system/`,
    so that runtime state remains local.
12. As a project operator, I want GitHub owner/repo detected from remotes, so
    that GitHub setup is fast but still reviewable.
13. As a project operator, I want Node package-manager detection when using a
    Node toolchain pack, so that hooks match the project.
14. As a project operator, I want init to validate generated workflow before
    writing success output, so that bad templates fail early.
15. As a Symphony maintainer, I want init to avoid `symphony-internal` unless
    explicitly requested, so that arbitrary projects do not inherit internal
    Symphony lifecycle assumptions.
16. As a Symphony maintainer, I want init to support non-interactive mode, so
    that generated workflows can be tested in CI.
17. As a project reviewer, I want all runtime policy in root `WORKFLOW.md`, so
    that project review does not require chasing hidden config files.

## Implementation Decisions

- Build a deep `Workflow Materializer` module that takes resolved packs,
  detected project facts, and user choices, then returns an ordered file plan.
- The file plan includes path, action, rendered content, overwrite status, and
  validation notes.
- `symphony init --dry-run` prints the file plan without writing files.
- `symphony init` writes only after conflict checks and confirmation rules pass.
- Existing files are never overwritten without `--force` or explicit
  confirmation.
- Root `WORKFLOW.md` is the primary generated artifact.
- `.env.example` is generated when selected packs require environment
  variables.
- `.worktreeinclude` is generated only when selected workspace behavior needs
  ignored-file copying.
- `.gitignore` is updated to include `.symphony/system/` when missing.
- Project-local `.symphony/config.yaml` is not generated in the MVP.
- Init can run interactively or non-interactively with complete flags.
- Generated workflows must pass the existing workflow parser and config
  validator.

## Testing Decisions

- Tests should verify generated file plans and written file outcomes, not
  private rendering helpers.
- Unit tests cover dry-run file plans for common pack combinations.
- Unit tests cover overwrite protection, `--force`, and confirmation paths.
- Unit tests cover `.gitignore` updates and duplicate avoidance.
- Unit tests cover `.env.example` generation without secrets.
- Unit tests cover detection inputs for git remotes and Node package managers.
- Integration tests run init in temporary git repositories and validate the
  generated `WORKFLOW.md`.
- Regression tests ensure init does not select `symphony-internal` by default.

## Out of Scope

- Runtime workflow inheritance.
- Project-local `.symphony/config.yaml`.
- Full language-specific setup beyond Node and generic toolchains.
- Public package distribution.
- Automatically configuring tracker projects through Linear or GitHub APIs.

## Further Notes

Init should be boring and explicit. Its main job is to create a trustworthy
starting point, not to hide runtime behavior behind a profile system.
