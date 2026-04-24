# Symphony PRD Execution Status

Last updated: 2026-04-24
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
- Program status: P0 governance is closed; implementation evidence is recorded through P15b functional parity uplift closure.
- Current phase: P1 (entry approved; implementation delivered through P15 evidence below).
- Next phase after P0: P1 (`WorkflowConfig` + validation contract).
- Execution routing source: `Next Queue` (P1 baseline is complete; route from the first unchecked queue item).
- Next-agent routing: queue is fully closed through `P15b`; route new work from governance backlog updates.
- P0 governance remaining after this update: none.
- Blockers: None currently recorded.

## Implementation Evidence (SPEC Coverage Program)
- Date: 2026-04-17
- Scope delivered:
  - Added canonical requirement-level manifest policy and expanded artifact:
    - `docs/prd/SPEC-TEST-MANIFEST-POLICY.json`
    - `docs/prd/SPEC-TEST-MANIFEST.json`
  - Added deterministic gate script:
    - `scripts/check-spec-coverage.js`
  - Added test-ID convention in suite titles using `SPEC-<section>-<unit>` tags
    for canonical anchors referenced by the manifest.
  - Added coverage scope policy in `vitest.config.ts`:
    - report scope limited to runtime code (`src/**`),
    - pure type files (`src/**/types.ts`) excluded from reported percentages.
  - Added tiered gate references in traceability:
    - PR: deterministic suite + `check:spec-coverage`
    - Nightly: deterministic + e2e
    - Pre-release: nightly + required real integration profile
- Validation commands:
  - `npm test`
  - `npm run build`
  - `npm run check:spec-coverage`
  - `npm run check:meta`
  - `git diff --check`

## Done
- [x] PRD package authored in `docs/prd/`.
- [x] Master system contract defined (`PRD-000`).
- [x] Core subsystem PRDs defined (`PRD-001` to `PRD-006`).
- [x] Phase 2 GitHub Issues PRD defined (`PRD-007`).
- [x] Delivery roadmap/gates defined (`PRD-008`).
- [x] Traceability matrix scaffold created (`TRACEABILITY-MATRIX.md`).
- [x] PRD-000 through PRD-008 reviewed and signed off for P0 planning baseline.

## Current Phase (P1)
- [x] P1 entry approved from closed P0 governance gate.
- [x] P1 implementation scope completed and evidenced in this file's implementation sections.
- [x] P8 parity-audit governance scope completed and evidenced in `docs/prd/SPEC-LINE-PARITY-AUDIT.md`.

## P0 Gate Checklist (Closed)
- [x] Review and sign off PRD-000 through PRD-008.
- [x] Confirm interface ownership per subsystem.
- [x] Lock initial implementation repo structure (`src/`, `tests/`, `scripts/`).
- [x] Convert traceability checklist placeholders into concrete owner/test references.
- [x] Approve entry into P1.

## P0 Closeout Decision

- Date: 2026-04-12
- Decision: Approved entry into P1; P0 governance is fully closed.
- Evidence links:
  - `docs/prd/STATUS.md` (this file): P0 checklist now fully complete.
  - `docs/prd/TRACEABILITY-MATRIX.md`: audit checklist confirms owner
    consistency and Phase 2 non-regression against v1 core conformance.

## P0 Sign-off Evidence (Traceability Placeholder Conversion)

- Date: 2026-04-12
- Scope: Converted core conformance traceability placeholders to concrete
  references in `docs/prd/TRACEABILITY-MATRIX.md`.
- Evidence captured:
  - Accountable owner role is explicit per matrix row.
  - Test anchors are concrete file and test-case references for core
    conformance rows.
  - Observability signals are concrete runtime/API outputs per row.
- Validation commands for this governance change:
  - `npm test`
  - `npm run build`
  - `git diff --check`

## Repository Structure Baseline (P0 Governance Evidence)

Decision: Initial implementation repository structure is locked as:
- `src/` for runtime subsystem implementations.
- `tests/` for mirrored subsystem test coverage.
- `scripts/` for build, launch, and developer automation tooling.

Lock status evidence (2026-04-12 refresh):
- The required top-level baseline remains exactly `src/`, `tests/`, and
  `scripts/`.
- P1 through P7 implementation evidence in this file remained within that
  baseline and did not require additional top-level runtime directories.

Ownership and decision authority:
- Accountable owner role: `orchestration planning`.
- Structural governance authority is maintained via this status tracker and
  aligned repository guidance in `AGENTS.md`.
- Decision authority for top-level structural changes remains with governance
  review in this tracker, with aligned PRD updates in the same change.

Rules for adding new top-level directories:
- Add only when required by a new subsystem boundary or toolchain/runtime
  requirement that cannot fit existing top-level structure.
- Document rationale and ownership impact in `docs/prd/STATUS.md` (and linked
  PRD docs when contract changes are involved) in the same change.
- Validate with `npm test`, `npm run build`, and `git diff --check` in the same
  change set.

Subsystem mapping baseline:
- Orchestrator: `src/orchestrator/` and `tests/orchestrator/`.
- Workflow/config: `src/workflow/` and `tests/workflow/`.
- Workspace lifecycle: `src/workspace/` and `tests/workspace/`.
- Codex runner: `src/codex/` and `tests/codex/`.
- Tracker adapters: `src/tracker/` and `tests/tracker/`.
- Security/redaction: `src/security/` and `tests/security/`.
- Persistence: `src/persistence/` and `tests/persistence/`.
- Observability: `src/observability/` and `tests/observability/`.
- Runtime/bootstrap: `src/runtime/` and `tests/runtime/`.
- Local API/dashboard projection: `src/api/` and `tests/api/`.

Evidence:
- P1 through P7 implementation evidence in this file demonstrates the baseline
  structure remained stable across staged delivery while validation gates stayed
  green (`npm test`, `npm run build`, `git diff --check`).

## Interface Ownership (P0 Governance Evidence)

