# PRD-006 Simple Task Fast Path

## Problem Statement

Simple tickets can still trigger the same broad orchestration path as complex contract or runtime changes. The workflow analysis highlighted `NIE-121`, a button color change that still consumed multiple phase iterations and millions of recorded tokens. The system needs a safe way to narrow discovery and validation for low-risk tasks without hiding coupling or bypassing governance.

## Solution

Introduce a simple-task fast path that classifies narrow change types, selects scoped discovery and validation, and escalates to the full workflow when touched paths, generated artifacts, UI evidence gates, shared contracts, failing checks, or governance requirements demand it.

This fast path should be implemented after the ticket ledger and validation ledger are available, so its decisions are auditable and fail closed.

## User Stories

1. As an operator, I want simple tickets to avoid broad rediscovery, so that small changes do not become expensive.
2. As an agent, I want a touched-area classifier, so that I can choose the right validation scope.
3. As an agent, I want explicit escalation triggers, so that hidden coupling does not get missed.
4. As a reviewer, I want scoped validation decisions recorded, so that I can judge whether the fast path was safe.
5. As a reviewer, I want UI-only changes to still publish UI evidence, so that visual behavior is verified.
6. As a maintainer, I want docs-only changes to avoid runtime validation when safe, so that docs work stays lightweight.
7. As a maintainer, I want shared-contract changes to bypass the fast path, so that risky changes get full validation.
8. As an operator, I want fast-path metrics, so that token and time savings can be measured.
9. As an agent, I want the fast path to reuse validation ledger entries, so that prior evidence is not rerun unnecessarily.
10. As an agent, I want the fast path to fail closed on uncertainty, so that correctness is preserved.
11. As a product owner, I want small UI tasks to remain ergonomic while still respecting Human Review requirements.
12. As a maintainer, I want workflow-specific configuration for fast-path classes, so that repositories can tune risk tolerance.

## Implementation Decisions

- Build a `Task Scope Classifier` that returns docs-only, style-only, test-only, metadata-only, low-risk code, or full workflow required.
- The classifier uses touched areas, generated artifact state, shared contract markers, UI evidence requirements, validation failures, and workflow governance rules.
- Fast-path decisions are recorded in the ticket ledger with reason, confidence, validation scope, and escalation checks.
- The validation ledger provides reusable evidence for scoped checks.
- Handoff packets include the fast-path decision and any escalation reason.
- The Orchestrator starts with scoped discovery for accepted fast-path tasks.
- Any failed scoped validation escalates to full workflow or a typed repair path.
- UI-visible fast-path tasks still satisfy UI evidence and Human Review routing rules.

## Testing Decisions

- Unit tests cover task classification for docs-only, style-only, UI-visible style, tests-only, shared-contract, generated-artifact, and uncertain changes.
- Unit tests cover fail-closed behavior on ambiguous touched areas.
- Integration tests cover a UI-only task that still requires UI evidence.
- Integration tests cover a docs-only task that avoids runtime validation.
- Regression tests cover shared contract changes bypassing the fast path.
- Tests should assert external decisions and recorded reasons, not internal classifier heuristics.

## Out of Scope

- Skipping required UI evidence.
- Skipping governance checks.
- Applying fast path before validation ledger and ticket ledger support exist.
- Replacing human review for product-visible changes.
- Classifying every possible change perfectly in the first iteration.

## Further Notes

This PRD is local only and was not published to any issue tracker. The fast path is valuable, but it should follow ledger and validation safety work so it does not trade correctness for speed.
