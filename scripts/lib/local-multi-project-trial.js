const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 60_000;
const DASHBOARD_TIMEOUT_MS = 90_000;
const HOSTED_ISSUE_RUN_TIMEOUT_MS = 15 * 60_000;
const HOSTED_ISSUE_RUN_POLL_MS = 5_000;
const SECRET_KEY_PATTERN = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE)/i;
const HOSTED_CREDENTIAL_KEYS = ['LINEAR_API_KEY', 'LINEAR_AUTH_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'];
const HOSTED_RESOURCE_ENV_KEYS = [
  'SYMPHONY_TRIAL_LINEAR_PROJECT_SLUG',
  'SYMPHONY_TRIAL_LINEAR_PROJECT_DISPOSABLE',
  'SYMPHONY_TRIAL_LINEAR_ISSUE_ID',
  'SYMPHONY_TRIAL_GITHUB_OWNER',
  'SYMPHONY_TRIAL_GITHUB_REPO',
  'SYMPHONY_TRIAL_GITHUB_REMOTE_URL'
];
const GENERATED_LINEAR_NODE_SLUG = 'SYMPHONY-TRIAL';

function isoNow() {
  return new Date().toISOString();
}

function realpathIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return filePath;
  }
  return fs.realpathSync(filePath);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
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
    '  host: 127.0.0.1',
    '  port: 0',
    '---',
    '',
    `# ${name}`,
    '',
    'Synthetic workflow used by the Local Multi-Project Trial harness.',
    ''
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    report: null,
    outputDir: null,
    projectRoots: [],
    requiredProjectRoots: [],
    projectShape: null,
    hostedCredentials: false,
    hostedLinearProjectSlug: null,
    hostedLinearProjectDisposable: false,
    hostedLinearIssueId: null,
    hostedGithubOwner: null,
    hostedGithubRepo: null,
    hostedGithubRemoteUrl: null,
    noDashboard: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return value;
    };

    if (arg === '--report') {
      options.report = readValue();
    } else if (arg === '--output-dir') {
      options.outputDir = readValue();
    } else if (arg === '--project-root') {
      options.projectRoots.push({ path: readValue(), required: false, shape: options.projectShape || 'existing-local' });
    } else if (arg === '--required-project-root') {
      options.requiredProjectRoots.push({ path: readValue(), required: true, shape: options.projectShape || 'existing-local-required' });
    } else if (arg === '--project-shape') {
      options.projectShape = readValue();
    } else if (arg === '--with-hosted-credentials') {
      options.hostedCredentials = true;
    } else if (arg === '--hosted-linear-project-slug') {
      options.hostedLinearProjectSlug = readValue();
    } else if (arg === '--hosted-linear-project-disposable') {
      options.hostedLinearProjectDisposable = true;
    } else if (arg === '--hosted-linear-issue-id') {
      options.hostedLinearIssueId = readValue();
    } else if (arg === '--hosted-github-owner') {
      options.hostedGithubOwner = readValue();
    } else if (arg === '--hosted-github-repo') {
      options.hostedGithubRepo = readValue();
    } else if (arg === '--hosted-github-remote-url') {
      options.hostedGithubRemoteUrl = readValue();
    } else if (arg === '--no-dashboard') {
      options.noDashboard = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unsupported option: ${arg}`);
    }
  }

  return options;
}

function renderHelp() {
  return [
    'Local Multi-Project Trial harness',
    '',
    'Usage:',
    '  node scripts/local-multi-project-trial.js [options]',
    '',
    'Options:',
    '  --report <path>                 Write the JSON evidence report to this path',
    '  --output-dir <path>             Directory for the default report path',
    '  --project-root <path>           Include an optional real local project root',
    '  --required-project-root <path>  Include a required real local project root',
    '  --project-shape <name>          Shape label for following project-root args',
    '  --with-hosted-credentials       Mark hosted credential lanes as intended',
    '  --hosted-linear-project-slug <slug>',
    '                                  Disposable Linear project slug for hosted issue-run proof',
    '  --hosted-linear-project-disposable',
    '                                  Acknowledge the Linear project is isolated and disposable',
    '  --hosted-linear-issue-id <id>   Disposable Linear issue identifier for hosted issue-run proof',
    '  --hosted-github-owner <owner>   Disposable GitHub owner for hosted issue-run proof',
    '  --hosted-github-repo <repo>     Disposable GitHub repository for hosted issue-run proof',
    '  --hosted-github-remote-url <url>',
    '                                  Disposable GitHub remote URL for hosted issue-run proof',
    '  --no-dashboard                  Skip dashboard proof and mark it out of scope',
    '  --help                          Show this help'
  ].join('\n');
}

function summarizeEnv(env) {
  const symphony = Object.keys(env)
    .filter((key) => key.startsWith('SYMPHONY_'))
    .sort()
    .map((key) => ({
      name: key,
      present: true,
      secret_like: SECRET_KEY_PATTERN.test(key),
      value: SECRET_KEY_PATTERN.test(key) ? '<redacted>' : '<present>'
    }));

  return {
    symphony,
    hosted_credentials: HOSTED_CREDENTIAL_KEYS.map((name) => ({
      name,
      present: Boolean(env[name]),
      secret_like: true,
      value: env[name] ? '<redacted>' : '<missing>'
    }))
  };
}

function summarizeHostedResources(env, options = {}) {
  const read = (optionName, envName) => options[optionName] || env[envName] || null;
  const disposableProject =
    options.hostedLinearProjectDisposable === true ||
    ['1', 'true', 'yes'].includes(String(env.SYMPHONY_TRIAL_LINEAR_PROJECT_DISPOSABLE || '').toLowerCase());
  return {
    linear_project_slug: {
      present: Boolean(read('hostedLinearProjectSlug', 'SYMPHONY_TRIAL_LINEAR_PROJECT_SLUG')),
      source: options.hostedLinearProjectSlug ? 'cli' : env.SYMPHONY_TRIAL_LINEAR_PROJECT_SLUG ? 'env' : 'missing'
    },
    linear_project_disposable: {
      present: disposableProject,
      source: options.hostedLinearProjectDisposable ? 'cli' : env.SYMPHONY_TRIAL_LINEAR_PROJECT_DISPOSABLE ? 'env' : 'missing'
    },
    linear_issue_id: {
      present: Boolean(read('hostedLinearIssueId', 'SYMPHONY_TRIAL_LINEAR_ISSUE_ID')),
      source: options.hostedLinearIssueId ? 'cli' : env.SYMPHONY_TRIAL_LINEAR_ISSUE_ID ? 'env' : 'missing'
    },
    github_owner: {
      present: Boolean(read('hostedGithubOwner', 'SYMPHONY_TRIAL_GITHUB_OWNER')),
      source: options.hostedGithubOwner ? 'cli' : env.SYMPHONY_TRIAL_GITHUB_OWNER ? 'env' : 'missing'
    },
    github_repo: {
      present: Boolean(read('hostedGithubRepo', 'SYMPHONY_TRIAL_GITHUB_REPO')),
      source: options.hostedGithubRepo ? 'cli' : env.SYMPHONY_TRIAL_GITHUB_REPO ? 'env' : 'missing'
    },
    github_remote_url: {
      present: Boolean(read('hostedGithubRemoteUrl', 'SYMPHONY_TRIAL_GITHUB_REMOTE_URL')),
      source: options.hostedGithubRemoteUrl ? 'cli' : env.SYMPHONY_TRIAL_GITHUB_REMOTE_URL ? 'env' : 'missing'
    }
  };
}

function redact(text, env) {
  let output = String(text || '');
  for (const [key, value] of Object.entries(env)) {
    if (!value || typeof value !== 'string' || value.length < 6) {
      continue;
    }
    if (SECRET_KEY_PATTERN.test(key)) {
      output = output.split(value).join('<redacted>');
    }
  }
  return output;
}

function summarizeTranscript(text, env, maxChars = 4_000) {
  const clean = redact(text, env);
  return {
    line_count: clean.length === 0 ? 0 : clean.split(/\r?\n/).filter(Boolean).length,
    truncated: clean.length > maxChars,
    text: clean.length > maxChars ? `${clean.slice(0, maxChars)}\n...[truncated]` : clean
  };
}

function runCommand(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  });
  const status = result.status === null ? 1 : result.status;
  const record = {
    name: options.name,
    command: [command, ...args],
    cwd: options.cwd,
    exit_code: status,
    signal: result.signal || null,
    timed_out: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    stdout: summarizeTranscript(result.stdout || '', options.env),
    stderr: summarizeTranscript(result.stderr || '', options.env)
  };
  Object.defineProperty(record, '_rawStdout', { value: result.stdout || '', enumerable: false });
  Object.defineProperty(record, '_rawStderr', { value: result.stderr || '', enumerable: false });
  return record;
}

function resolveOperatorCommand(repoRoot, env) {
  const buildArtifact = path.join(repoRoot, 'dist', 'src', 'runtime', 'command-router.js');
  const fallbackEntrypoint = path.join(repoRoot, 'scripts', 'symphony.js');
  const commandLookup = spawnSync('bash', ['-lc', 'command -v symphony'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8'
  });
  const linkedPath = commandLookup.status === 0 ? commandLookup.stdout.trim() : '';
  if (linkedPath) {
    const linkedMetadata = readLinkedShimMetadata(linkedPath);
    if (!linkedMetadata.repoRoot || realpathIfExists(linkedMetadata.repoRoot) === realpathIfExists(repoRoot)) {
      return {
        source: 'linked-symphony',
        command: linkedPath,
        argsPrefix: [],
        buildArtifact,
        fallbackEntrypoint,
        linkedShim: {
          path: linkedPath,
          repo_root: linkedMetadata.repoRoot,
          entrypoint: linkedMetadata.entrypoint,
          usable_for_checkout: true
        }
      };
    }
    return {
      source: 'local-development-fallback',
      command: process.execPath,
      argsPrefix: [fallbackEntrypoint],
      buildArtifact,
      fallbackEntrypoint,
      linkedShim: {
        path: linkedPath,
        repo_root: linkedMetadata.repoRoot,
        entrypoint: linkedMetadata.entrypoint,
        usable_for_checkout: false,
        mismatch: 'linked shim targets a different Symphony checkout'
      }
    };
  }
  return {
    source: 'local-development-fallback',
    command: process.execPath,
    argsPrefix: [fallbackEntrypoint],
    buildArtifact,
    fallbackEntrypoint,
    linkedShim: null
  };
}

function readLinkedShimMetadata(shimPath) {
  try {
    const content = fs.readFileSync(shimPath, 'utf8');
    return {
      repoRoot: content.match(/^# symphony-repo-root:\s*(.+)$/m)?.[1]?.trim() || null,
      entrypoint: content.match(/^# symphony-entrypoint:\s*(.+)$/m)?.[1]?.trim() || null
    };
  } catch {
    return { repoRoot: null, entrypoint: null };
  }
}

function addFinding(lane, category, severity, summary, remediation, status = 'open') {
  lane.findings.push({ category, severity, status, summary, remediation });
}

function laneStatus(lane) {
  if (lane.findings.some((finding) => finding.severity === 'blocker')) {
    const blockers = lane.findings.filter((finding) => finding.severity === 'blocker');
    if (blockers.every((finding) => finding.category === 'environment_prerequisite')) {
      return 'blocked';
    }
    return 'failed';
  }
  if (lane.findings.some((finding) => finding.severity === 'warning')) {
    return 'passed_with_warnings';
  }
  return 'passed';
}

function summarizeWorkflowFile(workflowPath) {
  if (!fs.existsSync(workflowPath)) {
    return null;
  }
  const content = fs.readFileSync(workflowPath, 'utf8');
  const trackerMatch = content.match(/tracker:\s*\n\s*kind:\s*([^\s]+)/);
  return {
    path: workflowPath,
    exists: true,
    bytes: Buffer.byteLength(content),
    line_count: content.split(/\r?\n/).length,
    sha256_available: false,
    tracker_kind: trackerMatch ? trackerMatch[1] : null,
    generated_profile: content.includes('symphony-generated-profile')
  };
}

function summarizeGeneratedFiles(projectRoot) {
  const candidates = ['WORKFLOW.md', '.env.example', '.worktreeinclude', '.gitignore', '.symphony/system/.gitignore', '.symphony/system/runtime.sqlite'];
  return candidates.map((relativePath) => {
    const filePath = path.join(projectRoot, relativePath);
    return {
      path: relativePath,
      exists: fs.existsSync(filePath),
      bytes: fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? fs.statSync(filePath).size : null
    };
  });
}

function parseInitFilePlan(stdout) {
  const files = [];
  const lines = String(stdout || '').split(/\r?\n/);
  let inFiles = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*Files:\s*$/.test(lines[index])) {
      inFiles = true;
      continue;
    }
    if (!inFiles) {
      continue;
    }
    const match = lines[index].match(/^\s{0,4}(?:\d+\.|-)\s+(.+?)(?::\s*(\w+).*)?\s*$/);
    if (!match) {
      continue;
    }
    const entry = { path: match[1], action: match[2] || null, would_write: null };
    for (let cursor = index + 1; cursor < Math.min(lines.length, index + 8); cursor += 1) {
      const action = lines[cursor].match(/^\s*action:\s*(.+?)\s*$/);
      if (action) {
        entry.action = action[1];
      }
      const wouldWrite = lines[cursor].match(/^\s*would_write:\s*(yes|no)\s*$/);
      if (wouldWrite) {
        entry.would_write = wouldWrite[1] === 'yes';
      }
    }
    files.push(entry);
  }
  return files;
}

function commitProjectChanges(projectRoot, message) {
  const add = spawnSync('git', ['add', 'WORKFLOW.md', '.env.example', '.worktreeinclude', '.gitignore'], {
    cwd: projectRoot,
    encoding: 'utf8'
  });
  if (add.status !== 0) {
    return { ok: false, step: 'git add', exit_code: add.status, stdout: add.stdout || '', stderr: add.stderr || '' };
  }
  const commit = spawnSync('git', ['commit', '-m', message], { cwd: projectRoot, encoding: 'utf8' });
  return {
    ok: commit.status === 0,
    step: 'git commit',
    exit_code: commit.status,
    stdout: commit.stdout || '',
    stderr: commit.stderr || ''
  };
}

function summarizeGitStatus(projectRoot) {
  const result = spawnSync('git', ['status', '--porcelain=v1'], { cwd: projectRoot, encoding: 'utf8' });
  return {
    exit_code: result.status,
    clean: result.status === 0 && result.stdout.trim().length === 0,
    porcelain: result.stdout.trim().split(/\r?\n/).filter(Boolean)
  };
}

function readWorkflowChecks(workflowPath, expectedLinearProjectSlug) {
  const content = fs.existsSync(workflowPath) ? fs.readFileSync(workflowPath, 'utf8') : '';
  const unintendedStates = ['Agent Review', 'Human Review', 'Merging', 'Rework'].filter((state) => content.includes(state));
  const checks = {
    parses_and_validates: content.includes('Validation: ok') ? null : null,
    generated_profile_provenance: content.includes('symphony-generated-profile') && content.includes('bundle=linear-node'),
    includes_node_setup_command: /setup_command:\s*"npm install"/.test(content) || /setup_command:\s*"npm ci"/.test(content),
    includes_node_validation_command: /validation_command:\s*"npm test"/.test(content),
    linear_project_slug: content.includes(`project_slug: "${expectedLinearProjectSlug}"`) || content.includes(`project_slug: ${expectedLinearProjectSlug}`),
    unintended_symphony_internal_states: unintendedStates,
    tracker_kind_linear: /tracker:\s*\n\s*kind:\s*"linear"|tracker:\s*\n\s*kind:\s*linear/.test(content),
    active_states_solo_local: content.includes('active_states: ["Todo", "In Progress"]'),
    handoff_states_absent: !content.includes('handoff_states:'),
    fresh_dispatch_states_absent: !content.includes('fresh_dispatch_states:')
  };
  checks.ok =
    checks.generated_profile_provenance &&
    checks.includes_node_setup_command &&
    checks.includes_node_validation_command &&
    checks.linear_project_slug &&
    checks.tracker_kind_linear &&
    checks.active_states_solo_local &&
    checks.handoff_states_absent &&
    checks.fresh_dispatch_states_absent &&
    checks.unintended_symphony_internal_states.length === 0;
  return checks;
}

function createGeneratedNodeProject(tempRoot, name) {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, `${name}-`)));
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: name.replace(/[^a-z0-9-]/g, '-'),
        version: '0.0.0',
        private: true,
        scripts: {
          test: 'node test.js'
        }
      },
      null,
      2
    )}\n`
  );
  fs.writeFileSync(path.join(projectRoot, 'index.js'), "module.exports = function hello() { return 'hello'; };\n");
  fs.writeFileSync(path.join(projectRoot, 'test.js'), "const hello = require('./index'); if (hello() !== 'hello') process.exit(1);\n");
  spawnSync('git', ['init', '-b', 'main'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 'symphony-trial@example.invalid'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.name', 'Symphony Trial'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['add', 'package.json', 'index.js', 'test.js'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', 'Initial Node trial project'], { cwd: projectRoot, encoding: 'utf8' });
  const remoteRoot = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, `${name}-remote-`)));
  spawnSync('git', ['init', '--bare'], { cwd: remoteRoot, encoding: 'utf8' });
  spawnSync('git', ['remote', 'add', 'origin', remoteRoot], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['push', '-u', 'origin', 'main'], { cwd: projectRoot, encoding: 'utf8' });
  return { projectRoot, remoteRoot };
}

