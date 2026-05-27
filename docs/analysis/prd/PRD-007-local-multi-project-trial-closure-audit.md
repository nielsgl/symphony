# PRD-007 Local Multi-Project Trial Closure Audit

## Verdict

Status: blocked on required real existing-project evidence.

The Local Multi-Project Trial is not clean enough to unblock public npm,
Homebrew, standalone binary, or desktop packaging work. The harness and child
slices now prove the synthetic/generated lanes, the Symphony-internal protected
profile, the hosted Linear/Node issue-run, and recovered-worker ownership
hardening. The required existing external project lane still lacks a supplied
real project root in the closure run, so synthetic existing-workflow evidence
must not be counted as parent-PRD acceptance.

## Closure Command

Run the closure command after build output exists:

```bash
npm run build
npm run trial:local-multi-project -- --required-project-root /path/to/real/project
npm run smoke:local-command
```

Use a real project that already has a hand-written `WORKFLOW.md`. The harness
may also accept synthetic fixtures for regression coverage, but a synthetic
fixture is not enough to close the parent PRD.

The 2026-05-27 closure reproduction in `NIE-275` used:

```bash
npm run build
npm run trial:local-multi-project -- --report /tmp/nie-275-repro-trial-report.json
```

Result:

| Lane | Status | Evidence Type | Closure Meaning |
| --- | --- | --- | --- |
| `synthetic-memory-baseline` | passed | synthetic | Smoke coverage only. |
| `synthetic-generated-generic` | passed | synthetic generated project | Proves generic/non-Node generated path. |
| `generated-linear-node-setup` | passed | synthetic generated project | Proves non-hosted Linear/Node setup readiness. |
| `symphony-internal-profile` | passed | real Symphony checkout | Proves protected internal profile resolves the checked-in workflow. |
| `real-existing-project-missing` | blocked | missing real root | Parent PRD remains blocked. |

## User Story Traceability

| Story | Evidence | Verdict |
| --- | --- | --- |
| 1. Symphony repository through protected internal profile | `NIE-271`, PR #490, and `NIE-275` closure report: `symphony-internal-profile: passed`. | Pass |
| 2. Existing external project with hand-written `WORKFLOW.md` | `NIE-271` added real-root support and synthetic regression coverage, but no real project root was supplied to `NIE-275`. | Blocked |
| 3. Fresh Node project with `linear-node` defaults | `NIE-273`, PR #489, generated setup lane and hosted evidence for `NIE-280`. | Pass |
| 4. Generic or non-Node project | `NIE-272`, PR #488, generated generic lane. | Pass |
| 5. `symphony doctor` in every trial project | Harness records doctor JSON for all exercised lanes; missing real root has no runnable doctor evidence. | Blocked for existing-project lane |
| 6. `symphony setup` and user-local consent | `NIE-271`, `NIE-272`, and `NIE-273` record setup consent scoped to Project Identity. | Pass for exercised lanes |
| 7. `symphony dashboard` from project directories | Harness dashboard probes passed for exercised lanes with server bind and shutdown evidence. | Pass for exercised lanes |
| 8. Generated `WORKFLOW.md` inspection | `NIE-272` and `NIE-273` inspect file plans, provenance, and generated workflow content. | Pass |
| 9. External generated workflows avoid Symphony-internal assumptions | Generic and Linear/Node workflow checks reject internal lifecycle terms and prompt assumptions. | Pass |
| 10. `.symphony/system/` ignored while skills/prompts visible | Doctor/layout evidence and smoke coverage record runtime-owned and project-owned paths. | Pass |
| 11. Real tracker-backed issue run creates branch and PR | `NIE-273` hosted run: Linear `NIE-280`, branch `feature/NIE-280`, commit `618f052d3cfbf1be991bf2d616c6bbc20a5fb058`, pushed branch, PR `https://github.com/nielsgl/symphony-linear-node-trial-nie-273-20260527-b/pull/1`. | Pass |
| 12. Agent Review or handoff behavior outside Symphony repo | `NIE-273` records final Linear state `Done` for the disposable hosted issue and PR evidence. | Pass |
| 13. Project Execution History scoped to external Project Identity | `NIE-273` hosted report records project key `55c6fb3df84f501fc7641de62390ccd44d447c5432c3d04d3a4249a742d56db7`, ticket identity, list total `1`, and token/model facts. | Pass |
| 14. Recovery, blocked, retry, and stale-worker evidence checked | `NIE-274`, PR #495, deterministic setup/preflight residue recovery tests and projection assertions. | Pass |
| 15. Setup-hook side effects classified | `NIE-273` and `NIE-274` classify generated Node lockfiles/setup residue in the runbook. | Pass |
| 16. Product friction versus implementation defects distinguished | Harness finding categories separate `implementation_defect`, `product_friction`, `environment_prerequisite`, and `intentional_out_of_scope`. | Pass |
| 17. Concise local trial report | Harness writes JSON reports with lane status, commands, doctor findings, dashboard/API evidence, generated files, and findings. | Pass |
| 18. Findings mapped to follow-up work | `NIE-277` exists for hosted fake-success automation. This audit keeps the real existing-project lane blocked instead of filing an implementation-defect duplicate. | Pass |
| 19. Public distribution deferred until trial passes | This audit keeps distribution deferred because one required lane is blocked. | Pass |
| 20. Reuse local command smoke while extending real behavior | `npm run smoke:local-command` remains required; trial harness extends it with generated and hosted lanes. | Pass |

## Follow-Up Queue

| Follow-Up | Type | Evidence | Priority | Relationship |
| --- | --- | --- | --- | --- |
| Supply and run a real existing external project root for the Local Multi-Project Trial closure | Environment prerequisite / closure blocker | `NIE-275` report has `real-existing-project-missing: blocked`; no real root was supplied. | High | Blocks closing `NIE-269`; not an implementation defect. |
| `NIE-277` Automate hosted Linear/Node trial issue-run evidence capture | Bounded implementation follow-up | Fake-hosted success coverage remains useful for CI-like proof without real secrets. | Medium | Related to `NIE-273`; does not block the already-recorded hosted live evidence. |

No new implementation-defect follow-up was found in the `NIE-275` closure run.
The only parent-blocking gap is unavailable real external project evidence.

## Distribution Gate

Keep the following work deferred until a closure run includes a passing real
existing-project lane or the parent PRD owner explicitly accepts a documented
exception:

- npm package publishing.
- Homebrew formula work.
- Standalone binary packaging.
- Desktop app packaging as a distribution substitute.

## Warning Interpretation

- `environment_prerequisite`: missing roots, credentials, disposable resources,
  or local tools. These block closure when the missing evidence is required.
- `implementation_defect`: Symphony behavior that must be fixed before a lane
  can pass.
- `product_friction`: usable but confusing behavior that should become a
  follow-up unless it blocks adoption.
- `intentional_out_of_scope`: evidence skipped by operator choice; it cannot
  satisfy required acceptance.
