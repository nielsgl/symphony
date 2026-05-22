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
