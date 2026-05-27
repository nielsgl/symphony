import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const trial = require('../../scripts/lib/local-multi-project-trial.js') as {
  parseArgs(argv: string[]): {
    report: string | null;
    projectRoots: Array<{ path: string; required: boolean; shape: string }>;
    requiredProjectRoots: Array<{ path: string; required: boolean; shape: string }>;
  };
  runTrial(options: Record<string, unknown>): Promise<{ report: any; reportPath: string }>;
  summarizeEnv(env: Record<string, string | undefined>): any;
  workflow(name: string): string;
};

function createFakeRepo() {
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-trial-fake-repo-')));
  const buildArtifact = path.join(repoRoot, 'dist', 'src', 'runtime', 'command-router.js');
  fs.mkdirSync(path.dirname(buildArtifact), { recursive: true });
  fs.writeFileSync(buildArtifact, '');
  return { repoRoot, buildArtifact };
}

function writeFakeCommand(tempRoot: string) {
  const scriptPath = path.join(tempRoot, 'fake-symphony.js');
  fs.writeFileSync(
    scriptPath,
    `
const http = require('node:http');
const path = require('node:path');

const [command, ...args] = process.argv.slice(2);

function doctorPayload(status, reason, exitCode, findings = []) {
  return {
    version: 1,
    command: 'doctor',
    status,
    reason,
    exitCode,
    exitSemantics: {
      code: exitCode,
      meaning: reason === 'blockers_present' ? 'blockers_present' : reason,
      ci: { requested: true, promptsAllowed: false, nonZeroOnBlocker: true }
    },
    ci: true,
    resolution: {
      projectRoot: process.cwd(),
      workflowPath: path.join(process.cwd(), 'WORKFLOW.md'),
      envFilePath: path.join(process.cwd(), '.env'),
      host: '127.0.0.1',
      port: 0,
      ephemeralPort: true,
      consent: 'setup'
    },
    findings,
    checks: findings
  };
}

if (command === '--version') {
  console.log('symphony-test 0.0.0');
} else if (command === 'profile') {
  console.log('memory-generic');
} else if (command === 'init') {
  const dryRun = args.includes('--dry-run');
  const linearProjectSlug = args[args.indexOf('--linear-project-slug') + 1] || 'SYMPHONY-TRIAL';
  const workflow = [
    '---',
    'symphony:',
    '  generated_profile:',
    '    profile: "solo-local"',
    '    bundle: "linear-node"',
    '    packs:',
    '      - "tracker:linear"',
    '      - "workspace:worktree"',
    '      - "toolchain:node"',
    '      - "workflow:solo-local"',
    'tracker:',
    '  kind: "linear"',
    '  project_slug: "' + linearProjectSlug + '"',
    '  active_states: ["Todo", "In Progress"]',
    '  terminal_states: ["Done"]',
    'toolchain:',
    '  setup_command: "npm install"',
    '  validation_command: "npm test"',
    '---',
    '<!-- symphony-generated-profile: profile=solo-local; bundle=linear-node; packs=tracker:linear,workspace:worktree,toolchain:node,workflow:solo-local; -->',
    ''
  ].join('\\n');
  const files = [
    ['WORKFLOW.md', workflow],
    ['.env.example', 'LINEAR_API_KEY=\\n'],
    ['.worktreeinclude', 'node_modules/**\\n'],
    [path.join('.symphony', 'system', '.gitignore'), '*\\n!.gitignore\\n'],
    ['.gitignore', '.symphony/system/\\n']
  ];
  if (!dryRun) {
    for (const [relativePath, content] of files) {
      require('node:fs').mkdirSync(path.dirname(path.join(process.cwd(), relativePath)), { recursive: true });
      require('node:fs').writeFileSync(path.join(process.cwd(), relativePath), content);
    }
  }
  console.log('Symphony init ' + (dryRun ? 'dry-run' : 'write') + ' file plan');
  console.log('');
  console.log('Validation: ok');
  console.log('');
  console.log('Files:');
  files.forEach(([relativePath], index) => {
    console.log('  ' + (index + 1) + '. ' + relativePath);
    console.log('     action: create');
    console.log('     would_write: yes');
  });
} else if (command === 'setup') {
  console.log('setup ok');
} else if (command === 'doctor') {
  if (process.cwd().includes('real-doctor-blocked')) {
    console.log(JSON.stringify(doctorPayload('failure', 'blockers_present', 2, [
      {
        id: 'layout.gitignore_system',
        code: 'system_runtime_ignored',
        severity: 'blocker',
        checkStatus: 'failure',
        message: 'The project ignores the Symphony runtime directory.',
        source: { category: 'layout_inspection', present: true },
        remediationInfo: { guidance: 'Narrow the .symphony ignore rule to allow .symphony/system/.' },
        safeFix: { available: false }
      }
    ])));
    process.exit(2);
  }
  console.log(JSON.stringify(doctorPayload('ok', 'ready', 0)));
} else if (command === 'dashboard') {
  const workflowPath = args[args.indexOf('--workflow') + 1];
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/v1/state') {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === '/api/v1/diagnostics') {
      response.end(JSON.stringify({
        runtime_resolution: {
          workflow_path: workflowPath,
          workflow_dir: process.cwd().includes('dashboard-mismatch')
            ? path.join(process.cwd(), 'wrong-root')
            : process.cwd()
        }
      }));
      return;
    }
    if (request.url === '/api/v1/drain-mode/shutdown' && request.method === 'POST') {
      response.statusCode = 202;
      response.end(JSON.stringify({ accepted: true }));
      server.close(() => process.exit(0));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    console.log(\`Symphony dashboard running at http://127.0.0.1:\${address.port}/\`);
  });
} else {
  console.error(\`unsupported fake command: \${command}\`);
  process.exit(1);
}
`,
    { mode: 0o755 }
  );
  return scriptPath;
}

