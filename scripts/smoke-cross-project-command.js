#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-cross-project-smoke-')));
const binDir = path.join(tempRoot, 'bin');
const homeDir = path.join(tempRoot, 'home');
const stateHome = path.join(tempRoot, 'state');
const dashboardCapture = path.join(tempRoot, 'dashboard-calls.jsonl');
const dashboardChild = path.join(tempRoot, 'dashboard-child.js');
const diagnosticsProbe = path.join(tempRoot, 'diagnostics-probe.js');
const projectA = path.join(tempRoot, 'external-project-a');
const projectB = path.join(tempRoot, 'external-project-b');
const broadIgnoreProject = path.join(tempRoot, 'broad-ignore-project');
const narrowIgnoreProject = path.join(tempRoot, 'narrow-ignore-project');
const legacyProject = path.join(tempRoot, 'legacy-runtime-project');
const nodeProject = path.join(tempRoot, 'node-project');
const genericProject = path.join(tempRoot, 'generic-project');
const shimPath = path.join(binDir, 'symphony');

const results = [];

function writeFile(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, mode ? { mode } : undefined);
}

function workflow(name) {
  return [
    '---',
    'tracker:',
    '  kind: memory',
    'codex:',
    '  command: codex',
    '  approval_policy: never',
    '  thread_sandbox: danger-full-access',
    '  turn_sandbox_policy: danger-full-access',
    'server:',
    '  port: 0',
    '---',
    '',
    `# ${name}`,
    '',
    'Smoke workflow used by cross-project local command compatibility coverage.',
    ''
  ].join('\n');
}

function baseEnv(extra = {}) {
  const env = {
    ...process.env,
    HOME: homeDir,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
    SYMPHONY_LOCAL_STATE_HOME: stateHome,
    SYMPHONY_SUPERVISOR_CHILD_SCRIPT: dashboardChild,
    SYMPHONY_DASHBOARD_SMOKE_CAPTURE: dashboardCapture,
    ...extra
  };
  for (const key of ['SYMPHONY_WORKFLOW_PATH', 'SYMPHONY_PORT', 'SYMPHONY_HOST', 'SYMPHONY_ENV_FILE']) {
    if (!(key in extra)) {
      delete env[key];
    }
  }
  return env;
}

function runStep(name, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || baseEnv(),
    encoding: 'utf8',
    timeout: options.timeoutMs || 60_000
  });
  const status = result.status === null ? 1 : result.status;
  const record = {
    name,
    command: [command, ...args].join(' '),
    cwd: options.cwd || repoRoot,
    status
  };
  results.push(record);
  if (status !== (options.expectedStatus ?? 0)) {
    process.stderr.write(`Smoke step failed: ${name}\n`);
    process.stderr.write(`command: ${record.command}\n`);
    process.stderr.write(`cwd: ${record.cwd}\n`);
    process.stderr.write(`expected status: ${options.expectedStatus ?? 0}, actual: ${status}\n`);
    process.stderr.write(`stdout:\n${result.stdout || ''}\n`);
    process.stderr.write(`stderr:\n${result.stderr || ''}\n`);
    process.exit(1);
  }
  return result;
}

function assertIncludes(name, value, expected) {
  if (!value.includes(expected)) {
    process.stderr.write(`Smoke assertion failed: ${name}\n`);
    process.stderr.write(`Missing: ${expected}\n`);
    process.stderr.write(`Value:\n${value}\n`);
    process.exit(1);
  }
}

function assertNotIncludes(name, value, unexpected) {
  if (value.includes(unexpected)) {
    process.stderr.write(`Smoke assertion failed: ${name}\n`);
    process.stderr.write(`Unexpected: ${unexpected}\n`);
    process.stderr.write(`Value:\n${value}\n`);
    process.exit(1);
  }
}

function assertEqual(name, actual, expected) {
  if (actual !== expected) {
    process.stderr.write(`Smoke assertion failed: ${name}\n`);
    process.stderr.write(`Expected: ${expected}\n`);
    process.stderr.write(`Actual: ${actual}\n`);
    process.exit(1);
  }
}

function assertPathExists(name, filePath) {
  if (!fs.existsSync(filePath)) {
    process.stderr.write(`Smoke assertion failed: ${name}\n`);
    process.stderr.write(`Missing path: ${filePath}\n`);
    process.exit(1);
  }
}

