# PRD-002 Project Layout Closure Audit

Parent Linear issue: NIE-126
Closure slice: NIE-250

This audit closes the Project Layout and Config Boundaries PRD against current
implementation evidence. `SPEC.md` remains canonical and was not edited for this
closure. Symphony-local layout extension material belongs in `SPEC.ext.md` and
operational docs.

## User Story Mapping

| Story | Closure evidence | Verdict |
| --- | --- | --- |
| 1. Root `WORKFLOW.md` is obvious during review. | `inspectProjectLayout` classifies root `WORKFLOW.md` as the canonical committed runtime contract; local resolver and command-router tests use root `WORKFLOW.md`; smoke runs every project shape from a root workflow. | Implemented |
| 2. One project runtime contract avoids config precedence ambiguity. | `SPEC.ext.md` keeps root `WORKFLOW.md` as the project contract and explicitly excludes project-local `.symphony/config.yaml`; `symphony profile show symphony-internal` remains protected and does not materialize another config file. | Implemented |
| 3. Workspaces, logs, and runtime databases are ignored. | Runtime defaults resolve to `.symphony/system/workspaces/`, `.symphony/system/logs/`, and `.symphony/system/runtime.sqlite`; smoke verifies `.symphony/system/runtime.sqlite` is ignored. | Implemented |
| 4. Setup adds the right gitignore entry. | `setup --yes` and `doctor --fix --yes` append `.symphony/system/` when missing and avoid duplicates; smoke covers no `.gitignore`, broad-ignore, and narrow-ignore projects. | Implemented |
| 5. Project secrets stay out of committed files. | Setup consent is stored in user-local state and refuses project-contained stores; doctor redacts `.env` values and workflow secrets in JSON output. | Implemented |
| 6. Future project skills have a clear versioned home. | `SPEC.ext.md`, `inspectProjectLayout`, diagnostics, and runbook reserve `.symphony/skills/`; smoke verifies it is not ignored in healthy layouts and is not loaded by runtime. | Implemented |
| 7. Future prompt fragments have a clear versioned home. | `SPEC.ext.md`, `inspectProjectLayout`, diagnostics, and runbook reserve `.symphony/prompts/`; smoke verifies it is not ignored in healthy layouts and is not loaded by runtime. | Implemented |
| 8. `.symphony/system/` replaces `.symphony/workspaces`. | Runtime default workspace, log, and persistence paths resolve under `.symphony/system/`; legacy `.symphony/workspaces` is reported as legacy state. | Implemented |
| 9. Migration is low-risk and self-hosting keeps working. | The self-hosting `symphony-internal` profile remains protected; root `.gitignore` keeps `.symphony/system/` narrow while preserving targeted legacy ignores; smoke covers self-hosting and external projects. | Implemented |
| 10. Doctor reports old layout usage. | Doctor emits layout checks for broad ignores and legacy runtime paths; smoke validates legacy path warnings and manual migration guidance. | Implemented |
| 11. Workflow-relative defaults point to `.symphony/system/`. | Runtime bootstrap diagnostics assert default workspace, log, and persistence paths under the workflow directory's `.symphony/system/`; smoke validates the same through `symphony doctor --json`. | Implemented |
| 12. Logs and persistence paths are visible in diagnostics. | `/api/v1/diagnostics` exposes logging health, persistence health, and `project_layout.effective_log_root` plus `project_layout.effective_persistence_path`. | Implemented |
| 13. Project-owned Symphony customization is reviewable in git. | Broad `.symphony/` ignores warn; narrow `.symphony/system/` ignores leave `.symphony/skills/` and `.symphony/prompts/` visible; smoke validates git visibility. | Implemented |
| 14. User-local trust choices are excluded from the repo. | Setup consent is keyed and stored outside the checkout; project-contained consent is refused or ignored; setup docs call out that project files cannot grant consent. | Implemented |

## Explicit Non-Goals Confirmed

This PRD did not implement:

- project-owned skill loading;
- prompt fragment loading;
- profile registry or profile materialization beyond the protected
  `symphony-internal` profile;
- package distribution;
- root workflow relocation;
- top-level repository structure changes;
- full Project Execution History storage design.

## Closure Evidence

- Layout boundary inspector and ignore analyzer:
  `src/runtime/project-layout-inspector.ts` and
  `tests/runtime/project-layout-inspector.test.ts`.
- Runtime default path projection:
  `src/runtime/bootstrap.ts` and `tests/runtime/bootstrap.test.ts`.
- Setup and doctor layout guidance:
  `src/runtime/command-router.ts`, `src/runtime/local-doctor.ts`, and
  `tests/cli/local-command-router.test.ts`.
- Cross-project smoke:
  `scripts/smoke-cross-project-command.js`, run by
  `npm run smoke:local-command`.
- Operator docs:
  `SPEC.ext.md` and `docs/playbooks/local-command-runbook.md`.

## Follow-Up Audit

No unresolved PRD gap was found during this closure audit. The remaining
capabilities listed as non-goals are deliberate future PRD scope, not defects in
NIE-126 closure.