All interfaces below are accountable to owner role `orchestration planning`.
Each ownership entry is scoped to interface contract and routing correctness,
not implementation staffing by named individual.

| Interface / Component | Accountable owner role | Boundaries (owns) | Boundaries (does not own) | Upstream dependencies | Downstream dependencies | Required acceptance-test anchors |
|---|---|---|---|---|---|---|
| TrackerAdapter (`fetch_candidate_issues`, `fetch_issues_by_states`, `fetch_issue_states_by_ids`) | orchestration planning | Tracker query contract, adapter normalization parity, typed tracker error mapping | Orchestrator scheduling policy, workspace lifecycle semantics, API/UI projection logic | `WorkflowConfig` tracker settings, tracker credentials/env resolution | `Orchestrator` candidate selection/reconciliation inputs | `tests/tracker/linear-adapter.test.ts`, `tests/tracker/github-adapter.test.ts`, `tests/tracker/factory.test.ts` |
| WorkflowConfig resolver/validator/reload (`load`, `resolve`, `validate_for_dispatch`, `watch_and_reload`) | orchestration planning | Workflow parsing, typed defaults, env/path resolution, validation errors, hot-reload atomic swap | Orchestrator runtime dispatch loop decisions, tracker transport behavior | Workflow file path selection, environment variables, schema/type contract | Tracker factory config, orchestrator preflight dispatch gates, startup diagnostics | `tests/workflow/loader.test.ts`, `tests/workflow/resolver.test.ts`, `tests/workflow/validator.test.ts`, `tests/workflow/watcher.test.ts` |
| OrchestratorState + dispatch/reconciliation (`tick`, `dispatch`, `snapshot`) | orchestration planning | Single-authority scheduling state (`claimed`, `running`, `retry_attempts`), retry/reconciliation policy, worker lifecycle coordination | Tracker API normalization internals, workspace path sanitization internals, Codex protocol framing | Tracker snapshots/state refresh, effective workflow config, worker bridge events | Local API state projection, observability logs, persistence history writer events | `tests/orchestrator/core.test.ts`, `tests/orchestrator/local-runner-bridge.test.ts` |
| WorkspaceManager (`create_for_issue`, hook execution, cleanup) | orchestration planning | Workspace path derivation/containment, create-reuse safety, hooks timeout/failure semantics, cleanup helpers | Scheduling decisions, tracker state fetch, Codex protocol policy | Resolved workspace root config, issue identifiers, hook configuration | Worker launch cwd guarantees, terminal/cleanup behavior used by orchestrator bridge | `tests/workspace/workspace-manager.test.ts`, `tests/orchestrator/local-runner-bridge.test.ts` |
| CodexRunner protocol (`start_session`, `run_turn`, `stop_session`) | orchestration planning | App-server startup handshake, turn lifecycle and continuation semantics, protocol parsing, timeout/error mapping, usage extraction | Orchestrator scheduling ownership, workspace derivation, API response schema ownership | WorkspaceManager cwd contract, workflow codex policy settings, orchestrator turn requests | Orchestrator worker-event stream, API/observability token/session surfaces | `tests/codex/runner.test.ts`, `tests/orchestrator/local-runner-bridge.test.ts` |
| Local HTTP API + desktop integration (`/api/v1/state`, `/api/v1/:issue_identifier`, `/api/v1/refresh`, dashboard integration) | orchestration planning | API contract stability, error envelope behavior, refresh coalescing, embedded dashboard integration contract | Core scheduler state transition rules, tracker adapter internals, security-profile selection logic | Orchestrator snapshots/events, bootstrap runtime wiring, desktop launcher process config | Operator UI views, diagnostics consumers, external local clients | `tests/api/server.test.ts`, `tests/api/snapshot-service.test.ts`, `tests/api/refresh-coalescer.test.ts`, `tests/runtime/bootstrap.test.ts`, `tests/runtime/desktop-launcher.test.ts` |
| Security profiles + redaction | orchestration planning | Profile precedence/default contract, redaction rules for logs/API/persistence, diagnostics visibility | Tracker query semantics, orchestrator dispatch ordering, workspace cleanup sequencing | Workflow codex policy fields, startup environment/settings | Logger sinks, API projections, persistence storage outputs | `tests/security/profiles.test.ts`, `tests/security/redaction.test.ts`, `tests/observability/logger.test.ts`, `tests/api/server.test.ts` |
| Persistence (history + ui-state) | orchestration planning | Durable history/ui-state schema, retention and integrity checks, restart continuity contract boundaries | Durable restoration of active claims/running/retry state, tracker adapter logic, dispatch rules | Runtime event stream, redacted API/log payload contracts, local storage location config | `/api/v1/history`, `/api/v1/ui-state`, `/api/v1/diagnostics`, operator continuity behavior | `tests/persistence/store.test.ts`, `tests/runtime/bootstrap.test.ts`, `tests/api/server.test.ts` |

Ownership evidence links:
- Subsystem boundary source: `docs/prd/PRD-000-master.md` (Architecture and Ownership Boundaries).
- Delivery gate source: `docs/prd/PRD-008-delivery-roadmap-gates.md` (Phase gates and ownership sequencing).
- Requirement mapping source with explicit owner-role references:
  `docs/prd/TRACEABILITY-MATRIX.md`.

