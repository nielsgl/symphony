export type ApprovalPolicy = 'never' | 'on-request';
export type ThreadSandbox = 'workspace-write' | 'read-only' | 'danger-full-access';
export type TurnSandboxType = 'workspace' | 'workspace-write' | 'read-only' | 'danger-full-access';
export type UserInputPolicy = 'fail_attempt';

export interface SecurityProfile {
  name: string;
  approval_policy: ApprovalPolicy;
  thread_sandbox: ThreadSandbox;
  turn_sandbox_policy: {
    type: TurnSandboxType;
  };
  user_input_policy: UserInputPolicy;
}

export const DEFAULT_BALANCED_PROFILE: SecurityProfile = {
  name: 'balanced',
  approval_policy: 'on-request',
  thread_sandbox: 'workspace-write',
  turn_sandbox_policy: { type: 'workspace' },
  user_input_policy: 'fail_attempt'
};

const APPROVAL_POLICIES = new Set<ApprovalPolicy>(['never', 'on-request']);
const THREAD_SANDBOXES = new Set<ThreadSandbox>(['workspace-write', 'read-only', 'danger-full-access']);
const TURN_SANDBOX_TYPES = new Set<TurnSandboxType>(['workspace', 'workspace-write', 'read-only', 'danger-full-access']);

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveSecurityProfile(overrides: {
  security_profile?: string;
  approval_policy?: string;
  thread_sandbox?: string;
  turn_sandbox_policy?: string;
  user_input_policy?: string;
}): SecurityProfile {
  const name = readString(overrides.security_profile) ?? DEFAULT_BALANCED_PROFILE.name;

  const profile: SecurityProfile = {
    name,
    approval_policy: DEFAULT_BALANCED_PROFILE.approval_policy,
    thread_sandbox: DEFAULT_BALANCED_PROFILE.thread_sandbox,
    turn_sandbox_policy: { ...DEFAULT_BALANCED_PROFILE.turn_sandbox_policy },
    user_input_policy: DEFAULT_BALANCED_PROFILE.user_input_policy
  };

  const approval = readString(overrides.approval_policy);
  if (approval && APPROVAL_POLICIES.has(approval as ApprovalPolicy)) {
    profile.approval_policy = approval as ApprovalPolicy;
  }

  const threadSandbox = readString(overrides.thread_sandbox);
  if (threadSandbox && THREAD_SANDBOXES.has(threadSandbox as ThreadSandbox)) {
    profile.thread_sandbox = threadSandbox as ThreadSandbox;
  }

  const turnSandbox = readString(overrides.turn_sandbox_policy);
  if (turnSandbox && TURN_SANDBOX_TYPES.has(turnSandbox as TurnSandboxType)) {
    profile.turn_sandbox_policy = { type: turnSandbox as TurnSandboxType };
  }

  const userInputPolicy = readString(overrides.user_input_policy);
  if (userInputPolicy === 'fail_attempt') {
    profile.user_input_policy = 'fail_attempt';
  }

  return profile;
}

export function securityProfileSummary(profile: SecurityProfile): string {
  return `profile=${profile.name} approval=${profile.approval_policy} thread_sandbox=${profile.thread_sandbox} turn_sandbox=${profile.turn_sandbox_policy.type} user_input=${profile.user_input_policy}`;
}

export function isSupportedApprovalPolicy(value: string | undefined): boolean {
  return value === undefined || APPROVAL_POLICIES.has(value as ApprovalPolicy);
}

export function isSupportedThreadSandbox(value: string | undefined): boolean {
  return value === undefined || THREAD_SANDBOXES.has(value as ThreadSandbox);
}

export function isSupportedTurnSandbox(value: string | undefined): boolean {
  return value === undefined || TURN_SANDBOX_TYPES.has(value as TurnSandboxType);
}