function buildLane(id, label, projectShape, projectRoot, synthetic) {
  return {
    id,
    label,
    project_shape: projectShape,
    project_root: projectRoot,
    synthetic,
    counts_for_external_project_evidence: synthetic ? false : true,
    workflow_source: null,
    tracker_identifiers: [],
    status: 'blocked',
    findings: [],
    commands: [],
    generated_files: [],
    dashboard: null
  };
}

function appendCommand(lane, commandRecord, expectedCodes = [0]) {
  lane.commands.push(commandRecord);
  if (!expectedCodes.includes(commandRecord.exit_code)) {
    addFinding(
      lane,
      'implementation_defect',
      'blocker',
      `${commandRecord.name} exited ${commandRecord.exit_code}; expected ${expectedCodes.join(' or ')}`,
      `Inspect the command transcript for ${commandRecord.name} and fix the local Symphony command path.`
    );
  }
}

function summarizeDoctorFinding(finding) {
  if (!finding || typeof finding !== 'object') {
    return null;
  }
  return {
    id: finding.id ?? null,
    code: finding.code ?? null,
    severity: finding.severity ?? null,
    check_status: finding.checkStatus ?? null,
    message: finding.message ?? null,
    source_category: finding.source?.category ?? null,
    remediation: finding.remediationInfo?.guidance ?? finding.safeFix?.command ?? null
  };
}

