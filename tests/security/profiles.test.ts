import { describe, expect, it } from 'vitest';

import { DEFAULT_BALANCED_PROFILE, resolveSecurityProfile, securityProfileSummary } from '../../src/security/profiles';

describe('security profile resolution', () => {
  it('uses balanced safe defaults when workflow does not override', () => {
    const profile = resolveSecurityProfile({});
    expect(profile).toEqual(DEFAULT_BALANCED_PROFILE);
  });

  it('applies workflow overrides on top of defaults', () => {
    const profile = resolveSecurityProfile({
      security_profile: 'balanced',
      approval_policy: 'never',
      thread_sandbox: 'read-only',
      turn_sandbox_policy: 'workspace-write'
    });

    expect(profile.name).toBe('balanced');
    expect(profile.approval_policy).toBe('never');
    expect(profile.thread_sandbox).toBe('read-only');
    expect(profile.turn_sandbox_policy.type).toBe('workspace-write');
    expect(profile.user_input_policy).toBe('fail_attempt');
  });

  it('emits operator-visible profile summary', () => {
    const summary = securityProfileSummary(DEFAULT_BALANCED_PROFILE);
    expect(summary).toContain('profile=balanced');
    expect(summary).toContain('approval=on-request');
  });
});
