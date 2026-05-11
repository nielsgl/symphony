# PRD-005 Doctor and Diagnostics

## Problem Statement

Local Symphony adoption will fail if users discover setup mistakes only after
starting a long-running dashboard or agent loop. Today, readiness is spread
across workflow parsing, environment variables, tracker credentials, Codex
availability, git/worktree configuration, hook behavior, ports, persistence,
and local trust posture.

From the user's perspective, `symphony doctor` should explain whether the
project is ready, what is missing, and what can be fixed automatically before
runtime startup.

## Solution

Implement `symphony doctor` as a preflight diagnostics surface. It validates the
effective project workflow, local command setup, user-local trust consent,
tracker prerequisites, Codex command availability, workspace configuration,
runtime state layout, hooks, ports, and optional project-owned skills. It
supports human output, JSON output, CI mode, and fix suggestions.

Doctor is the enforcement and explanation surface for local-first adoption.

## User Stories

1. As a project operator, I want doctor to tell me whether `WORKFLOW.md` exists,
   so that I know whether to run init.
2. As a project operator, I want doctor to validate workflow syntax, so that
   startup does not fail late.
3. As a project operator, I want doctor to validate resolved config, so that
   invalid tracker, workspace, or Codex settings are visible.
4. As a project operator, I want doctor to report missing environment
   variables, so that credentials can be supplied before startup.
5. As a project operator, I want doctor to report tracker credential presence,
   so that Linear or GitHub failures are clear.
6. As a project operator, I want doctor to detect the Codex command, so that
   agent startup prerequisites are known.
7. As a project operator, I want doctor to inspect git/worktree settings, so
   that workspace provisioning failures are caught early.
8. As a project operator, I want doctor to check whether `base_ref` exists or is
   fetchable, so that worktree creation does not fail later.
9. As a project operator, I want doctor to report dirty-repo policy conflicts,
   so that provisioning behavior is predictable.
10. As a project operator, I want doctor to check fixed port availability, so
    that dashboard startup does not collide with another process.
11. As a project operator, I want doctor to report high-trust consent state, so
    that I understand whether setup is complete.
12. As a project operator, I want `doctor --fix` to run safe setup actions, so
    that common local setup gaps are easy to repair.
13. As a project operator, I want doctor to identify the old `.symphony/`
    runtime layout, so that I can migrate to `.symphony/system/`.
14. As a project operator, I want doctor to report project-owned skill and
    prompt references, so that missing customization files are clear.
15. As a CI maintainer, I want `doctor --ci`, so that readiness can be checked
    without interactive prompts.
16. As a tool integrator, I want `doctor --json`, so that editor or dashboard
    integrations can consume structured diagnostics.
17. As a Symphony maintainer, I want diagnostics to include source/provenance,
    so that users can see whether values came from CLI, env, workflow, or
    user-local state.
18. As a Symphony maintainer, I want doctor failures to be categorized, so that
    tests and automation can distinguish warnings from blockers.

## Implementation Decisions

- Build a deep `Doctor Engine` module that runs checks and returns structured
  diagnostic findings independent of the CLI renderer.
- Each finding includes severity, code, message, source, suggested fix, and
  whether it is safe to auto-fix.
- Doctor supports human text output, JSON output, and CI output semantics.
- `doctor --ci` never prompts and exits non-zero on blocker findings.
- `doctor --fix` can invoke safe setup actions, including local trust consent,
  gitignore insertion, and link-local guidance.
- Doctor validates root `WORKFLOW.md` as the project runtime contract.
- Doctor checks user-local high-trust consent, but never accepts project files
  as consent.
- Doctor reports selected profile pack provenance when a generated workflow
  records it.
- Doctor checks `.symphony/system/` ignore status and reports broad `.symphony/`
  ignore entries when they block versioned project customization.
- Doctor treats skill resolution policy as observable diagnostics until Codex
  skill resolution behavior is formally verified.

## Testing Decisions

- Tests should assert diagnostic findings and exit behavior, not exact prose
  formatting except where CLI output is part of the contract.
- Unit tests cover each check category with pass, warning, and blocker cases.
- Unit tests cover source/provenance fields for workflow, env, CLI, and
  user-local values.
- Unit tests cover `--ci` exit codes.
- Unit tests cover JSON output schema stability.
- Integration tests cover doctor in temporary projects with missing workflow,
  generated workflow, missing env vars, and invalid workspace configuration.
- Integration tests cover `doctor --fix` adding `.symphony/system/` to
  `.gitignore` without touching unrelated entries.
- Regression tests cover high-trust consent never being read from project files.

## Out of Scope

- Starting long-running dashboard sessions.
- Creating workflows from profiles.
- Publishing diagnostics remotely.
- Guaranteeing every hook command will succeed at runtime.
- Fully verifying Codex plugin or skill availability beyond observable local
  checks.

## Further Notes

Doctor should become the main local support surface. It should be strict enough
to catch real blockers and calm enough to explain what can wait.