describe('local multi-project trial harness', () => {
  it('parses optional and required project roots without hardcoded paths', () => {
    const options = trial.parseArgs([
      '--project-shape',
      'existing-node',
      '--project-root',
      '/tmp/project-a',
      '--required-project-root',
      '/tmp/project-b'
    ]);

    expect(options.projectRoots).toEqual([{ path: '/tmp/project-a', required: false, shape: 'existing-node' }]);
    expect(options.requiredProjectRoots).toEqual([{ path: '/tmp/project-b', required: true, shape: 'existing-node' }]);
  });

  it('summarizes SYMPHONY and hosted credential environment without secret values', () => {
    const summary = trial.summarizeEnv({
      SYMPHONY_PORT: '1234',
      SYMPHONY_API_TOKEN: 'super-secret-token',
      GITHUB_TOKEN: 'ghp_secret'
    });

    expect(summary.symphony).toContainEqual({
      name: 'SYMPHONY_API_TOKEN',
      present: true,
      secret_like: true,
      value: '<redacted>'
    });
    expect(summary.symphony).toContainEqual({
      name: 'SYMPHONY_PORT',
      present: true,
      secret_like: false,
      value: '<present>'
    });
    expect(summary.hosted_credentials.find((item: any) => item.name === 'GITHUB_TOKEN')).toMatchObject({
      present: true,
      value: '<redacted>'
    });
  });

  it('fails closed when build output is missing and writes report shape', async () => {
    const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-trial-missing-build-')));
    const reportPath = path.join(repoRoot, 'trial-report.json');
    const { report } = await trial.runTrial({
      repoRoot,
      report: reportPath,
      env: {},
      operator: {
        source: 'local-development-fallback',
        command: process.execPath,
        argsPrefix: ['missing-script.js'],
        buildArtifact: path.join(repoRoot, 'dist', 'src', 'runtime', 'command-router.js'),
        fallbackEntrypoint: path.join(repoRoot, 'scripts', 'symphony.js')
      }
    });

    expect(report.summary.status).toBe('blocked');
    expect(report.lanes[0]).toMatchObject({
      id: 'preflight',
      status: 'blocked',
      findings: [
        {
          category: 'environment_prerequisite',
          severity: 'blocker'
        }
      ]
    });
    expect(JSON.parse(fs.readFileSync(reportPath, 'utf8'))).toMatchObject({
      version: 1,
      trial: 'local_multi_project',
      summary: { status: 'blocked' }
    });
  });

  it('records a successful non-hosted baseline lane through the command path', async () => {
    const { repoRoot, buildArtifact } = createFakeRepo();
    const fakeCommand = writeFakeCommand(repoRoot);
    const reportPath = path.join(repoRoot, 'trial-report.json');
    const { report } = await trial.runTrial({
      repoRoot,
      report: reportPath,
      env: { PATH: process.env.PATH },
      operator: {
        source: 'linked-symphony',
        command: process.execPath,
        argsPrefix: [fakeCommand],
        buildArtifact,
        fallbackEntrypoint: fakeCommand
      }
    });

    expect(report.summary).toMatchObject({
      status: 'passed',
      passed: 2,
      failed: 0,
      blocked: 0
    });
    expect(report.lanes[0]).toMatchObject({
      id: 'synthetic-memory-baseline',
      status: 'passed',
      synthetic: true,
      counts_for_external_project_evidence: false,
      doctor: {
        status: 'ok',
        reason: 'ready',
        exit_code: 0,
        finding_counts: {
          total: 0,
          blockers: 0,
          warnings: 0
        }
      },
      dashboard: {
        status: 'bound',
        project_identity_match: true,
        health: { ok: true, status: 200 },
        diagnostics: { ok: true, status: 200 },
        shutdown: { clean: true }
      }
    });
    expect(report.lanes.find((lane: any) => lane.id === 'generated-linear-node-setup')).toMatchObject({
      status: 'passed',
      synthetic: true,
      counts_for_external_project_evidence: false,
      init_file_plan_match: true,
      generated_workflow_checks: {
        ok: true,
        generated_profile_provenance: true,
        includes_node_setup_command: true,
        includes_node_validation_command: true,
        unintended_symphony_internal_states: []
      }
    });
  });

  it('blocks real-project lanes when doctor JSON reports blockers', async () => {
    const { repoRoot, buildArtifact } = createFakeRepo();
    const fakeCommand = writeFakeCommand(repoRoot);
    const realProject = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'real-doctor-blocked-')));
    fs.writeFileSync(path.join(realProject, 'WORKFLOW.md'), trial.workflow('Blocked real project'));
    const { report } = await trial.runTrial({
      repoRoot,
      report: path.join(repoRoot, 'trial-report.json'),
      env: { PATH: process.env.PATH },
      projectRoots: [{ path: realProject, required: false, shape: 'existing-node' }],
      operator: {
        source: 'linked-symphony',
        command: process.execPath,
        argsPrefix: [fakeCommand],
        buildArtifact,
        fallbackEntrypoint: fakeCommand
      }
    });

    const realLane = report.lanes.find((lane: any) => lane.id === 'real-project-1');
    expect(realLane).toMatchObject({
      status: 'blocked',
      doctor: {
        status: 'failure',
        reason: 'blockers_present',
        exit_code: 2,
        finding_counts: {
          total: 1,
          blockers: 1,
          warnings: 0
        },
        findings: [
          {
            id: 'layout.gitignore_system',
            severity: 'blocker',
            remediation: 'Narrow the .symphony ignore rule to allow .symphony/system/.'
          }
        ]
      },
      findings: [
        {
          category: 'environment_prerequisite',
          severity: 'blocker',
          summary: expect.stringContaining('Doctor reported blockers')
        }
      ]
    });
    expect(report.summary).toMatchObject({
      status: 'blocked',
      passed: 2,
      blocked: 1,
      findings_by_category: {
        environment_prerequisite: 1
      }
    });
  });

  it('fails mixed blocker lanes when implementation defects are present', async () => {
    const { repoRoot, buildArtifact } = createFakeRepo();
    const fakeCommand = writeFakeCommand(repoRoot);
    const realProject = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'real-doctor-blocked-dashboard-mismatch-'))
    );
    fs.writeFileSync(path.join(realProject, 'WORKFLOW.md'), trial.workflow('Mixed blocker real project'));
    const { report } = await trial.runTrial({
      repoRoot,
      report: path.join(repoRoot, 'trial-report.json'),
      env: { PATH: process.env.PATH },
      projectRoots: [{ path: realProject, required: false, shape: 'existing-node' }],
      operator: {
        source: 'linked-symphony',
        command: process.execPath,
        argsPrefix: [fakeCommand],
        buildArtifact,
        fallbackEntrypoint: fakeCommand
      }
    });

    const realLane = report.lanes.find((lane: any) => lane.id === 'real-project-1');
    expect(realLane.status).toBe('failed');
    expect(realLane.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'environment_prerequisite', severity: 'blocker' }),
        expect.objectContaining({ category: 'implementation_defect', severity: 'blocker' })
      ])
    );
    expect(report.summary).toMatchObject({
      status: 'failed',
      passed: 2,
      failed: 1,
      blocked: 0,
      findings_by_category: {
        environment_prerequisite: 1,
        implementation_defect: 1
      }
    });
  });

  it('blocks hosted issue-run lanes until explicit disposable resources and credentials are supplied', async () => {
    const { repoRoot, buildArtifact } = createFakeRepo();
    const fakeCommand = writeFakeCommand(repoRoot);
    const { report } = await trial.runTrial({
      repoRoot,
      report: path.join(repoRoot, 'trial-report.json'),
      env: { PATH: process.env.PATH, LINEAR_API_KEY: 'linear-secret' },
      hostedCredentials: true,
      operator: {
        source: 'linked-symphony',
        command: process.execPath,
        argsPrefix: [fakeCommand],
        buildArtifact,
        fallbackEntrypoint: fakeCommand
      }
    });

    const hostedLane = report.lanes.find((lane: any) => lane.id === 'hosted-linear-node-issue-run');
    expect(hostedLane).toMatchObject({
      status: 'blocked',
      counts_for_external_project_evidence: true,
      hosted_prerequisites: {
        status: 'blocked',
        missing: expect.arrayContaining([
          expect.objectContaining({ name: 'GITHUB_TOKEN or GH_TOKEN' }),
          expect.objectContaining({ name: 'hosted Linear project slug' }),
          expect.objectContaining({ name: 'isolated disposable Linear project acknowledgement' }),
          expect.objectContaining({ name: 'hosted Linear issue id' }),
          expect.objectContaining({ name: 'hosted GitHub owner' }),
          expect.objectContaining({ name: 'hosted GitHub repository' }),
          expect.objectContaining({ name: 'hosted GitHub remote URL' })
        ])
      }
    });
    expect(report.summary).toMatchObject({
      status: 'blocked',
      passed: 2,
      blocked: 1
    });
  });
});
