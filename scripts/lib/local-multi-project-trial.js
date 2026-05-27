const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
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
const PROJECT_RESOLUTION_SYMPHONY_KEYS = [
  'SYMPHONY_WORKFLOW_PATH',
  'SYMPHONY_PORT',
  'SYMPHONY_HOST',
  'SYMPHONY_ENV_FILE',
  'SYMPHONY_PROFILE'
];
const PACKAGE_METADATA_FILES = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'];
const INIT_FILE_CANDIDATES = [
  'WORKFLOW.md',
  '.gitignore',
  '.symphony/system/.gitignore',
  '.env.example',
  '.worktreeinclude',
  ...PACKAGE_METADATA_FILES
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
    syntheticProjectRoots: [],
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
    } else if (arg === '--synthetic-project-root') {
      options.syntheticProjectRoots.push({ path: readValue(), required: false, shape: options.projectShape || 'synthetic-existing-workflow' });
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
    '  --synthetic-project-root <path> Include a synthetic existing-workflow fixture',
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
    cleared_for_project_resolution: PROJECT_RESOLUTION_SYMPHONY_KEYS.map((name) => ({
      name,
      present: Boolean(env[name])
    })),
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

function summarizeLaneEnv(env) {
  const clearedAmbient = ['SYMPHONY_WORKFLOW_PATH', 'SYMPHONY_PORT', 'SYMPHONY_HOST', 'SYMPHONY_ENV_FILE', 'SYMPHONY_PROFILE'];
  return {
    ...summarizeEnv(env),
    cleared_or_unset: clearedAmbient.map((name) => ({
      name,
      cleared: !Object.prototype.hasOwnProperty.call(env, name)
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
    maxBuffer: 16 * 1024 * 1024,
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
  const candidates = [
    'WORKFLOW.md',
    '.gitignore',
    '.symphony/system/.gitignore',
    '.symphony/system',
    '.symphony/system/workspaces',
    '.symphony/system/logs',
    '.symphony/system/runtime.sqlite',
    '.symphony/skills',
    '.symphony/prompts',
    '.symphony/setup-consent.json',
    ...PACKAGE_METADATA_FILES
  ];
  return candidates.map((relativePath) => {
    const filePath = path.join(projectRoot, relativePath);
    const exists = fs.existsSync(filePath);
    return {
      path: relativePath,
      exists,
      kind: exists ? (fs.statSync(filePath).isDirectory() ? 'directory' : 'file') : null,
      bytes: exists && fs.statSync(filePath).isFile() ? fs.statSync(filePath).size : null
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
    environment: null,
    project_identity: null,
    setup_consent: null,
    layout: null,
    history_isolation: null,
    tracker_identifiers: [],
    status: 'blocked',
    findings: [],
    commands: [],
    generated_files: [],
    dashboard: null
  };
}

function stableHash(parts) {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part ?? '');
    hash.update('\0');
  }
  return hash.digest('hex');
}

function buildExpectedProjectIdentity(projectRoot, workflowPath) {
  const root = realpathIfExists(projectRoot);
  const workflow = realpathIfExists(workflowPath);
  return {
    key: stableHash(['project', root, workflow]),
    project_root: root,
    workflow_path: workflow
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
      profile: payload.resolution?.profile ?? null,
      host: payload.resolution?.host ?? null,
      port: payload.resolution?.port ?? null,
      consent: payload.resolution?.consent ?? null
    },
    layout: payload.layout
      ? {
          status: payload.layout.status ?? null,
          runtime_state_root: payload.layout.runtimeStateRoot?.path ?? null,
          runtime_owned_paths: Array.isArray(payload.layout.runtimeOwnedPaths)
            ? payload.layout.runtimeOwnedPaths.map((item) => item.path).filter(Boolean)
            : [],
          reserved_customization_paths: Array.isArray(payload.layout.reservedCustomizationPaths)
            ? payload.layout.reservedCustomizationPaths.map((item) => ({
                path: item.path,
                loaded_by_runtime: item.loadedByRuntime ?? null,
                exists: item.exists ?? null
              }))
            : [],
          ignore_status: payload.layout.ignoreAnalysis?.status ?? null,
          warnings: Array.isArray(payload.layout.warnings)
            ? payload.layout.warnings.map((warning) => ({
                code: warning.code,
                message: warning.message
              }))
            : []
        }
      : null,
    finding_counts: {
      total: findings.length,
      blockers: blockers.length,
      warnings: warnings.length
    },
    findings: findings.map(summarizeDoctorFinding).filter(Boolean).slice(0, 20)
  };
}

function findDoctorFinding(summary, id) {
  return summary?.findings?.find((finding) => finding.id === id) ?? null;
}

function summarizeExpectedLinearCredentialBlockers(summary) {
  const blockerFindings = (summary?.findings || []).filter((finding) => finding.severity === 'blocker');
  const expectedCredentialBlockers = [
    { id: 'workflow.effective_config', code: 'missing_tracker_api_key' },
    { id: 'env.required_variables', code: 'required_env_missing' },
    { id: 'tracker.credentials', code: 'linear_tracker_credentials_missing' }
  ];
  const expectedKeys = new Set(expectedCredentialBlockers.map((finding) => `${finding.id}:${finding.code}`));
  const foundKeys = new Set(blockerFindings.map((finding) => `${finding.id}:${finding.code}`));
  return {
    missing_credentials_expected_for_non_hosted_setup:
      blockerFindings.length > 0 && blockerFindings.every((finding) => expectedKeys.has(`${finding.id}:${finding.code}`)),
    expected_blockers_present: expectedCredentialBlockers.every((finding) =>
      foundKeys.has(`${finding.id}:${finding.code}`)
    ),
    blocker_codes: blockerFindings.map((finding) => finding.code).filter(Boolean),
    remediation:
      findDoctorFinding(summary, 'tracker.credentials')?.remediation ||
      'Set LINEAR_API_KEY only when running the explicit hosted Linear/Node issue-run lane.'
  };
}

function parseInitFilePlan(text) {
  const files = [];
  let current = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const fileMatch = line.match(/^\s+\d+\.\s+(.+)$/);
    if (fileMatch) {
      current = {
        path: fileMatch[1].trim(),
        action: null,
        overwrite: null,
        would_write: null,
        overwrite_approval_required: null
      };
      files.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    const propertyMatch = line.match(/^\s+([a-z_]+):\s*(.+)$/);
    if (!propertyMatch) {
      continue;
    }
    const key = propertyMatch[1];
    const value = propertyMatch[2].trim();
    if (key === 'action') {
      current.action = value;
    } else if (key === 'overwrite') {
      current.overwrite = value;
    } else if (key === 'would_write') {
      current.would_write = value === 'yes';
    } else if (key === 'overwrite_approval_required') {
      current.overwrite_approval_required = value === 'yes';
    }
  }
  return { files };
}

function parseInitWriteSummary(text) {
  const files = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s+-\s+(.+?):\s+([a-z]+)(?:\s+written)?$/);
    if (match) {
      files.push({
        path: match[1],
        action: match[2],
        written: line.includes(' written')
      });
    }
  }
  const writesMatch = String(text || '').match(/^Writes performed:\s+(\d+)$/m);
  const skippedMatch = String(text || '').match(/^Skipped unchanged:\s+(\d+)$/m);
  return {
    writes_performed: writesMatch ? Number(writesMatch[1]) : null,
    skipped_unchanged: skippedMatch ? Number(skippedMatch[1]) : null,
    files
  };
}

function snapshotFileStates(projectRoot, relativePaths) {
  const states = {};
  for (const relativePath of relativePaths) {
    const filePath = path.join(projectRoot, relativePath);
    if (!fs.existsSync(filePath)) {
      states[relativePath] = { exists: false, type: null, bytes: null };
      continue;
    }
    const stat = fs.statSync(filePath);
    states[relativePath] = {
      exists: true,
      type: stat.isDirectory() ? 'directory' : 'file',
      bytes: stat.isFile() ? stat.size : null
    };
  }
  return states;
}

function verifyDryRunNoWrites(lane, before, after) {
  const changed = [];
  for (const relativePath of INIT_FILE_CANDIDATES) {
    const left = before[relativePath] ?? { exists: false, type: null, bytes: null };
    const right = after[relativePath] ?? { exists: false, type: null, bytes: null };
    if (left.exists !== right.exists || left.type !== right.type || left.bytes !== right.bytes) {
      changed.push(relativePath);
    }
  }
  if (changed.length > 0) {
    addFinding(
      lane,
      'implementation_defect',
      'blocker',
      `Init dry-run changed files: ${changed.join(', ')}`,
      'Fix init dry-run so it only renders the plan and writes no project files.'
    );
  }
  return { changed_files: changed, passed: changed.length === 0 };
}

function verifyInitWrite(lane, projectRoot, dryRunPlan, writeSummary) {
  const expectedWrites = dryRunPlan.files.filter((file) => file.would_write).map((file) => file.path).sort();
  const actualWrites = writeSummary.files.filter((file) => file.written).map((file) => file.path).sort();
  const missingWrites = expectedWrites.filter((file) => !actualWrites.includes(file));
  const extraWrites = actualWrites.filter((file) => !expectedWrites.includes(file));
  const missingFiles = expectedWrites.filter((file) => !fs.existsSync(path.join(projectRoot, file)));
  if (missingWrites.length > 0 || extraWrites.length > 0 || missingFiles.length > 0) {
    addFinding(
      lane,
      'implementation_defect',
      'blocker',
      'Init write summary did not match the dry-run file plan.',
      'Compare dry-run and write summaries, then fix init materialization reporting or writes.'
    );
  }
  return {
    expected_writes: expectedWrites,
    actual_writes: actualWrites,
    missing_writes: missingWrites,
    extra_writes: extraWrites,
    missing_files: missingFiles,
    passed: missingWrites.length === 0 && extraWrites.length === 0 && missingFiles.length === 0
  };
}

function summarizeGeneratedWorkflow(projectRoot) {
  const workflowPath = path.join(projectRoot, 'WORKFLOW.md');
  if (!fs.existsSync(workflowPath)) {
    return {
      path: workflowPath,
      exists: false,
      generated_profile_provenance: false,
      parse_validation: 'missing'
    };
  }
  const content = fs.readFileSync(workflowPath, 'utf8');
  const forbiddenTerms = ['Agent Review', 'Human Review', 'Merging', 'Rework', 'workflow:symphony-internal'];
  const hostedCredentialTerms = ['LINEAR_API_KEY', 'GITHUB_TOKEN'];
  const nodeCommandTerms = ['npm install', 'npm test', 'pnpm install', 'pnpm test', 'yarn install', 'yarn test'];
  return {
    path: workflowPath,
    exists: true,
    bytes: Buffer.byteLength(content),
    generated_profile_provenance: content.includes('symphony-generated-profile'),
    frontmatter_generated_profile: content.includes('generated_profile:'),
    memory_tracker: /tracker:\s*\n\s*kind:\s*"memory"/.test(content) || /tracker:\s*\n\s*kind:\s*memory/.test(content),
    generic_toolchain: /toolchain:\s*\n\s*kind:\s*"generic"/.test(content) || /toolchain:\s*\n\s*kind:\s*generic/.test(content),
    validation_command: content.match(/validation_command:\s*("?[^"\n]+"?)/)?.[1] ?? null,
    setup_command: content.match(/setup_command:\s*("?[^"\n]*"?)/)?.[1] ?? null,
    forbidden_internal_terms_present: forbiddenTerms.filter((term) => content.includes(term)),
    hosted_credential_terms_present: hostedCredentialTerms.filter((term) => content.includes(term)),
    node_command_terms_present: nodeCommandTerms.filter((term) => content.includes(term)),
    prompt_reference_present: /\.symphony\/prompts|prompt=/.test(content),
    parse_validation: 'checked_by_init_and_doctor'
  };
}

function verifyGeneratedWorkflow(lane, summary) {
  const failures = [];
  if (!summary.exists) {
    failures.push('WORKFLOW.md missing');
  }
  if (!summary.generated_profile_provenance || !summary.frontmatter_generated_profile) {
    failures.push('generated profile provenance missing');
  }
  if (!summary.memory_tracker) {
    failures.push('memory tracker config missing');
  }
  if (!summary.generic_toolchain) {
    failures.push('generic toolchain config missing');
  }
  if (summary.forbidden_internal_terms_present.length > 0) {
    failures.push(`internal workflow terms present: ${summary.forbidden_internal_terms_present.join(', ')}`);
  }
  if (summary.hosted_credential_terms_present.length > 0) {
    failures.push(`hosted credential terms present: ${summary.hosted_credential_terms_present.join(', ')}`);
  }
  if (summary.node_command_terms_present.length > 0) {
    failures.push(`node command terms present: ${summary.node_command_terms_present.join(', ')}`);
  }
  if (summary.prompt_reference_present) {
    failures.push('prompt customization reference present');
  }
  if (failures.length > 0) {
    addFinding(
      lane,
      'implementation_defect',
      'blocker',
      `Generated generic workflow failed acceptance checks: ${failures.join('; ')}`,
      'Fix memory-generic materialization before accepting generated non-Node adoption.'
    );
  }
  return { passed: failures.length === 0, failures };
}

function readLinearNodeWorkflowChecks(workflowPath, expectedLinearProjectSlug) {
  const content = fs.existsSync(workflowPath) ? fs.readFileSync(workflowPath, 'utf8') : '';
  const unintendedStates = ['Agent Review', 'Human Review', 'Merging', 'Rework'].filter((state) => content.includes(state));
  const checks = {
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

function parseJsonObjectOutput(text) {
  const raw = String(text || '').trim();
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    for (let start = raw.indexOf('{'); start !== -1; start = raw.indexOf('{', start + 1)) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let index = start; index < raw.length; index += 1) {
        const char = raw[index];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') {
          inString = !inString;
          continue;
        }
        if (inString) {
          continue;
        }
        if (char === '{') {
          depth += 1;
        } else if (char === '}') {
          depth -= 1;
          if (depth === 0) {
            try {
              return JSON.parse(raw.slice(start, index + 1));
            } catch {
              break;
            }
          }
        }
      }
    }
    throw new Error('no JSON object found in command output');
  }
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
    payload = parseJsonObjectOutput(commandRecord._rawStdout);
    if (!payload) {
      throw new Error('empty JSON output');
    }
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
    const remediation = summary.findings.find((finding) => finding.remediation)?.remediation || 'Run `symphony doctor --json` in this project root and resolve the reported blockers before counting this lane as passed.';
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
    const remediation = summary.findings.find((finding) => finding.remediation)?.remediation || 'Review `symphony doctor --json` warnings before using this lane as clean evidence.';
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
    ...(options.profile ? ['--profile', options.profile] : ['--workflow', workflowPath]),
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
  const projectLayout = dashboard.diagnostics.body?.project_layout;
  const resolvedWorkflow = runtimeResolution?.workflow_path ? realpathIfExists(runtimeResolution.workflow_path) : null;
  const resolvedRoot = runtimeResolution?.workflow_dir ? realpathIfExists(runtimeResolution.workflow_dir) : null;
  dashboard.project_identity_match =
    dashboard.health.ok === true &&
    dashboard.diagnostics.ok === true &&
    resolvedWorkflow === realpathIfExists(workflowPath) &&
    resolvedRoot === realpathIfExists(projectRoot);
  dashboard.project_identity = {
    expected_key: lane.project_identity?.key ?? null,
    expected_project_root: realpathIfExists(projectRoot),
    expected_workflow_path: realpathIfExists(workflowPath),
    reported_workflow_path: resolvedWorkflow,
    reported_workflow_dir: resolvedRoot,
    reported_workspace_root: runtimeResolution?.workspace_root ?? null,
    reported_log_root: dashboard.diagnostics.body?.logging?.root ?? null,
    reported_persistence_path: dashboard.diagnostics.body?.persistence?.db_path ?? null
  };
  dashboard.layout = {
    expected_runtime_state_root: projectLayout?.expected_runtime_state_root?.path ?? null,
    effective_workspace_root: projectLayout?.effective_workspace_root?.path ?? null,
    effective_log_root: projectLayout?.effective_log_root?.path ?? null,
    effective_persistence_path: projectLayout?.effective_persistence_path?.path ?? null,
    reserved_customization_paths: Array.isArray(projectLayout?.reserved_customization_paths)
      ? projectLayout.reserved_customization_paths.map((item) => ({
          path: item.path,
          loaded_by_runtime: item.loaded_by_runtime ?? null,
          exists: item.exists ?? null
        }))
      : []
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
      run?.identity?.project?.key ||
      run?.identity?.project_key ||
      run?.project_key ||
      run?.project_identity?.key ||
      run?.project_identity?.project_key ||
      run?.identity_projection?.project_key ||
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

function findProjectHistoryTicketKey(listPayload, issueIdentifier) {
  const tickets = Array.isArray(listPayload?.tickets) ? listPayload.tickets : [];
  const match = tickets.find((ticket) => {
    const identity = ticket.ticket_identity || ticket.identity?.ticket || {};
    return (
      identity.human_issue_identifier === issueIdentifier ||
      ticket.issue_identifier === issueIdentifier ||
      ticket.human_issue_identifier === issueIdentifier
    );
  });
  return match?.ticket_identity?.key || match?.identity?.ticket?.key || null;
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
      const detailByIdentifierUrl = `${baseUrl}/api/v1/projects/${encodeURIComponent(projectKey)}/history/tickets/${encodeURIComponent(config.linearIssueId)}`;
      const healthUrl = `${baseUrl}/api/v1/projects/${encodeURIComponent(projectKey)}/history/health`;
      const list = await fetchJson(listUrl).catch((error) => ({ ok: false, error: String(error) }));
      let detail = await fetchJson(detailByIdentifierUrl).catch((error) => ({ ok: false, error: String(error) }));
      const detailLookup = { requested_identifier: config.linearIssueId, fallback_ticket_key: null };
      const ticketKey = findProjectHistoryTicketKey(list.body, config.linearIssueId);
      if (!detail.ok && ticketKey) {
        detailLookup.fallback_ticket_key = ticketKey;
        const detailByTicketKeyUrl = `${baseUrl}/api/v1/projects/${encodeURIComponent(projectKey)}/history/tickets/${encodeURIComponent(ticketKey)}`;
        detail = await fetchJson(detailByTicketKeyUrl).catch((error) => ({ ok: false, error: String(error) }));
      }
      proof.project_history = {
        project_key: projectKey,
        detail_lookup: detailLookup,
        list,
        detail,
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

function recordPostCommandEvidence(lane, projectRoot, workflowPath, env) {
  const consentPath = path.join(projectRoot, '.symphony', 'setup-consent.json');
  lane.environment = summarizeLaneEnv(env);
  lane.project_identity = buildExpectedProjectIdentity(projectRoot, workflowPath);
  lane.setup_consent = {
    project_checkout_path_exists: fs.existsSync(consentPath),
    user_local_state_home: env.SYMPHONY_LOCAL_STATE_HOME ?? env.SYMPHONY_USER_STATE_DIR ?? null,
    scoped_identity_key: lane.project_identity.key
  };
  lane.layout = {
    runtime_state_root: path.join(projectRoot, '.symphony', 'system'),
    runtime_owned_paths: [
      path.join(projectRoot, '.symphony', 'system', 'workspaces'),
      path.join(projectRoot, '.symphony', 'system', 'logs'),
      path.join(projectRoot, '.symphony', 'system', 'runtime.sqlite')
    ],
    project_owned_paths: [
      path.join(projectRoot, '.symphony', 'skills'),
      path.join(projectRoot, '.symphony', 'prompts')
    ]
  };
  lane.history_isolation = {
    expected_project_identity_key: lane.project_identity.key,
    expected_project_root: lane.project_identity.project_root,
    expected_workflow_path: lane.project_identity.workflow_path,
    status: 'recorded_for_dashboard_api_projection'
  };
}

function runRequiredCommandSet(lane, operator, env, projectRoot, commandOptions = {}) {
  const resolverArgs = [
    ...(commandOptions.profile ? ['--profile', commandOptions.profile] : []),
    ...(commandOptions.workflowPath ? ['--workflow', commandOptions.workflowPath] : [])
  ];
  appendCommand(lane, runCommand(operator.command, [...operator.argsPrefix, '--version'], { name: 'symphony --version', cwd: projectRoot, env }));
  appendCommand(lane, runCommand(operator.command, [...operator.argsPrefix, 'profile', 'list'], { name: 'symphony profile list', cwd: projectRoot, env }));
  appendCommand(
    lane,
    runCommand(operator.command, [...operator.argsPrefix, 'profile', 'show', commandOptions.profileShow || 'memory-generic'], {
      name: `symphony profile show ${commandOptions.profileShow || 'memory-generic'}`,
      cwd: projectRoot,
      env
    })
  );
  appendCommand(
    lane,
    runCommand(operator.command, [...operator.argsPrefix, 'setup', '--yes', ...resolverArgs], {
      name: 'symphony setup --yes',
      cwd: projectRoot,
      env
    })
  );
  const doctor = runCommand(
    operator.command,
    [...operator.argsPrefix, 'doctor', '--json', ...resolverArgs],
    {
      name: 'symphony doctor --json',
      cwd: projectRoot,
      env
    }
  );
  appendCommand(lane, doctor, commandOptions.doctorExpectedCodes || [0]);
  return doctor;
}

function createSyntheticProject(tempRoot, name) {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, `${name}-`)));
  fs.writeFileSync(path.join(projectRoot, 'WORKFLOW.md'), workflow(`Local trial ${name}`));
  fs.writeFileSync(path.join(projectRoot, '.gitignore'), '.symphony/system/\n');
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  return projectRoot;
}

function createGeneratedGenericProject(tempRoot) {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, 'generated-generic-')));
  fs.writeFileSync(path.join(projectRoot, 'README.md'), '# Generated generic trial project\n');
  fs.mkdirSync(path.join(projectRoot, '.symphony', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.symphony', 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.symphony', 'skills', 'README.md'), 'Reserved for project-owned skills.\n');
  fs.writeFileSync(path.join(projectRoot, '.symphony', 'prompts', 'README.md'), 'Reserved for project-owned prompts.\n');
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  return projectRoot;
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
  for (const key of PROJECT_RESOLUTION_SYMPHONY_KEYS) {
    delete next[key];
  }
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
  lane.environment = summarizeEnv(env);
  lane.workflow_source = summarizeWorkflowFile(workflowPath);
  recordPostCommandEvidence(lane, projectRoot, workflowPath, env);
  lane.tracker_identifiers.push({ kind: 'memory', present: true });

  appendCommand(lane, runCommand(operator.command, [...operator.argsPrefix, '--version'], { name: 'symphony --version', cwd: projectRoot, env }));
  appendCommand(lane, runCommand(operator.command, [...operator.argsPrefix, 'profile', 'list'], { name: 'symphony profile list', cwd: projectRoot, env }));
  appendCommand(
    lane,
    runCommand(operator.command, [...operator.argsPrefix, 'profile', 'show', 'memory-generic'], {
      name: 'symphony profile show memory-generic',
      cwd: projectRoot,
      env
    })
  );
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

async function runGeneratedGenericLane(report, operator, env, tempRoot, options) {
  const projectRoot = createGeneratedGenericProject(tempRoot);
  const workflowPath = path.join(projectRoot, 'WORKFLOW.md');
  const lane = buildLane(
    'synthetic-generated-generic',
    'Synthetic generated generic non-Node project',
    'synthetic-generated-generic-no-node-metadata',
    projectRoot,
    true
  );
  lane.environment = summarizeEnv(env);
  lane.tracker_identifiers.push({ kind: 'memory', present: true });
  lane.project_facts = {
    git_repository: fs.existsSync(path.join(projectRoot, '.git')),
    package_metadata_absent: PACKAGE_METADATA_FILES.every((relativePath) => !fs.existsSync(path.join(projectRoot, relativePath))),
    reserved_customization_paths: [
      { path: '.symphony/skills', exists: fs.existsSync(path.join(projectRoot, '.symphony', 'skills')) },
      { path: '.symphony/prompts', exists: fs.existsSync(path.join(projectRoot, '.symphony', 'prompts')) }
    ]
  };
  if (!lane.project_facts.package_metadata_absent) {
    addFinding(
      lane,
      'implementation_defect',
      'blocker',
      'Generated generic trial project unexpectedly contains Node package metadata.',
      'Create the synthetic generic project without package.json or package manager lockfiles.'
    );
  }

  const beforeDryRun = snapshotFileStates(projectRoot, INIT_FILE_CANDIDATES);
  const dryRun = runCommand(operator.command, [...operator.argsPrefix, 'init', '--dry-run', '--bundle', 'memory-generic', '--no-input'], {
    name: 'generated generic init dry-run',
    cwd: projectRoot,
    env
  });
  appendCommand(lane, dryRun);
  lane.init = {
    dry_run: {
      file_plan: parseInitFilePlan(dryRun._rawStdout),
      no_write_verification: null
    },
    write: null,
    idempotent_write: null
  };
  lane.init.dry_run.no_write_verification = verifyDryRunNoWrites(
    lane,
    beforeDryRun,
    snapshotFileStates(projectRoot, INIT_FILE_CANDIDATES)
  );

  const write = runCommand(operator.command, [...operator.argsPrefix, 'init', '--bundle', 'memory-generic', '--no-input'], {
    name: 'generated generic init write',
    cwd: projectRoot,
    env
  });
  appendCommand(lane, write);
  const writeSummary = parseInitWriteSummary(write._rawStdout);
  lane.init.write = {
    summary: writeSummary,
    verification: verifyInitWrite(lane, projectRoot, lane.init.dry_run.file_plan, writeSummary)
  };

  const idempotentWrite = runCommand(operator.command, [...operator.argsPrefix, 'init', '--bundle', 'memory-generic', '--no-input'], {
    name: 'generated generic init idempotent write',
    cwd: projectRoot,
    env
  });
  appendCommand(lane, idempotentWrite);
  const idempotentSummary = parseInitWriteSummary(idempotentWrite._rawStdout);
  lane.init.idempotent_write = { summary: idempotentSummary };
  if (idempotentSummary.writes_performed !== 0 || idempotentSummary.files.some((file) => file.action !== 'skip')) {
    addFinding(
      lane,
      'implementation_defect',
      'blocker',
      'Repeated memory-generic init did not skip unchanged generated files.',
      'Fix init idempotence so generated files are skipped when content already matches.'
    );
  }

  lane.workflow_source = summarizeWorkflowFile(workflowPath);
  lane.generated_workflow = summarizeGeneratedWorkflow(projectRoot);
  lane.generated_workflow.verification = verifyGeneratedWorkflow(lane, lane.generated_workflow);

  appendCommand(lane, runCommand(operator.command, [...operator.argsPrefix, 'setup', '--yes'], { name: 'generated generic setup consent', cwd: projectRoot, env }));
  const doctor = runCommand(operator.command, [...operator.argsPrefix, 'doctor', '--json', '--ci'], {
    name: 'generated generic doctor JSON',
    cwd: projectRoot,
    env
  });
  appendCommand(lane, doctor);
  const doctorSummary = parseDoctorJson(lane, doctor);
  lane.layout = {
    runtime_state_root: findDoctorFinding(doctorSummary, 'layout.runtime_state_root'),
    gitignore_system: findDoctorFinding(doctorSummary, 'layout.gitignore_system'),
    reserved_customization: findDoctorFinding(doctorSummary, 'layout.reserved_customization'),
    generated_profile: findDoctorFinding(doctorSummary, 'customization.generated_profile')
  };
  lane.validation_behavior = {
    setup_command: lane.generated_workflow.setup_command,
    validation_command: lane.generated_workflow.validation_command,
    node_command_terms_present: lane.generated_workflow.node_command_terms_present,
    hosted_tracker_credentials_required:
      findDoctorFinding(doctorSummary, 'tracker.credentials')?.code !== 'tracker_credentials_not_required'
  };
  if (lane.validation_behavior.hosted_tracker_credentials_required) {
    addFinding(
      lane,
      'implementation_defect',
      'blocker',
      'Doctor reported hosted tracker credentials for memory-generic.',
      'Fix generic memory tracker doctor readiness so hosted tracker credentials are not required.'
    );
  }

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
  lane.environment = summarizeEnv(env);
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
    files: parseInitFilePlan(dryRun._rawStdout).files,
    validation_ok: /Validation:\s+ok/.test(dryRun._rawStdout)
  };

  const initWrite = runCommand(operator.command, [...operator.argsPrefix, ...initArgs], {
    name: 'linear-node init write',
    cwd: projectRoot,
    env
  });
  appendCommand(lane, initWrite);
  lane.init_write_plan = {
    files: parseInitWriteSummary(initWrite._rawStdout).files.length > 0
      ? parseInitWriteSummary(initWrite._rawStdout).files
      : parseInitFilePlan(initWrite._rawStdout).files,
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
  lane.generated_workflow_checks = readLinearNodeWorkflowChecks(workflowPath, GENERATED_LINEAR_NODE_SLUG);
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
  const doctorSummary = parseDoctorJson(lane, doctor);
  lane.hosted_credential_behavior = {
    mode: 'non_hosted_setup',
    hosted_credentials_required_for_issue_run: true,
    doctor: summarizeExpectedLinearCredentialBlockers(doctorSummary)
  };
  if (
    doctorSummary &&
    (doctorSummary.status === 'failure' ||
      doctorSummary.reason === 'blockers_present' ||
      doctorSummary.finding_counts.blockers > 0 ||
      doctor.exit_code === 2) &&
    !lane.hosted_credential_behavior.doctor.missing_credentials_expected_for_non_hosted_setup
  ) {
    const remediation =
      doctorSummary.findings.find((finding) => finding.remediation)?.remediation ||
      'Run `symphony doctor --json` in this project root and resolve unexpected blockers before counting this lane as passed.';
    addFinding(
      lane,
      'environment_prerequisite',
      'blocker',
      `Doctor reported unexpected blockers for generated Linear/Node setup: ${doctorSummary.reason || 'blockers_present'}.`,
      remediation
    );
  }
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
  appendCommand(lane, runCommand(operator.command, [...operator.argsPrefix, ...initArgs, '--dry-run'], { name: 'hosted linear-node init dry-run', cwd: projectRoot, env }));
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
  const pushMain = runCommand('git', ['push', '-u', 'origin', 'main'], {
    name: 'hosted push main',
    cwd: projectRoot,
    env
  });
  lane.hosted_main_push = {
    exit_code: pushMain.exit_code,
    pushed: pushMain.exit_code === 0,
    remote: config.githubRemoteUrl ? '<configured-hosted-remote>' : null
  };
  appendCommand(lane, pushMain);
  appendCommand(lane, runCommand(operator.command, [...operator.argsPrefix, 'setup', '--yes'], { name: 'hosted setup consent', cwd: projectRoot, env }));
  const doctor = runCommand(operator.command, [...operator.argsPrefix, 'doctor', '--json', '--ci'], { name: 'hosted doctor JSON', cwd: projectRoot, env });
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

async function runInternalSymphonyLane(report, operator, env, repoRoot, options) {
  const projectRoot = repoRoot;
  const workflowPath = path.join(projectRoot, 'WORKFLOW.md');
  const lane = buildLane(
    'symphony-internal-profile',
    'Symphony checkout protected internal profile',
    'symphony-checkout-internal-profile',
    projectRoot,
    false
  );
  lane.counts_for_external_project_evidence = false;
  lane.workflow_source = summarizeWorkflowFile(workflowPath);
  recordPostCommandEvidence(lane, projectRoot, workflowPath, env);

  const doctor = runRequiredCommandSet(lane, operator, env, projectRoot, {
    profile: 'symphony-internal',
    profileShow: 'symphony-internal',
    doctorExpectedCodes: [0, 1, 2]
  });
  const doctorSummary = parseDoctorJson(lane, doctor, { classifyNonReady: true });
  if (
    doctorSummary?.resolution?.workflow_path &&
    realpathIfExists(doctorSummary.resolution.workflow_path) !== realpathIfExists(workflowPath)
  ) {
    addFinding(
      lane,
      'implementation_defect',
      'blocker',
      'Protected internal profile did not resolve the checked-in Symphony WORKFLOW.md.',
      'Fix symphony-internal profile resolution before using internal adoption evidence.'
    );
  }
  if (lane.workflow_source?.generated_profile) {
    addFinding(
      lane,
      'implementation_defect',
      'blocker',
      'Protected internal profile lane resolved a generated workflow.',
      'The internal lane must bind to the checked-in workflow rather than materializing a generated profile.'
    );
  }

  await runDashboardProof(lane, operator, projectRoot, workflowPath, env, { ...options, profile: 'symphony-internal' });
  lane.generated_files = summarizeGeneratedFiles(projectRoot);
  lane.status = laneStatus(lane);
  report.lanes.push(lane);
}

async function runRealProjectLane(report, operator, env, rootSpec, index, options) {
  const projectRoot = path.resolve(rootSpec.path);
  const lane = buildLane(
    rootSpec.synthetic ? `synthetic-existing-project-${index + 1}` : `real-project-${index + 1}`,
    rootSpec.synthetic ? `Synthetic existing-workflow project ${index + 1}` : `Real local project ${index + 1}`,
    rootSpec.shape,
    projectRoot,
    Boolean(rootSpec.synthetic)
  );
  lane.environment = summarizeEnv(env);
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

  recordPostCommandEvidence(lane, projectRoot, workflowPath, env);
  const doctor = runRequiredCommandSet(lane, operator, env, projectRoot, {
    workflowPath,
    doctorExpectedCodes: [0, 1, 2]
  });
  parseDoctorJson(lane, doctor, { classifyNonReady: true });
  await runDashboardProof(lane, operator, projectRoot, workflowPath, env, options);
  lane.generated_files = summarizeGeneratedFiles(projectRoot);
  lane.status = laneStatus(lane);
  report.lanes.push(lane);
}

function runMissingRealProjectLane(report, env) {
  const lane = buildLane(
    'real-existing-project-missing',
    'Missing real existing-project evidence',
    'existing-local-required',
    null,
    false
  );
  lane.counts_for_external_project_evidence = false;
  lane.environment = summarizeLaneEnv(env);
  addFinding(
    lane,
    'environment_prerequisite',
    'blocker',
    'No real existing local project root was supplied to the trial harness.',
    'Rerun with --project-root or --required-project-root pointing at a real local project that already has a hand-written WORKFLOW.md.'
  );
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
      symphony_resolution_env_cleared: PROJECT_RESOLUTION_SYMPHONY_KEYS,
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
    await runGeneratedGenericLane(report, operator, env, tempRoot, options);
    await runGeneratedLinearNodeLane(report, operator, env, tempRoot, options);
    await runInternalSymphonyLane(report, operator, env, repoRoot, options);
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
    const realRoots = [...(options.projectRoots || []), ...(options.requiredProjectRoots || [])];
    const syntheticRoots = (options.syntheticProjectRoots || []).map((root) => ({ ...root, synthetic: true }));
    const roots = [...realRoots, ...syntheticRoots];
    if (realRoots.length === 0) {
      runMissingRealProjectLane(report, env);
    }
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
