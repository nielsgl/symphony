import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const validReview = `## Agent Review

### Scope Read
- Issue: NIE-1
- PR: https://github.com/example/repo/pull/1
- Head SHA: abc123
- Prior findings reviewed: none

### Independent Invariants
- Runtime mutation must happen only after approval.

### Acceptance Criteria Mapping
| Criterion | Evidence | Verdict |
| --- | --- | --- |
| Detect update | tests/runtime/update.test.ts | pass |

### Triggered Review Lenses
| Lens | Trigger | Evidence | Verdict |
| --- | --- | --- | --- |
| Multi-Phase Mutation | prepare/apply workflow | src/runtime/update-manager.ts and regression test | pass |

### Findings
- No blocking findings.

### Verdict
- Pass: route to Human Review
`;

const validCrossSurfaceReview = `## Agent Review

### Scope Read
- Issue: NIE-2
- PR: https://github.com/example/repo/pull/2
- Head SHA: def456
- Prior findings reviewed: first comment required pending work in UI

### Independent Invariants
- Pending work must be visible in runtime state, dashboard UI, and persisted audit history.

### Acceptance Criteria Mapping
| Criterion | Evidence | Verdict |
| --- | --- | --- |
| Pending work is visible across surfaces | src/orchestrator/core.ts, src/api/dashboard-client/overview.ts, tests/api/dashboard-client.test.ts | pass |

### Triggered Review Lenses
| Lens | Trigger | Evidence | Verdict |
| --- | --- | --- | --- |
| Cross-Cutting Contract Propagation | runtime state, API, dashboard, persistence | scenario trace and path census below | pass |

### Scope Comments Reviewed
| Comment / prior finding | Required scenario | Evidence | Verdict |
| --- | --- | --- | --- |
| First Linear comment | Stale Agent Review with safe restart guidance | tests/orchestrator/core-dispatch.test.ts and dashboard DOM assertion | pass |

### Scenario-To-Surface Trace
| Scenario / criterion | Runtime behavior | API/state/diagnostics | Dashboard/operator UI | Persistence/history/audit | Tests/assertions | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Stale Agent Review | dispatch blocked with stale_runtime_build | /api/v1/state includes pending_work | DOM renders pending Agent Review text | drain audit state_context persists pending_work | dashboard and server-state assertions cover fields | pass |

### Path Census
| Contract / invariant | Search evidence | Paths found | Paths verified | Gaps |
| --- | --- | --- | --- | --- |
| Drain audit state_context includes guidance | rg "recordDrainAuditEvent|state_context" src/api/server.ts | wait, shutdown, runtime-update apply | all listed paths inspected | none |

### Invalid Evidence Check
- Fixture-only evidence present? no
- Representative-path shortcut used? no
- UI evidence matches changed state? yes
- Head SHA reviewed: def456
- Residual unreviewed surfaces: none

### Findings
- No blocking findings.

### Verdict
- Pass: route to Human Review
`;

function runReviewCheck(body: string, env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ['scripts/check-review-artifact.js'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      SYMPHONY_REVIEW_BODY: body,
      ...env
    }
  });
}

describe('review artifact check', () => {
  it('passes a concise review artifact with findings', () => {
    const result = runReviewCheck(validReview.replace('No blocking findings.', 'P1: candidate drift is not refused.'));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Review artifact check passed.');
  });

  it('passes a concise review artifact without findings when lens evidence is present', () => {
    const result = runReviewCheck(validReview);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Review artifact check passed.');
  });

  it('does not require cross-surface sections for an explicit non-cross-cutting review', () => {
    const result = runReviewCheck(
      validReview.replace(
        '### Findings',
        'Propagation matrix: not required because this is a docs-only typo fix.\n\n### Findings'
      )
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Review artifact check passed.');
  });

  it('passes a cross-surface review only when the strict trace sections are present', () => {
    const result = runReviewCheck(validCrossSurfaceReview);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Review artifact check passed.');
  });

  it('fails when prior findings are not reconciled', () => {
    const result = runReviewCheck(validReview.replace('- Prior findings reviewed: none\n', ''));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing required Scope Read field: Prior findings reviewed');
  });

  it('fails when a triggered lens has no evidence', () => {
    const result = runReviewCheck(
      validReview.replace('| Multi-Phase Mutation | prepare/apply workflow | src/runtime/update-manager.ts and regression test | pass |', '| Multi-Phase Mutation | prepare/apply workflow |  | pass |')
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Triggered Review Lenses row is missing evidence');
  });

  it('fails when pass verdict has no reviewed lenses', () => {
    const result = runReviewCheck(
      validReview.replace(
        `| Lens | Trigger | Evidence | Verdict |
| --- | --- | --- | --- |
| Multi-Phase Mutation | prepare/apply workflow | src/runtime/update-manager.ts and regression test | pass |`,
        `| Lens | Trigger | Evidence | Verdict |
| --- | --- | --- | --- |`
      )
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Triggered Review Lenses must include a markdown table with at least one evidence row');
  });

  it('fails cross-surface reviews when dashboard evidence is merged into API evidence', () => {
    const result = runReviewCheck(
      validCrossSurfaceReview.replace(
        '| Stale Agent Review | dispatch blocked with stale_runtime_build | /api/v1/state includes pending_work | DOM renders pending Agent Review text | drain audit state_context persists pending_work | dashboard and server-state assertions cover fields | pass |',
        '| Stale Agent Review | dispatch blocked with stale_runtime_build | /api/v1/state includes pending_work | same as API | drain audit state_context persists pending_work | dashboard and server-state assertions cover fields | pass |'
      )
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dashboard evidence cannot be merged into API evidence');
  });

  it('fails passing cross-surface reviews when fixture-only evidence is present', () => {
    const result = runReviewCheck(
      validCrossSurfaceReview.replace('- Fixture-only evidence present? no', '- Fixture-only evidence present? yes')
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Fixture-only evidence cannot pass cross-surface review');
  });

  it('fails passing cross-surface reviews when representative-path shortcuts are used', () => {
    const result = runReviewCheck(
      validCrossSurfaceReview.replace('- Representative-path shortcut used? no', '- Representative-path shortcut used? yes')
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Representative-path shortcut cannot pass cross-surface review');
  });

  it('fails cross-surface reviews when the invalid-evidence head SHA is missing', () => {
    const result = runReviewCheck(validCrossSurfaceReview.replace('- Head SHA reviewed: def456', '- Head SHA reviewed:'));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid Evidence Check missing required field: Head SHA reviewed');
  });

  it('allows blocked cross-surface reviews to report fixture-only or representative-path problems', () => {
    const result = runReviewCheck(
      validCrossSurfaceReview
        .replace('- Fixture-only evidence present? no', '- Fixture-only evidence present? yes')
        .replace('- Representative-path shortcut used? no', '- Representative-path shortcut used? yes')
        .replace('- No blocking findings.', '- P1: dashboard proof is fixture-only.')
        .replace('- Pass: route to Human Review', '- Blocked: move to In Progress')
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Review artifact check passed.');
  });

  it('fails escaped newline review bodies', () => {
    const result = runReviewCheck('## Agent Review\\\\n### Scope Read');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('pr_body_escaped_newlines: body contains escaped newline sequences; normalize before submit');
  });

  it('reads review body files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-review-artifact-'));
    const reviewPath = path.join(dir, 'review.md');
    fs.writeFileSync(reviewPath, validReview, 'utf8');

    const result = spawnSync(process.execPath, ['scripts/check-review-artifact.js', '--body-file', reviewPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        SYMPHONY_REVIEW_BODY: ''
      }
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Review artifact check passed.');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