function assertPathNotExists(name, filePath) {
  if (fs.existsSync(filePath)) {
    process.stderr.write(`Smoke assertion failed: ${name}\n`);
    process.stderr.write(`Unexpected path: ${filePath}\n`);
    process.exit(1);
  }
}

function assertJsonMatch(name, value, predicate) {
  if (!predicate(value)) {
    process.stderr.write(`Smoke assertion failed: ${name}\n`);
    process.stderr.write(`${JSON.stringify(value, null, 2)}\n`);
    process.exit(1);
  }
}

function git(projectRoot, args, options = {}) {
  return runStep(options.name || `git ${args.join(' ')}`, 'git', args, {
    cwd: projectRoot,
    env: baseEnv(),
    expectedStatus: options.expectedStatus ?? 0
  });
}

function initGitProject(projectRoot) {
  git(projectRoot, ['init'], { name: `git init ${path.basename(projectRoot)}` });
}

function assertGitIgnored(projectRoot, relativePath, expectedIgnored) {
  const result = git(projectRoot, ['check-ignore', relativePath], {
    name: `git check-ignore ${path.basename(projectRoot)} ${relativePath}`,
    expectedStatus: expectedIgnored ? 0 : 1
  });
  if (expectedIgnored) {
    assertIncludes(`git ignored ${relativePath}`, result.stdout, relativePath);
  } else {
    assertEqual(`git did not ignore ${relativePath}`, result.stdout, '');
  }
}

function assertDoctorLayoutRoot(name, payload, projectRoot) {
  assertJsonMatch(name, payload.layout, (layout) => {
    return (
      layout &&
      layout.runtimeStateRoot.path === '.symphony/system' &&
      layout.runtimeOwnedPaths.some((item) => item.path === '.symphony/system/workspaces') &&
      layout.runtimeOwnedPaths.some((item) => item.path === '.symphony/system/logs') &&
      layout.runtimeOwnedPaths.some((item) => item.path === '.symphony/system/runtime.sqlite')
    );
  });
}

function assertDefaultDiagnosticsLayout(name, payload, projectRoot) {
  assertJsonMatch(name, payload, (diagnostics) => {
    const layout = diagnostics.project_layout;
    return (
      diagnostics.runtime_resolution.workspace_root === path.join(projectRoot, '.symphony', 'system', 'workspaces') &&
      diagnostics.runtime_resolution.workspace_root_source === 'default' &&
      diagnostics.logging.root === path.join(projectRoot, '.symphony', 'system', 'logs') &&
      diagnostics.persistence.db_path === path.join(projectRoot, '.symphony', 'system', 'runtime.sqlite') &&
      layout &&
      layout.expected_runtime_state_root.path === path.join(projectRoot, '.symphony', 'system') &&
      layout.effective_workspace_root.path === path.join(projectRoot, '.symphony', 'system', 'workspaces') &&
      layout.effective_workspace_root.source === 'default_system_state' &&
      layout.effective_log_root.path === path.join(projectRoot, '.symphony', 'system', 'logs') &&
      layout.effective_log_root.source === 'default_system_state' &&
      layout.effective_persistence_path.path === path.join(projectRoot, '.symphony', 'system', 'runtime.sqlite') &&
      layout.effective_persistence_path.source === 'default_system_state'
    );
  });
}

function runDiagnosticsProbe(projectRoot) {
  return JSON.parse(
    runStep('runtime diagnostics layout projection', 'node', [diagnosticsProbe, path.join(projectRoot, 'WORKFLOW.md')], {
      cwd: repoRoot,
      env: baseEnv(),
      timeoutMs: 60_000
    }).stdout
  );
}