## Next Queue
- [x] P1: Implement workflow loader/config resolver/validator/reload pipeline.
- [x] P2: Implement orchestrator loop and Linear adapter read operations.
- [x] P3: Implement workspace manager, hooks, and safety invariants.
- [x] P4: Implement Codex runner protocol lifecycle.
- [x] P5: Implement local HTTP API and embedded desktop UI integration.
- [x] P6: Implement security profiles and minimal persistence.
- [x] P7: Implement GitHub Issues adapter + PR metadata (Phase 2).
- [x] P8: Perform full SPEC line parity audit and extract backlog stories (docs-only).
- [x] P9a: Close CLI/host lifecycle + HTTP control parity gaps.
- [x] P9b: Implement real integration + operational validation profile evidence.
- [x] P9c: Close failure-model/security-hardening parity gaps.
- [x] P9d: Close domain/config/telemetry + Section 18 conformance parity gaps.
- [x] P10: Implement web parity + superset UI/runtime push upgrades (SSE + redesigned operator surface).
- [x] P11: Implement XR-01/XR-02/XR-04/XR-05/XR-08 with breaking defaults now.
- [x] P12: Implement XR-06/XR-09 observability enrichment + canonical event vocabulary harmonization.
- [x] P14: Implement logging lifecycle/context parity closure against reference logging contract.
- [x] P14b: Implement logging substrate parity (rotating file sink + logs-root + diagnostics + debug-skill alignment).
- [x] P15: Implement logging hardening (bootstrap API cleanup, CLI duplication guard regression, AST context governance).
- [x] P15b: Implement functional parity uplift findings F1-F8 (tracker write paths, assignee routing, memory tracker, runtime workflow switching, host binding, retry projection enrichment, observability knobs, prompt fallback).

## Implementation Evidence (P15b Functional Parity Uplift)
- Date: 2026-04-24
- Scope delivered:
  - Added tracker write-path contract (`create_comment`, `update_issue_state`) across Linear, GitHub, and memory adapters.
  - Added assignee-aware candidate routing (`tracker.assignee`) including `me` viewer resolution for Linear.
  - Added `tracker.kind=memory` read/write adapter for deterministic local/dev routing.
  - Added runtime workflow controls (`POST /api/v1/workflow/path`, `POST /api/v1/workflow/reload`) with last-known-good protection.
  - Added `server.host` workflow+CLI resolution with typed validation and deterministic precedence.
  - Enriched `/api/v1/state.retrying` rows with `worker_host` and `workspace_path`.
  - Added observability dashboard knobs (`dashboard_enabled`, `refresh_ms`, `render_interval_ms`) with safe minimums.
  - Added deterministic default prompt fallback for empty workflow prompt bodies and surfaced diagnostics marker (`workflow.prompt_fallback_active`).
- Key outputs:
  - `src/tracker/types.ts`
  - `src/tracker/linear-adapter.ts`
  - `src/tracker/github-adapter.ts`
  - `src/tracker/memory-adapter.ts`
  - `src/workflow/types.ts`
  - `src/workflow/resolver.ts`
  - `src/workflow/loader.ts`
  - `src/runtime/cli.ts`
  - `src/runtime/bootstrap.ts`
  - `src/orchestrator/core.ts`
  - `src/api/server.ts`
  - `src/api/dashboard-assets.ts`
  - `tests/tracker/*.test.ts`
  - `tests/workflow/*.test.ts`
  - `tests/api/server.test.ts`
  - `tests/runtime/bootstrap.test.ts`
- Validation commands:
  - `npm test`
  - `npm run build`
  - `npm run check:meta`
  - `git diff --check`

## Implementation Evidence (P15)
- Date: 2026-04-24
- Scope delivered:
  - Removed runtime bootstrap transitional observer alias and kept `logObserver` as the sole observer hook.
  - Added CLI lifecycle regression proving default CLI startup does not wire default logger as runtime observer.
  - Extended runtime logging source coverage to include explicit workflow-root source (`logs_root_source=workflow`) plus existing `default` and `cli` assertions.
  - Upgraded `check-log-context` from line-window regex checks to TypeScript AST analysis with file/line diagnostics.
  - Added dedicated script tests for canonical/pass and identifier/violation cases.
  - Updated logging and workflow config docs with the breaking rename and typed logging config reference.
- Key outputs:
  - `src/runtime/bootstrap.ts`
  - `tests/cli/lifecycle.test.ts`
  - `tests/runtime/bootstrap.test.ts`
  - `scripts/check-log-context.js`
  - `tests/cli/check-log-context.test.ts`
  - `docs/logging.md`
  - `docs/prd/PRD-002-workflow-config-reload.md`
  - `docs/prd/STATUS.md`
- Validation commands:
  - `npm test`
  - `npm run build`
  - `npm run check:meta`
  - `git diff --check`

## Implementation Evidence (P14b)
- Date: 2026-04-23
- Scope delivered:
  - Added rotating durable file sink (`symphony.log` with capped archives) while keeping default stderr visibility.
  - Added runtime log-root resolution contract with precedence: CLI `--logs-root` > workflow `logging.root` > workflow-scoped default (`<workflow_dir>/.symphony/log`).
  - Kept intentional path-semantics divergence from Elixir: TypeScript `--logs-root` is the direct directory containing `symphony.log*`.
  - Added fail-fast startup behavior for non-writable logging root with typed config error (`invalid_logging_root`).
  - Extended diagnostics contract with additive `logging` block (`root`, `active_file`, `rotation`, `sinks`).
  - Added local debug skill contract and updated logging docs for operational discovery/query flows.
  - Added meta check to prevent non-canonical `identifier` context-key regressions in issue-scoped log contexts.
- Key outputs:
  - `src/observability/logger.ts`
  - `src/runtime/cli.ts`
  - `src/runtime/cli-runner.ts`
  - `src/runtime/bootstrap.ts`
  - `src/workflow/types.ts`
  - `src/workflow/resolver.ts`
  - `src/api/types.ts`
  - `src/api/server.ts`
  - `scripts/check-log-context.js`
  - `scripts/check-meta.js`
  - `.codex/skills/debug/SKILL.md`
  - `docs/logging.md`
  - `docs/analysis/crossref/02-cross-reference-matrix.md`
  - `docs/analysis/crossref/03-recommendations-and-migration-plan.md`
  - `docs/analysis/crossref/appendix/subsystem-diff.json`
  - `docs/prd/STATUS.md`
- Validation commands:
  - `npm test`
  - `npm run build`
  - `npm run check:meta`
  - `git diff --check`

