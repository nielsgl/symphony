# Symphony PRD Execution Status

Last updated: 2026-04-10
Owner: orchestration planning

## How Agents Should Use This File
1. Read this file first.
2. Use the routing source in `Overall State`:
   - If `Execution routing source` is `Next Queue`, take the first unchecked item in `Next Queue`.
   - Otherwise, take the first unchecked item in `Current Phase`.
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
- Program status: Program-level governance remains in P0; implementation evidence is recorded through P5 groundwork.
- Current phase: P0 (Architecture freeze and PRD sign-off).
- Next phase after P0: P1 (`WorkflowConfig` + validation contract).
- Execution routing source: `Next Queue` (implementation delivery should follow this list while P0 governance items remain open).
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
- [x] P3: Implement workspace manager, hooks, and safety invariants.
- [x] P4: Implement Codex runner protocol lifecycle.
- [x] P5: Implement local HTTP API and embedded desktop UI integration.
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

## Implementation Evidence (P3)
- Date: 2026-04-10
- Scope delivered:
  - `WorkspaceManager` in `src/workspace/manager.ts`:
    - Deterministic per-issue workspace derivation with sanitization rule `[A-Za-z0-9._-]` and replacement to `_`.
    - Safe create/reuse behavior with `created_now` and fail-fast non-directory collision handling.
    - Root-containment and launch-cwd equality invariants.
    - Hook lifecycle support for `after_create`, `before_run`, `after_run`, `before_remove` with timeout support (`hooks.timeout_ms`) and SPEC 9.4 failure semantics.
    - Attempt prep cleanup helpers for `tmp` and `.elixir_ls`, plus terminal cleanup helpers (`cleanupWorkspace`, `cleanupWorkspaces`).
  - Minimal Codex runner in `src/codex/runner.ts`:
    - Launch via `bash -lc <codex.command>` in workspace cwd.
    - Startup handshake support (`initialize`, `initialized`, `thread/start`, `turn/start`).
    - Nested thread/turn id parsing and `session_id` composition.
    - One-turn streaming outcome mapping (`turn_completed`, `turn_failed`, `turn_cancelled`, input-required).
    - `read_timeout_ms` and `turn_timeout_ms` enforcement.
    - Stdout protocol parsing with partial-line buffering; stderr isolation as diagnostics.
  - Integration bridge:
    - Local runner wiring in `src/orchestrator/local-worker-runner.ts` + `src/orchestrator/local-runner-bridge.ts`.
    - Orchestrator-compatible `spawnWorker`/`terminateWorker` bridge for deterministic local execution tests.
- Test evidence:
  - `npm test` -> pass (12 files, 79 tests).
  - `npm run build` -> pass (`tsc --project tsconfig.json`).
  - `git diff --check` -> pass.
- SPEC coverage anchors:
  - SPEC 17.2 (`Workspace Manager and Safety`): `tests/workspace/workspace-manager.test.ts`
  - SPEC 17.5 (`Coding-Agent App-Server Client`): `tests/codex/runner.test.ts`
  - Orchestrator bridge integration evidence: `tests/orchestrator/local-runner-bridge.test.ts`

## Implementation Evidence (P4)
- Date: 2026-04-10
- Scope delivered:
  - `CodexRunner` lifecycle completion in `src/codex/runner.ts`:
    - Robust ordered startup handshake with strict request timeout enforcement.
    - Continuation-turn loop on one live process and one `thread_id` for `maxTurns`.
    - Protocol compatibility normalization for nested id and equivalent terminal/user-input payload shapes.
    - Approval/tool/user-input policy behavior:
      - auto-approve approval requests
      - reject unsupported dynamic tool calls without stalling
      - hard-fail user-input-required turns.
    - Timeout/error mapping parity including `response_timeout`, `turn_timeout`, `response_error`, `turn_failed`, `turn_cancelled`, `turn_input_required`, `port_exit`, `codex_not_found`, `invalid_workspace_cwd`.
    - Token/rate-limit extraction for compatible payload variants with absolute-total preference and delta-safe aggregation.
  - Local worker lifecycle in `src/orchestrator/local-worker-runner.ts`:
    - Worker-lifetime continuation turns via `agent.max_turns` with fixed continuation guidance.
    - Preserved workspace `ensure`/`prepare`/`finalize` behavior and existing abnormal/normal exit mapping.
  - Bridge non-regression in `tests/orchestrator/local-runner-bridge.test.ts`:
    - Explicit assertion that runner invocation includes `maxTurns`.
- Test evidence:
  - `npm test` -> pass (12 files, 79 tests).
  - `npm run build` -> pass (`tsc --project tsconfig.json`).
  - `git diff --check` -> pass.
  - Session protocol soak (gate artifact):
    - Start: `2026-04-10T18:49:19Z`
    - End: `2026-04-10T18:50:52Z`
    - Duration: `93s`
    - Command/setup:
      - Baseline suite: `npm test -- tests/codex/runner.test.ts`
      - Soak loop (120 iterations): `npm test -- tests/codex/runner.test.ts -t "handles a bounded high-volume stream deterministically"`
    - Outcome: `120/120` iterations passed with no protocol parser stalls or process-exit failures.
