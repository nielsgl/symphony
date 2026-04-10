# PRD-008 Delivery Roadmap, Dependencies, and Gates

## Problem and Goals (SPEC Alignment)
Provide a decision-complete phased execution plan with explicit dependency graph and entry/exit gates so implementation can proceed with low coordination ambiguity.

SPEC anchors:
- Core conformance obligations: Section 18.1
- Extension posture and future trackers: Section 18.2
- Validation profiles: Section 17

Goals:
- Sequence work to reduce integration risk.
- Define measurable completion criteria per phase.
- Keep GitHub tracker support isolated until Linear core hardens.

## Scope
In scope:
- Phase plan P0-P6 for v1 and Phase 2.
- Critical path and parallelizable workstreams.
- Gate criteria and rollback criteria.

Out of scope:
- Sprint staffing assignment by named individuals.

## Architecture and Ownership
Critical path:
1. Workflow/config and validation contract.
2. Orchestrator core loop and tracker adapter (Linear).
3. Workspace safety and hook lifecycle.
4. Codex runner integration.
5. Observability/API/UI integration.
6. Security profile hardening and minimal persistence.
7. Phase-2 GitHub adapter extension.

Parallelizable streams after P2:
- UI/dashboard implementation.
- Persistence implementation.
- Extended observability and diagnostics.

## Interface and Contract Milestones
Phase gates:
- P0: Architecture freeze and PRD sign-off.
- P1: `WorkflowConfig` + validation contract complete.
- P2: `Orchestrator` + `LinearAdapter` core contract complete.
- P3: `WorkspaceManager` invariants and hooks complete.
- P4: `CodexRunner` protocol compliance complete.
- P5: Local API and embedded UI complete.
- P6: Security profiles + minimal persistence complete.
- P7 (Phase 2): GitHub adapter + PR metadata complete.

Gate artifacts per phase:
- Contract tests passing.
- Required log/diagnostic signals present.
- Operator runbook updates accepted.

## Failure, Risk, and Recovery Plan
Top risks:
- Protocol drift with targeted Codex app-server version.
- Reload races causing stale/partial config application.
- Tracker API failure patterns under pagination/rate limits.
- UI/API drift from runtime snapshot semantics.

Risk controls:
- Contract-level golden tests for protocol and API schemas.
- Atomic config swap and invariant checks.
- Backpressure/coalescing on refresh and retries.
- Soak tests and failure injection before pilot.

## Security and Safety Gates
- Workspace containment and cwd invariants verified before P4 closure.
- Secret redaction tests and log audits required before P6 closure.
- Local API loopback bind and method restrictions required before P5 closure.

## Acceptance Criteria and Test Plan
Per-phase exit requires:
- Relevant Section 17 profile tests pass.
- No Sev-1/Sev-2 open defects in phase-owned modules.
- Traceability matrix updated with implemented requirements and evidence links.

Program-level acceptance:
- Full Section 18.1 requirement coverage.
- Team-scale validation (50 active issues, 10 concurrent agents) with no duplicate dispatch.
- macOS desktop pilot sign-off.

## Operational Rollout Plan
- Stage 1: Local developer alpha.
- Stage 2: Internal pilot with constrained workflow/project.
- Stage 3: Team production rollout with observability watch period.
- Stage 4: Phase-2 GitHub rollout under feature flag.