## Implementation Evidence (P14)
- Date: 2026-04-23
- Scope delivered:
  - Added explicit orchestrator lifecycle logs for dispatch attempt/success/failure, retry scheduling, worker exits, termination transitions, and stall handling.
  - Standardized issue/session log context keys for issue-related logs (`issue_id`, `issue_identifier`, `session_id`) and removed non-canonical `identifier` usage from retry failure logs.
  - Added explicit AgentRunner boundary logs for attempt started/completed/failed with issue/session context.
  - Extended canonical event vocabulary for new lifecycle events and updated covered emitter checks.
  - Added reference-aligned local logging contract document in `docs/logging.md`.
- Key outputs:
  - `src/observability/events.ts`
  - `src/orchestrator/core.ts`
  - `src/orchestrator/local-runner-bridge.ts`
  - `src/runtime/bootstrap.ts`
  - `tests/orchestrator/core.test.ts`
  - `tests/orchestrator/local-runner-bridge.test.ts`
  - `tests/observability/events-vocabulary.test.ts`
  - `docs/logging.md`
  - `docs/analysis/crossref/02-cross-reference-matrix.md`
  - `docs/analysis/crossref/03-recommendations-and-migration-plan.md`
  - `docs/analysis/crossref/appendix/subsystem-diff.json`
  - `docs/prd/STATUS.md`
- Validation commands:
  - `npm test`
  - `npm run build`
  - `npm run check:meta`
  - `git diff --check`

## Implementation Evidence (P12)
- Date: 2026-04-17
- Scope delivered:
  - XR-06 closed with throughput aggregation (`5s`, `60s`, `10m`), additive `/api/v1/state` fields (`throughput`, `recent_runtime_events`), and dashboard runtime-event feed + throughput panel wired through `/api/v1/ui-state` continuity keys.
  - XR-09 closed with canonical event vocabulary registry (`event_vocabulary_version: v2`) and covered emitter migration (workflow/orchestrator/codex/runtime/api) to canonical names.
  - Locked hard-cut decision: no `legacy_event` alias retained (no external users), frontend and diagnostics consume canonical names directly.
- Key outputs:
  - `src/observability/events.ts`
  - `src/observability/throughput.ts`
  - `src/orchestrator/core.ts`
  - `src/api/server.ts`
  - `src/api/snapshot-service.ts`
  - `src/api/dashboard-assets.ts`
  - `tests/observability/throughput.test.ts`
  - `tests/observability/events-vocabulary.test.ts`
  - `docs/analysis/crossref/02-cross-reference-matrix.md`
  - `docs/analysis/crossref/03-recommendations-and-migration-plan.md`
  - `docs/analysis/crossref/appendix/subsystem-diff.json`
- Validation commands:
  - `npm test`
  - `npm run build`
  - `npm run check:meta`
  - `git diff --check`

## Implementation Evidence (P9d)
- Date: 2026-04-12
- Scope delivered (domain/config/telemetry + Section 18 conformance parity closure):
  - Added explicit Section 4.1 live-session parity fields in orchestrator runtime state and API projections:
    - `thread_id`, `turn_id`, `codex_app_server_pid`, `last_event_summary` are now tracked and projected.
    - `session_id` composition remains `<thread_id>-<turn_id>` with fallback synthesis when event payloads provide thread/turn IDs.
  - Added optional humanized event summaries for Section 13.6 telemetry parity as observability-only output:
    - runtime keeps `last_event_summary` without coupling orchestrator control logic to humanized text.
  - Added Section 6.4 worker extension config support and validation:
    - `worker.ssh_hosts` parsing/normalization.
    - `worker.max_concurrent_agents_per_host` parsing and positive-integer validation semantics.
  - Extended deterministic tests for all closed parity gaps:
    - `tests/orchestrator/core.test.ts`
      - `aggregates worker event usage and turn counts deterministically` now asserts `thread_id`, `turn_id`, `codex_app_server_pid`, and `last_event_summary`.
    - `tests/api/snapshot-service.test.ts`
      - state and issue projection assertions now cover `thread_id`, `turn_id`, `codex_app_server_pid`, and summary fields.
    - `tests/api/server.test.ts`
      - issue endpoint projection now asserts `thread_id`, `turn_id`, and `codex_app_server_pid`.
    - `tests/workflow/resolver.test.ts`
      - `parses optional worker extension fields` validates worker extension resolution behavior.
    - `tests/workflow/validator.test.ts`
      - `rejects non-positive worker max_concurrent_agents_per_host when provided` validates extension safety semantics.
- SPEC closure intent:
  - SPEC 4.1 (`Domain Model`): session/thread/turn/pid and summarized event parity fields are represented in runtime state and API contracts.
  - SPEC 6.4 (`Config Fields Summary`): worker extension cheat-sheet fields are parsed and validated deterministically.
  - SPEC 13.5 (`Session Metrics and Token Accounting`): token/rate-limit accounting remains deterministic and projected with updated live-session identifiers.
  - SPEC 13.6 (`Humanized Agent Event Summaries`): optional summaries are implemented as observability-only output.
  - SPEC 18 + 18.1 + 18.2 (`Implementation Checklist`): conformance checklist rows now have explicit triad evidence anchors across code/tests/observability and are reflected in parity/traceability updates.
- Outputs:
  - `src/orchestrator/types.ts`
  - `src/orchestrator/core.ts`
  - `src/runtime/bootstrap.ts`
  - `src/api/types.ts`
  - `src/api/snapshot-service.ts`
  - `src/workflow/types.ts`
  - `src/workflow/resolver.ts`
  - `src/workflow/validator.ts`
  - `tests/orchestrator/core.test.ts`
  - `tests/api/snapshot-service.test.ts`
  - `tests/api/server.test.ts`
  - `tests/workflow/resolver.test.ts`
  - `tests/workflow/validator.test.ts`
  - `docs/prd/TRACEABILITY-MATRIX.md`
  - `docs/prd/SPEC-LINE-PARITY-AUDIT.md`
  - `docs/prd/STATUS.md`
