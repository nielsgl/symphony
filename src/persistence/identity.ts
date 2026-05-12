import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import type { DurableIdentity, IdentityEvidence, ProjectIdentity, TicketIdentity } from './types';

function stableHash(parts: Array<string | null | undefined>): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part ?? '');
    hash.update('\0');
  }
  return hash.digest('hex');
}

function presentOrMissing(value: string | null | undefined, reason: string): IdentityEvidence {
  const trimmed = value?.trim();
  return trimmed ? { status: 'present', value: trimmed } : { status: 'missing', reason };
}

export function buildProjectIdentity(params: {
  projectRoot: string;
  workflowPath: string;
  workflowHash?: IdentityEvidence;
  repositoryRemote?: IdentityEvidence;
}): ProjectIdentity {
  const projectRoot = path.resolve(params.projectRoot);
  const workflowPath = path.resolve(params.workflowPath);
  const workflowHash = params.workflowHash ?? hashWorkflowFile(workflowPath);
  const repositoryRemote = params.repositoryRemote ?? resolveRepositoryRemote(projectRoot);

  return {
    key: stableHash(['project', projectRoot, workflowPath]),
    project_root: projectRoot,
    workflow_path: workflowPath,
    workflow_hash: workflowHash,
    repository_remote: repositoryRemote
  };
}

export function buildTicketIdentity(params: {
  trackerKind: string;
  trackerScope?: string | null;
  remoteIssueId: string;
  humanIssueIdentifier: string;
}): TicketIdentity {
  const trackerKind = params.trackerKind.trim();
  const remoteIssueId = params.remoteIssueId.trim();
  const humanIssueIdentifier = params.humanIssueIdentifier.trim();
  if (!trackerKind || !remoteIssueId || !humanIssueIdentifier) {
    throw new Error('ticket identity requires tracker kind, remote issue id, and human issue identifier');
  }

  const trackerScope = presentOrMissing(params.trackerScope, 'tracker_scope_unavailable');
  const trackerScopeValue = trackerScope.status === 'present' ? trackerScope.value : `missing:${trackerScope.reason}`;
  return {
    key: stableHash(['ticket', trackerKind, trackerScopeValue, remoteIssueId]),
    tracker_kind: trackerKind,
    tracker_scope: trackerScope,
    remote_issue_id: remoteIssueId,
    human_issue_identifier: humanIssueIdentifier
  };
}

export function buildDurableIdentity(params: {
  projectRoot: string;
  workflowPath: string;
  workflowHash?: IdentityEvidence;
  repositoryRemote?: IdentityEvidence;
  trackerKind: string;
  trackerScope?: string | null;
  remoteIssueId: string;
  humanIssueIdentifier: string;
}): DurableIdentity {
  return {
    project: buildProjectIdentity(params),
    ticket: buildTicketIdentity(params)
  };
}

export function hashWorkflowFile(workflowPath: string): IdentityEvidence {
  try {
    const content = fs.readFileSync(workflowPath);
    return { status: 'present', value: createHash('sha256').update(content).digest('hex') };
  } catch {
    return { status: 'missing', reason: 'workflow_file_unreadable' };
  }
}

export function resolveRepositoryRemote(projectRoot: string): IdentityEvidence {
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    return { status: 'missing', reason: 'repository_remote_unavailable' };
  }
  return presentOrMissing(result.stdout, 'repository_remote_unavailable');
}
