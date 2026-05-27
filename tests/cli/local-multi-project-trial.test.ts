import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const trial = require('../../scripts/lib/local-multi-project-trial.js') as {
  parseArgs(argv: string[]): {
    report: string | null;
    projectRoots: Array<{ path: string; required: boolean; shape: string }>;
    requiredProjectRoots: Array<{ path: string; required: boolean; shape: string }>;
    syntheticProjectRoots: Array<{ path: string; required: boolean; shape: string }>;
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
  fs.writeFileSync(path.join(repoRoot, 'WORKFLOW.md'), trial.workflow('Fake Symphony checkout'));
  return { repoRoot, buildArtifact };
}

function writeFakeCommand(tempRoot: string) {
  const scriptPath = path.join(tempRoot, 'fake-symphony.js');
  fs.writeFileSync(
    scriptPath,
    `
const http = require('node:http');
const path = require('node:path');
const repoRoot = __dirname;

const [command, ...args] = process.argv.slice(2);
const profile = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : 'project';
const workflowArg = args.includes('--workflow') ? args[args.indexOf('--workflow') + 1] : null;
const workflowPath = profile === 'symphony-internal' ? path.join(repoRoot, 'WORKFLOW.md') : (workflowArg || path.join(process.cwd(), 'WORKFLOW.md'));

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
      projectRoot: profile === 'symphony-internal' ? repoRoot : process.cwd(),
      workflowPath,
      profile,
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
  console.log(args.includes('symphony-internal') ? 'symphony-internal' : 'memory-generic');
} else if (command === 'init') {
  const dryRun = args.includes('--dry-run');
  const bundle = args[args.indexOf('--bundle') + 1] || 'memory-generic';
  const linearProjectSlug = args[args.indexOf('--linear-project-slug') + 1] || 'SYMPHONY-TRIAL';
  const isLinearNode = bundle === 'linear-node';
  const workflow = [
    '---',
    'symphony:',
    '  generated_profile:',
    '    profile: "solo-local"',
    '    bundle: "' + bundle + '"',
    '    packs:',
    isLinearNode ? '      - "tracker:linear"' : '      - "tracker:memory"',
    isLinearNode ? '      - "workspace:worktree"' : '      - "workspace:none"',
    isLinearNode ? '      - "toolchain:node"' : '      - "toolchain:generic"',
    '      - "workflow:solo-local"',
    'tracker:',
    isLinearNode ? '  kind: "linear"' : '  kind: "memory"',
    isLinearNode ? '  project_slug: "' + linearProjectSlug + '"' : '  endpoint: "memory://local"',
    isLinearNode ? '  active_states: ["Todo", "In Progress"]' : '  api_key: ""',
    isLinearNode ? '  terminal_states: ["Done"]' : '',
    'toolchain:',
    isLinearNode ? '  kind: "node"' : '  kind: "generic"',
    isLinearNode ? '  setup_command: "npm install"' : '  setup_command: ""',
    isLinearNode ? '  validation_command: "npm test"' : '  validation_command: "git diff --check"',
    '---',
    '<!-- symphony-generated-profile: profile=solo-local; bundle=' + bundle + '; packs=' + (isLinearNode ? 'tracker:linear,workspace:worktree,toolchain:node' : 'tracker:memory,workspace:none,toolchain:generic') + ',workflow:solo-local; -->',
    '# Symphony Workflow',
    '',
    isLinearNode ? '- Linear tracker project: ' + linearProjectSlug : '- Memory tracker: no hosted tracker credentials required.',
    isLinearNode ? '- Validation: npm test' : '- Validation: git diff --check',
    ''
  ].filter(Boolean).join('\\n');
  const files = [
    { path: 'WORKFLOW.md', content: workflow },
    ...(isLinearNode
      ? [
          { path: '.env.example', content: 'LINEAR_API_KEY=\\n' },
          { path: '.worktreeinclude', content: 'node_modules/**\\n' }
        ]
      : []),
    { path: path.join('.symphony', 'system', '.gitignore'), content: '*\\n!.gitignore\\n' },
    { path: '.gitignore', content: '.symphony/system/\\n' }
  ];
  function actionFor(file) {
    if (!require('node:fs').existsSync(path.join(process.cwd(), file.path))) return 'create';
    return require('node:fs').readFileSync(path.join(process.cwd(), file.path), 'utf8') === file.content ? 'skip' : 'overwrite';
  }
  const actions = files.map((file) => ({ ...file, action: actionFor(file) }));
  if (dryRun) {
    console.log('Symphony init dry-run file plan');
    console.log('');
    console.log('Dry run: yes');
    console.log('Validation: ok');
    console.log('');
    console.log('Files:');
    actions.forEach((file, index) => {
      console.log(\`  \${index + 1}. \${file.path}\`);
      console.log(\`     action: \${file.action}\`);
      console.log(\`     overwrite: \${file.action === 'create' ? 'absent' : 'exists'}\`);
      console.log(\`     would_write: \${file.action === 'skip' ? 'no' : 'yes'}\`);
      console.log('     overwrite_approval_required: no');
    });
    return;
  }
  let writes = 0;
  let skipped = 0;
  for (const file of actions) {
    if (file.action === 'skip') {
      skipped += 1;
      continue;
    }
    require('node:fs').mkdirSync(path.dirname(path.join(process.cwd(), file.path)), { recursive: true });
    require('node:fs').writeFileSync(path.join(process.cwd(), file.path), file.content);
    writes += 1;
  }
  console.log('Symphony init write complete');
  console.log('');
  console.log('Writes performed: ' + writes);
  console.log('Skipped unchanged: ' + skipped);
  console.log('Validation: ok');
  console.log('');
  console.log('Files:');
  actions.forEach((file) => console.log(\`  - \${file.path}: \${file.action}\${file.action === 'skip' ? '' : ' written'}\`));
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
  console.log(JSON.stringify(doctorPayload('ok', 'ready', 0, [
    {
      id: 'tracker.credentials',
      code: 'tracker_credentials_not_required',
      severity: 'pass',
      checkStatus: 'ok',
      message: 'Memory tracker mode does not require external tracker credentials.',
      source: { category: 'runtime_probe', present: true }
    },
    {
      id: 'layout.runtime_state_root',
      code: 'runtime_state_root_reserved',
      severity: 'pass',
      checkStatus: 'ok',
      message: '.symphony/system/ is the runtime-owned local state root.',
      source: { category: 'layout_inspection', present: true }
    },
    {
      id: 'layout.gitignore_system',
      code: 'system_ignore_present',
      severity: 'pass',
      checkStatus: 'ok',
      message: '.gitignore includes .symphony/system/.',
      source: { category: 'layout_inspection', present: true }
    },
    {
      id: 'layout.reserved_customization',
      code: 'reserved_customization_reported',
      severity: 'pass',
      checkStatus: 'ok',
      message: 'Reserved customization paths are visible and not runtime-loaded.',
      source: { category: 'layout_inspection', present: true }
    },
    {
      id: 'customization.generated_profile',
      code: 'generated_profile_provenance_recorded',
      severity: 'pass',
      checkStatus: 'ok',
      message: 'Generated workflow provenance is recorded.',
      source: { category: 'generated_profile', present: true }
    }
  ])));
} else if (command === 'dashboard') {
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
      '/tmp/project-b',
      '--synthetic-project-root',
      '/tmp/project-c'
    ]);

    expect(options.projectRoots).toEqual([{ path: '/tmp/project-a', required: false, shape: 'existing-node' }]);
    expect(options.requiredProjectRoots).toEqual([{ path: '/tmp/project-b', required: true, shape: 'existing-node' }]);
    expect(options.syntheticProjectRoots).toEqual([{ path: '/tmp/project-c', required: false, shape: 'existing-node' }]);
  }, 30_000);

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
  }, 30_000);

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
    const realProject = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'real-existing-project-')));
    fs.writeFileSync(path.join(realProject, 'WORKFLOW.md'), trial.workflow('Real existing project'));
    const reportPath = path.join(repoRoot, 'trial-report.json');
    const { report } = await trial.runTrial({
      repoRoot,
      report: reportPath,
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

    expect(report.summary).toMatchObject({
      status: 'passed',
      passed: 5,
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
          total: 5,
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
    const generatedLane = report.lanes.find((lane: any) => lane.id === 'synthetic-generated-generic');
    expect(generatedLane).toMatchObject({
      status: 'passed',
      synthetic: true,
      project_shape: 'synthetic-generated-generic-no-node-metadata',
      project_facts: {
        git_repository: true,
        package_metadata_absent: true
      },
      init: {
        dry_run: {
          no_write_verification: { passed: true, changed_files: [] }
        },
        write: {
          verification: { passed: true }
        },
        idempotent_write: {
          summary: { writes_performed: 0, skipped_unchanged: 3 }
        }
      },
      generated_workflow: {
        generated_profile_provenance: true,
        memory_tracker: true,
        generic_toolchain: true,
        verification: { passed: true, failures: [] }
      },
      validation_behavior: {
        setup_command: '""',
        validation_command: '"git diff --check"',
        node_command_terms_present: [],
        hosted_tracker_credentials_required: false
      },
      dashboard: {
        status: 'bound',
        project_identity_match: true,
        shutdown: { clean: true }
      }
    });
    expect(report.lanes.find((lane: any) => lane.id === 'symphony-internal-profile')).toMatchObject({
      status: 'passed',
      counts_for_external_project_evidence: false,
      doctor: {
        resolution: {
          profile: 'symphony-internal',
          workflow_path: path.join(repoRoot, 'WORKFLOW.md')
        }
      },
      dashboard: {
        project_identity_match: true
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
    expect(report.lanes.find((lane: any) => lane.id === 'real-project-1')).toMatchObject({
      status: 'passed',
      synthetic: false,
      counts_for_external_project_evidence: true
    });
  }, 30_000);

  it('blocks full trial evidence when no real existing project root is supplied', async () => {
    const { repoRoot, buildArtifact } = createFakeRepo();
    const fakeCommand = writeFakeCommand(repoRoot);
    const { report } = await trial.runTrial({
      repoRoot,
      report: path.join(repoRoot, 'trial-report.json'),
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
      status: 'blocked',
      passed: 4,
      blocked: 1
    });
    expect(report.lanes.find((lane: any) => lane.id === 'real-existing-project-missing')).toMatchObject({
      status: 'blocked',
      counts_for_external_project_evidence: false,
      findings: [
        expect.objectContaining({
          category: 'environment_prerequisite',
          severity: 'blocker',
          summary: expect.stringContaining('No real existing local project root')
        })
      ]
    });
  }, 30_000);

  it('labels synthetic existing-workflow fixtures without counting them as real external evidence', async () => {
    const { repoRoot, buildArtifact } = createFakeRepo();
    const fakeCommand = writeFakeCommand(repoRoot);
    const syntheticProject = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-existing-project-')));
    fs.writeFileSync(path.join(syntheticProject, 'WORKFLOW.md'), trial.workflow('Synthetic existing project'));
    const { report } = await trial.runTrial({
      repoRoot,
      report: path.join(repoRoot, 'trial-report.json'),
      env: { PATH: process.env.PATH },
      syntheticProjectRoots: [{ path: syntheticProject, required: false, shape: 'synthetic-existing-workflow' }],
      operator: {
        source: 'linked-symphony',
        command: process.execPath,
        argsPrefix: [fakeCommand],
        buildArtifact,
        fallbackEntrypoint: fakeCommand
      }
    });

    expect(report.summary).toMatchObject({
      status: 'blocked',
      passed: 5,
      blocked: 1
    });
    expect(report.lanes.find((lane: any) => lane.id === 'synthetic-existing-project-1')).toMatchObject({
      status: 'passed',
      synthetic: true,
      counts_for_external_project_evidence: false
    });
  }, 30_000);

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
      passed: 4,
      blocked: 1,
      findings_by_category: {
        environment_prerequisite: 1
      }
    });
  }, 30_000);

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
      passed: 4,
      failed: 1,
      blocked: 0,
      findings_by_category: {
        environment_prerequisite: 1,
        implementation_defect: 1
      }
    });
  }, 30_000);

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
      passed: 4,
      blocked: 2
    });
  }, 30_000);
});