function summarizeDoctorPayload(payload, commandRecord) {
  const findings = Array.isArray(payload.findings) ? payload.findings : [];
  const blockers = findings.filter((finding) => finding?.severity === 'blocker');
  const warnings = findings.filter((finding) => finding?.severity === 'warning');
  return {
    status: payload.status ?? null,
    reason: payload.reason ?? null,
    exit_code: payload.exitCode ?? commandRecord.exit_code,
    command_exit_code: commandRecord.exit_code,
    exit_semantics: payload.exitSemantics ?? null,
    workflow_path: payload.resolution?.workflowPath ?? null,
    project_root: payload.resolution?.projectRoot ?? null,
    resolution: {
      project_root: payload.resolution?.projectRoot ?? null,
      workflow_path: payload.resolution?.workflowPath ?? null,
      env_file_path: payload.resolution?.envFilePath ?? null,
      host: payload.resolution?.host ?? null,
      port: payload.resolution?.port ?? null,
      consent: payload.resolution?.consent ?? null
    },
    finding_counts: {
      total: findings.length,
      blockers: blockers.length,
      warnings: warnings.length
    },
    findings: findings.map(summarizeDoctorFinding).filter(Boolean).slice(0, 20)
  };
}

function parseDoctorJson(lane, commandRecord, { classifyNonReady = false } = {}) {
  if (!commandRecord._rawStdout) {
    addFinding(
      lane,
      'implementation_defect',
      'blocker',
      'Doctor JSON output was empty.',
      'Fix doctor --json output before accepting this lane.'
    );
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(commandRecord._rawStdout);
  } catch {
    addFinding(lane, 'implementation_defect', 'blocker', 'Doctor JSON output was not parseable.', 'Fix doctor --json output.');
    return null;
  }

  const summary = summarizeDoctorPayload(payload, commandRecord);
  lane.doctor = summary;

  if (!classifyNonReady) {
    return summary;
  }

  if (summary.status === 'failure' || summary.reason === 'blockers_present' || summary.finding_counts.blockers > 0 || commandRecord.exit_code === 2) {
    const remediation = summary.findings.find((finding) => finding.remediation)?.remediation || 'Run `symphony doctor --json --ci` in this project root and resolve the reported blockers before counting this lane as passed.';
    addFinding(
      lane,
      'environment_prerequisite',
      'blocker',
      `Doctor reported blockers for this real project: ${summary.reason || 'blockers_present'}.`,
      remediation
    );
    return summary;
  }

  if (summary.status === 'warning' || summary.reason === 'warnings_present' || summary.finding_counts.warnings > 0 || commandRecord.exit_code === 1) {
    const remediation = summary.findings.find((finding) => finding.remediation)?.remediation || 'Review `symphony doctor --json --ci` warnings before using this lane as clean evidence.';
    addFinding(
      lane,
      'product_friction',
      'warning',
      `Doctor reported non-blocking warnings for this real project: ${summary.reason || 'warnings_present'}.`,
      remediation
    );
  }

  return summary;
}