- Validation commands:
  - `npm test`
  - `npm run build`
  - `git diff --check`

## Implementation Evidence (P9c)
- Date: 2026-04-12
- Scope delivered (failure-model/security-hardening parity closure):
  - Added deterministic recovery-transition and failure-class diagnostics in orchestrator core:
    - `dispatch_validation_recovered`
    - `tracker_state_refresh_failed`
    - `tracker_retry_fetch_failed`
    - Existing `dispatch_validation_failed` and `tracker_candidate_fetch_failed` now include tick/error context.
  - Added deterministic startup/restart recovery diagnostics in runtime bootstrap:
    - `startup_orchestrator_state_initialized` with cold-start source and cleared-state counters.
    - `startup_terminal_cleanup_completed` with terminal issue count and cleanup pass/fail counts.
  - Extended deterministic tests to lock in these failure-model and hardening observability guarantees:
    - `tests/orchestrator/core.test.ts`
      - `emits dispatch validation recovered when preflight transitions failed->ok`
      - `logs tracker state refresh failure and keeps workers running`
      - `logs retry candidate fetch failure and requeues retry with incremented attempt`
    - `tests/runtime/bootstrap.test.ts`
      - `emits startup cold-start and terminal cleanup diagnostics markers`
  - Reused existing hardening controls/signals for SPEC 15.5 closure evidence:
    - security posture diagnostics via `security_profile_active` and `/api/v1/diagnostics.active_profile`.
    - secret/log redaction and workspace safety controls validated by existing `tests/security/*.test.ts` and `tests/workspace/workspace-manager.test.ts` anchors.
- SPEC closure intent:
  - SPEC 14.1 (`Failure Classes`): explicit failure-class observability and deterministic fault-path assertions across workflow/tracker/worker/bootstrap handling.
  - SPEC 14.2 (`Recovery Behavior`): deterministic recovery transition behavior and retry/reconciliation failure handling with non-crash semantics.
  - SPEC 14.3 (`Partial State Recovery`): startup cold-state initialization and terminal cleanup sweep are explicitly signaled and tested.
  - SPEC 14.4 (`Operator Intervention Points`): operator-visible dispatch/recovery and startup cleanup markers are exposed via logs/API health surfaces.
  - SPEC 15.5 (`Harness Hardening Guidance`): hardening posture is explicitly observable (`security_profile_active`, diagnostics profile payload), with deterministic tests guarding safety-relevant behavior.
- Outputs:
  - `src/orchestrator/core.ts`
  - `src/runtime/bootstrap.ts`
  - `tests/orchestrator/core.test.ts`
  - `tests/runtime/bootstrap.test.ts`
  - `docs/prd/TRACEABILITY-MATRIX.md`
  - `docs/prd/SPEC-LINE-PARITY-AUDIT.md`
  - `docs/prd/STATUS.md`
- Validation commands:
  - `npm test`
  - `npm run build`
  - `git diff --check`

## Implementation Evidence (P9b)
- Date: 2026-04-12
- Scope delivered (real integration + operational validation profile evidence):
  - Added deterministic profile harness in `scripts/validate-real-integration-profile.js` with explicit evidence markers:
    - `P9B_PROFILE`, `P9B_MODE`, `P9B_REAL_INTEGRATION_REQUIRED`
    - `P9B_EVIDENCE_OPERATIONAL_CHECKS`, `P9B_EVIDENCE_WORKSPACE_ISOLATION`, `P9B_EVIDENCE_REAL_TRACKER`
    - `P9B_PROFILE_RESULT` (`PASS|SKIPPED|FAIL`)
  - Added required-mode command wiring in `package.json`:
    - `npm run validate:integration-profile`
    - `npm run validate:integration-profile:required`
  - Added deterministic script tests in `tests/cli/integration-profile-script.test.ts` for conservative skip/fail/pass semantics:
    - missing `LINEAR_API_KEY` in non-required mode reports `SKIPPED`
    - missing `LINEAR_API_KEY` in required mode fails
    - required mode rejects dry-run
    - live required-mode path validates operational command markers and tracker smoke pass via mock endpoint
  - Added executable runbook in `docs/prd/P9B-REAL-INTEGRATION-PROFILE.md` with command set, expected markers, and pass/fail criteria.
  - Extended `docs/prd/TRACEABILITY-MATRIX.md` with explicit SPEC 17.8 + 18.3 mapping rows linked to the harness/test anchors.
- SPEC closure intent:
  - SPEC 17.8 (`Real Integration Profile`): covered by real tracker credential checks, explicit skipped-state reporting, and required-mode failure behavior.
  - SPEC 18.3 (`Operational Validation Before Production`): covered by profile command set validating hook behavior, workflow path resolution, and optional HTTP server operational checks.
- Outputs:
  - `scripts/validate-real-integration-profile.js`
  - `tests/cli/integration-profile-script.test.ts`
  - `docs/prd/P9B-REAL-INTEGRATION-PROFILE.md`
  - `docs/prd/TRACEABILITY-MATRIX.md`
  - `docs/prd/SPEC-LINE-PARITY-AUDIT.md`
  - `docs/prd/STATUS.md`
- Captured invocation evidence (audit artifact):
  - Command: `npm run validate:integration-profile`
  - Output excerpt:
    - `P9B_PROFILE=REAL_INTEGRATION`
    - `P9B_MODE=LIVE`
    - `P9B_REAL_INTEGRATION_REQUIRED=0`
    - `P9B_COMMAND=npm test -- --run tests/cli/cli-args.test.ts`
    - `P9B_COMMAND=npm test -- --run tests/workspace/workspace-manager.test.ts`
    - `P9B_COMMAND=npm test -- --run tests/runtime/bootstrap.test.ts tests/api/server.test.ts`
    - `P9B_EVIDENCE_OPERATIONAL_CHECKS=PASS`
    - `P9B_EVIDENCE_WORKSPACE_ISOLATION=PASS`
    - `P9B_EVIDENCE_REAL_TRACKER=SKIPPED_MISSING_LINEAR_API_KEY`
    - `P9B_PROFILE_RESULT=SKIPPED`
  - Canonical evidence reference: `docs/prd/P9B-REAL-INTEGRATION-PROFILE.md` (`Captured Invocation Evidence (2026-04-12)` section).
