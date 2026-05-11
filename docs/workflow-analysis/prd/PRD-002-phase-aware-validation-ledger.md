# PRD-002 Phase-Aware Validation Ledger

## Problem Statement

Symphony reruns expensive validation across phase iterations without a structured way to know whether prior evidence is still valid. The workflow analysis found repeated `npm test`, build, meta-check, and whitespace validation across the ticket cohort. Some repetition is required, but the system currently lacks an explicit validation cache key and invalidation reason.

From the user's perspective, review and merge phases should not blindly repeat implementation validation when the tree, environment, and evidence artifacts have not changed.

## Solution

Create a phase-aware validation ledger that records validation results by command, git tree identity, dependency identity, environment fingerprint, generated artifact identity, phase, and evidence reference. Later phases can reuse still-valid validation with explicit provenance, or rerun with a clear invalidation reason.

The system should fail closed when validation identity is incomplete or stale.

## User Stories

1. As an operator, I want validation results tied to a ticket and phase, so that I can see what was proven and when.
2. As an operator, I want validation reuse to be explicit, so that skipped reruns are auditable.
3. As an agent, I want to know whether prior `npm test` evidence is still valid, so that I do not rerun it unnecessarily.
4. As an agent, I want invalidation reasons, so that reruns are deliberate rather than habitual.
5. As a reviewer, I want PR and handoff summaries to cite validation evidence, so that I can trust phase transitions.
6. As a reviewer, I want reused validation to include the tree and environment identity, so that stale evidence is not accepted.
7. As a maintainer, I want validation results to be stored independently of assistant prose, so that reports do not parse final messages.
8. As a maintainer, I want command failures categorized, so that repeated failures are visible by cause.
9. As a maintainer, I want generated artifacts included in validation identity, so that build-dependent tests are safe to reuse.
10. As a maintainer, I want missing cache keys to force reruns, so that correctness beats speed.
11. As an operator, I want to compare validation reuse rates before and after rollout, so that improvements are measurable.
12. As an agent, I want scoped validation suggestions based on touched areas, so that a docs-only or style-only change does not default to full validation without reason.

## Implementation Decisions

- Build a deep `Validation Ledger` module with record, lookup, invalidate, and summarize operations.
- Validation identity includes command, cwd category, git tree hash, dependency lock hash, environment fingerprint, generated artifact hash, and evidence artifact hash.
- Validation records are attached to ticket, phase, and run iteration.
- Validation lookup returns one of: reusable, invalidated, missing, or unsafe.
- Reuse decisions include a human-readable reason and the exact identity that was checked.
- The Orchestrator and governed submit flow consume validation summaries instead of scraping prior assistant messages.
- The Local API exposes validation summaries on ticket detail views.
- Validation reuse never bypasses required UI evidence or governance checks unless those checks have their own valid evidence record.

## Testing Decisions

- Unit tests cover validation identity construction and invalidation behavior.
- Unit tests cover fail-closed behavior when any required identity field is missing.
- Integration tests cover implementation-to-review and review-to-merge validation reuse.
- Regression tests cover tree changes, lockfile changes, generated artifact changes, and environment changes invalidating records.
- API tests cover validation summary fields.
- Tests should assert behavior at the validation contract level, not internal persistence details.

## Out of Scope

- Changing what validations the repository requires.
- Removing full validation from high-risk changes.
- Replacing UI evidence publication.
- Implementing the ticket orchestration ledger; this depends on PRD-001.

## Further Notes

This PRD is local only and was not published to any issue tracker. It is the highest direct lever for reducing duplicate validation while preserving safety.
