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
const projectA = path.join(tempRoot, 'external-project-a');
const projectB = path.join(tempRoot, 'external-project-b');
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
writeFile(path.join(projectA, 'WORKFLOW.md'), workflow('external project A'));
writeFile(path.join(projectA, '.env'), 'SYMPHONY_HOST=127.0.0.1\n', 0o600);
writeFile(path.join(projectB, 'WORKFLOW.md'), workflow('external project B'));
writeFile(path.join(projectB, '.env'), 'SYMPHONY_HOST=127.0.0.1\n', 0o600);
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

assertIncludes('setup consent', runStep('symphony setup', 'symphony', ['setup', '--yes'], { cwd: projectA }).stdout, 'Setup consent recorded for identity');
assertIncludes('doctor human ok', runStep('symphony doctor', 'symphony', ['doctor'], { cwd: projectA }).stdout, 'Symphony doctor: ok');
const doctorJson = JSON.parse(runStep('doctor --json', 'symphony', ['doctor', '--json'], { cwd: projectA }).stdout);
if (doctorJson.status !== 'ok' || doctorJson.resolution.consent !== 'setup') {
  process.stderr.write(`Smoke assertion failed: doctor --json ok/setup\n${JSON.stringify(doctorJson, null, 2)}\n`);
  process.exit(1);
}
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

assertNotIncludes('state stayed out of project A', fs.existsSync(path.join(projectA, '.symphony')) ? 'project-state-present' : '', 'project-state-present');
assertNotIncludes('state stayed out of project B', fs.existsSync(path.join(projectB, '.symphony')) ? 'project-state-present' : '', 'project-state-present');

printSummary();
