# PRD-001 Local Command and Setup

## Problem Statement

Symphony can already run against another project, but the current command is
too long and too tied to the source checkout path. The user must remember an
`npm --prefix` invocation, the workflow path flag, a port, and the high-trust
acknowledgement flag. This is workable for proving the runtime model, but it is
not good enough for everyday local use across projects.

From the user's perspective, Symphony should feel like a local tool that has
been installed once. After setup, the user should be able to move into any
project and run `symphony doctor` or `symphony dashboard` without remembering
where the Symphony checkout lives.

## Solution

Create a local-first `symphony` command that is linked from the active checkout
and wraps the existing runtime startup paths. Add setup behavior that records
user-local choices, including high-trust execution consent, outside the project
repository. Keep the existing npm scripts as compatibility paths.

The first useful milestone is: from any project that already has a
`WORKFLOW.md`, the user can run `symphony doctor` and `symphony dashboard`
without using `npm --prefix`.

## User Stories

1. As a Symphony maintainer, I want to link my local checkout once, so that I
   can use the same build across multiple projects.
2. As a Symphony maintainer, I want a stable `symphony` executable, so that I
   do not need to remember the checkout path.
3. As a project operator, I want `symphony dashboard` to default to the current
   project's `WORKFLOW.md`, so that startup is terse.
4. As a project operator, I want `symphony doctor` to work before dashboard
   startup, so that setup problems are visible early.
5. As a project operator, I want `symphony setup` to ask for local trust
   consent, so that repeated dashboard runs are seamless but deliberate.
6. As a project operator, I want project files to be unable to grant high-trust
   execution silently, so that a cloned repository cannot bypass my consent.
7. As a project operator, I want `WORKFLOW.md` to be able to declare required
   security posture, so that setup can explain why consent is needed.
8. As a project operator, I want high-trust consent keyed to the project and
   workflow, so that approval for one workflow does not automatically approve
   unrelated workflows.
9. As a project operator, I want the dashboard command to print the resolved
   local URL, so that I can open it without hunting through logs.
10. As a project operator, I want fixed ports to be optional, so that multiple
    projects can run without collisions.
11. As a project operator, I want `.env` to load from the project directory, so
    that tracker credentials and local settings remain project-adjacent.
12. As a Symphony maintainer, I want the existing `npm run start:dashboard`
    command to keep working, so that the current self-hosting workflow does not
    regress.
13. As a Symphony maintainer, I want `npm run start:project-dashboard` to become
    a compatibility wrapper, so that old usage has a migration path.
14. As a Symphony maintainer, I want `symphony --version` and `symphony --help`
    to work from the linked checkout, so that setup can be smoke-tested.
15. As a Symphony maintainer, I want unlink/update instructions after setup, so
    that local command state is inspectable and reversible.

## Implementation Decisions

- Build a deep `Local Command Resolver` module that resolves the linked
  checkout, project root, workflow path, env file, and dashboard startup
  options behind a small command-facing interface.
- Add a local link command exposed as `npm run link:local` and, where useful,
  `symphony link-local`.
- The link command builds the TypeScript runtime, creates or updates a
  user-local executable shim named `symphony`, and verifies the command without
  relying on npm package installation.
- Add a `symphony setup` flow for local machine choices. Setup can also be
  invoked from `symphony doctor --fix`.
- Store high-trust consent in user-local state, never in project-committed
  files.
- Consent records are keyed to a stable project/workflow identity and include
  enough diagnostic data to explain what was approved.
- `WORKFLOW.md` may declare that a workflow requires high-trust local execution,
  but that declaration only triggers setup or doctor guidance.
- `symphony dashboard` defaults to `./WORKFLOW.md`, project `.env`, and an
  ephemeral port unless the workflow or CLI pins a port.
- The command router supports at least `dashboard`, `doctor`, `setup`, `init`,
  `profile`, `link-local`, `--help`, and `--version` as top-level surfaces.
- Existing npm scripts remain supported and can delegate to the command router
  after the router exists.

## Testing Decisions

- Tests should assert observable command resolution and setup behavior, not
  implementation details of the shim file.
- Unit tests cover workflow path resolution, project root resolution, env-file
  resolution, port precedence, and high-trust consent lookup.
- Unit tests cover refusal to read high-trust consent from project-committed
  files.
- Integration tests cover `npm run link:local` creating a working command in a
  temporary target directory.
- Integration tests cover `symphony --help`, `symphony --version`,
  `symphony doctor --help`, and dashboard dry startup option resolution.
- Regression tests cover the existing `npm run start:dashboard` path.
- Regression tests cover `symphony dashboard --profile symphony-internal`
  preserving the current Symphony repository behavior.

## Out of Scope

- Publishing an npm package.
- Creating a Homebrew formula.
- Building a standalone binary.
- Replacing `WORKFLOW.md` as the runtime contract.
- Implementing every doctor check; detailed diagnostics are covered by
  PRD-005.
- Implementing profile materialization; profiles are covered by PRD-003 and
  PRD-004.

## Further Notes

This PRD is the first implementation priority because every later local-first
experience depends on a short, stable command.
