# PRD-004 Repair Loop And Escalation Policy

## Problem Statement

Many Symphony tickets move through repeated implementation and review loops. Some loops are legitimate, but repeated phase transitions can become expensive when the system does not record a typed repair reason, blocker category, expected scope, or escalation threshold.

From the user's perspective, the workflow should distinguish useful repair from unbounded churn.

## Solution

Introduce a phase-aware repair loop policy. Every return from review or merge back to implementation records a structured reason, blocker category, changed scope, expected validation scope, and escalation state. Soft thresholds trigger narrower repair plans or human/planning intervention when the same ticket repeats without new evidence.

## User Stories

1. As an operator, I want repeated phase loops to be visible, so that I can intervene before token spend grows.
2. As a reviewer, I want a typed reason when review sends work back to implementation, so that the repair target is clear.
3. As an agent, I want scoped repair instructions, so that I do not rediscover the whole ticket.
4. As an agent, I want the prior blocker category, so that I can validate the actual failure.
5. As a maintainer, I want soft thresholds by iteration count and token spend, so that legitimate hard work is not blocked automatically.
6. As a maintainer, I want repeated failed validation to trigger escalation, so that loops are not hidden as progress.
7. As an operator, I want escalation reasons recorded on the ticket, so that the next action is explicit.
8. As a product owner, I want reports of repair loops by ticket and phase, so that workflow bottlenecks are measurable.
9. As a reviewer, I want to know whether a repair changed only the blocker scope, so that rereview can be focused.
10. As an agent, I want repair-loop state in the handoff packet, so that I do not repeat previous failed approaches.
11. As a maintainer, I want policy thresholds configurable by workflow, so that small projects and high-risk repos can differ.
12. As an operator, I want an override path, so that urgent or unusual tickets can continue with an explicit rationale.

## Implementation Decisions

- Build a `Repair Loop Policy` module that evaluates ticket ledger state and returns continue, narrow repair, escalate, or block.
- Repair events include source phase, target phase, blocker category, expected changed scope, validation scope, evidence reference, and actor.
- Thresholds are soft by default and workflow-configurable.
- The Orchestrator evaluates policy before dispatching another implementation iteration after review or merge.
- Review handoff records use the same blocker categories that the policy consumes.
- Dashboard issue detail shows repair-loop count, latest reason, and escalation state.
- The Local API exposes repair-loop diagnostics for reports.
- The policy does not prevent legitimate work; it requires stronger evidence when loops repeat.

## Testing Decisions

- Unit tests cover policy decisions for first repair, repeated repair, high token spend, repeated validation failure, and override.
- Integration tests cover Agent Review returning to implementation with structured blocker categories.
- Regression tests cover tickets with multiple implementation-review loops.
- API tests cover repair-loop diagnostics.
- Tests should verify policy outcomes and recorded evidence, not internal threshold implementation details.

## Out of Scope

- Replacing human review judgment.
- Automatically closing or cancelling tickets.
- Changing tracker status names.
- Implementing validation reuse; this consumes validation state from PRD-002.
- Implementing handoff packets; this should integrate with PRD-003.

## Further Notes

This PRD is local only and was not published to any issue tracker. The policy should be conservative: escalate with evidence, not hard-stop useful work.
