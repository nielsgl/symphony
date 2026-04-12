import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

function runProfile(env: NodeJS.ProcessEnv) {
  const scriptPath = path.resolve(process.cwd(), 'scripts/validate-real-integration-profile.js');
  return spawnSync(process.execPath, [scriptPath], {
    env: {
      ...process.env,
      ...env,
      SYMPHONY_P9B_DRY_RUN: '1'
    },
    encoding: 'utf8'
  });
}

describe('P9b integration profile script', () => {
  it('reports SKIPPED when LINEAR_API_KEY is missing and strict mode is disabled', () => {
    const result = runProfile({
      LINEAR_API_KEY: '',
      SYMPHONY_REAL_INTEGRATION_REQUIRED: '0'
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('P9B_EVIDENCE_REAL_TRACKER=SKIPPED_MISSING_LINEAR_API_KEY');
    expect(result.stdout).toContain('P9B_PROFILE_RESULT=SKIPPED');
  });

  it('fails when LINEAR_API_KEY is missing and strict mode is enabled', () => {
    const result = runProfile({
      LINEAR_API_KEY: '',
      SYMPHONY_REAL_INTEGRATION_REQUIRED: '1'
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('P9B_EVIDENCE_REAL_TRACKER=FAIL_MISSING_LINEAR_API_KEY');
    expect(result.stdout).toContain('P9B_PROFILE_RESULT=FAIL');
  });

  it('reports PASS in dry-run mode when LINEAR_API_KEY is present', () => {
    const result = runProfile({
      LINEAR_API_KEY: 'test-token',
      SYMPHONY_REAL_INTEGRATION_REQUIRED: '1'
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('P9B_EVIDENCE_REAL_TRACKER=PASS_DRY_RUN_WITH_KEY');
    expect(result.stdout).toContain('P9B_PROFILE_RESULT=PASS');
  });
});
