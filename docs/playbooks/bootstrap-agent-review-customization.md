# Bootstrap Agent Review Customization

Use this playbook when setting up a project to use Symphony's Agent Review
workflow. The goal is to make review behavior explicit in the target
repository, not hidden in Symphony runtime defaults.

## Boundary

Symphony owns the review protocol: Agent Review must produce an evidence-backed
artifact before it can route work onward.

The target project owns the lens vocabulary: the repository should version the
review lenses that match its domain, architecture, compliance needs, and
operational risks.

## Required Files

- `WORKFLOW.md`: the root Symphony workflow and Agent Review protocol.
- `docs/agents/review-lenses.md`: the project-local lens library used by Agent
  Review.
- Optional project docs: deeper domain-specific review guidance linked from
  `docs/agents/review-lenses.md`.

Do not rely on private local prompts for required review behavior. If a review
rule should affect project work, commit it to the repository.

## Bootstrap Checklist

1. Copy or generate the root `WORKFLOW.md`.
2. Add `docs/agents/review-lenses.md`.
3. Identify the project's recurring risk domains.
4. Keep the portable base lenses that apply to most software projects.
5. Add project-specific lenses only for recurring domain risks.
6. Define trigger rules for every lens.
7. Define acceptable evidence for every lens.
8. Link `docs/agents/review-lenses.md` from the Agent Review section of
   `WORKFLOW.md`.
9. Add a review artifact validation command if the project has local scripts.
10. Run the project's workflow/docs validation before using Agent Review.

## How To Customize Lenses

Start with the base lens names:

- Acceptance Criteria
- Production Wiring
- State Transitions And Invariants
- Multi-Phase Mutation
- Failure And Refusal Paths
- Idempotency, Retry, And Concurrency
- External Integration
- Control-Plane Hot Path
- Persistence And Auditability
- Security, Secrets, And Shell Execution
- UI And Operator Workflow
- Refactor Boundary Preservation
- Generated Asset And Freshness
- Metric And Telemetry Semantics
- Test Adequacy

For each lens, keep three parts:

- Trigger: when the reviewer must apply it.
- Review question: the invariant or risk to attack.
- Evidence examples: what proof is acceptable.

Project-specific lenses should follow the same shape. Avoid writing vague
preferences such as "use clean code"; write concrete review obligations such as
"payment settlement changes must prove ledger idempotency across retry."

## Example Project Lenses

### Payments

Trigger: settlement, payout, refund, reconciliation, balance, ledger, or
idempotency-key behavior changed.

Review question: can duplicate processing, partial failure, or retry create
incorrect money movement?

Evidence examples: ledger invariants, duplicate webhook tests, reconciliation
tests, audit trail checks, rollback/refund scenarios.

### Healthcare Data

Trigger: protected health information, exports, retention, access control,
audit logging, or external sharing changed.

Review question: can sensitive data leak, become untraceable, or bypass
retention/access policy?

Evidence examples: redaction tests, authorization tests, audit-log persistence,
least-privilege checks, export scope tests.

### Mobile Release

Trigger: app release, feature flag, migration, offline sync, push notification,
or backwards-compatibility behavior changed.

Review question: can old clients, offline clients, or staged rollout cohorts
break after release?

Evidence examples: compatibility matrix, migration rollback tests, flag default
tests, offline replay tests.

### Infrastructure

Trigger: deployment, provisioning, secrets, networking, DNS, migrations,
observability, or autoscaling changed.

Review question: can the change cause outage, privilege expansion, irreversible
data loss, or unobservable failure?

Evidence examples: dry-run output, rollback plan, least-privilege diff,
alert/metric proof, migration rehearsal.

### Frontend Product UI

Trigger: user-visible layout, navigation, interaction, copy, loading, error, or
empty states changed.

Review question: can the intended user complete the workflow clearly across
desktop, mobile, loading, empty, and error states?

Evidence examples: screenshots or videos, interaction tests, accessibility
checks, responsive viewport checks.

## Review Artifact Validation

When available, configure a local validator so Agent Review comments must
include:

- scope facts,
- prior finding reconciliation,
- independent invariants,
- acceptance criteria mapping,
- triggered lenses with evidence-backed verdicts,
- findings, and
- a routing verdict.

The validator should check structure, not truth. The reviewer remains
responsible for the correctness of the evidence and judgment.

## Maintenance Loop

When Human Review or production usage catches a bug that Agent Review missed:

1. Classify the missed risk.
2. Add or tighten a trigger rule in `docs/agents/review-lenses.md`.
3. Add a better evidence requirement.
4. Update the issue template or project playbook if the invariant should be
   known before implementation.
5. Keep the change in git so future agents inherit it.
