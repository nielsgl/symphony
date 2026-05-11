# PRD-007 Local Multi-Project Trial

## Problem Statement

The plan should not advance to npm, Homebrew, standalone binary, or desktop
distribution work until the local multi-project experience is proven. Without a
trial, Symphony could optimize for packaging while still being awkward to use
from real local projects.

From the user's perspective, the work is successful when Symphony can be linked
once, used in the Symphony repo without regression, used in an existing project
with a workflow, and used to bootstrap a new project with clear diagnostics.

## Solution

Run a local multi-project trial as a formal acceptance gate. The trial exercises
the linked local command, root `WORKFLOW.md`, `.symphony/system/` layout,
composable profiles, init, doctor, dashboard startup, and the protected
`symphony-internal` path across representative projects.

The trial records findings and updates defaults before any public distribution
PRDs become active.

## User Stories

1. As a Symphony maintainer, I want to run Symphony against the Symphony repo,
   so that self-hosting behavior is proven unchanged.
2. As a Symphony maintainer, I want to run Symphony against an existing project
   with `WORKFLOW.md`, so that the local command proves immediate value.
3. As a Symphony maintainer, I want to initialize a new Node project, so that
   Node toolchain defaults are validated.
4. As a Symphony maintainer, I want to initialize a generic or non-Node project,
   so that Symphony is not accidentally Node-only.
5. As a Symphony maintainer, I want to run `symphony doctor` in each project,
   so that diagnostics are compared across real contexts.
6. As a Symphony maintainer, I want to run `symphony dashboard` where safe, so
   that runtime startup is proven outside the source repo.
7. As a Symphony maintainer, I want to verify high-trust setup once, so that
   consent is seamless after deliberate approval.
8. As a Symphony maintainer, I want to verify project files cannot grant trust,
   so that the trust boundary survives real setup.
9. As a Symphony maintainer, I want to verify `.symphony/system/` ignore rules,
   so that runtime state is not committed.
10. As a Symphony maintainer, I want to inspect generated `WORKFLOW.md` files,
    so that profile output is readable and not too generic.
11. As a Symphony maintainer, I want to inspect generated prompt language, so
    that non-Symphony projects do not inherit internal lifecycle assumptions.
12. As a Symphony maintainer, I want to capture setup friction, so that defaults
    are improved before packaging.
13. As a project operator, I want a trial report, so that I can see what was
    proven and what remains risky.
14. As a future distribution maintainer, I want local acceptance gates, so that
    npm and Homebrew work starts from a stable product surface.
15. As a future issue author, I want findings mapped to follow-up work, so that
    implementation tickets are grounded in real usage.

## Implementation Decisions

- Treat the local multi-project trial as a release gate for public distribution
  work.
- Trial projects include the Symphony repository, one existing external local
  project with `WORKFLOW.md`, one newly initialized Node project, and one newly
  initialized generic or non-Node project.
- The Symphony repository trial uses `symphony-internal` and proves the
  checked-in workflow remains authoritative.
- The existing-project trial starts from `symphony doctor` and
  `symphony dashboard` without `npm --prefix`.
- New-project trials use `symphony init --dry-run`, `symphony init`,
  `symphony doctor`, and dashboard startup where safe.
- The trial records command transcripts, generated file summaries, observed
  warnings, blockers, and follow-up decisions.
- The trial updates profile defaults only after findings are reviewed.
- Public distribution PRDs remain deferred until the trial passes.

## Testing Decisions

- Tests should verify the acceptance gates through smoke tests and documented
  trial evidence, not only isolated unit tests.
- Smoke tests cover linked command availability outside the Symphony checkout.
- Smoke tests cover `doctor` and `init --dry-run` in temporary projects.
- Smoke tests cover generated workflow validation.
- Regression tests cover the Symphony-internal workflow path after local CLI
  changes.
- Manual evidence records cover dashboard startup against representative local
  projects.
- Trial findings should distinguish product friction from implementation bugs.

## Out of Scope

- Publishing to npm.
- Building Homebrew or standalone binary artifacts.
- Desktop app packaging.
- Supporting every tracker, language, or operating system.
- Running destructive agent workflows in arbitrary real projects without
  explicit approval.

## Further Notes

This PRD is the quality bar for the program. It keeps the strategy factual: if
local project usage is still clumsy, distribution work should wait.