async function waitForDashboardUrl(child, lane, env, timeoutMs) {
  const startedAt = Date.now();
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  return await new Promise((resolve) => {
    const timer = setInterval(() => {
      const match = stdout.match(/Symphony dashboard running at (http:\/\/[^\s/]+:\d+\/)/);
      if (match) {
        clearInterval(timer);
        resolve({ ok: true, url: match[1], stdout, stderr });
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        resolve({ ok: false, url: null, stdout, stderr });
      }
    }, 100);
  });
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { parse_error: text.slice(0, 500) };
  }
  return { ok: response.ok, status: response.status, body };
}

async function postJson(url, payload = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { parse_error: text.slice(0, 500) };
  }
  return { ok: response.ok, status: response.status, body };
}

async function waitForDashboardExit(child, timeoutMs = 30_000, options = {}) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { clean: child.exitCode === 0, exit_code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (options.killOnTimeout) {
        child.kill('SIGKILL');
        resolve({ clean: false, exit_code: null, signal: 'SIGKILL' });
        return;
      }
      resolve({ clean: false, exit_code: null, signal: null, timed_out: true });
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ clean: code === 0, exit_code: code, signal: signal || null });
    });
  });
}

async function stopDashboard(child, url) {
  if (url) {
    try {
      const response = await fetch(`${url.replace(/\/$/, '')}/api/v1/drain-mode/shutdown`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ override: true })
      });
      const body = await response.json().catch(() => null);
      let exit = await waitForDashboardExit(child, 2_000, { killOnTimeout: false });
      let settlement = 'api_shutdown';
      if (exit.timed_out) {
        settlement = 'api_shutdown_then_sigterm';
        child.kill('SIGTERM');
        exit = await waitForDashboardExit(child, 10_000, { killOnTimeout: true });
      }
      const expectedSignalExit = exit.exit_code === 143 || exit.signal === 'SIGTERM';
      return {
        clean: response.status === 202 && (exit.clean || expectedSignalExit),
        exit_code: exit.exit_code,
        signal: exit.signal,
        settlement,
        api_status: response.status,
        api_response: body
      };
    } catch (error) {
      const exit = await waitForDashboardExit(child);
      return {
        clean: false,
        exit_code: exit.exit_code,
        signal: exit.signal,
        api_status: null,
        api_error: error instanceof Error ? error.message : String(error)
      };
    }
  }
  child.kill('SIGTERM');
  return waitForDashboardExit(child, 10_000, { killOnTimeout: true });
}