function readDashboardCalls() {
  if (!fs.existsSync(dashboardCapture)) {
    return [];
  }
  return fs
    .readFileSync(dashboardCapture, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function lastDashboardCall() {
  const calls = readDashboardCalls();
  return calls.at(-1);
}

function assertLastDashboardCall(name, predicate) {
  const call = lastDashboardCall();
  if (!call || !predicate(call)) {
    process.stderr.write(`Smoke assertion failed: ${name}\n`);
    process.stderr.write(`Dashboard calls:\n${JSON.stringify(readDashboardCalls(), null, 2)}\n`);
    process.exit(1);
  }
}

function printSummary() {
  process.stdout.write('Cross-project local command smoke passed.\n');
  for (const result of results) {
    process.stdout.write(`- ${result.name}: exit ${result.status}\n`);
  }
}

fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(homeDir, { recursive: true });
fs.mkdirSync(stateHome, { recursive: true });
fs.mkdirSync(projectA, { recursive: true });
fs.mkdirSync(projectB, { recursive: true });
fs.mkdirSync(broadIgnoreProject, { recursive: true });
fs.mkdirSync(narrowIgnoreProject, { recursive: true });
fs.mkdirSync(legacyProject, { recursive: true });
fs.mkdirSync(nodeProject, { recursive: true });
fs.mkdirSync(genericProject, { recursive: true });
writeFile(path.join(projectA, 'WORKFLOW.md'), workflow('external project A'));
writeFile(path.join(projectA, '.env'), 'SYMPHONY_HOST=127.0.0.1\n', 0o600);
writeFile(path.join(projectB, 'WORKFLOW.md'), workflow('external project B'));
writeFile(path.join(projectB, '.env'), 'SYMPHONY_HOST=127.0.0.1\n', 0o600);
writeFile(path.join(broadIgnoreProject, 'WORKFLOW.md'), workflow('broad ignore project'));
writeFile(path.join(broadIgnoreProject, '.gitignore'), '.symphony/\n');
writeFile(path.join(broadIgnoreProject, '.symphony', 'skills', 'README.md'), '# project skills\n');
writeFile(path.join(broadIgnoreProject, '.symphony', 'prompts', 'README.md'), '# project prompts\n');
writeFile(path.join(narrowIgnoreProject, 'WORKFLOW.md'), workflow('narrow ignore project'));
writeFile(path.join(narrowIgnoreProject, '.gitignore'), '.symphony/system/\n');
writeFile(path.join(narrowIgnoreProject, '.symphony', 'skills', 'README.md'), '# project skills\n');
writeFile(path.join(narrowIgnoreProject, '.symphony', 'prompts', 'README.md'), '# project prompts\n');
writeFile(path.join(legacyProject, 'WORKFLOW.md'), workflow('legacy runtime project'));
writeFile(path.join(legacyProject, '.gitignore'), '.symphony/system/\n');
fs.mkdirSync(path.join(legacyProject, '.symphony', 'workspaces'), { recursive: true });
writeFile(path.join(legacyProject, '.symphony', 'runtime.sqlite'), 'legacy runtime database\n');
writeFile(path.join(nodeProject, 'WORKFLOW.md'), workflow('node-ish project'));
writeFile(path.join(nodeProject, 'package.json'), '{"scripts":{"test":"node -e \\"process.exit(0)\\""}}\n');
writeFile(path.join(nodeProject, '.gitignore'), 'node_modules/\n.symphony/system/\n');
writeFile(path.join(genericProject, 'WORKFLOW.md'), workflow('generic project'));
writeFile(path.join(genericProject, 'README.md'), '# Generic project\n');
writeFile(path.join(genericProject, '.gitignore'), '.symphony/system/\n');
for (const project of [projectA, projectB, broadIgnoreProject, narrowIgnoreProject, legacyProject, nodeProject, genericProject]) {
  initGitProject(project);
}
writeFile(
  dashboardChild,
  [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    'const payload = {',
    '  cwd: process.cwd(),',
    '  argv: process.argv.slice(2),',
    '  envFile: process.env.SYMPHONY_ENV_FILE || null',
    '};',
    "fs.appendFileSync(process.env.SYMPHONY_DASHBOARD_SMOKE_CAPTURE, `${JSON.stringify(payload)}\\n`);",
    ''
  ].join('\n'),
  0o755
);
writeFile(
  diagnosticsProbe,
  [
    '#!/usr/bin/env node',
    "const { createRuntimeEnvironment } = require(process.cwd() + '/dist/src/runtime');",
    'const workflowPath = process.argv[2];',
    'const trackerAdapter = {',
    '  fetch_candidate_issues: async () => [],',
    '  fetch_issues_by_states: async () => [],',
    '  fetch_issue_states_by_ids: async () => [],',
    '  create_comment: async () => undefined,',
    '  update_issue_state: async () => undefined',
    '};',
    '(async () => {',
    '  const runtime = createRuntimeEnvironment({ workflowPath, trackerAdapter, port: 0 });',
    '  try {',
    '    await runtime.start();',
    '    const address = runtime.apiServer.address();',
    "    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);",
    '    if (!response.ok) { throw new Error(`diagnostics status ${response.status}`); }',
    '    process.stdout.write(JSON.stringify(await response.json()));',
    '  } finally {',
    '    await runtime.stop();',
    '  }',
    '})().catch((error) => {',
    '  process.stderr.write(`${error.stack || error.message}\\n`);',
    '  process.exit(1);',
    '});',
    ''
  ].join('\n'),
  0o755
);

runStep('build runtime for linked CLI', 'npm', ['run', 'build'], { cwd: repoRoot, env: baseEnv() });
runStep('link local checkout into temp bin', 'npm', ['run', 'link:local', '--', '--target', shimPath], {
  cwd: repoRoot,
  env: baseEnv({ SYMPHONY_LINK_LOCAL_BUILD_VERIFIED: '1' })
});

const version = runStep('symphony --version', 'symphony', ['--version'], { cwd: projectA }).stdout.trim();
assertIncludes('version output', version, '0.1.0');
assertIncludes('symphony --help', runStep('symphony --help', 'symphony', ['--help'], { cwd: projectA }).stdout, 'symphony <command> [options]');
assertIncludes('profile list', runStep('symphony profile list', 'symphony', ['profile', 'list'], { cwd: projectA }).stdout, 'symphony-internal');
assertIncludes(
  'profile show symphony-internal',
  runStep('symphony profile show symphony-internal', 'symphony', ['profile', 'show', 'symphony-internal'], { cwd: projectA }).stdout,
  path.join(repoRoot, 'WORKFLOW.md')
);
assertIncludes('init --help', runStep('symphony init --help', 'symphony', ['init', '--help'], { cwd: projectA }).stdout, 'does not generate, copy, or overwrite workflows');

const noGitignoreDoctor = JSON.parse(
  runStep('doctor --json --ci no gitignore', 'symphony', ['doctor', '--json', '--ci'], {
    cwd: projectA,
    expectedStatus: 2
  }).stdout
);
assertJsonMatch('no .gitignore projects report layout guidance', noGitignoreDoctor, (payload) => {
  return (
    payload.layout.ignoreAnalysis.exists === false &&
    payload.layout.ignoreAnalysis.status === 'missing' &&
    payload.checks.some((check) => check.id === 'layout.gitignore_system' && check.reason === 'system_ignore_missing')
  );
});

assertIncludes('setup consent', runStep('symphony setup', 'symphony', ['setup', '--yes'], { cwd: projectA }).stdout, 'Setup consent recorded for identity');
assertEqual('setup adds system gitignore for no .gitignore project', fs.readFileSync(path.join(projectA, '.gitignore'), 'utf8'), '.symphony/system/\n');
assertPathNotExists('setup does not create runtime state root by itself', path.join(projectA, '.symphony', 'system'));
assertGitIgnored(projectA, '.symphony/system/runtime.sqlite', true);
assertGitIgnored(projectA, '.symphony/skills/example.md', false);
assertGitIgnored(projectA, '.symphony/prompts/example.md', false);
assertIncludes('doctor human ok', runStep('symphony doctor', 'symphony', ['doctor'], { cwd: projectA }).stdout, 'Symphony doctor: ok');
const doctorJson = JSON.parse(runStep('doctor --json', 'symphony', ['doctor', '--json'], { cwd: projectA }).stdout);
if (doctorJson.status !== 'ok' || doctorJson.resolution.consent !== 'setup') {
  process.stderr.write(`Smoke assertion failed: doctor --json ok/setup\n${JSON.stringify(doctorJson, null, 2)}\n`);
  process.exit(1);
}
assertDoctorLayoutRoot('doctor --json reports system runtime root', doctorJson, projectA);
assertDefaultDiagnosticsLayout('runtime diagnostics defaults use .symphony/system', runDiagnosticsProbe(projectA), projectA);
assertIncludes('doctor --ci ok', runStep('doctor --ci', 'symphony', ['doctor', '--ci'], { cwd: projectA }).stdout, 'Symphony doctor: ok');
const doctorCiFailure = JSON.parse(
  runStep('doctor --json --ci missing setup', 'symphony', ['doctor', '--json', '--ci'], {
    cwd: projectB,
    expectedStatus: 2
  }).stdout
);
if (doctorCiFailure.status !== 'failure' || doctorCiFailure.reason !== 'blockers_present') {
  process.stderr.write(`Smoke assertion failed: doctor --json --ci failure\n${JSON.stringify(doctorCiFailure, null, 2)}\n`);
  process.exit(1);
}

assertIncludes('setup broad ignore project', runStep('symphony setup broad ignore', 'symphony', ['setup', '--yes'], { cwd: broadIgnoreProject }).stdout, '[applied] layout.gitignore-system');
const broadDoctor = JSON.parse(runStep('doctor --json broad ignore', 'symphony', ['doctor', '--json'], { cwd: broadIgnoreProject, expectedStatus: 1 }).stdout);
assertDoctorLayoutRoot('broad ignore doctor reports system root', broadDoctor, broadIgnoreProject);
assertJsonMatch('broad ignore reports migration warning', broadDoctor, (payload) => {
  return (
    payload.status === 'warning' &&
    payload.layout.ignoreAnalysis.status === 'broad-symphony' &&
    payload.layout.ignoreAnalysis.hasBroadSymphonyIgnore === true &&
    payload.layout.ignoreAnalysis.hasNarrowSystemIgnore === true &&
    payload.layout.warnings.some((warning) => warning.code === 'broad_symphony_ignore') &&
    payload.checks.some((check) => check.id === 'layout.broad_symphony_ignore' && check.status === 'warning')
  );
});
assertIncludes('broad ignore setup preserves broad rule', fs.readFileSync(path.join(broadIgnoreProject, '.gitignore'), 'utf8'), '.symphony/\n.symphony/system/\n');
assertPathExists('broad ignore setup preserves reserved skills', path.join(broadIgnoreProject, '.symphony', 'skills', 'README.md'));
assertPathExists('broad ignore setup preserves reserved prompts', path.join(broadIgnoreProject, '.symphony', 'prompts', 'README.md'));

assertIncludes('setup narrow ignore project', runStep('symphony setup narrow ignore', 'symphony', ['setup', '--yes'], { cwd: narrowIgnoreProject }).stdout, 'Setup consent recorded for identity');
const narrowDoctor = JSON.parse(runStep('doctor --json narrow ignore', 'symphony', ['doctor', '--json'], { cwd: narrowIgnoreProject }).stdout);
assertDoctorLayoutRoot('narrow ignore doctor reports system root', narrowDoctor, narrowIgnoreProject);
assertJsonMatch('narrow ignore keeps customization visible', narrowDoctor, (payload) => {
  const reservedPaths = payload.layout.reservedCustomizationPaths;
  return (
    payload.layout.ignoreAnalysis.status === 'narrow-system' &&
    payload.layout.warnings.every((warning) => warning.code !== 'broad_symphony_ignore') &&
    reservedPaths.some((item) => item.path === '.symphony/skills' && item.loadedByRuntime === false) &&
    reservedPaths.some((item) => item.path === '.symphony/prompts' && item.loadedByRuntime === false)
  );
});
assertGitIgnored(narrowIgnoreProject, '.symphony/system/runtime.sqlite', true);
assertGitIgnored(narrowIgnoreProject, '.symphony/skills/README.md', false);
assertGitIgnored(narrowIgnoreProject, '.symphony/prompts/README.md', false);

assertIncludes('setup legacy project', runStep('symphony setup legacy', 'symphony', ['setup', '--yes'], { cwd: legacyProject }).stdout, 'Setup consent recorded for identity');
const legacyDoctor = JSON.parse(runStep('doctor --json legacy runtime', 'symphony', ['doctor', '--json'], { cwd: legacyProject, expectedStatus: 1 }).stdout);
assertDoctorLayoutRoot('legacy runtime doctor reports system root', legacyDoctor, legacyProject);
assertJsonMatch('legacy runtime reports migration guidance', legacyDoctor, (payload) => {
  return (
    payload.status === 'warning' &&
    payload.layout.legacyRuntimePaths.some((item) => item.path === '.symphony/workspaces') &&
    payload.layout.legacyRuntimePaths.some((item) => item.path === '.symphony/runtime.sqlite') &&
    payload.checks.some((check) => check.id === 'layout.legacy_runtime_paths' && check.status === 'warning')
  );
});
assertPathExists('legacy setup does not auto-move workspaces', path.join(legacyProject, '.symphony', 'workspaces'));
assertPathExists('legacy setup does not auto-delete persistence', path.join(legacyProject, '.symphony', 'runtime.sqlite'));

assertIncludes('setup node-ish project', runStep('symphony setup node-ish', 'symphony', ['setup', '--yes'], { cwd: nodeProject }).stdout, 'Setup consent recorded for identity');
const nodeDoctor = JSON.parse(runStep('doctor --json node-ish', 'symphony', ['doctor', '--json'], { cwd: nodeProject }).stdout);
assertDoctorLayoutRoot('node-ish doctor reports system root', nodeDoctor, nodeProject);
assertJsonMatch('node-ish project stays healthy', nodeDoctor, (payload) => payload.status === 'ok' && payload.layout.status === 'ok');

assertIncludes('setup generic project', runStep('symphony setup generic', 'symphony', ['setup', '--yes'], { cwd: genericProject }).stdout, 'Setup consent recorded for identity');
const genericDoctor = JSON.parse(runStep('doctor --json generic', 'symphony', ['doctor', '--json'], { cwd: genericProject }).stdout);
assertDoctorLayoutRoot('generic doctor reports system root', genericDoctor, genericProject);
assertJsonMatch('generic project stays healthy', genericDoctor, (payload) => payload.status === 'ok' && payload.layout.status === 'ok');

const explicitDashboard = runStep(
  'dashboard explicit workflow',
  'symphony',
  ['dashboard', '--workflow', './WORKFLOW.md', '--port', '0'],
  { cwd: projectA }
).stdout;
assertIncludes('explicit dashboard workflow source', explicitDashboard, `workflow: ${path.join(projectA, 'WORKFLOW.md')} (cli)`);
assertIncludes('explicit dashboard consent', explicitDashboard, 'consent: setup');
assertLastDashboardCall('explicit dashboard child cwd/env', (call) => call.cwd === projectA && call.envFile === path.join(projectA, '.env'));

const defaultDashboard = runStep('dashboard default workflow', 'symphony', ['dashboard'], { cwd: projectA }).stdout;
assertIncludes('default dashboard workflow source', defaultDashboard, `workflow: ${path.join(projectA, 'WORKFLOW.md')} (project)`);
assertLastDashboardCall('default dashboard child port', (call) => call.argv.includes('--port=0'));

const changedIdentityDashboard = runStep('dashboard changed identity bypasses old consent', 'symphony', ['dashboard', '--port', '0'], {
  cwd: projectB
}).stdout;
assertIncludes('changed identity missing consent', changedIdentityDashboard, 'consent: missing');
assertLastDashboardCall(
  'changed identity omits guardrail acknowledgement',
  (call) => !call.argv.includes('--i-understand-that-this-will-be-running-without-the-usual-guardrails')
);

const internalDashboard = runStep(
  'dashboard symphony-internal profile',
  'symphony',
  ['dashboard', '--profile', 'symphony-internal', '--port', '0', '--i-understand-that-this-will-be-running-without-the-usual-guardrails'],
  { cwd: repoRoot }
).stdout;
assertIncludes('internal profile workflow', internalDashboard, `workflow: ${path.join(repoRoot, 'WORKFLOW.md')} (profile)`);
assertIncludes('internal profile name', internalDashboard, 'profile: symphony-internal (cli)');
assertGitIgnored(repoRoot, '.symphony/system/runtime.sqlite', true);
assertGitIgnored(repoRoot, '.symphony/skills/example.md', false);
assertGitIgnored(repoRoot, '.symphony/prompts/example.md', false);

const wrapperDashboard = runStep(
  'npm start:project-dashboard compatibility wrapper',
  'npm',
  ['run', 'start:project-dashboard', '--', projectA, '--port', '0', '--offline'],
  { cwd: repoRoot, env: baseEnv(), timeoutMs: 120_000 }
).stdout;
assertIncludes('wrapper delegates through start:dashboard', wrapperDashboard, '--workflow=');
assertLastDashboardCall(
  'wrapper includes guardrail acknowledgement',
  (call) =>
    call.cwd === repoRoot &&
    call.argv.includes('--i-understand-that-this-will-be-running-without-the-usual-guardrails') &&
    call.argv.includes(`--workflow=${path.join(projectA, 'WORKFLOW.md')}`)
);

assertPathExists('runtime state stays under project A system root', path.join(projectA, '.symphony', 'system'));
assertPathNotExists('setup consent stayed out of project A checkout', path.join(projectA, '.symphony', 'setup-consent.json'));
assertNotIncludes('state stayed out of project B', fs.existsSync(path.join(projectB, '.symphony')) ? 'project-state-present' : '', 'project-state-present');

printSummary();
