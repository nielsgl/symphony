import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildProjectIdentity } from '../../src/persistence';
import {
  buildSetupConsentRecord,
  createFileSetupConsentStore,
  defaultSetupConsentStorePath,
  findValidSetupConsent,
  persistSetupConsent,
  resolveWorkflowPosture,
  type WorkflowPosture
} from '../../src/runtime/setup-consent';
import type { LocalCommandResolution } from '../../src/runtime/local-command-resolver';

async function makeProject(workflowContent: string): Promise<{ root: string; workflowPath: string }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-consent-project-')));
  const workflowPath = path.join(root, 'WORKFLOW.md');
  await fs.writeFile(workflowPath, workflowContent, 'utf8');
  return { root, workflowPath };
}

function makeResolution(params: { root: string; workflowPath: string }): LocalCommandResolution {
  return {
    command: 'setup',
    symphonyCheckoutRoot: params.root,
    currentProjectRoot: params.root,
    workflowPath: params.workflowPath,
    envFilePath: path.join(params.root, '.env'),
    profile: { name: 'project', source: 'default' },
    host: { host: '127.0.0.1', source: 'default' },
    port: { port: 0, source: 'default' },
    projectIdentity: buildProjectIdentity({
      projectRoot: params.root,
      workflowPath: params.workflowPath
    }),
    sources: {
      projectRoot: 'project',
      workflowPath: 'project',
      envFilePath: 'project'
    },
    dashboardArgv: [`--workflow=${params.workflowPath}`, '--host=127.0.0.1', '--port=0']
  };
}

const HIGH_TRUST_POSTURE: WorkflowPosture = {
  posture: 'high-trust',
  reason: 'workflow effective codex sandbox posture requires danger-full-access local execution',
  evidence: {
    thread_sandbox: 'danger-full-access',
    turn_sandbox_policy: 'danger-full-access'
  }
};

describe('setup consent persistence', () => {
  it('uses a user-local default consent store path', () => {
    expect(defaultSetupConsentStorePath({ XDG_STATE_HOME: '/tmp/user-state' })).toBe(
      path.join('/tmp/user-state', 'symphony', 'setup-consent.json')
    );
    expect(defaultSetupConsentStorePath({ SYMPHONY_LOCAL_STATE_HOME: '/tmp/custom-state' })).toBe(
      path.join('/tmp/custom-state', 'setup-consent.json')
    );
  });

  it('parses workflow high-trust posture from effective codex sandbox config', async () => {
    const { workflowPath } = await makeProject(
      [
        '---',
        'codex:',
        '  thread_sandbox: danger-full-access',
        '  turn_sandbox_policy: danger-full-access',
        '---',
        'workflow prompt'
      ].join('\n')
    );

    const posture = resolveWorkflowPosture(workflowPath, {});

    expect(posture.posture).toBe('high-trust');
    expect(posture.reason).toContain('danger-full-access');
    expect(posture.evidence.thread_sandbox).toBe('danger-full-access');
    expect(posture.evidence.turn_sandbox_policy).toBe('danger-full-access');
  });

  it('stores bounded consent evidence without workflow content or repository remote', async () => {
    const { root, workflowPath } = await makeProject('secret workflow prompt\n');
    const storePath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-consent-store-')), 'consent.json');
    const store = createFileSetupConsentStore(storePath);
    const resolved = makeResolution({ root, workflowPath });
    const record = buildSetupConsentRecord({
      resolved,
      posture: HIGH_TRUST_POSTURE,
      approvedAt: '2026-05-24T20:00:00.000Z'
    });

    persistSetupConsent(store, record);
    const stored = await fs.readFile(storePath, 'utf8');

    expect(stored).toContain(root);
    expect(stored).toContain(workflowPath);
    expect(stored).not.toContain('secret workflow prompt');
    expect(stored).not.toContain('repository_remote');
    expect(store.read().records).toHaveLength(1);
  });

  it('requires identity, path, posture, and workflow hash to match for reuse', async () => {
    const projectA = await makeProject('workflow a\n');
    const projectB = await makeProject('workflow b\n');
    const storePath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-consent-match-')), 'consent.json');
    const store = createFileSetupConsentStore(storePath);
    const first = makeResolution({ root: projectA.root, workflowPath: projectA.workflowPath });
    const second = makeResolution({ root: projectB.root, workflowPath: projectB.workflowPath });
    const record = buildSetupConsentRecord({
      resolved: first,
      posture: HIGH_TRUST_POSTURE,
      approvedAt: '2026-05-24T20:00:00.000Z'
    });
    persistSetupConsent(store, record);

    expect(findValidSetupConsent({ store, resolved: first, posture: HIGH_TRUST_POSTURE })).not.toBeNull();
    expect(findValidSetupConsent({ store, resolved: second, posture: HIGH_TRUST_POSTURE })).toBeNull();

    await fs.writeFile(projectA.workflowPath, 'workflow a changed\n', 'utf8');
    const changed = makeResolution({ root: projectA.root, workflowPath: projectA.workflowPath });
    expect(findValidSetupConsent({ store, resolved: changed, posture: HIGH_TRUST_POSTURE })).toBeNull();
  });
});
