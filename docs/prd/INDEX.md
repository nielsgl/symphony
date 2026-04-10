# Symphony PRD Index

## Package Summary
This directory contains the decision-complete PRD suite for Symphony:
- macOS-first Tauri desktop app with embedded UI
- local orchestrator daemon
- Linear-first core conformance
- required local HTTP API
- GitHub Issues support in Phase 2

## Documents
0. [Status Tracker](/Users/niels.van.Galen.last/code/symphony/docs/prd/STATUS.md)
1. [PRD-000 Master](/Users/niels.van.Galen.last/code/symphony/docs/prd/PRD-000-master.md)
2. [PRD-001 Orchestrator Core (Linear)](/Users/niels.van.Galen.last/code/symphony/docs/prd/PRD-001-orchestrator-core-linear.md)
3. [PRD-002 Workflow and Config Reload](/Users/niels.van.Galen.last/code/symphony/docs/prd/PRD-002-workflow-config-reload.md)
4. [PRD-003 Workspace Lifecycle and Safety](/Users/niels.van.Galen.last/code/symphony/docs/prd/PRD-003-workspace-lifecycle-safety.md)
5. [PRD-004 Codex Runner and Session Protocol](/Users/niels.van.Galen.last/code/symphony/docs/prd/PRD-004-codex-runner-session-protocol.md)
6. [PRD-005 Observability, Local API, and Desktop UI](/Users/niels.van.Galen.last/code/symphony/docs/prd/PRD-005-observability-local-api-desktop-ui.md)
7. [PRD-006 Security Profiles, Approval Policy, and Minimal Persistence](/Users/niels.van.Galen.last/code/symphony/docs/prd/PRD-006-security-approval-profiles-persistence.md)
8. [PRD-007 Phase 2: GitHub Issues Adapter with PR Metadata](/Users/niels.van.Galen.last/code/symphony/docs/prd/PRD-007-phase2-github-issues-pr-metadata.md)
9. [PRD-008 Delivery Roadmap, Dependencies, and Gates](/Users/niels.van.Galen.last/code/symphony/docs/prd/PRD-008-delivery-roadmap-gates.md)
10. [Traceability Matrix](/Users/niels.van.Galen.last/code/symphony/docs/prd/TRACEABILITY-MATRIX.md)

## Reading Order
- Start: PRD-000
- Build core: PRD-002 -> PRD-001 -> PRD-003 -> PRD-004
- Integrate operator surface: PRD-005
- Apply safety/persistence: PRD-006
- Execute phased roadmap: PRD-008
- Plan Phase 2: PRD-007
- Validate completeness: TRACEABILITY-MATRIX

## Definition of Complete PRD Package
- Every core requirement in SPEC 18.1 has an owner and test/observability mapping.
- Interface contracts are explicit enough for parallel implementation.
- Roadmap gates enforce Linear core completion before GitHub phase entry.
