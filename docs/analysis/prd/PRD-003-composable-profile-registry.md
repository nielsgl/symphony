# PRD-003 Composable Profile Registry

## Problem Statement

The current plan describes examples such as `linear-node`, but that combines
tracker choice, workspace strategy, toolchain assumptions, and workflow style
into a single name. This is convenient at first but can become rigid as soon as
projects mix different trackers, languages, and workflow expectations.

From the user's perspective, project setup should feel plug-and-play without
forcing every combination to become a bespoke built-in profile. The user should
be able to choose Linear with Node, GitHub with a generic toolchain, or memory
tracking for a local demo without Symphony hiding the resulting runtime policy.

## Solution

Create a composable profile registry made of profile packs. Packs are grouped
by dimension, such as tracker, workspace, toolchain, and workflow intensity.
Named bundles can still exist for convenience, but they resolve into explicit
pack combinations and materialize a complete `WORKFLOW.md`.

Keep `symphony-internal` as a protected golden alias to the checked-in Symphony
`WORKFLOW.md`, not as a generated template.

## User Stories

1. As a project operator, I want to choose a tracker pack, so that Linear,
   GitHub, or local memory behavior is explicit.
2. As a project operator, I want to choose a workspace pack, so that worktree,
   clone, or no-workspace behavior matches my project.
3. As a project operator, I want to choose a toolchain pack, so that Node
   setup is optional rather than assumed.
4. As a project operator, I want to choose a workflow style pack, so that solo
   local use and team review flows are distinct.
5. As a project operator, I want named bundles for common combinations, so that
   setup remains fast when I do not care about every dimension.
6. As a project operator, I want named bundles to expand visibly, so that I can
   see which packs were selected.
7. As a project operator, I want `tracker:memory` for local demos, so that I
   can try Symphony without Linear or GitHub credentials.
8. As a project operator, I want generated workflow output to be complete, so
   that runtime behavior is inspectable without reading profile internals.
9. As a project operator, I want profile conflicts explained, so that invalid
   combinations do not produce confusing workflows.
10. As a Symphony maintainer, I want `symphony-internal` protected, so that
    generic project support does not weaken the workflow used to build
    Symphony.
11. As a Symphony maintainer, I want tests proving `symphony-internal` maps to
    the checked-in workflow, so that profile refactors do not alter self-hosting
    behavior.
12. As a Symphony maintainer, I want profile metadata, so that `profile list`
    and `profile show` can explain intended use.
13. As a Symphony maintainer, I want profile packs to be small and testable, so
    that new trackers or toolchains can be added without duplicating whole
    workflows.
14. As a project reviewer, I want generated workflows to include pack
    provenance comments, so that review can tell where defaults came from.
15. As an external user, I want GitHub and generic profiles to avoid
    Symphony-specific Linear lifecycle states unless I choose them.

## Implementation Decisions

- Build a deep `Profile Registry` module that exposes pack listing, bundle
  listing, pack resolution, conflict validation, and materialization inputs.
- Define profile pack dimensions for tracker, workspace, toolchain, and
  workflow style.
- Initial tracker packs are `tracker:linear`, `tracker:github`, and
  `tracker:memory`.
- Initial workspace packs are `workspace:worktree`, `workspace:clone`, and
  `workspace:none`.
- Initial toolchain packs are `toolchain:node` and `toolchain:generic`.
- Initial workflow packs are `workflow:solo-local`, `workflow:team-review`, and
  `workflow:symphony-internal`.
- Convenience bundles may include names such as `linear-node` and
  `github-node`, but they are aliases for explicit pack sets.
- `tracker:memory` replaces the earlier `memory-demo` terminology.
- `symphony-internal` is an alias/golden binding to the repository's checked-in
  `WORKFLOW.md`.
- Runtime execution does not read profile templates. Profiles are generation
  and discovery inputs only.
- Materialized workflows include clear comments naming selected packs and
  bundles.
- Pack resolution fails on incompatible combinations rather than silently
  choosing defaults.

## Testing Decisions

- Tests should verify pack resolution and materialized workflow behavior, not
  private template implementation details.
- Unit tests cover pack listing, bundle expansion, conflict detection, and
  required dimension validation.
- Unit tests cover `tracker:memory` requiring no external tracker credentials.
- Unit tests cover `linear-node` and `github-node` expanding into explicit
  packs.
- Regression tests cover `symphony-internal` resolving to the checked-in
  Symphony workflow without generating a replacement.
- Snapshot-style tests may be used for materialized workflow output, but they
  should assert important semantic sections rather than every whitespace detail.
- CLI tests cover `symphony profile list` and `symphony profile show`.

## Out of Scope

- Adding workflow inheritance to runtime loading.
- Public package distribution of profile assets.
- Supporting every programming language in the first implementation.
- Auto-detecting all profile dimensions without user confirmation.
- Replacing root `WORKFLOW.md`.

## Further Notes

The registry should optimize for explainability. Convenience bundles are fine,
but the user should always be able to see the composable pack set behind them.
