# Symphony PRD Execution Status

Last updated: 2026-04-10
Owner: orchestration planning

## How Agents Should Use This File
1. Read this file first.
2. Take the first unchecked item in `Current Phase`.
3. Verify dependencies listed in `Phase Gates` are satisfied.
4. Update this file in the same PR when work status changes.

## Per-Task Requirements (Applies To Every Agent, Every Task)
1. Restate the exact task scope before implementation.
2. Map the task to the relevant PRD(s) and acceptance criteria.
3. Define tests/verification steps before coding.
4. Record what was validated in the PR/commit notes.
5. Treat `Current Phase` checkboxes as program-level progress only; do not
   skip task-level planning because a phase item is already checked.

## Overall State
- Program status: Program-level governance remains in P0; implementation evidence is recorded through P2.
- Current phase: P0 (Architecture freeze and PRD sign-off).
- Next phase after P0: P1 (`WorkflowConfig` + validation contract).
- Blockers: None currently recorded.

## Done
- [x] PRD package authored in `docs/prd/`.
- [x] Master system contract defined (`PRD-000`).
- [x] Core subsystem PRDs defined (`PRD-001` to `PRD-006`).
- [x] Phase 2 GitHub Issues PRD defined (`PRD-007`).
- [x] Delivery roadmap/gates defined (`PRD-008`).
- [x] Traceability matrix scaffold created (`TRACEABILITY-MATRIX.md`).
- [x] PRD-000 through PRD-008 reviewed and signed off for P0 planning baseline.

## Current Phase (P0)
- [x] Review and sign off PRD-000 through PRD-008.
- [ ] Confirm interface ownership per subsystem.
- [ ] Lock initial implementation repo structure (`src/`, `tests/`, `scripts/`).
- [ ] Convert traceability checklist placeholders into concrete owner/test references.
- [ ] Approve entry into P1.

## Next Queue
- [x] P1: Implement workflow loader/config resolver/validator/reload pipeline.
- [x] P2: Implement orchestrator loop and Linear adapter read operations.
- [ ] P3: Implement workspace manager, hooks, and safety invariants.
- [ ] P4: Implement Codex runner protocol lifecycle.
- [ ] P5: Implement local HTTP API and embedded desktop UI integration.
- [ ] P6: Implement security profiles and minimal persistence.
- [ ] P7: Implement GitHub Issues adapter + PR metadata (Phase 2).

## Implementation Evidence (P1)
- Date: 2026-04-10
- Scope delivered:
  - `WorkflowLoader` (`src/workflow/loader.ts`): path precedence + YAML front matter/prompt split + typed loader errors.
  - `ConfigResolver` (`src/workflow/resolver.ts`): typed config defaults, `$VAR` resolution, `~`/path handling, per-state concurrency normalization.
  - `ConfigValidator` (`src/workflow/validator.ts`): startup/per-tick preflight validation contract with typed failures.
  - `TemplateEngine` (`src/workflow/template-engine.ts`): strict parse/render behavior for `issue`/`attempt`.
  - `EffectiveConfigStore` (`src/workflow/store.ts`): atomic last-known-good snapshot + version hash.
  - `WorkflowWatcher` (`src/workflow/watcher.ts`): debounced hot-reload transaction with retain-on-invalid semantics.
- Test evidence:
  - `npm test` -> pass (6 files, 30 tests).
  - `npm run build` -> pass (`tsc --project tsconfig.json`).
  - `git diff --check` -> pass.
- SPEC 17.1 coverage anchors:
  - Loader path precedence + parse/error behaviors: `tests/workflow/loader.test.ts`
  - Typed defaults + env/path semantics: `tests/workflow/resolver.test.ts`
  - Validation checks + dispatch/reconciliation gating: `tests/workflow/validator.test.ts`
  - Strict template behavior: `tests/workflow/template-engine.test.ts`
  - Reload success/failure and last-known-good retention: `tests/workflow/watcher.test.ts`

## Implementation Evidence (P2)
- Date: 2026-04-10
- Scope delivered:
  - Tracker contracts in `src/tracker/types.ts` with required operations:
    - `fetch_candidate_issues()`
    - `fetch_issues_by_states(state_names)`
    - `fetch_issue_states_by_ids(issue_ids)`
  - Linear adapter implementation in `src/tracker/linear-adapter.ts`:
    - GraphQL query isolation for candidate/state queries.
    - Project filter via `project.slugId`, active-state filtering, and pagination.
    - Normalization contract for labels, blockers, priority, and timestamps.
    - Typed tracker error mapping (`linear_api_request`, `linear_api_status`, `linear_graphql_errors`, `linear_unknown_payload`, `linear_missing_end_cursor`).
  - Tracker adapter config validation + construction in `src/tracker/factory.ts`.
  - Orchestrator core state machine in `src/orchestrator/core.ts` + `src/orchestrator/decisions.ts`:
    - Candidate eligibility + sorting.
    - Claim/running/retry bookkeeping.
    - Continuation retry (`1000` ms) and failure backoff with cap.
    - Reconciliation semantics for terminal/non-active/active transitions.
    - Stall detection and retry scheduling.
- Test evidence:
  - `npm test` -> pass (9 files, 52 tests).
  - `npm run build` -> pass (`tsc --project tsconfig.json`).
  - `git diff --check` -> pass.
- SPEC coverage anchors:
  - SPEC 17.3 (`Issue Tracker Client`): `tests/tracker/linear-adapter.test.ts`, `tests/tracker/factory.test.ts`
  - SPEC 17.4 (`Orchestrator Dispatch, Reconciliation, and Retry`): `tests/orchestrator/core.test.ts`

## Phase Gates
1. P0 exit requires: PRD package approved; ownership and dependencies accepted; traceability matrix converted from scaffold to actionable mapping.
2. P1 exit requires: Section 17.1 tests passing; typed validation errors surfaced in logs/API.
3. P2 exit requires: Section 17.3 and 17.4 tests passing for Linear core; no duplicate dispatch under simulated load.
4. P3 exit requires: Section 17.2 tests passing; workspace containment invariants verified.
5. P4 exit requires: Section 17.5 tests passing; session protocol soak test completed.
6. P5 exit requires: Section 17.6 pass criteria met; `/api/v1/state`, `/api/v1/<issue_identifier>`, `/api/v1/refresh` stable for UI.
7. P6 exit requires: security profile and redaction checks passing; minimal persistence continuity verified across restart.
8. P7 exit requires: GitHub adapter contract tests passing; Linear regression suite remains green.

## Active Blockers
- None.

## Sign-off Evidence (P0 Item 1)
- Date: 2026-04-10
- Scope reviewed:
  - `PRD-000` through `PRD-008` in `docs/prd/`
  - `INDEX.md` package ordering and completeness contract
  - `TRACEABILITY-MATRIX.md` owner/test/observability linkage scaffold
- Outcome: Accepted as planning baseline for remaining P0 checklist items.

## References
- Index: `/Users/niels.van.Galen.last/code/symphony/docs/prd/INDEX.md`
- Roadmap/gates: `/Users/niels.van.Galen.last/code/symphony/docs/prd/PRD-008-delivery-roadmap-gates.md`
- Traceability: `/Users/niels.van.Galen.last/code/symphony/docs/prd/TRACEABILITY-MATRIX.md`
