export type ApprovalPolicy =
  | 'never'
  | 'on-request'
  | {
      reject?: {
        sandbox_approval?: boolean;
        rules?: boolean;
        mcp_elicitations?: boolean;
      };
    };
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

export const DEFAULT_STRICT_PROFILE: SecurityProfile = {
  name: 'strict',
  approval_policy: 'never',
  thread_sandbox: 'read-only',
  turn_sandbox_policy: { type: 'read-only' },
  user_input_policy: 'fail_attempt'
};

export const DEFAULT_BALANCED_PROFILE: SecurityProfile = {
  name: 'balanced',
  approval_policy: 'on-request',
  thread_sandbox: 'workspace-write',
  turn_sandbox_policy: { type: 'workspace-write' },
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
  approval_policy?:
    | string
    | {
        reject?: {
          sandbox_approval?: boolean;
          rules?: boolean;
          mcp_elicitations?: boolean;
        };
      };
  thread_sandbox?: string;
  turn_sandbox_policy?: string;
  user_input_policy?: string;
}): SecurityProfile {
  const requestedName = readString(overrides.security_profile);
  const baseline = requestedName === 'balanced' ? DEFAULT_BALANCED_PROFILE : DEFAULT_STRICT_PROFILE;
  const name = requestedName ?? baseline.name;

  const profile: SecurityProfile = {
    name,
    approval_policy: baseline.approval_policy,
    thread_sandbox: baseline.thread_sandbox,
    turn_sandbox_policy: { ...baseline.turn_sandbox_policy },
    user_input_policy: baseline.user_input_policy
  };

  const approval = overrides.approval_policy;
  if (typeof approval === 'string' && APPROVAL_POLICIES.has(approval as Exclude<ApprovalPolicy, object>)) {
    profile.approval_policy = approval as Exclude<ApprovalPolicy, object>;
  } else if (
    approval &&
    typeof approval === 'object' &&
    !Array.isArray(approval) &&
    (!('reject' in approval) ||
      approval.reject === undefined ||
      (typeof approval.reject === 'object' && approval.reject !== null && !Array.isArray(approval.reject)))
  ) {
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
  const approvalText =
    typeof profile.approval_policy === 'string' ? profile.approval_policy : JSON.stringify(profile.approval_policy);
  return `profile=${profile.name} approval=${approvalText} thread_sandbox=${profile.thread_sandbox} turn_sandbox=${profile.turn_sandbox_policy.type} user_input=${profile.user_input_policy}`;
}

export function isSupportedApprovalPolicy(value: unknown): value is ApprovalPolicy {
  if (value === undefined) {
    return true;
  }

  if (typeof value === 'string') {
    return APPROVAL_POLICIES.has(value as Exclude<ApprovalPolicy, object>);
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const reject = (value as { reject?: unknown }).reject;
  if (reject === undefined) {
    return true;
  }

  if (typeof reject !== 'object' || reject === null || Array.isArray(reject)) {
    return false;
  }

  const rejectRecord = reject as Record<string, unknown>;
  const allowedKeys = new Set(['sandbox_approval', 'rules', 'mcp_elicitations']);
  for (const key of Object.keys(rejectRecord)) {
    if (!allowedKeys.has(key)) {
      return false;
    }
    if (typeof rejectRecord[key] !== 'boolean') {
      return false;
    }
  }

  return true;
}

export function isSupportedThreadSandbox(value: string | undefined): boolean {
  return value === undefined || THREAD_SANDBOXES.has(value as ThreadSandbox);
}

export function isSupportedTurnSandbox(value: string | undefined): boolean {
  return value === undefined || TURN_SANDBOX_TYPES.has(value as TurnSandboxType);
}