- SPEC coverage anchors:
  - SPEC 17.5 (`Coding-Agent App-Server Client`): `tests/codex/runner.test.ts`
    - `launches with bash command/cwd and performs ordered startup handshake`
    - `supports continuation turns on the same thread within one process`
    - `accepts compatible payload variants for nested ids`
    - `parses partial stdout lines until newline framing boundary`
    - `keeps stderr isolated from stdout protocol parsing`
    - `maps read timeout to response_timeout`
    - `maps turn timeout to turn_timeout`
    - `maps process exit to port_exit`
    - `maps codex command-not-found stderr to codex_not_found`
    - `maps invalid workspace cwd to invalid_workspace_cwd before launch`
    - `auto-approves approval requests and rejects unsupported tool calls without stalling`
    - `fails hard on user-input-required signals from compatible payload shapes`
    - `extracts usage/rate-limit telemetry from compatible payload variants`
    - `handles a bounded high-volume stream deterministically`
  - Phase-gate artifact recorded in this section; P4 exit criteria satisfied.

## Implementation Evidence (P5)
- Date: 2026-04-11
- Scope delivered (observability + local API + embedded UI):
  - Structured logging and sink-failure resilience in `src/observability/logger.ts`:
    - Stable key=value logs with issue/session context fields (`issue_id`, `issue_identifier`, `session_id`).
    - Sink failures emit `log_sink_failure` warning and do not crash service orchestration paths.
  - Orchestrator observability state in `src/orchestrator/types.ts` and `src/orchestrator/core.ts`:
    - Health model (`dispatch_validation`, `last_error`) maintained from preflight and runtime failures.
    - Running-entry observability metadata (`session_id`, `turn_count`, `last_event`, `tokens`, `recent_events`).
    - Deterministic token/rate-limit aggregation from worker events into `codex_totals` / `codex_rate_limits`.
  - Embedded desktop UI integration in `src/api/server.ts`:
    - Human-readable dashboard served at `GET /`.
    - Dashboard is API-driven only via `GET /api/v1/state`, `GET /api/v1/:issue_identifier`, and `POST /api/v1/refresh`.
    - No direct orchestrator mutation from UI; refresh remains the only control trigger.
  - Runtime bootstrap wiring in `src/runtime/bootstrap.ts` and `scripts/start-dashboard.js`:
    - Dashboard/API launcher now composes the live orchestrator runtime (`WorkflowLoader` + tracker + workspace manager + runner bridge + orchestrator + API server), not an in-memory static snapshot.
    - Startup performs terminal workspace cleanup, initial `startup` reconciliation tick, and periodic `interval` polling ticks.
    - Graceful shutdown path closes API listener and clears retry/poll timers.
  - Tauri desktop dev host in `src-tauri/src/main.rs`:
    - `npm run start:desktop` launches Tauri and manages backend lifecycle directly (spawn, startup readiness detection, teardown).
    - `npm run build:desktop` bundles platform backend sidecar (`symphony-backend`) into app resources for standalone packaging.
    - Dev host startup can fall back to repository launcher when sidecar is unavailable.
    - Desktop backend launch contract is shared via typed helpers in `src/runtime/desktop-launcher.ts`.
  - API projection completion in `src/api/snapshot-service.ts` and `src/api/types.ts`:
    - `health` reflects live orchestrator validation/error state.
    - Running and issue detail projections expose session counters/events/tokens and workspace path.
    - Stable error envelope semantics preserved for 404/405/500 paths.
- Test evidence:
  - `npm test` -> pass (18 files, 102 tests).
  - `npm run build` -> pass (`tsc --project tsconfig.json`).
  - `git diff --check` -> pass (`DIFF_CHECK_EXIT:0`).
- SPEC coverage anchors (P5 closure):
  - SPEC 13.1-13.2 + 17.6 logging/observability semantics:
    - `tests/observability/logger.test.ts`
      - `renders stable key=value logs with context fields`
      - `continues logging when one sink fails and emits a sink warning`
    - `tests/orchestrator/core.test.ts`
      - `tracks failed dispatch validation in health state`
      - `aggregates worker event usage and turn counts deterministically`
  - SPEC 13.7 + 17.6 API and UI integration semantics:
    - `tests/api/server.test.ts`
      - `serves embedded dashboard HTML at root path`
      - `returns failed health semantics for UI health banner rendering`
      - `returns 500 envelope when snapshot source throws`
      - existing state/issue/refresh and method/error tests
    - `tests/api/snapshot-service.test.ts`
      - `projects failed health state and issue recent events for diagnostics`
    - `tests/api/refresh-coalescer.test.ts`
      - `coalesces burst requests into one manual refresh tick`
      - `schedules a later tick after the coalescing window has elapsed`
    - `tests/runtime/bootstrap.test.ts`
      - `starts live runtime and serves orchestrator-backed state endpoint`
      - `maps refresh endpoint to orchestrator manual refresh tick`
    - `tests/runtime/desktop-launcher.test.ts`
      - `parses dashboard startup URL from launcher output`
      - `builds backend launch config with explicit workflow path`
      - `defaults workflow file to repository WORKFLOW.md`
- Gate outcome:
  - P5 exit criteria satisfied (SPEC 17.6 and required `/api/v1/*` endpoints stable for embedded UI).
  - P6 remains open and not started.

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