- Validation commands:
  - `npm test`
  - `npm run build`
  - `git diff --check`

## Implementation Evidence (P9a)
- Date: 2026-04-12
- Scope delivered (CLI/host lifecycle + HTTP extension parity):
  - Added deterministic CLI argument resolution with required positional workflow path semantics in `src/runtime/cli.ts` and wired `scripts/start-dashboard.js` to use it.
  - Implemented lifecycle-compatible workflow path precedence: positional argument, then `--workflow=` compatibility alias, then `SYMPHONY_WORKFLOW_PATH`, then default `./WORKFLOW.md`.
  - Removed implicit always-on HTTP behavior in runtime bootstrap and gated HTTP extension startup to explicit port sources only (`--port` via runtime option or `server.port` from workflow).
  - Added explicit HTTP bind/startup diagnostics (`runtime_args_resolved`, `api_server_listening`, `runtime_http_enabled`, `runtime_http_disabled`) to satisfy P9a observability evidence.
  - Added deterministic lifecycle tests under `tests/cli/` that verify startup-failure surfacing, success exit on normal signal shutdown, and nonzero exit on abnormal host/fatal paths, plus runtime and API coverage updates.
- Outputs:
  - `scripts/start-dashboard.js`
  - `src/runtime/cli.ts`
  - `src/runtime/bootstrap.ts`
  - `src/api/server.ts`
  - `tests/cli/cli-args.test.ts`
  - `tests/cli/lifecycle.test.ts`
  - `tests/runtime/bootstrap.test.ts`
  - `tests/api/server.test.ts`
  - `docs/prd/SPEC-LINE-PARITY-AUDIT.md`
- Validation commands:
  - `npm test`
  - `npm run build`
  - `git diff --check`

## Implementation Evidence (P8)
- Date: 2026-04-12
- Scope delivered (SPEC line parity audit + backlog extraction):
  - Added deterministic sentence/bullet parity audit artifact in
    `docs/prd/SPEC-LINE-PARITY-AUDIT.md`.
  - Parsed `SPEC.md` into atomic units with stable IDs
    (`SPEC-<section>-<unit_index>`) and classified all unit ranges as
    `implemented`, `partially_implemented`, `missing`, or `not_applicable`.
  - Applied strict triad evidence mapping (code + tests + observability) to
    all implemented range classifications.
  - Created backlog bundle stories `P9a` through `P9d`; every partial/missing
    SPEC range maps to exactly one follow-up story.
- Coverage summary:
  - Total units classified: `1240`
  - Implemented ranges: `60`
  - Partially implemented ranges: `13`
  - Missing ranges: `3`
  - Not applicable ranges: `5`
- Outputs:
  - `docs/prd/SPEC-LINE-PARITY-AUDIT.md`
  - `docs/prd/STATUS.md` queue and routing updates
- Validation commands:
  - `npm test`
  - `npm run build`
  - `git diff --check`

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

## Implementation Evidence (P6)
- Date: 2026-04-11
- Scope delivered (security profiles + redaction + minimal persistence):
  - Security profile contract and precedence in `src/security/profiles.ts`:
    - Balanced safe default profile (`approval_policy=on-request`, `thread_sandbox=workspace-write`, `turn_sandbox_policy.type=workspace-write`, `user_input_policy=fail_attempt`).
    - Deterministic precedence from defaults with workflow codex overrides for allowed fields.
    - Operator-visible startup diagnostics (`security_profile_active`) emitted from `src/runtime/bootstrap.ts`.
  - Secret redaction in `src/security/redaction.ts` integrated across:
    - Logs: `src/observability/logger.ts`
    - API payloads: `src/api/server.ts`, `src/api/snapshot-service.ts`
    - Persistence writes/reads: `src/persistence/store.ts`
  - Minimal durable local persistence with SQLite in `src/persistence/store.ts`:
    - Append-only run/session history records (`run_id`, `issue_id`, `issue_identifier`, `started_at`, `ended_at`, `terminal_status`, `error_code`, `session_ids`).
    - UI continuity state persistence (`selected_issue`, `filters`, `panel_state`).
    - Retention pruning and integrity diagnostics (`pruneExpiredRuns`, `health`).
  - Runtime restart continuity behavior in `src/runtime/bootstrap.ts` and `src/orchestrator/core.ts`:
    - Durable history restored via `/api/v1/history` after restart.
    - Active running sessions and retry timers remain ephemeral and are not restored.
  - Operator diagnostics API in `src/api/server.ts`:
    - `GET /api/v1/diagnostics` (active profile + persistence health)
    - `GET /api/v1/history`
    - `GET/POST /api/v1/ui-state`
- Test evidence:
  - `npm test` -> pass (21 files, 118 tests).
  - `npm run build` -> pass (`tsc --project tsconfig.json`).
  - `git diff --check` -> pass.
- SPEC coverage anchors (P6 closure):
  - Profile precedence/contract: `tests/security/profiles.test.ts`, `tests/workflow/validator.test.ts`, `tests/workflow/resolver.test.ts`
  - Secret redaction in logs/API/persistence outputs: `tests/security/redaction.test.ts`, `tests/observability/logger.test.ts`, `tests/api/server.test.ts`
  - Durable history + UI continuity + retention/integrity: `tests/persistence/store.test.ts`
  - Restart continuity semantics: `tests/runtime/bootstrap.test.ts` (`restores durable history on restart without restoring running or retry state`)
- Gate outcome:
  - P6 exit criteria satisfied (security profile and redaction checks passing; minimal persistence continuity verified across restart).