async function runDashboardProof(lane, operator, projectRoot, workflowPath, env, options = {}) {
  if (options.noDashboard) {
    lane.dashboard = {
      status: 'skipped',
      reason: 'intentional_out_of_scope',
      remediation: 'Rerun without --no-dashboard for acceptance evidence.'
    };
    addFinding(
      lane,
      'intentional_out_of_scope',
      'warning',
      'Dashboard proof was skipped by operator request.',
      'Rerun without --no-dashboard before counting dashboard acceptance.'
    );
    return;
  }

  const args = [
    ...operator.argsPrefix,
    'dashboard',
    '--workflow',
    workflowPath,
    '--port',
    '0',
    '--offline'
  ];
  const child = spawn(operator.command, args, {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const started = await waitForDashboardUrl(child, lane, env, DASHBOARD_TIMEOUT_MS);
  const dashboard = {
    status: started.ok ? 'bound' : 'failed_to_bind',
    url: started.url,
    api_urls: {},
    health: null,
    diagnostics: null,
    project_identity_match: false,
    shutdown: null,
    stdout: summarizeTranscript(started.stdout, env),
    stderr: summarizeTranscript(started.stderr, env)
  };
  lane.dashboard = dashboard;

  if (!started.ok || !started.url) {
    addFinding(
      lane,
      'implementation_defect',
      'blocker',
      'Dashboard did not report a bound local API URL within the timeout.',
      'Inspect dashboard stdout/stderr and fix startup before accepting this lane.'
    );
    dashboard.shutdown = await stopDashboard(child, null);
    return;
  }

  const baseUrl = started.url.replace(/\/$/, '');
  dashboard.api_urls.state = `${baseUrl}/api/v1/state`;
  dashboard.api_urls.diagnostics = `${baseUrl}/api/v1/diagnostics`;
  dashboard.health = await fetchJson(dashboard.api_urls.state);
  dashboard.diagnostics = await fetchJson(dashboard.api_urls.diagnostics);

  const runtimeResolution = dashboard.diagnostics.body?.runtime_resolution;
  const resolvedWorkflow = runtimeResolution?.workflow_path ? realpathIfExists(runtimeResolution.workflow_path) : null;
  const resolvedRoot = runtimeResolution?.workflow_dir ? realpathIfExists(runtimeResolution.workflow_dir) : null;
  dashboard.project_identity_match =
    dashboard.health.ok === true &&
    dashboard.diagnostics.ok === true &&
    resolvedWorkflow === realpathIfExists(workflowPath) &&
    resolvedRoot === realpathIfExists(projectRoot);
  dashboard.project_identity = {
    expected_project_root: realpathIfExists(projectRoot),
    expected_workflow_path: realpathIfExists(workflowPath),
    reported_workflow_path: resolvedWorkflow,
    reported_workflow_dir: resolvedRoot
  };
  dashboard.shutdown = await stopDashboard(child, started.url);

  if (!dashboard.health.ok || !dashboard.diagnostics.ok) {
    addFinding(
      lane,
      'implementation_defect',
      'blocker',
      'Dashboard bound but health/state or diagnostics API probes failed.',
      'Fix the local API probe failure before accepting this lane.'
    );
  }
  if (!dashboard.project_identity_match) {
    addFinding(
      lane,
      'implementation_defect',
      'blocker',
      'Dashboard Project Identity did not match the target project root/workflow.',
      'Verify workflow resolution and runtime diagnostics before accepting this lane.'
    );
  }
  if (!dashboard.shutdown.clean) {
    addFinding(
      lane,
      'implementation_defect',
      'blocker',
      'Dashboard process did not shut down cleanly after API shutdown.',
      'Inspect runtime shutdown handling and supervisor logs.'
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchLinearIssueEvidence(env, issueIdentifier) {
  const apiKey = env.LINEAR_API_KEY || env.LINEAR_AUTH_TOKEN;
  if (!apiKey || !issueIdentifier) {
    return { ok: false, reason: 'missing_linear_api_key_or_issue_identifier' };
  }
  const query = `
    query HostedTrialIssue($id: String!) {
      issue(id: $id) {
        id
        identifier
        title
        url
        branchName
        state { name type }
        attachments { nodes { title url } }
      }
    }
  `;
  try {
    const response = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: apiKey
      },
      body: JSON.stringify({ query, variables: { id: issueIdentifier } })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.errors) {
      return {
        ok: false,
        status: response.status,
        errors: Array.isArray(payload?.errors) ? payload.errors.map((error) => error.message).slice(0, 5) : []
      };
    }
    return { ok: Boolean(payload?.data?.issue), issue: payload?.data?.issue ?? null };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function runGitJson(projectRoot, args) {
  const result = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
  return {
    exit_code: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim()
  };
}

function readBranchEvidence(projectRoot, branchName) {
  if (!branchName) {
    return { branch_name: null, local_present: false, commit_sha: null, pushed: false };
  }
  const local = runGitJson(projectRoot, ['rev-parse', '--verify', branchName]);
  const remote = runGitJson(projectRoot, ['ls-remote', '--heads', 'origin', branchName]);
  return {
    branch_name: branchName,
    local_present: local.exit_code === 0,
    commit_sha: local.exit_code === 0 ? local.stdout : null,
    pushed: remote.exit_code === 0 && remote.stdout.length > 0,
    remote_ref: remote.stdout || null,
    errors: {
      local: local.exit_code === 0 ? null : local.stderr || local.stdout || 'branch not found',
      remote: remote.exit_code === 0 ? null : remote.stderr || 'ls-remote failed'
    }
  };
}

function readPullRequestEvidence(config, branchName) {
  if (!config.githubOwner || !config.githubRepo) {
    return { ok: false, reason: 'missing_github_owner_or_repo' };
  }
  const result = spawnSync(
    'gh',
    [
      'pr',
      'list',
      '--repo',
      `${config.githubOwner}/${config.githubRepo}`,
      '--head',
      branchName,
      '--state',
      'all',
      '--json',
      'url,state,headRefName,headRefOid,number,title'
    ],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    return { ok: false, exit_code: result.status, stderr: (result.stderr || '').trim() };
  }
  let prs = [];
  try {
    prs = JSON.parse(result.stdout || '[]');
  } catch {
    return { ok: false, reason: 'gh_pr_json_parse_failed', stdout: (result.stdout || '').slice(0, 500) };
  }
  const pr = prs[0] ?? null;
  return {
    ok: Boolean(pr?.url),
    pr_url: pr?.url ?? null,
    state: pr?.state ?? null,
    head_ref: pr?.headRefName ?? null,
    head_sha: pr?.headRefOid ?? null,
    number: pr?.number ?? null,
    title: pr?.title ?? null
  };
}

function firstProjectHistoryKey(historyPayload, fallbackProjectRoot) {
  const runs = Array.isArray(historyPayload?.runs) ? historyPayload.runs : [];
  for (const run of runs) {
    const key =
      run?.identity?.project_key ||
      run?.project_key ||
      run?.project_identity?.key ||
      run?.project_identity?.project_key ||
      null;
    if (key) {
      return key;
    }
  }
  return fallbackProjectRoot ? realpathIfExists(fallbackProjectRoot) : null;
}

function historyContainsIssue(payload, issueIdentifier) {
  if (!payload || !issueIdentifier) {
    return false;
  }
  return JSON.stringify(payload).includes(issueIdentifier);
}

async function runHostedIssueRunProof(lane, operator, projectRoot, workflowPath, env, config, options = {}) {
  const args = [...operator.argsPrefix, 'dashboard', '--workflow', workflowPath, '--port', '0'];
  const child = spawn(operator.command, args, {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const started = await waitForDashboardUrl(child, lane, env, DASHBOARD_TIMEOUT_MS);
  const proof = {
    status: started.ok ? 'running' : 'failed_to_bind',
    url: started.url,
    issue_identifier: config.linearIssueId,
    branch_name: config.linearIssueId ? `feature/${config.linearIssueId}` : null,
    state_samples: [],
    issue_detail_samples: [],
    history_samples: [],
    project_history: null,
    linear_issue: null,
    branch: null,
    pull_request: null,
    dashboard_shutdown: null
  };
  lane.issue_run = proof;

  if (!started.ok || !started.url) {
    proof.dashboard_shutdown = await stopDashboard(child, null);
    addFinding(
      lane,
      'implementation_defect',
      'blocker',
      'Hosted issue-run dashboard did not bind before dispatch proof.',
      'Inspect hosted issue-run dashboard stdout/stderr and fix runtime startup.'
    );
    return proof;
  }

  const baseUrl = started.url.replace(/\/$/, '');
  proof.dashboard = {
    status: 'bound',
    url: started.url,
    state_url: `${baseUrl}/api/v1/state`,
    issue_url: `${baseUrl}/api/v1/issues/${encodeURIComponent(config.linearIssueId)}`,
    history_url: `${baseUrl}/api/v1/history?limit=50`
  };

  const deadline = Date.now() + (options.hostedIssueRunTimeoutMs ?? HOSTED_ISSUE_RUN_TIMEOUT_MS);
  let completed = false;
  while (Date.now() < deadline) {
    await postJson(`${baseUrl}/api/v1/refresh`, { source: 'local-multi-project-trial' }).catch(() => null);
    const state = await fetchJson(proof.dashboard.state_url).catch((error) => ({ ok: false, error: String(error) }));
    const issue = await fetchJson(proof.dashboard.issue_url).catch((error) => ({ ok: false, error: String(error) }));
    const history = await fetchJson(proof.dashboard.history_url).catch((error) => ({ ok: false, error: String(error) }));
    proof.state_samples.push({ at: isoNow(), ok: state.ok, status: state.status, body: state.body ?? state.error ?? null });
    proof.issue_detail_samples.push({ at: isoNow(), ok: issue.ok, status: issue.status, body: issue.body ?? issue.error ?? null });
    proof.history_samples.push({ at: isoNow(), ok: history.ok, status: history.status, body: history.body ?? history.error ?? null });

    proof.linear_issue = await fetchLinearIssueEvidence(env, config.linearIssueId);
    proof.branch = readBranchEvidence(projectRoot, proof.branch_name);
    proof.pull_request = readPullRequestEvidence(config, proof.branch_name);

    const projectKey = firstProjectHistoryKey(history.body, projectRoot);
    if (projectKey) {
      const listUrl = `${baseUrl}/api/v1/projects/${encodeURIComponent(projectKey)}/history/tickets?limit=50`;
      const detailUrl = `${baseUrl}/api/v1/projects/${encodeURIComponent(projectKey)}/history/tickets/${encodeURIComponent(config.linearIssueId)}`;
      const healthUrl = `${baseUrl}/api/v1/projects/${encodeURIComponent(projectKey)}/history/health`;
      proof.project_history = {
        project_key: projectKey,
        list: await fetchJson(listUrl).catch((error) => ({ ok: false, error: String(error) })),
        detail: await fetchJson(detailUrl).catch((error) => ({ ok: false, error: String(error) })),
        health: await fetchJson(healthUrl).catch((error) => ({ ok: false, error: String(error) }))
      };
    }

    const finalState = proof.linear_issue?.issue?.state?.name ?? null;
    const finalStateInactive = finalState && !['Todo', 'In Progress'].includes(finalState);
    const hasHistory =
      historyContainsIssue(history.body, config.linearIssueId) ||
      historyContainsIssue(proof.project_history?.list?.body, config.linearIssueId) ||
      historyContainsIssue(proof.project_history?.detail?.body, config.linearIssueId);
    if (finalStateInactive && proof.branch?.commit_sha && proof.branch?.pushed && proof.pull_request?.pr_url && hasHistory) {
      completed = true;
      break;
    }

    await sleep(options.hostedIssueRunPollMs ?? HOSTED_ISSUE_RUN_POLL_MS);
  }

  proof.status = completed ? 'passed' : 'blocked';
  proof.dashboard_shutdown = await stopDashboard(child, started.url);
  if (!completed) {
    addFinding(
      lane,
      'environment_prerequisite',
      'blocker',
      'Hosted issue-run did not produce the required external-project evidence before timeout.',
      'Inspect lane.issue_run for final Linear state, dashboard state, branch, PR, and Project Execution History samples; rerun after resolving the missing hosted-runtime prerequisite.'
    );
  }
  return proof;
}

function createSyntheticProject(tempRoot, name) {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, `${name}-`)));
  fs.writeFileSync(path.join(projectRoot, 'WORKFLOW.md'), workflow(`Local trial ${name}`));
  fs.writeFileSync(path.join(projectRoot, '.gitignore'), '.symphony/system/\n');
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  return projectRoot;
}

function makeBaseEnv(env, tempRoot) {
  const homeDir = path.join(tempRoot, 'home');
  const stateHome = path.join(tempRoot, 'state');
  ensureDir(homeDir);
  ensureDir(stateHome);
  const next = {
    ...env,
    HOME: homeDir,
    SYMPHONY_LOCAL_STATE_HOME: stateHome,
    SYMPHONY_USER_STATE_DIR: stateHome
  };
  delete next.SYMPHONY_WORKFLOW_PATH;
  delete next.SYMPHONY_PORT;
  delete next.SYMPHONY_HOST;
  delete next.SYMPHONY_ENV_FILE;
  return next;
}

function installFallbackShim(env, repoRoot, tempRoot) {
  const binDir = path.join(tempRoot, 'bin');
  ensureDir(binDir);
  const shimPath = path.join(binDir, 'symphony');
  const entrypoint = path.join(repoRoot, 'scripts', 'symphony.js');
  fs.writeFileSync(
    shimPath,
    [
      '#!/usr/bin/env bash',
      '# symphony-local-shim',
      '# symphony-shim-version: 1',
      `# symphony-repo-root: ${repoRoot}`,
      `# symphony-entrypoint: ${entrypoint}`,
      'set -euo pipefail',
      `exec /usr/bin/env node '${entrypoint}' "$@"`,
      ''
    ].join('\n'),
    { mode: 0o755 }
  );
  return {
    ...env,
    PATH: `${binDir}${path.delimiter}${env.PATH || ''}`
  };
}

async function runBaselineLane(report, operator, env, tempRoot, options) {
  const projectRoot = createSyntheticProject(tempRoot, 'baseline-memory');
  const workflowPath = path.join(projectRoot, 'WORKFLOW.md');
  const lane = buildLane('synthetic-memory-baseline', 'Synthetic memory baseline', 'synthetic-memory-project', projectRoot, true);
  lane.workflow_source = summarizeWorkflowFile(workflowPath);
  lane.tracker_identifiers.push({ kind: 'memory', present: true });

  appendCommand(lane, runCommand(operator.command, [...operator.argsPrefix, '--version'], { name: 'command availability', cwd: projectRoot, env }));
  appendCommand(lane, runCommand(operator.command, [...operator.argsPrefix, 'profile', 'list'], { name: 'profile discovery', cwd: projectRoot, env }));
  appendCommand(
    lane,
    runCommand(operator.command, [...operator.argsPrefix, 'init', '--dry-run', '--bundle', 'memory-generic', '--no-input'], {
      name: 'init dry-run',
      cwd: fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, 'init-dry-run-'))),
      env
    })
  );
  appendCommand(lane, runCommand(operator.command, [...operator.argsPrefix, 'setup', '--yes'], { name: 'setup consent', cwd: projectRoot, env }));
  const doctor = runCommand(operator.command, [...operator.argsPrefix, 'doctor', '--json', '--ci'], {
    name: 'doctor JSON',
    cwd: projectRoot,
    env
  });
  appendCommand(lane, doctor);
  parseDoctorJson(lane, doctor);

  await runDashboardProof(lane, operator, projectRoot, workflowPath, env, options);
  lane.generated_files = summarizeGeneratedFiles(projectRoot);
  lane.status = laneStatus(lane);
  report.lanes.push(lane);
}

async function runGeneratedLinearNodeLane(report, operator, env, tempRoot, options) {
  const { projectRoot, remoteRoot } = createGeneratedNodeProject(tempRoot, 'generated-linear-node');
  const workflowPath = path.join(projectRoot, 'WORKFLOW.md');
  const lane = buildLane('generated-linear-node-setup', 'Generated Linear/Node setup', 'generated-linear-node', projectRoot, true);
  lane.counts_for_external_project_evidence = false;
  lane.synthetic_reason = 'fresh temporary project proves generated setup path without hosted tracker mutation';
  lane.tracker_identifiers.push({ kind: 'linear', project_slug: GENERATED_LINEAR_NODE_SLUG, hosted: false });
  lane.disposable_remote = {
    kind: 'local-bare-git',
    path: remoteRoot,
    purpose: 'origin/main support for generated worktree workflow validation'
  };

  const initArgs = ['init', '--bundle', 'linear-node', '--linear-project-slug', GENERATED_LINEAR_NODE_SLUG, '--no-input'];
  const dryRun = runCommand(operator.command, [...operator.argsPrefix, ...initArgs, '--dry-run'], {
    name: 'linear-node init dry-run',
    cwd: projectRoot,
    env
  });
  appendCommand(lane, dryRun);
  lane.init_dry_run_plan = {
    files: parseInitFilePlan(dryRun._rawStdout),
    validation_ok: /Validation:\s+ok/.test(dryRun._rawStdout)
  };

  const initWrite = runCommand(operator.command, [...operator.argsPrefix, ...initArgs], {
    name: 'linear-node init write',
    cwd: projectRoot,
    env
  });
  appendCommand(lane, initWrite);
  lane.init_write_plan = {
    files: parseInitFilePlan(initWrite._rawStdout),
    validation_ok: /Validation:\s+ok/.test(initWrite._rawStdout)
  };

  const dryRunPaths = lane.init_dry_run_plan.files.map((file) => file.path).sort();
  const writePaths = lane.init_write_plan.files.map((file) => file.path).sort();
  lane.init_file_plan_match = JSON.stringify(dryRunPaths) === JSON.stringify(writePaths) && dryRunPaths.length > 0;
  if (!lane.init_file_plan_match) {
    addFinding(
      lane,
      'implementation_defect',
      'blocker',
      'Linear/Node init write file plan did not match the dry-run file plan.',
      'Keep init dry-run and write materialization plans aligned before accepting generated setup evidence.'
    );
  }
  if (!lane.init_dry_run_plan.validation_ok || !lane.init_write_plan.validation_ok) {
    addFinding(
      lane,
      'implementation_defect',
      'blocker',
      'Linear/Node generated workflow did not validate during init.',
      'Fix generated workflow validation before accepting generated setup evidence.'
    );
  }

  lane.init_commit = commitProjectChanges(projectRoot, 'Add generated Symphony Linear Node workflow');
  if (!lane.init_commit.ok) {
    addFinding(
      lane,
      'implementation_defect',
      'blocker',
      'Generated Linear/Node init files could not be committed before doctor readiness.',
      'Inspect lane.init_commit and ensure the generated project can become clean before workspace provisioning.'
    );
  }
  lane.setup_side_effects = {
    package_lock_after_setup: false,
    classification: 'expected_clean_generated_workflow',
    note: 'The generated setup lane commits intended init files before doctor; no setup-generated lockfile is expected before workspace hooks run.'
  };

  lane.workflow_source = summarizeWorkflowFile(workflowPath);
  lane.generated_workflow_checks = readWorkflowChecks(workflowPath, GENERATED_LINEAR_NODE_SLUG);
  if (!lane.generated_workflow_checks.ok) {
    addFinding(
      lane,
      'implementation_defect',
      'blocker',
      'Generated Linear/Node WORKFLOW.md failed provenance, Node command, tracker, or lifecycle-state checks.',
      'Inspect lane.generated_workflow_checks and update profile materialization or trial assertions.'
    );
  }

  appendCommand(lane, runCommand('npm', ['test'], { name: 'generated project test command', cwd: projectRoot, env }));
  appendCommand(lane, runCommand(operator.command, [...operator.argsPrefix, 'setup', '--yes'], { name: 'setup consent', cwd: projectRoot, env }));
  lane.git_status_after_setup = summarizeGitStatus(projectRoot);
  if (!lane.git_status_after_setup.clean) {
    addFinding(
      lane,
      'product_friction',
      'warning',
      'Generated project setup left local checkout changes after intended init files were committed.',
      'Inspect lane.git_status_after_setup; classify expected hook side effects or adjust setup behavior.'
    );
  }
  const doctor = runCommand(operator.command, [...operator.argsPrefix, 'doctor', '--json', '--ci'], {
    name: 'doctor JSON',
    cwd: projectRoot,
    env
  });
  appendCommand(lane, doctor, [0, 1, 2]);
  parseDoctorJson(lane, doctor, { classifyNonReady: true });
  await runDashboardProof(lane, operator, projectRoot, workflowPath, env, options);
  lane.generated_files = summarizeGeneratedFiles(projectRoot);
  lane.status = laneStatus(lane);
  report.lanes.push(lane);
}

function getHostedConfig(env, options) {
  return {
    linearProjectSlug: options.hostedLinearProjectSlug || env.SYMPHONY_TRIAL_LINEAR_PROJECT_SLUG || null,
    linearProjectDisposable:
      options.hostedLinearProjectDisposable === true ||
      ['1', 'true', 'yes'].includes(String(env.SYMPHONY_TRIAL_LINEAR_PROJECT_DISPOSABLE || '').toLowerCase()),
    linearIssueId: options.hostedLinearIssueId || env.SYMPHONY_TRIAL_LINEAR_ISSUE_ID || null,
    githubOwner: options.hostedGithubOwner || env.SYMPHONY_TRIAL_GITHUB_OWNER || null,
    githubRepo: options.hostedGithubRepo || env.SYMPHONY_TRIAL_GITHUB_REPO || null,
    githubRemoteUrl: options.hostedGithubRemoteUrl || env.SYMPHONY_TRIAL_GITHUB_REMOTE_URL || null
  };
}

function addHostedPrerequisiteFinding(lane, summary, remediation) {
  addFinding(lane, 'environment_prerequisite', 'blocker', summary, remediation);
}

async function runHostedLinearNodeIssueLane(report, operator, env, tempRoot, options) {
  const config = getHostedConfig(env, options);
  const lane = buildLane('hosted-linear-node-issue-run', 'Hosted Linear/Node issue run', 'hosted-generated-linear-node', null, false);
  lane.counts_for_external_project_evidence = true;
  lane.hosted_resources = summarizeHostedResources(env, options);
  lane.tracker_identifiers = [
    { kind: 'linear', project_slug: config.linearProjectSlug, issue_id: config.linearIssueId, hosted: true },
    { kind: 'github', owner: config.githubOwner, repo: config.githubRepo, remote_url_present: Boolean(config.githubRemoteUrl), hosted: true }
  ];

  const missing = [];
  if (!options.hostedCredentials) {
    missing.push({
      name: '--with-hosted-credentials',
      remediation: 'Rerun with --with-hosted-credentials to make hosted mutation explicit.'
    });
  }
  if (!env.LINEAR_API_KEY && !env.LINEAR_AUTH_TOKEN) {
    missing.push({ name: 'LINEAR_API_KEY or LINEAR_AUTH_TOKEN', remediation: 'Export a Linear API token for a disposable trial project.' });
  }
  if (!env.GITHUB_TOKEN && !env.GH_TOKEN) {
    missing.push({ name: 'GITHUB_TOKEN or GH_TOKEN', remediation: 'Export a GitHub token scoped to a disposable trial repository.' });
  }
  if (!config.linearProjectSlug) {
    missing.push({
      name: 'hosted Linear project slug',
      remediation: 'Pass --hosted-linear-project-slug or set SYMPHONY_TRIAL_LINEAR_PROJECT_SLUG for a disposable project.'
    });
  }
  if (!config.linearProjectDisposable) {
    missing.push({
      name: 'isolated disposable Linear project acknowledgement',
      remediation:
        'Use a Linear project dedicated to this hosted trial and pass --hosted-linear-project-disposable or set SYMPHONY_TRIAL_LINEAR_PROJECT_DISPOSABLE=1. A clearly named issue inside an active real project is not isolated enough because existing Symphony runtimes may dispatch unrelated active issues.'
    });
  }
  if (!config.linearIssueId) {
    missing.push({
      name: 'hosted Linear issue id',
      remediation: 'Pass --hosted-linear-issue-id or set SYMPHONY_TRIAL_LINEAR_ISSUE_ID for a clearly named disposable issue.'
    });
  }
  if (!config.githubOwner) {
    missing.push({
      name: 'hosted GitHub owner',
      remediation: 'Pass --hosted-github-owner or set SYMPHONY_TRIAL_GITHUB_OWNER for a disposable repository.'
    });
  }
  if (!config.githubRepo) {
    missing.push({
      name: 'hosted GitHub repository',
      remediation: 'Pass --hosted-github-repo or set SYMPHONY_TRIAL_GITHUB_REPO for a disposable repository.'
    });
  }
  if (!config.githubRemoteUrl) {
    missing.push({
      name: 'hosted GitHub remote URL',
      remediation: 'Pass --hosted-github-remote-url or set SYMPHONY_TRIAL_GITHUB_REMOTE_URL for the disposable repository.'
    });
  }

  if (missing.length > 0) {
    lane.project_root = null;
    lane.hosted_prerequisites = { status: 'blocked', missing };
    for (const item of missing) {
      addHostedPrerequisiteFinding(lane, `Missing hosted issue-run prerequisite: ${item.name}.`, item.remediation);
    }
    lane.status = laneStatus(lane);
    report.lanes.push(lane);
    return;
  }

  const { projectRoot } = createGeneratedNodeProject(tempRoot, 'hosted-linear-node');
  lane.project_root = projectRoot;
  const workflowPath = path.join(projectRoot, 'WORKFLOW.md');
  spawnSync('git', ['remote', 'set-url', 'origin', config.githubRemoteUrl], { cwd: projectRoot, encoding: 'utf8' });
  const initArgs = ['init', '--bundle', 'linear-node', '--linear-project-slug', config.linearProjectSlug, '--no-input'];
  appendCommand(
    lane,
    runCommand(operator.command, [...operator.argsPrefix, ...initArgs, '--dry-run'], {
      name: 'hosted linear-node init dry-run',
      cwd: projectRoot,
      env
    })
  );
  appendCommand(lane, runCommand(operator.command, [...operator.argsPrefix, ...initArgs], { name: 'hosted linear-node init write', cwd: projectRoot, env }));
  lane.init_commit = commitProjectChanges(projectRoot, 'Add generated Symphony Linear Node workflow');
  if (!lane.init_commit.ok) {
    addFinding(
      lane,
      'implementation_defect',
      'blocker',
      'Hosted Linear/Node init files could not be committed before doctor readiness.',
      'Inspect lane.init_commit and ensure the hosted generated project can become clean before workspace provisioning.'
    );
  }
  appendCommand(lane, runCommand(operator.command, [...operator.argsPrefix, 'setup', '--yes'], { name: 'hosted setup consent', cwd: projectRoot, env }));
  const doctor = runCommand(operator.command, [...operator.argsPrefix, 'doctor', '--json', '--ci'], {
    name: 'hosted doctor JSON',
    cwd: projectRoot,
    env
  });
  appendCommand(lane, doctor, [0, 1, 2]);
  parseDoctorJson(lane, doctor, { classifyNonReady: true });
  if (!lane.findings.some((finding) => finding.severity === 'blocker')) {
    await runHostedIssueRunProof(lane, operator, projectRoot, workflowPath, env, config, options);
  } else {
    lane.issue_run = {
      status: 'blocked',
      reason: 'hosted_project_not_ready_for_dispatch',
      expected_evidence: [
        'tracker ticket final state',
        'workspace path',
        'branch name',
        'commit SHA',
        'pushed branch proof',
        'PR URL',
        'dashboard/API issue evidence',
        'Project Execution History evidence'
      ]
    };
  }
  lane.workflow_source = summarizeWorkflowFile(workflowPath);
  lane.generated_files = summarizeGeneratedFiles(projectRoot);
  lane.status = laneStatus(lane);
  report.lanes.push(lane);
}

async function runRealProjectLane(report, operator, env, rootSpec, index, options) {
  const projectRoot = path.resolve(rootSpec.path);
  const lane = buildLane(`real-project-${index + 1}`, `Real local project ${index + 1}`, rootSpec.shape, projectRoot, false);
  if (!fs.existsSync(projectRoot)) {
    addFinding(
      lane,
      'environment_prerequisite',
      'blocker',
      `Required project root is missing: ${projectRoot}`,
      `Create or mount ${projectRoot}, or remove this root from the trial command.`
    );
    lane.status = laneStatus(lane);
    report.lanes.push(lane);
    return;
  }

  const workflowPath = path.join(projectRoot, 'WORKFLOW.md');
  lane.workflow_source = summarizeWorkflowFile(workflowPath);
  if (!lane.workflow_source) {
    addFinding(
      lane,
      'environment_prerequisite',
      'blocker',
      `Project root has no WORKFLOW.md: ${projectRoot}`,
      'Add a WORKFLOW.md or run the init lane for this project before dashboard acceptance.'
    );
    lane.status = laneStatus(lane);
    report.lanes.push(lane);
    return;
  }

  const doctor = runCommand(operator.command, [...operator.argsPrefix, 'doctor', '--json', '--ci'], {
    name: 'doctor JSON',
    cwd: projectRoot,
    env
  });
  appendCommand(lane, doctor, [0, 1, 2]);
  parseDoctorJson(lane, doctor, { classifyNonReady: true });
  await runDashboardProof(lane, operator, projectRoot, workflowPath, env, options);
  lane.generated_files = summarizeGeneratedFiles(projectRoot);
  lane.status = laneStatus(lane);
  report.lanes.push(lane);
}

function summarizeReport(report) {
  const summary = {
    status: 'passed',
    total_lanes: report.lanes.length,
    passed: 0,
    failed: 0,
    blocked: 0,
    passed_with_warnings: 0,
    findings_by_category: {
      implementation_defect: 0,
      product_friction: 0,
      environment_prerequisite: 0,
      intentional_out_of_scope: 0
    }
  };

  for (const lane of report.lanes) {
    if (lane.status === 'blocked') {
      summary.blocked += 1;
    } else if (lane.status === 'failed') {
      summary.failed += 1;
    } else if (lane.status === 'passed_with_warnings') {
      summary.passed_with_warnings += 1;
    } else if (lane.status === 'passed') {
      summary.passed += 1;
    }
    for (const finding of lane.findings) {
      summary.findings_by_category[finding.category] = (summary.findings_by_category[finding.category] || 0) + 1;
    }
  }

  if (summary.failed > 0) {
    summary.status = 'failed';
  } else if (summary.blocked > 0) {
    summary.status = 'blocked';
  } else if (summary.passed_with_warnings > 0) {
    summary.status = 'passed_with_warnings';
  }
  report.summary = summary;
}

async function runTrial(options = {}) {
  const repoRoot = realpathIfExists(options.repoRoot || path.resolve(__dirname, '..', '..'));
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-local-trial-')));
  let env = makeBaseEnv(options.env || process.env, tempRoot);
  const operator = options.operator || resolveOperatorCommand(repoRoot, env);
  if (operator.source === 'local-development-fallback') {
    env = installFallbackShim(env, repoRoot, tempRoot);
  }
  const reportPath = options.report
    ? path.resolve(options.report)
    : path.join(path.resolve(options.outputDir || path.join(repoRoot, 'output', 'local-multi-project-trial')), `trial-report-${Date.now()}.json`);
  const report = {
    version: 1,
    trial: 'local_multi_project',
    generated_at: isoNow(),
    repo_root: repoRoot,
    command: {
      source: operator.source,
      executable: operator.command,
      args_prefix: operator.argsPrefix,
      required_build_artifact: operator.buildArtifact,
      fallback_entrypoint: operator.fallbackEntrypoint,
      linked_shim: operator.linkedShim ?? null
    },
    environment: summarizeEnv(env),
    environment_handling: {
      symphony_resolution_env_cleared: ['SYMPHONY_WORKFLOW_PATH', 'SYMPHONY_PORT', 'SYMPHONY_HOST', 'SYMPHONY_ENV_FILE'],
      symphony_env_recorded: true,
      hosted_resource_env_recorded: HOSTED_RESOURCE_ENV_KEYS
    },
    hosted_resources: summarizeHostedResources(env, options),
    hosted_credentials_requested: Boolean(options.hostedCredentials),
    lanes: [],
    summary: null
  };

  if (!fs.existsSync(operator.buildArtifact)) {
    const lane = buildLane('preflight', 'Preflight', 'symphony-checkout', repoRoot, false);
    addFinding(
      lane,
      'environment_prerequisite',
      'blocker',
      `Required build artifact is missing: ${operator.buildArtifact}`,
      'Run `npm run build` from the Symphony checkout, then rerun the trial harness.'
    );
    lane.status = laneStatus(lane);
    report.lanes.push(lane);
    summarizeReport(report);
    ensureDir(path.dirname(reportPath));
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    return { report, reportPath };
  }

  if (spawnSync('git', ['--version'], { encoding: 'utf8' }).status !== 0) {
    const lane = buildLane('preflight', 'Preflight', 'symphony-checkout', repoRoot, false);
    addFinding(lane, 'environment_prerequisite', 'blocker', 'git is unavailable on PATH.', 'Install git and rerun the trial harness.');
    lane.status = laneStatus(lane);
    report.lanes.push(lane);
  } else {
    await runBaselineLane(report, operator, env, tempRoot, options);
    await runGeneratedLinearNodeLane(report, operator, env, tempRoot, options);
    if (
      options.hostedCredentials ||
      options.hostedLinearProjectSlug ||
      options.hostedLinearIssueId ||
      options.hostedGithubOwner ||
      options.hostedGithubRepo ||
      options.hostedGithubRemoteUrl
    ) {
      await runHostedLinearNodeIssueLane(report, operator, env, tempRoot, options);
    }
    const roots = [...(options.projectRoots || []), ...(options.requiredProjectRoots || [])];
    for (let index = 0; index < roots.length; index += 1) {
      await runRealProjectLane(report, operator, env, roots[index], index, options);
    }
  }

  summarizeReport(report);
  ensureDir(path.dirname(reportPath));
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return { report, reportPath };
}

module.exports = {
  parseArgs,
  renderHelp,
  runTrial,
  summarizeEnv,
  summarizeReport,
  workflow
};
