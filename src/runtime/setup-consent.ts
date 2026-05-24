import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';

import { WorkflowLoader, ConfigResolver } from '../workflow';
import type { LocalCommandResolution } from './local-command-resolver';

export type LocalExecutionPosture = 'standard' | 'high-trust';
export type SetupConsentSource = 'flag' | 'setup' | 'missing';

export interface WorkflowPosture {
  posture: LocalExecutionPosture;
  reason: string;
  evidence: {
    security_profile?: string;
    approval_policy?: string;
    thread_sandbox?: string;
    turn_sandbox_policy?: string;
    workflow_hash?: string;
  };
}

export interface SetupConsentRecord {
  version: 1;
  identity_key: string;
  posture: LocalExecutionPosture;
  approved_at: string;
  evidence: {
    project_root: string;
    workflow_path: string;
    workflow_hash?: string;
    posture_reason: string;
    project_root_hash: string;
    workflow_path_hash: string;
  };
}

export interface SetupConsentStorePayload {
  version: 1;
  records: SetupConsentRecord[];
}

export interface SetupConsentStore {
  path: string;
  read: () => SetupConsentStorePayload;
  write: (payload: SetupConsentStorePayload) => void;
}

export interface PromptSetupConsentOptions {
  resolved: LocalCommandResolution;
  posture: WorkflowPosture;
  input?: Readable;
  output?: Writable;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function defaultStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SYMPHONY_LOCAL_STATE_HOME && env.SYMPHONY_LOCAL_STATE_HOME.trim().length > 0) {
    return env.SYMPHONY_LOCAL_STATE_HOME;
  }

  if (env.XDG_STATE_HOME && env.XDG_STATE_HOME.trim().length > 0) {
    return path.join(env.XDG_STATE_HOME, 'symphony');
  }

  return path.join(os.homedir(), '.local', 'state', 'symphony');
}

export function defaultSetupConsentStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(defaultStateRoot(env), 'setup-consent.json');
}

function emptyPayload(): SetupConsentStorePayload {
  return { version: 1, records: [] };
}

function normalizePayload(raw: unknown): SetupConsentStorePayload {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return emptyPayload();
  }

  const record = raw as { version?: unknown; records?: unknown };
  if (record.version !== 1 || !Array.isArray(record.records)) {
    return emptyPayload();
  }

  const records = record.records.filter((entry): entry is SetupConsentRecord => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return false;
    }
    const candidate = entry as Partial<SetupConsentRecord>;
    return (
      candidate.version === 1 &&
      typeof candidate.identity_key === 'string' &&
      (candidate.posture === 'standard' || candidate.posture === 'high-trust') &&
      typeof candidate.approved_at === 'string' &&
      typeof candidate.evidence === 'object' &&
      candidate.evidence !== null &&
      typeof candidate.evidence.project_root === 'string' &&
      typeof candidate.evidence.workflow_path === 'string' &&
      typeof candidate.evidence.posture_reason === 'string'
    );
  });

  return { version: 1, records };
}

export function createFileSetupConsentStore(storePath = defaultSetupConsentStorePath()): SetupConsentStore {
  return {
    path: storePath,
    read: () => {
      try {
        return normalizePayload(JSON.parse(fs.readFileSync(storePath, 'utf8')) as unknown);
      } catch {
        return emptyPayload();
      }
    },
    write: (payload) => {
      fs.mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(storePath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    }
  };
}

function workflowHashValue(resolved: LocalCommandResolution): string | undefined {
  const hash = resolved.projectIdentity.workflow_hash;
  return hash.status === 'present' ? hash.value : undefined;
}

export function resolveWorkflowPosture(
  workflowPath: string,
  env: NodeJS.ProcessEnv = process.env
): WorkflowPosture {
  const loader = new WorkflowLoader();
  const definition = loader.load({ explicitPath: workflowPath });
  const effective = new ConfigResolver({ env }).resolve(definition, { workflowPath });
  const approvalPolicy =
    typeof effective.codex.approval_policy === 'string'
      ? effective.codex.approval_policy
      : effective.codex.approval_policy
        ? 'object'
        : undefined;
  const evidence = {
    security_profile: effective.codex.security_profile,
    approval_policy: approvalPolicy,
    thread_sandbox: effective.codex.thread_sandbox,
    turn_sandbox_policy: effective.codex.turn_sandbox_policy,
    workflow_hash: definition.prompt_template ? sha256(JSON.stringify(definition.config)) : undefined
  };
  const highTrust =
    effective.codex.thread_sandbox === 'danger-full-access' ||
    effective.codex.turn_sandbox_policy === 'danger-full-access';

  return {
    posture: highTrust ? 'high-trust' : 'standard',
    reason: highTrust
      ? 'workflow effective codex sandbox posture requires danger-full-access local execution'
      : 'workflow effective codex sandbox posture does not require danger-full-access local execution',
    evidence
  };
}

export function buildSetupConsentRecord(params: {
  resolved: LocalCommandResolution;
  posture: WorkflowPosture;
  approvedAt: string;
}): SetupConsentRecord {
  const workflowHash = workflowHashValue(params.resolved);
  return {
    version: 1,
    identity_key: params.resolved.projectIdentity.key,
    posture: params.posture.posture,
    approved_at: params.approvedAt,
    evidence: {
      project_root: params.resolved.currentProjectRoot,
      workflow_path: params.resolved.workflowPath,
      ...(workflowHash ? { workflow_hash: workflowHash } : {}),
      posture_reason: params.posture.reason,
      project_root_hash: sha256(params.resolved.currentProjectRoot),
      workflow_path_hash: sha256(params.resolved.workflowPath)
    }
  };
}

export function persistSetupConsent(
  store: SetupConsentStore,
  record: SetupConsentRecord
): SetupConsentRecord {
  const payload = store.read();
  const records = payload.records.filter((entry) => entry.identity_key !== record.identity_key);
  records.push(record);
  store.write({ version: 1, records });
  return record;
}

export function findValidSetupConsent(params: {
  store: SetupConsentStore;
  resolved: LocalCommandResolution;
  posture: WorkflowPosture;
}): SetupConsentRecord | null {
  const workflowHash = workflowHashValue(params.resolved);
  const payload = params.store.read();
  const record = payload.records.find(
    (entry) => entry.identity_key === params.resolved.projectIdentity.key && entry.posture === params.posture.posture
  );

  if (!record) {
    return null;
  }

  if (record.evidence.project_root !== params.resolved.currentProjectRoot) {
    return null;
  }
  if (record.evidence.workflow_path !== params.resolved.workflowPath) {
    return null;
  }
  if (workflowHash && record.evidence.workflow_hash !== workflowHash) {
    return null;
  }

  return record;
}

export async function promptSetupConsent(options: PromptSetupConsentOptions): Promise<boolean> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!('isTTY' in input) || !input.isTTY) {
    return false;
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question('Type YES to approve this local high-trust setup consent: ');
    return answer.trim() === 'YES';
  } finally {
    rl.close();
  }
}