## Implementation Evidence (P7)
- Date: 2026-04-11
- Scope delivered (GitHub adapter + PR metadata parity):
  - GitHub tracker adapter in `src/tracker/github-adapter.ts`:
    - Repository-scoped candidate/state-refresh queries with pagination and deterministic ordering.
    - Normalized issue parity mapping with lowercased labels, null-safe timestamps, and strict minimal-issue filtering.
    - PR linkage enrichment via optional `tracker_meta.pr_links` metadata for prompt/API diagnostics.
    - Typed error mapping (`github_api_request`, `github_api_status`, `github_graphql_errors`, `github_unknown_payload`, `github_missing_end_cursor`).
  - Shared tracker/workflow contract extensions:
    - `src/tracker/types.ts` adds optional `Issue.tracker_meta` and GitHub-specific error/config support.
    - `src/workflow/types.ts` adds GitHub validation codes and optional tracker owner/repo config fields.
  - Config/factory wiring for deterministic backend selection:
    - `src/workflow/resolver.ts` adds GitHub endpoint default and `$GITHUB_TOKEN` fallback resolution.
    - `src/workflow/validator.ts` supports `tracker.kind=github` with owner/repo required-field validation.
    - `src/tracker/factory.ts` now selects Linear or GitHub adapters by kind with typed missing-field failures.
  - Post-review hardening for first-run GitHub dispatch safety:
    - GitHub defaults now use dispatch-capable states (`active_states=['Open']`, `terminal_states=['Closed']`).
    - Validator rejects unmappable GitHub `active_states` with typed failure (`invalid_tracker_active_states_for_github`).
    - Adapter fails fast on non-empty unsupported state filters (`github_invalid_state_filter`) instead of silent no-op.
- Test evidence:
  - `npm test` -> pass (22 files, 133 tests).
  - `npm run build` -> pass (`tsc --project tsconfig.json`).
  - `git diff --check` -> pass (`DIFF_CHECK_EXIT:0`).
- SPEC/PRD coverage anchors (P7 closure):
  - SPEC 17.3 (`Issue Tracker Client`): `tests/tracker/github-adapter.test.ts`, `tests/tracker/factory.test.ts`, `tests/tracker/linear-adapter.test.ts`
  - Config parity and kind-specific validation: `tests/workflow/resolver.test.ts`, `tests/workflow/validator.test.ts`
  - PRD-007 acceptance points covered: normalized parity, pagination, PR metadata null-safe enrichment, typed error mapping, deterministic kind switch, and dispatch-capable defaults.
- Gate outcome:
  - P7 exit criteria satisfied (GitHub adapter contract tests passing; Linear regression suite remains green).

## Implementation Evidence (P10)
- Date: 2026-04-17
- Scope delivered (web parity + superset execution):
  - Replaced dashboard information architecture in `src/api/dashboard-assets.ts` with parity-complete operator surface:
    - Hero with explicit `Live/Offline` connection badge and last-update timestamp.
    - KPI strip for running/retrying/tokens/runtime.
    - Dedicated rate-limit panel.
    - Running sessions table with parity actions and metadata columns (`state badge`, `session`, `runtime`, `turns`, `tokens`, `last event`, `last message`, `last event at`, row actions).
    - Retry queue table and upgraded issue-detail panel.
    - Diagnostics/history extension panels integrated as first-class UI sections.
  - Added realtime push API in `src/api/server.ts`:
    - `GET /api/v1/events` SSE endpoint with typed envelopes:
      - `state_snapshot`
      - `refresh_accepted`
      - `runtime_health_changed`
      - `heartbeat`
    - Monotonic `event_id` and `generated_at` included in each envelope.
    - Streaming clients receive initial snapshot and ongoing updates; method/error envelope semantics remain stable.
  - Wired runtime observer notifications in `src/runtime/bootstrap.ts`:
    - Orchestrator observer callbacks now trigger API stream state publication on tick/reconcile lifecycle updates.
    - Existing REST endpoints remain unchanged and backward compatible.
  - Added resilient client stream behavior in dashboard JS:
    - SSE first, with exponential reconnect and polling fallback when stream is disconnected.
    - UI continuity persistence/restoration retained via `GET/POST /api/v1/ui-state`.
    - No unsafe `innerHTML` usage; runtime/tracker-controlled content is rendered via text-node APIs.
- Public interface deltas:
  - Added `GET /api/v1/events` contract and `ApiEventEnvelope` / `ApiEventType` in `src/api/types.ts`.
  - No breaking changes to:
    - `GET /api/v1/state`
    - `POST /api/v1/refresh`
    - `GET /api/v1/:issue_identifier`
    - diagnostics/history/ui-state extension endpoints.
- Test evidence:
  - `tests/api/server.test.ts`
    - `serves GET /api/v1/events as SSE and emits state snapshots with monotonic ids`
    - `emits refresh_accepted event envelopes on POST /api/v1/refresh`
    - updated dashboard asset assertions for new UI/stream contract.
  - `tests/runtime/bootstrap.test.ts`
    - `exposes SSE event stream endpoint for runtime state push updates`
  - Full regression validation:
    - `npm test` -> pass (`27` files, `176` tests).
    - `npm run build` -> pass (`tsc --project tsconfig.json`).
    - `git diff --check` -> pass.
- Gate outcome:
  - P10 web parity + superset scope closed with SSE contract, operator surface redesign, runtime observer push wiring, and non-breaking API compatibility.

