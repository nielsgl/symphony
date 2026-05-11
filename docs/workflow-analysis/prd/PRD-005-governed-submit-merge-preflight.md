# PRD-005 Governed Submit And Merge Preflight

## Problem Statement

Merge and PR phases still use repeated shell probes and retry-prone command sequences. Missing PR body input, branch tracking questions, git config failures, template absence, label state, and mergeability can be discovered late after expensive validation or repeated commands.

From the user's perspective, merge and governed submit should start with one structured preflight and then consume its result instead of rediscovering the same facts.

## Solution

Create a governed submit and merge preflight that returns structured JSON. The preflight checks git config writability, branch tracking, PR identity, PR body source, labels, status checks, mergeability, template availability, validation ledger state, and required evidence. Governed submit and merge flows consume this preflight result and avoid duplicate probes until relevant inputs drift.

## User Stories

1. As an agent, I want one preflight result before governed submit, so that missing inputs are found early.
2. As an agent, I want PR body availability checked before validation reruns, so that avoidable failures do not waste time.
3. As an agent, I want branch tracking and PR identity checked together, so that push and PR commands are deterministic.
4. As an agent, I want git config writability checked once, so that repeated `rerere` failures do not loop.
5. As an agent, I want mergeability and status checks summarized, so that merge decisions are based on current state.
6. As a maintainer, I want preflight output to be machine-readable, so that submit and merge scripts do not scrape shell text.
7. As a reviewer, I want missing governance evidence reported before merge, so that handoff quality stays high.
8. As an operator, I want preflight failures categorized, so that common setup problems can be fixed systematically.
9. As an agent, I want preflight reuse until branch head or PR state changes, so that merge runs do not repeat probes.
10. As a maintainer, I want the preflight to consume validation ledger state, so that it does not trigger unnecessary reruns.
11. As an operator, I want preflight summaries visible in ticket diagnostics, so that merge blockers are clear.
12. As an agent, I want governed submit to fail closed when required PR body or evidence is missing, so that it does not create misleading PR state.

## Implementation Decisions

- Build a `Governed Preflight` module with a stable machine-readable result shape.
- Preflight sections include git environment, branch, PR, governance body, labels, checks, mergeability, validation, and evidence.
- Each section has status, observed values, failure category, and remediation hint.
- Governed submit and merge commands consume the preflight result instead of rerunning independent probes.
- Preflight reuse is valid until branch head, PR head, labels, checks, body source, or validation state changes.
- The Orchestrator records preflight results in the ticket ledger.
- Dashboard and Local API expose current preflight blockers.

## Testing Decisions

- Unit tests cover preflight result construction for clean, missing PR body, missing PR, untracked branch, unwritable git config, missing label, failing checks, and non-mergeable PR.
- Integration tests cover governed submit consuming preflight output.
- Integration tests cover merge consuming preflight output.
- Regression tests cover no-checks-reported merge state when governance validation is otherwise satisfied.
- Tests should assert structured failure categories and remediation hints.

## Out of Scope

- Changing merge policy.
- Replacing GitHub or Linear adapters.
- Automatically creating PR bodies.
- Skipping governance validation.
- Replacing validation ledger behavior.

## Further Notes

This PRD is local only and was not published to any issue tracker. The preflight should replace duplicated probes, not add another ceremony on top of them.
