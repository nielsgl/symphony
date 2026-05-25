# PRD-001 Local Command and Setup Closure Audit

Source PRD: `docs/analysis/prd/PRD-001-local-command-and-setup.md`.

This audit closes the Local Command and Setup implementation slice without
editing `SPEC.md`. `SPEC.md` remains canonical; local-command extension notes
belong in `SPEC.ext.md` or operational docs.

## User Story Mapping

| Story | Implemented behavior | Proof |
| --- | --- | --- |
| 1. Link local checkout once for multiple projects | `npm run link:local` and `symphony link-local` create a checkout-backed shim. | `tests/cli/local-link.test.ts`; `npm run smoke:local-command` link step |
| 2. Stable `symphony` executable | Package `bin` points at `scripts/symphony.js`; shim delegates to that entrypoint. | `package.json`; smoke `symphony --version` and `symphony --help` |
| 3. Dashboard defaults to current project `WORKFLOW.md` | Local resolver finds nearest project workflow when no `--workflow` is provided. | `tests/cli/local-command-router.test.ts`; smoke default dashboard step |
| 4. Doctor works before dashboard startup | `symphony doctor` validates local adoption readiness without starting dashboard. | `tests/cli/local-command-router.test.ts`; smoke doctor steps |
| 5. Setup asks/records local trust consent | `symphony setup --yes` records user-local consent for resolved identity. | `tests/cli/local-command-router.test.ts`; smoke setup step |
| 6. Project files cannot grant consent silently | Project-contained consent and workflow declarations are ignored as authority. | `tests/cli/local-command-router.test.ts` |
| 7. Workflow can declare required security posture | Effective workflow posture drives setup/doctor/dashboard consent reporting. | `src/runtime/setup-consent.ts`; smoke high-trust workflow |
| 8. Consent is keyed to project/workflow identity | Changed project/workflow identity does not reuse prior consent. | `tests/cli/local-command-router.test.ts`; smoke changed-identity dashboard step |
| 9. Dashboard prints resolved local context | Router prints project root, workflow, env file, host, port, posture, and consent before delegation. | `tests/cli/local-command-router.test.ts`; smoke dashboard stdout assertions |
| 10. Fixed ports are optional | Port defaults to `0`; CLI/env override paths are resolved and validated. | `tests/runtime/local-command-resolver.test.ts`; smoke default and explicit port steps |
| 11. `.env` loads from project directory | Dashboard and doctor resolve project `.env` from the selected workflow's project root. | `tests/cli/local-command-router.test.ts`; smoke dashboard child env-file capture |
| 12. `npm run start:dashboard` keeps working | Existing script remains present and is used by the wrapper. | `package.json`; wrapper smoke delegates through `start:dashboard` |
| 13. `npm run start:project-dashboard` compatibility wrapper | Wrapper resolves external project workflow and delegates through dashboard startup. | `scripts/start-project-dashboard.sh`; smoke wrapper step |
| 14. `--version` and `--help` work from linked checkout | Router exposes top-level version/help surfaces. | `tests/cli/local-command-router.test.ts`; smoke version/help steps |
| 15. Update/unlink instructions after setup | Linker prints update, unlink, inspect, and PATH guidance. | `tests/cli/local-link.test.ts`; `docs/playbooks/local-command-runbook.md` |

## Acceptance Criteria Mapping

| Criterion | Evidence | Verdict |
| --- | --- | --- |
| Cross-project smoke creates a temporary external project with `WORKFLOW.md`. | `scripts/smoke-cross-project-command.js` creates two temp external projects. | Complete |
| Smoke validates link/test-equivalent, version/help/profile/init/setup/doctor/explicit dashboard. | Smoke runs each named command through the linked shim. | Complete |
| Smoke validates default current-project dashboard workflow. | Smoke runs `symphony dashboard` from the external project with no workflow flag. | Complete |
| Smoke validates same-identity consent and changed-identity bypass/rejection. | Smoke setup for project A yields `consent: setup`; project B dashboard yields `consent: missing` and no guardrail acknowledgement. | Complete |
| Smoke validates `doctor --json` and `doctor --ci`. | Smoke parses successful JSON and asserts CI failure for missing setup consent exits `2`. | Complete |
| Smoke validates `dashboard --profile symphony-internal`. | Smoke runs the profile from the Symphony checkout and asserts the checked-in workflow binding. | Complete |
| Existing npm scripts and compatibility wrapper are validated. | Smoke runs `npm run start:project-dashboard`; package retains `start:dashboard`, `start:api`, and `start:web`. | Complete |
| Runbook explains link, PATH, consent, doctor, dashboard, bounded surfaces, update, unlink. | `docs/playbooks/local-command-runbook.md`. | Complete |
| Docs state `SPEC.md` is canonical and extension docs belong elsewhere. | Runbook and this audit state the boundary. | Complete |
| Closure audit maps PRD stories to behavior/tests/follow-ups. | This document. | Complete |
| Later PRDs not accidentally implemented or contradicted. | Boundary audit below. | Complete |

## Later-PRD Boundary Audit

- Profile registry: not implemented. `symphony profile` only lists and shows
  `symphony-internal`.
- Init materialization: not implemented. `symphony init --help` is the only
  supported init surface and explicitly says it does not generate, copy, or
  overwrite workflows.
- Project layout/bootstrap: not implemented. The smoke uses projects that
  already contain `WORKFLOW.md`; no project files are generated.
- Full doctor diagnostics: not implemented. Doctor remains bounded to local
  adoption readiness checks and reports stable blocker/warning status.

No closure-blocking gap was found that requires a new Linear follow-up for this
ticket. Public npm/Homebrew/standalone distribution remains out of scope in the
source PRD.
