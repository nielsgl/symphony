# P9b Real Integration + Operational Validation Profile

Date: 2026-04-12
Owner role: orchestration planning
Scope: SPEC 17.8 and SPEC 18.3 evidence profile only.

## Purpose
Provide a deterministic, repeatable validation profile for real tracker integration and operational host checks before production.

## Canonical Commands
1. Optional dry-run evidence (no network call, deterministic local proof):
   - `SYMPHONY_P9B_DRY_RUN=1 npm run validate:integration-profile`
2. Real integration profile (recommended when credentials/network are available):
   - `LINEAR_API_KEY=<token> npm run validate:integration-profile`
3. Required gate mode (for CI/release jobs that explicitly enable real integration):
   - `LINEAR_API_KEY=<token> npm run validate:integration-profile:required`

## Evidence Markers
The validation script emits stable `P9B_*` lines.

Required markers:
- `P9B_PROFILE=REAL_INTEGRATION`
- `P9B_MODE=DRY_RUN|LIVE`
- `P9B_REAL_INTEGRATION_REQUIRED=0|1`
- `P9B_EVIDENCE_REQUIRED_MODE=FAIL_DRY_RUN_NOT_ALLOWED` (required mode guardrail)
- `P9B_EVIDENCE_OPERATIONAL_CHECKS=PASS|SKIPPED|FAIL`
- `P9B_EVIDENCE_WORKSPACE_ISOLATION=PASS`
- `P9B_EVIDENCE_REAL_TRACKER=PASS|PASS_DRY_RUN_WITH_KEY|SKIPPED_MISSING_LINEAR_API_KEY|FAIL_*`
- `P9B_PROFILE_RESULT=PASS|SKIPPED|FAIL`

## Pass/Fail Criteria
Pass criteria:
- `P9B_PROFILE_RESULT=PASS`
- Operational checks complete (`P9B_EVIDENCE_OPERATIONAL_CHECKS=PASS`) in live mode.
- Workspace isolation/cleanup evidence is present (`P9B_EVIDENCE_WORKSPACE_ISOLATION=PASS`).
- Real tracker check passes (`P9B_EVIDENCE_REAL_TRACKER=PASS` or `PASS_DRY_RUN_WITH_KEY` in dry-run mode).

Skipped criteria (allowed in non-required mode only):
- `LINEAR_API_KEY` is unavailable.
- Script emits `P9B_EVIDENCE_REAL_TRACKER=SKIPPED_MISSING_LINEAR_API_KEY`.
- Script emits `P9B_PROFILE_RESULT=SKIPPED`.

Fail criteria:
- Any operational check fails.
- Required mode is enabled and `LINEAR_API_KEY` is missing.
- Required mode is combined with dry-run.
- Live tracker query returns non-OK status or invalid payload.

## SPEC Mapping
SPEC 17.8:
- Real tracker smoke with valid credentials: covered by `LINEAR_API_KEY` + live GraphQL `viewer` query in `scripts/validate-real-integration-profile.js`.
- Isolated workspaces and cleanup: covered by deterministic temp workspace create/remove evidence.
- Skip is explicit and not silent: covered by `P9B_PROFILE_RESULT=SKIPPED` markers.
- Fail when explicitly enabled: covered by required mode (`validate:integration-profile:required`).

SPEC 18.3:
- Run real integration profile with valid credentials/network: covered by canonical command #2/#3.
- Verify hook execution + workflow path resolution: covered by operational check command set run by the profile script:
  - `tests/workspace/workspace-manager.test.ts`
  - `tests/cli/cli-args.test.ts`
- Verify optional HTTP port/bind behavior if shipped: covered by operational checks:
  - `tests/runtime/bootstrap.test.ts`
  - `tests/api/server.test.ts`

## Operational Check Command Set
The profile script runs this deterministic suite in live mode:
1. `npm test -- --run tests/cli/cli-args.test.ts`
2. `npm test -- --run tests/workspace/workspace-manager.test.ts`
3. `npm test -- --run tests/runtime/bootstrap.test.ts tests/api/server.test.ts`

These checks intentionally stay narrow to P9b evidence and avoid P9c/P9d scope.

## Conservative Completion Rule
P9b is complete only when at least one reproducible profile invocation is captured with concrete `P9B_*` markers and references from STATUS/parity/traceability docs.

## Captured Invocation Evidence (2026-04-12)
Command:
- `npm run validate:integration-profile`

Output excerpt:
```text
P9B_PROFILE=REAL_INTEGRATION
P9B_MODE=LIVE
P9B_REAL_INTEGRATION_REQUIRED=0
P9B_COMMAND=npm test -- --run tests/cli/cli-args.test.ts
P9B_COMMAND=npm test -- --run tests/workspace/workspace-manager.test.ts
P9B_COMMAND=npm test -- --run tests/runtime/bootstrap.test.ts tests/api/server.test.ts
P9B_EVIDENCE_OPERATIONAL_CHECKS=PASS
P9B_EVIDENCE_WORKSPACE_ISOLATION=PASS
P9B_EVIDENCE_REAL_TRACKER=SKIPPED_MISSING_LINEAR_API_KEY
P9B_PROFILE_RESULT=SKIPPED
```

Artifact interpretation:
- This invocation is audit-valid for reproducibility and explicit skip semantics.
- Required-mode release jobs must use `npm run validate:integration-profile:required`, where dry-run is rejected and missing credentials fail the job.