## Implementation Evidence (P11)
- Date: 2026-04-17
- Scope delivered (XR-01, XR-02, XR-04, XR-05, XR-08; breaking defaults now):
  - XR-01 + XR-07 combined strict-default execution:
    - Replaced balanced-first default with strict security profile defaults in `src/security/profiles.ts`.
    - Added mandatory startup acknowledgment flag in `src/runtime/cli.ts`:
      - `--i-understand-that-this-will-be-running-without-the-usual-guardrails`
    - Enforced deterministic startup block in `src/runtime/cli-runner.ts` when flag is missing, with explicit nonzero exit and fixed banner + telemetry (`startup_guardrail_ack_required`).
  - XR-02 approval-policy compatibility + unsafe-root diagnostics:
    - Expanded `WorkflowConfig.codex.approval_policy` contract to support string or object shape in `src/workflow/types.ts`.
    - Added resolver/validator normalization + typed error handling for invalid object shapes in `src/workflow/resolver.ts` and `src/workflow/validator.ts`.
    - Updated protocol forwarding in `src/codex/runner.ts` so `thread/start` and `turn/start` preserve normalized string/object policy payloads.
    - Added unsafe-root pre-spawn fail-fast diagnostics in `src/orchestrator/local-worker-runner.ts` (`unsafe_workspace_root` mapped through deterministic startup-failed path).
  - XR-04 remote worker execution activation:
    - Activated host-aware scheduling in orchestrator with deterministic round-robin and per-host cap enforcement in `src/orchestrator/core.ts`.
    - Threaded `worker_host` through orchestrator/bridge/runner contracts (`src/orchestrator/types.ts`, `src/orchestrator/local-runner-bridge.ts`, `src/codex/runner.ts`).
    - Added SSH remote spawn path with remote cwd validation and typed failures in `src/codex/runner.ts`.
    - Wired worker host settings into runtime bootstrap in `src/runtime/bootstrap.ts`.
  - XR-05 dynamic tool adapter enabled by default:
    - Added dynamic tool registry/executor subsystem in `src/codex/dynamic-tools.ts`.
    - `thread/start` now always advertises dynamic tools; `item/tool/call` is executed by registry-backed handlers in `src/codex/runner.ts`.
    - Added built-in `linear_graphql` dynamic tool wiring via runtime bootstrap with redaction-safe error mapping and preserved token telemetry fields.
  - XR-08 meta quality gates:
    - Added script checks:
      - `scripts/check-api-contract.js`
      - `scripts/check-pr-governance.js`
      - `scripts/check-meta.js`
    - Added lifecycle command in `package.json`: `npm run check:meta`.
    - Added script-level tests in `tests/cli/meta-check-scripts.test.ts`.
- Public/runtime contract impacts:
  - Startup now requires explicit guardrail acknowledgment flag.
  - Default security posture is strict immediately (no compatibility default mode).
  - `codex.approval_policy` supports string and object forms.
  - Dynamic tools are advertised and enabled by default.
  - Worker host fields are behaviorally active at runtime.
- Test evidence:
  - `tests/security/profiles.test.ts`
  - `tests/cli/cli-args.test.ts`
  - `tests/cli/lifecycle.test.ts`
  - `tests/workflow/resolver.test.ts`
  - `tests/workflow/validator.test.ts`
  - `tests/codex/runner.test.ts`
  - `tests/orchestrator/core.test.ts`
  - `tests/orchestrator/local-runner-bridge.test.ts`
  - `tests/runtime/bootstrap.test.ts`
  - `tests/cli/meta-check-scripts.test.ts`
- Validation commands:
  - `npm test`
  - `npm run build`
  - `npm run check:meta`
  - `git diff --check`
- Gate outcome:
  - P11 closure criteria satisfied for XR-01/XR-02/XR-04/XR-05/XR-08 with breaking-defaults rollout.

## Phase Gates
1. P0 exit requires: PRD package approved; ownership and dependencies accepted; traceability matrix converted from scaffold to actionable mapping.
2. P1 exit requires: Section 17.1 tests passing; typed validation errors surfaced in logs/API.
3. P2 exit requires: Section 17.3 and 17.4 tests passing for Linear core; no duplicate dispatch under simulated load.
4. P3 exit requires: Section 17.2 tests passing; workspace containment invariants verified.
5. P4 exit requires: Section 17.5 tests passing; session protocol soak test completed.
6. P5 exit requires: Section 17.6 pass criteria met; `/api/v1/state`, `/api/v1/<issue_identifier>`, `/api/v1/refresh` stable for UI.
7. P6 exit requires: security profile and redaction checks passing; minimal persistence continuity verified across restart.
8. P7 exit requires: GitHub adapter contract tests passing; Linear regression suite remains green.
9. P10 exit requires: SSE `/api/v1/events` contract stable, dashboard parity surface implemented, and REST compatibility preserved.
10. P11 exit requires: strict-default security + guardrail acknowledgment enforced, approval policy shape compatibility implemented, remote worker host path active, dynamic tools enabled by default, and `npm run check:meta` green.

## Active Blockers
- None.

## Sign-off Evidence (P0 Item 1)
- Date: 2026-04-10
- Scope reviewed:
  - `PRD-000` through `PRD-008` in `docs/prd/`
  - `INDEX.md` package ordering and completeness contract
  - `TRACEABILITY-MATRIX.md` owner/test/observability linkage scaffold
- Outcome: Accepted as planning baseline for remaining P0 checklist items.

## Sign-off Evidence (P0 Interface Ownership)
- Date: 2026-04-12
- Scope reviewed:
  - `Interface Ownership (P0 Governance Evidence)` section in this file.
  - Subsystem boundaries in `docs/prd/PRD-000-master.md`.
  - Requirement-level owner role references in
    `docs/prd/TRACEABILITY-MATRIX.md`.
- Outcome: Ownership per subsystem is explicitly assigned with boundaries,
  dependency routing, and acceptance-test anchors.

## References
- Index: `/Users/niels.van.Galen.last/code/symphony/docs/prd/INDEX.md`
- Roadmap/gates: `/Users/niels.van.Galen.last/code/symphony/docs/prd/PRD-008-delivery-roadmap-gates.md`
- Traceability: `/Users/niels.van.Galen.last/code/symphony/docs/prd/TRACEABILITY-MATRIX.md`
- SPEC parity audit (P8): `/Users/niels.van.Galen.last/code/symphony/docs/prd/SPEC-LINE-PARITY-AUDIT.md`
