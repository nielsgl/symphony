const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 60_000;
const DASHBOARD_TIMEOUT_MS = 90_000;
const SECRET_KEY_PATTERN = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE)/i;
const HOSTED_CREDENTIAL_KEYS = ['LINEAR_API_KEY', 'LINEAR_AUTH_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'];

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
  if (lane.findings.some((finding) => finding.severity === 'blocker' && finding.category === 'environment_prerequisite')) {
    return 'blocked';
  }
  if (lane.findings.some((finding) => finding.severity === 'blocker')) {
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
  const candidates = ['WORKFLOW.md', '.gitignore', '.symphony/system/runtime.sqlite'];
  return candidates.map((relativePath) => {
    const filePath = path.join(projectRoot, relativePath);
    return {
      path: relativePath,
      exists: fs.existsSync(filePath),
      bytes: fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? fs.statSync(filePath).size : null
    };
  });
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
  if (doctor.exit_code === 0 && doctor._rawStdout) {
    try {
      const payload = JSON.parse(doctor._rawStdout);
      lane.doctor = {
        status: payload.status,
        reason: payload.reason,
        exit_semantics: payload.exitSemantics,
        workflow_path: payload.resolution?.workflowPath ?? null,
        project_root: payload.resolution?.projectRoot ?? null
      };
    } catch {
      addFinding(lane, 'implementation_defect', 'blocker', 'Doctor JSON output was not parseable.', 'Fix doctor --json output.');
    }
  }

  await runDashboardProof(lane, operator, projectRoot, workflowPath, env, options);
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

  appendCommand(lane, runCommand(operator.command, [...operator.argsPrefix, 'doctor', '--json', '--ci'], {
    name: 'doctor JSON',
    cwd: projectRoot,
    env
  }), [0, 1, 2]);
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
