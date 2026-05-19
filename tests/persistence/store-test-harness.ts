import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';

import { buildDurableIdentity } from '../../src/persistence/identity';
import { SqlitePersistenceStore } from '../../src/persistence/store';

export { buildDurableIdentity, fs, os, path, SqlitePersistenceStore };

type TestDatabase = {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): unknown;
  };
};

const legacyStableHash = (parts: Array<string | null | undefined>): string => {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part ?? '');
    hash.update('\0');
  }
  return hash.digest('hex');
};

const legacyEvidenceValue = (evidence: { status: 'present'; value: string } | { status: 'missing'; reason: string }): string =>
  evidence.status === 'present' ? evidence.value : `missing:${evidence.reason}`;

const legacyProjectKey = (identity: ReturnType<typeof buildDurableIdentity>): string =>
  legacyStableHash([
    'project',
    identity.project.project_root,
    identity.project.workflow_path,
    legacyEvidenceValue(identity.project.workflow_hash),
    legacyEvidenceValue(identity.project.repository_remote)
  ]);

export const withLegacyProjectKey = (durableIdentity: ReturnType<typeof buildDurableIdentity>): ReturnType<typeof buildDurableIdentity> => ({
  ...durableIdentity,
  project: {
    ...durableIdentity.project,
    key: legacyProjectKey(durableIdentity)
  }
});

export const identity = (
  params: {
    issue_id?: string;
    issue_identifier?: string;
    projectRoot?: string;
    workflowPath?: string;
    workflowHash?: string;
    repositoryRemote?: string;
    trackerScope?: string | null;
  } = {}
) =>
  buildDurableIdentity({
    projectRoot: params.projectRoot ?? '/repo/main',
    workflowPath: params.workflowPath ?? '/repo/main/WORKFLOW.md',
    workflowHash: { status: 'present', value: params.workflowHash ?? 'workflow-hash' },
    repositoryRemote: { status: 'present', value: params.repositoryRemote ?? 'git@github.com:nielsgl/symphony.git' },
    trackerKind: 'linear',
    trackerScope: 'trackerScope' in params ? params.trackerScope : 'symphony',
    remoteIssueId: params.issue_id ?? 'issue-1',
    humanIssueIdentifier: params.issue_identifier ?? 'ABC-1'
  });

export const openDatabase = (dbPath: string): TestDatabase => {
  const sqlite = require('node:sqlite') as { DatabaseSync: new (path: string) => TestDatabase };
  return new sqlite.DatabaseSync(dbPath);
};

export const tableNames = (dbPath: string): string[] => {
  const db = openDatabase(dbPath);
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map(
      (row) => row.name
    );
  } finally {
    db.close();
  }
};

export const createStoreTestHarness = () => {
  const dirs: string[] = [];
  const stores: SqlitePersistenceStore[] = [];

  const cleanup = async () => {
    while (stores.length > 0) {
      stores.pop()?.close();
    }

    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  };

  return {
    dirs,
    stores,
    identity,
    openDatabase,
    tableNames,
    withLegacyProjectKey,
    cleanup
  };
};
