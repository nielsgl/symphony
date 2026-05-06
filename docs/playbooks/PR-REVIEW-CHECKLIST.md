# PR Review Checklist (Behavior-First)

Use this checklist for every implementation handoff before moving an issue to
`Agent Review`, and during Agent Review before routing the issue onward.

## 1) Semantic correctness (must pass)

- [ ] The core behavior change is implemented, not just UI/API contract additions.
- [ ] There is a concrete code path that applies the user action to runtime behavior.
- [ ] Claimed success modes are reachable in code (no hardcoded fallback-only stubs for in-scope behavior).
- [ ] No production-path placeholders/TODO stubs remain for required ticket scope.

## 2) Scenario matrix (must be present in PR description)

For each scenario, include expected status, mode, and reason code:

- [ ] Primary happy path (e.g. native apply).
- [ ] Designed fallback path.
- [ ] Request/session mismatch path.
- [ ] Validation failure path.
- [ ] Transport/session-expiry failure path (when applicable).

## 3) API/contract guarantees

- [ ] Success envelopes include all required typed fields.
- [ ] Failure envelopes are typed and map to deterministic HTTP codes.
- [ ] Error code naming is consistent across orchestrator, API, and tests.

## 4) Test evidence (must pass)

- [ ] Integration test proves primary behavior path.
- [ ] Integration test proves fallback behavior path.
- [ ] Integration test proves mismatch/conflict behavior.
- [ ] API tests cover success + all typed failure envelopes.
- [ ] UI test(s) cover operator-facing state changes for the feature.

## 5) Observability and auditability

- [ ] Lifecycle events emitted for requested/applied/fallback/failure transitions.
- [ ] Request lineage fields are persisted and exposed where required.
- [ ] Operator-visible state clearly distinguishes warning fallback vs hard failure.

## 6) Review outcome gate

Before approving:

- [ ] Confirm the PR does not over-claim scope completion.
- [ ] If only scaffolding/fallback is implemented, require explicit PR label in summary:
  - `foundation-only` (or equivalent wording), and list missing semantic gates.
