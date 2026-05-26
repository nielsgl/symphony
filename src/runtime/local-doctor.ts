import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';

import { ConfigResolver, ConfigValidator, WorkflowLoader } from '../workflow';
import { WorkflowConfigError } from '../workflow/errors';
import type { EffectiveConfig } from '../workflow/types';
import type {
  ResolveLocalCommandOptions,
  LocalCommandResolution,
  LocalPathSource,
  LocalScalarSource
} from './local-command-resolver';
import { LocalCommandResolutionError } from './local-command-resolver';
import { isWithinPath } from './path-containment';
import {
  ensureSystemGitignoreEntry,
  inspectProjectLayout,
  type ProjectLayoutInspection,
  type ProjectLayoutWarningCode
} from './project-layout-inspector';
import {
  buildSetupConsentRecord,
  findValidSetupConsent,
  persistSetupConsent,
  type SetupConsentSource,
  type SetupConsentStore,
  type WorkflowPosture
} from './setup-consent';
import {
  readWorkflowGeneratedProfileProvenance,
  validateWorkflowGeneratedProfileProvenance
} from '../workflow/provenance';

export type DoctorCheckStatus = 'ok' | 'warning' | 'failure';
export type DoctorOverallStatus = DoctorCheckStatus;
export type DoctorFindingSeverity = 'pass' | 'warning' | 'blocker';
export type DoctorFindingProvenanceCategory =
  | 'cli_flag'
  | 'environment_variable'
  | 'environment_file'
  | 'workflow_value'
  | 'generated_profile'
  | 'project_default'
  | 'layout_inspection'
  | 'user_local_trust_state'
  | 'inferred_runtime_default'
  | 'path_lookup'
  | 'local_checkout'
  | 'git_repository'
  | 'runtime_probe';

export interface DoctorFindingSource {
  category: DoctorFindingProvenanceCategory;
  value?: string;
  present?: boolean;
}

export interface DoctorFindingRemediation {
  guidance: string | null;
}

export type DoctorFindingSafeFixMutationScope = 'project_file' | 'user_local_state' | 'local_link';

export interface DoctorFindingSafeFixMutation {
  scope: DoctorFindingSafeFixMutationScope;
  path: string;
  operation: 'append_gitignore_entry' | 'record_setup_consent' | 'refresh_local_shim';
}

export interface DoctorFindingSafeFix {
  available: boolean;
  fixId: string | null;
  command: string | null;
  requiresYes: boolean;
  mutates: DoctorFindingSafeFixMutation[];
}

export interface DoctorFinding {
  id: string;
  code: string;
  title: string;
  message: string;
  status: DoctorCheckStatus;
  checkStatus: DoctorCheckStatus;
  severity: DoctorFindingSeverity;
  reason: string;
  summary: string;
  source: DoctorFindingSource;
  remediationGuidance: string | null;
  remediationInfo: DoctorFindingRemediation;
  safeFix: DoctorFindingSafeFix;
  remediation?: string;
  details: Record<string, unknown>;
}

export type DoctorCheck = DoctorFinding;
type DoctorFindingInput = Omit<
  DoctorFinding,
  | 'code'
  | 'message'
  | 'checkStatus'
  | 'severity'
  | 'source'
  | 'remediationGuidance'
  | 'remediationInfo'
  | 'safeFix'
  | 'details'
> & {
  code?: string;
  message?: string;
  source?: DoctorFindingSource;
  remediationGuidance?: string | null;
  remediationInfo?: DoctorFindingRemediation;
  safeFix?: DoctorFindingSafeFix;
  details?: Record<string, unknown>;
};

export interface DoctorFixAction {
  id: string;
  status: 'applied' | 'skipped' | 'failed';
  summary: string;
  safe: boolean;
  targetFindingIds: string[];
  requiresYes: boolean;
  details?: Record<string, unknown>;
}

type DoctorFixActionInput = Omit<DoctorFixAction, 'safe' | 'targetFindingIds' | 'requiresYes'> &
  Partial<Pick<DoctorFixAction, 'safe' | 'targetFindingIds' | 'requiresYes'>>;

export interface DoctorJsonResult {
  version: 1;
  command: 'doctor';
  status: DoctorOverallStatus;
  reason: 'ready' | 'warnings_present' | 'blockers_present';
  exitCode: 0 | 1 | 2;
  exitSemantics: {
    code: 0 | 1 | 2;
    meaning: 'ready' | 'warnings_non_blocking' | 'blockers_present';
    ci: {
      requested: boolean;
      promptsAllowed: false;
      nonZeroOnBlocker: boolean;
    };
  };
  ci: boolean;
  fix: boolean;
  cwd: string;
  symphonyCheckoutRoot: string;
  resolution: {
    projectRoot: string | null;
    workflowPath: string | null;
    envFilePath: string | null;
    profile: string | null;
    host: string | null;
    port: number | null;
    ephemeralPort: boolean | null;
    consent: SetupConsentSource | null;
  };
  layout: ProjectLayoutInspection | null;
  findings: DoctorFinding[];
  checks: DoctorFinding[];
  fixes: DoctorFixAction[];
  projectContext: {
    cwd: string;
    symphonyCheckoutRoot: string;
    projectRoot: string | null;
    workflowPath: string | null;
    envFilePath: string | null;
    envFileExists: boolean | null;
    profile: string | null;
  };
}

export interface RunLocalDoctorOptions {
  argv: readonly string[];
  deps: LocalDoctorDependencies;
}

export interface LocalDoctorDependencies {
  cwd: string;
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  resolveLocalCommand: (options: ResolveLocalCommandOptions) => LocalCommandResolution;
  resolveWorkflowPosture: (workflowPath: string, env?: NodeJS.ProcessEnv) => WorkflowPosture;
  setupConsentStore: SetupConsentStore;
  runLinkLocal: (argv: readonly string[]) => Promise<number>;
  clock: () => Date;
}

interface DoctorArgs {
  json: boolean;
  ci: boolean;
  fix: boolean;
  yes: boolean;
  resolverArgv: string[];
}

interface ShimMetadata {
  path: string;
  owned: boolean;
  repoRoot: string | null;
  entrypoint: string | null;
  verificationError?: string;
}

interface WorkflowCustomizationMetadata {
  profile: string | null;
  bundle: string | null;
  packs: string[];
  references: WorkflowCustomizationReference[];
  sources: string[];
}

interface WorkflowCustomizationReference {
  path: string;
  kind: 'skill' | 'prompt' | 'customization';
  source: string;
}

const DOCTOR_FLAGS = new Set(['--json', '--ci', '--fix', '--yes', '--accept-high-trust-local-run']);

function disabledSafeFix(): DoctorFindingSafeFix {
  return { available: false, fixId: null, command: null, requiresYes: false, mutates: [] };
}

function parseDoctorArgs(argv: readonly string[]): DoctorArgs | { error: string } {
  const resolverArgv: string[] = [];
  let json = false;
  let ci = false;
  let fix = false;
  let yes = false;

  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--ci') {
      ci = true;
      continue;
    }
    if (arg === '--fix') {
      fix = true;
      continue;
    }
    if (arg === '--yes' || arg === '--accept-high-trust-local-run') {
      yes = true;
      continue;
    }
    if (arg.startsWith('--doctor-')) {
      return { error: `Unsupported doctor option: ${arg}` };
    }
    if (arg.startsWith('--') && DOCTOR_FLAGS.has(arg.split('=')[0])) {
      return { error: `Unsupported doctor option value form: ${arg}` };
    }
    resolverArgv.push(arg);
  }

  return { json, ci, fix, yes, resolverArgv };
}

function findExecutableOnPath(env: NodeJS.ProcessEnv): string | null {
  const entries = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const entry of entries) {
    const candidate = path.join(entry, 'symphony');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

function parseShimMetadata(executablePath: string): ShimMetadata {
  let content: string;
  try {
    content = fs.readFileSync(executablePath, 'utf8');
  } catch (error) {
    return {
      path: executablePath,
      owned: false,
      repoRoot: null,
      entrypoint: null,
      verificationError: (error as Error).message
    };
  }

  const owned = content.includes('# symphony-local-shim');
  const repoRoot = content.match(/^# symphony-repo-root: (.+)$/m)?.[1] ?? null;
  const entrypoint = content.match(/^# symphony-entrypoint: (.+)$/m)?.[1] ?? null;
  return { path: executablePath, owned, repoRoot, entrypoint };
}

function severityForStatus(status: DoctorCheckStatus): DoctorFindingSeverity {
  if (status === 'failure') {
    return 'blocker';
  }
  if (status === 'warning') {
    return 'warning';
  }
  return 'pass';
}

function safeFixForFinding(
  check: Pick<DoctorFindingInput, 'id' | 'status'>,
  context: { projectRoot?: string; setupConsentStorePath?: string } = {}
): DoctorFindingSafeFix {
  if (check.id.startsWith('executable.') || check.id.startsWith('shim_checkout.')) {
    return {
      available: check.status !== 'ok',
      fixId: 'link-local',
      command: 'symphony doctor --fix --yes',
      requiresYes: true,
      mutates: [
        {
          scope: 'local_link',
          path: 'symphony link-local managed shim target',
          operation: 'refresh_local_shim'
        }
      ]
    };
  }
  if (check.id === 'layout.gitignore_system') {
    return {
      available: check.status !== 'ok',
      fixId: 'layout.gitignore-system',
      command: 'symphony doctor --fix --yes',
      requiresYes: true,
      mutates: [
        {
          scope: 'project_file',
          path: context.projectRoot ? path.join(context.projectRoot, '.gitignore') : '.gitignore',
          operation: 'append_gitignore_entry'
        }
      ]
    };
  }
  if (check.id === 'setup.consent') {
    return {
      available: check.status !== 'ok',
      fixId: 'setup-consent',
      command: 'symphony doctor --fix --yes',
      requiresYes: true,
      mutates: [
        {
          scope: 'user_local_state',
          path: context.setupConsentStorePath ?? 'user-local setup consent store',
          operation: 'record_setup_consent'
        }
      ]
    };
  }
  return disabledSafeFix();
}

function sourceFromPathSource(source: LocalPathSource): DoctorFindingSource {
  if (source === 'cli') {
    return { category: 'cli_flag', value: source, present: true };
  }
  if (source === 'env') {
    return { category: 'environment_variable', value: source, present: true };
  }
  if (source === 'profile') {
    return { category: 'generated_profile', value: source, present: true };
  }
  return { category: 'workflow_value', value: source, present: true };
}

function sourceFromScalarSource(source: LocalScalarSource): DoctorFindingSource {
  if (source === 'cli') {
    return { category: 'cli_flag', value: source, present: true };
  }
  if (source === 'env') {
    return { category: 'environment_variable', value: source, present: true };
  }
  if (source === 'profile') {
    return { category: 'generated_profile', value: source, present: true };
  }
  return { category: 'inferred_runtime_default', value: source, present: true };
}

function sourceForFinding(check: DoctorFindingInput): DoctorFindingSource {
  if (check.id === 'resolver.workflow' && typeof check.details?.workflowSource === 'string') {
    return sourceFromPathSource(check.details.workflowSource as LocalPathSource);
  }
  if (check.id === 'env.path' && typeof check.details?.source === 'string') {
    const source = check.details.source as LocalPathSource;
    if (check.details.exists === true) {
      return { category: 'environment_file', value: source, present: true };
    }
    return source === 'project'
      ? { category: 'project_default', value: source, present: true }
      : sourceFromPathSource(source);
  }
  if (check.id === 'server.port' && typeof check.details?.source === 'string') {
    return sourceFromScalarSource(check.details.source as LocalScalarSource);
  }
  if (check.id.startsWith('layout.')) {
    return { category: 'layout_inspection', present: true };
  }
  if (check.id.startsWith('customization.generated_profile')) {
    return { category: 'generated_profile', present: check.status === 'ok' };
  }
  if (check.id.startsWith('customization.reference.')) {
    return { category: 'generated_profile', present: check.status === 'ok' };
  }
  if (check.id === 'setup.consent') {
    return check.reason === 'setup_consent_flag'
      ? { category: 'cli_flag', value: 'guardrail_ack', present: true }
      : { category: 'user_local_trust_state', value: check.reason, present: check.status === 'ok' };
  }
  if (check.id.startsWith('workspace.')) {
    return check.id === 'workspace.base_ref' || check.id === 'workspace.dirty_policy'
      ? { category: 'git_repository', present: true }
      : { category: 'workflow_value', present: true };
  }
  if (check.id === 'workflow.effective_config' || check.id === 'codex.command') {
    return { category: 'workflow_value', present: check.status === 'ok' };
  }
  if (check.id.startsWith('executable.')) {
    return { category: 'path_lookup', present: check.status === 'ok' };
  }
  if (check.id.startsWith('shim_checkout.') || check.id === 'dashboard.prerequisites') {
    return { category: 'local_checkout', present: check.status === 'ok' };
  }
  if (check.id === 'doctor.options') {
    return { category: 'cli_flag', present: false };
  }
  return { category: 'runtime_probe', present: check.status === 'ok' };
}

function readWorkflowCustomizationMetadata(workflowPath: string, config: Record<string, unknown>): WorkflowCustomizationMetadata | null {
  let workflowText = '';
  try {
    workflowText = fs.readFileSync(workflowPath, 'utf8');
  } catch {
    return readWorkflowGeneratedProfileProvenance({ config }).metadata;
  }
  return readWorkflowGeneratedProfileProvenance({ config, workflowText }).metadata;
}

function safeReferenceId(reference: WorkflowCustomizationReference): string {
  return reference.path
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function resolveProjectReference(projectRoot: string, relativePath: string): string | null {
  if (path.isAbsolute(relativePath)) {
    return null;
  }
  const resolved = path.resolve(projectRoot, relativePath);
  return isWithinPath(projectRoot, resolved) ? resolved : null;
}

function addCustomizationChecks(
  checks: DoctorFinding[],
  resolved: LocalCommandResolution,
  metadata: WorkflowCustomizationMetadata | null
): void {
  const hasMetadata = Boolean(metadata?.profile || metadata?.bundle || metadata?.packs.length || metadata?.references.length);
  addCheck(checks, {
    id: 'customization.generated_profile',
    title: 'Generated workflow customization provenance is observable',
    status: 'ok',
    reason: hasMetadata ? 'generated_profile_provenance_recorded' : 'generated_profile_provenance_absent',
    summary: hasMetadata
      ? `Workflow records generated profile provenance (${[
          metadata?.profile ? `profile ${metadata.profile}` : null,
          metadata?.bundle ? `bundle ${metadata.bundle}` : null,
          metadata?.packs.length ? `packs ${metadata.packs.join(', ')}` : null
        ]
          .filter(Boolean)
          .join('; ')}); runtime behavior comes from the materialized workflow.`
      : 'Workflow does not record generated profile, bundle, pack, or customization provenance.',
    source: hasMetadata
      ? { category: 'generated_profile', value: metadata?.sources.join(',') ?? 'workflow', present: true }
      : { category: 'workflow_value', present: false },
    details: {
      profile: metadata?.profile ?? null,
      bundle: metadata?.bundle ?? null,
      packs: metadata?.packs ?? [],
      sources: metadata?.sources ?? [],
      runtimeLoadingSupported: false,
      runtimeLoadingBehavior: 'observable_only'
    }
  });

  for (const reference of metadata?.references ?? []) {
    const fullPath = resolveProjectReference(resolved.currentProjectRoot, reference.path);
    const exists = fullPath ? fs.existsSync(fullPath) : false;
    addCheck(checks, {
      id: `customization.reference.${safeReferenceId(reference) || reference.kind}`,
      title: `Observable ${reference.kind} customization reference exists`,
      status: exists ? 'ok' : 'warning',
      reason: exists ? 'customization_reference_present' : 'customization_reference_missing',
      summary: exists
        ? `Referenced ${reference.kind} customization file is present: ${reference.path}; this is observable project content, not runtime-loaded behavior.`
        : `Referenced ${reference.kind} customization file is missing: ${reference.path}; this is an observable project reference, not a Codex runtime loading failure.`,
      remediation: exists
        ? undefined
        : 'Create the referenced project file or remove the stale workflow customization reference.',
      source: { category: 'generated_profile', value: reference.source, present: true },
      details: {
        path: reference.path,
        kind: reference.kind,
        exists,
        projectRoot: resolved.currentProjectRoot,
        withinProject: fullPath !== null,
        source: reference.source,
        runtimeLoadingSupported: false,
        runtimeLoadingBehavior: 'observable_only',
        note: 'Doctor reports this explicit project reference; Codex project-local skill/prompt loading is not enabled by this finding.'
      }
    });
  }
}

function isSensitiveKey(key: string): boolean {
  return /(api[_-]?key|token|secret|password|credential|authorization|auth)/i.test(key);
}

function redactDetails(value: unknown, key = ''): unknown {
  if (isSensitiveKey(key)) {
    const present = typeof value === 'string' ? value.length > 0 : value !== null && value !== undefined;
    return { redacted: true, present };
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDetails(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        redactDetails(entryValue, entryKey)
      ])
    );
  }
  return value;
}

function normalizeFinding(check: DoctorFindingInput): DoctorFinding {
  const details = redactDetails(check.details ?? {}) as Record<string, unknown>;
  const remediationGuidance = check.remediationGuidance ?? check.remediation ?? null;
  return {
    ...check,
    code: check.code ?? check.reason,
    message: check.message ?? check.summary,
    checkStatus: check.status,
    severity: severityForStatus(check.status),
    source: check.source ?? sourceForFinding({ ...check, details }),
    remediationGuidance,
    remediationInfo: check.remediationInfo ?? { guidance: remediationGuidance },
    safeFix: check.safeFix ?? safeFixForFinding(check),
    details
  };
}

function addCheck(checks: DoctorFinding[], check: DoctorFindingInput): void {
  checks.push(normalizeFinding(check));
}

function normalizeFixAction(fix: DoctorFixActionInput): DoctorFixAction {
  const defaultTargets: Record<string, string[]> = {
    'link-local': [
      'executable.discoverable',
      'executable.checkout',
      'shim_checkout.checkout_exists',
      'shim_checkout.cli_script',
      'shim_checkout.built_cli'
    ],
    'layout.gitignore-system': ['layout.gitignore_system'],
    'setup-consent': ['setup.consent']
  };
  return {
    ...fix,
    safe: fix.safe ?? true,
    targetFindingIds: fix.targetFindingIds ?? defaultTargets[fix.id] ?? [],
    requiresYes: fix.requiresYes ?? true,
    details: redactDetails(fix.details ?? {}) as Record<string, unknown>
  };
}

function addFix(fixes: DoctorFixAction[], fix: DoctorFixActionInput): void {
  fixes.push(normalizeFixAction(fix));
}

function statusRank(status: DoctorCheckStatus): number {
  if (status === 'failure') {
    return 2;
  }
  if (status === 'warning') {
    return 1;
  }
  return 0;
}

function summarizeStatus(checks: readonly DoctorFinding[]): {
  status: DoctorOverallStatus;
  reason: DoctorJsonResult['reason'];
  exitCode: 0 | 1 | 2;
} {
  const worst = checks.reduce((current, check) => Math.max(current, statusRank(check.status)), 0);
  if (worst === 2) {
    return { status: 'failure', reason: 'blockers_present', exitCode: 2 };
  }
  if (worst === 1) {
    return { status: 'warning', reason: 'warnings_present', exitCode: 1 };
  }
  return { status: 'ok', reason: 'ready', exitCode: 0 };
}

function layoutWarningSeverity(code: ProjectLayoutWarningCode): DoctorCheckStatus {
  return code === 'workflow_missing' || code === 'invalid_layout_path' || code === 'gitignore_unreadable'
    ? 'failure'
    : 'warning';
}

function addLayoutChecks(checks: DoctorFinding[], layout: ProjectLayoutInspection): void {
  addCheck(checks, {
    id: 'layout.workflow',
    title: 'Root WORKFLOW.md is canonical',
    status: layout.workflow.exists ? 'ok' : 'failure',
    reason: layout.workflow.exists ? 'workflow_root_present' : 'workflow_root_missing',
    summary: layout.workflow.exists ? 'Root WORKFLOW.md is present.' : 'Root WORKFLOW.md is missing.',
    remediation: layout.workflow.remediation,
    details: { workflow: layout.workflow, projectContractPaths: layout.projectContractPaths }
  });
  addCheck(checks, {
    id: 'layout.runtime_state_root',
    title: '.symphony/system runtime root is reserved',
    status: 'ok',
    reason: 'runtime_state_root_reserved',
    summary: '.symphony/system/ is the runtime-owned local state root.',
    details: { runtimeStateRoot: layout.runtimeStateRoot, runtimeOwnedPaths: layout.runtimeOwnedPaths }
  });
  addCheck(checks, {
    id: 'layout.gitignore_system',
    title: '.gitignore covers runtime state root',
    status: layout.ignoreAnalysis.hasNarrowSystemIgnore
      ? 'ok'
      : layout.ignoreAnalysis.status === 'unreadable'
        ? 'failure'
        : 'warning',
    reason: layout.ignoreAnalysis.hasNarrowSystemIgnore
      ? 'system_ignore_present'
      : layout.ignoreAnalysis.status === 'unreadable'
        ? 'gitignore_unreadable'
        : 'system_ignore_missing',
    summary: layout.ignoreAnalysis.hasNarrowSystemIgnore
      ? '.gitignore includes .symphony/system/.'
      : '.gitignore does not narrowly ignore .symphony/system/.',
    remediation: layout.ignoreAnalysis.hasNarrowSystemIgnore
      ? undefined
      : 'Add .symphony/system/ to .gitignore; `symphony doctor --fix --yes` can append it safely.',
    safeFix: safeFixForFinding(
      { id: 'layout.gitignore_system', status: layout.ignoreAnalysis.hasNarrowSystemIgnore ? 'ok' : 'warning' },
      { projectRoot: layout.projectRoot }
    ),
    details: { ignoreAnalysis: layout.ignoreAnalysis }
  });
  addCheck(checks, {
    id: 'layout.broad_symphony_ignore',
    title: 'Broad .symphony/ ignores are not hiding project customization',
    status: layout.ignoreAnalysis.hasBroadSymphonyIgnore ? 'warning' : 'ok',
    reason: layout.ignoreAnalysis.hasBroadSymphonyIgnore ? 'broad_symphony_ignore_present' : 'no_broad_symphony_ignore',
    summary: layout.ignoreAnalysis.hasBroadSymphonyIgnore
      ? 'A broad .symphony/ ignore may hide future project-owned customization.'
      : 'No broad .symphony/ ignore was found.',
    remediation: layout.ignoreAnalysis.hasBroadSymphonyIgnore
      ? 'Migrate broad .symphony/ ignores to .symphony/system/ manually; doctor will not remove broad ignores.'
      : undefined,
    details: {
      patterns: layout.ignoreAnalysis.patterns.filter((pattern) => pattern.kind === 'broad-symphony')
    }
  });
  addCheck(checks, {
    id: 'layout.reserved_customization',
    title: 'Reserved customization paths remain project-owned',
    status: 'ok',
    reason: 'reserved_customization_reported',
    summary: 'Reserved .symphony customization paths are reported and are not loaded by runtime.',
    details: { reservedCustomizationPaths: layout.reservedCustomizationPaths }
  });
  addCheck(checks, {
    id: 'layout.legacy_runtime_paths',
    title: 'Legacy runtime paths are absent',
    status: layout.legacyRuntimePaths.length === 0 ? 'ok' : 'warning',
    reason: layout.legacyRuntimePaths.length === 0 ? 'legacy_runtime_paths_absent' : 'legacy_runtime_paths_present',
    summary:
      layout.legacyRuntimePaths.length === 0
        ? 'No legacy runtime state paths were found.'
        : `Found ${layout.legacyRuntimePaths.length} legacy runtime state path(s).`,
    remediation:
      layout.legacyRuntimePaths.length === 0
        ? undefined
        : 'Migrate runtime state to .symphony/system/ manually after verifying no active process uses the legacy paths.',
    details: { legacyRuntimePaths: layout.legacyRuntimePaths }
  });

  for (const warning of layout.warnings.filter((item) =>
    ['invalid_layout_path', 'gitignore_unreadable'].includes(item.code)
  )) {
    addCheck(checks, {
      id: `layout.warning.${warning.code}`,
      title: `Layout warning: ${warning.code}`,
      status: layoutWarningSeverity(warning.code),
      reason: warning.code,
      summary: warning.message,
      remediation: warning.remediation,
      details: { path: warning.path }
    });
  }
}

function checkCheckoutEntrypoint(repoRoot: string, label: string): DoctorFindingInput {
  const scriptEntrypoint = path.join(repoRoot, 'scripts', 'symphony.js');
  const builtEntrypoint = path.join(repoRoot, 'dist', 'src', 'runtime', 'command-router.js');
  if (!fs.existsSync(repoRoot)) {
    return {
      id: `${label}.checkout_exists`,
      title: `${label} checkout exists`,
      status: 'failure',
      reason: 'checkout_missing',
      summary: `Checkout does not exist: ${repoRoot}`,
      remediation: 'Refresh the local link from an existing Symphony checkout with `npm run link:local`.',
      details: { repoRoot }
    };
  }
  if (!fs.existsSync(scriptEntrypoint)) {
    return {
      id: `${label}.cli_script`,
      title: `${label} CLI script exists`,
      status: 'failure',
      reason: 'cli_script_missing',
      summary: `CLI script is missing: ${scriptEntrypoint}`,
      remediation: 'Refresh the local link from a valid Symphony checkout with `npm run link:local`.',
      details: { scriptEntrypoint }
    };
  }
  if (!fs.existsSync(builtEntrypoint)) {
    return {
      id: `${label}.built_cli`,
      title: `${label} built CLI entrypoint exists`,
      status: 'failure',
      reason: 'build_missing',
      summary: `Built CLI entrypoint is missing: ${builtEntrypoint}`,
      remediation: 'Run `npm run build` in the Symphony checkout, then rerun `npm run link:local`.',
      details: { builtEntrypoint }
    };
  }
  return {
    id: `${label}.built_cli`,
    title: `${label} built CLI entrypoint exists`,
    status: 'ok',
    reason: 'built_cli_ready',
    summary: `Built CLI entrypoint is present: ${builtEntrypoint}`,
    details: { scriptEntrypoint, builtEntrypoint }
  };
}

function canListen(host: string, port: number): Promise<boolean> {
  if (port === 0) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

function readEnvFileValues(envFilePath: string): NodeJS.ProcessEnv {
  try {
    return dotenv.parse(fs.readFileSync(envFilePath));
  } catch {
    return {};
  }
}

function findCommandOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
  const [executable] = command.trim().split(/\s+/);
  if (!executable) {
    return null;
  }

  if (executable.includes(path.sep)) {
    try {
      fs.accessSync(executable, fs.constants.X_OK);
      return fs.realpathSync(executable);
    } catch {
      return null;
    }
  }

  for (const entry of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(entry, executable);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Continue searching PATH.
    }
  }

  return null;
}

function workflowRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function envTokenName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith('$') || trimmed.length === 1) {
    return null;
  }
  const name = trimmed.slice(1);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : null;
}

function requiredTrackerEnvTokens(definition: { config: Record<string, unknown> }): Array<{ field: string; name: string }> {
  const tracker = workflowRecord(definition.config.tracker);
  const kind = typeof tracker.kind === 'string' ? tracker.kind.trim() : '';
  const requirements: Array<{ field: string; name: string }> = [];

  const explicitApiKey = typeof tracker.api_key === 'string';
  const apiKeyToken = explicitApiKey
    ? envTokenName(tracker.api_key)
    : kind === 'linear'
      ? 'LINEAR_API_KEY'
      : kind === 'github'
        ? 'GITHUB_TOKEN'
        : null;
  if ((kind === 'linear' || kind === 'github') && apiKeyToken) {
    requirements.push({ field: 'tracker.api_key', name: apiKeyToken });
  }

  for (const field of kind === 'linear' ? ['project_slug'] : kind === 'github' ? ['owner', 'repo'] : []) {
    const token = envTokenName(tracker[field]);
    if (token) {
      requirements.push({ field: `tracker.${field}`, name: token });
    }
  }

  return requirements;
}

function buildRequiredEnvCheck(
  definition: { config: Record<string, unknown> },
  env: NodeJS.ProcessEnv,
  envFilePath: string
): DoctorFindingInput {
  const requirements = requiredTrackerEnvTokens(definition);
  const variables = requirements.map((requirement) => ({
    name: requirement.name,
    field: requirement.field,
    present: typeof env[requirement.name] === 'string' && env[requirement.name]!.length > 0
  }));
  const missing = variables.filter((variable) => !variable.present);

  return {
    id: 'env.required_variables',
    title: 'Required environment variables are present',
    status: missing.length > 0 ? 'failure' : 'ok',
    reason: missing.length > 0 ? 'required_env_missing' : 'required_env_present',
    summary:
      missing.length > 0
        ? `Missing ${missing.length} required environment variable(s) after loading the effective environment source.`
        : 'All required environment variables are present after loading the effective environment source.',
    remediation:
      missing.length > 0
        ? 'Define the missing variables in the project .env file or process environment before starting Symphony.'
        : undefined,
    source: { category: 'environment_file', value: envFilePath, present: fs.existsSync(envFilePath) },
    details: {
      envFilePath,
      variables
    }
  };
}

function validateWorkflow(resolved: LocalCommandResolution, env: NodeJS.ProcessEnv): {
  check: DoctorFindingInput;
  effectiveConfig: EffectiveConfig | null;
  configValid: boolean;
  envCheck: DoctorFindingInput | null;
} {
  try {
    const definition = new WorkflowLoader().load({ explicitPath: resolved.workflowPath });
    const workflowText = fs.readFileSync(resolved.workflowPath, 'utf8');
    const provenanceValidation = validateWorkflowGeneratedProfileProvenance({
      config: definition.config,
      workflowText
    });
    if (!provenanceValidation.ok) {
      return {
        check: {
          id: 'workflow.effective_config',
          title: 'Workflow effective config validates',
          status: 'failure',
          reason: 'invalid_generated_profile_provenance',
          summary: provenanceValidation.message,
          remediation: 'Fix generated profile provenance in WORKFLOW.md before starting the dashboard.',
          details: { workflowPath: resolved.workflowPath }
        },
        effectiveConfig: null,
        configValid: false,
        envCheck: null
      };
    }
    const effective = new ConfigResolver({ env }).resolve(definition, { workflowPath: resolved.workflowPath });
    const envCheck = buildRequiredEnvCheck(definition, env, resolved.envFilePath);
    const workflowDetails = {
      workflowPath: resolved.workflowPath,
      trackerKind: effective.tracker.kind,
      trackerApiKey: effective.tracker.api_key
    };
    const validation = new ConfigValidator().validate(effective);
    if (!validation.ok) {
      return {
        check: {
          id: 'workflow.effective_config',
          title: 'Workflow effective config validates',
          status: 'failure',
          reason: validation.error_code,
          summary: validation.message,
          remediation: 'Fix WORKFLOW.md or the referenced environment variables before starting the dashboard.',
          details: { ...workflowDetails, at: validation.at }
        },
        effectiveConfig: effective,
        configValid: false,
        envCheck
      };
    }
    return {
      check: {
        id: 'workflow.effective_config',
        title: 'Workflow effective config validates',
        status: 'ok',
        reason: 'workflow_config_valid',
        summary: 'Workflow syntax and effective configuration are valid for local startup.',
        details: workflowDetails
      },
      effectiveConfig: effective,
      configValid: true,
      envCheck
    };
  } catch (error) {
    const code = error instanceof WorkflowConfigError ? error.code : 'workflow_validation_failed';
    const message = error instanceof Error ? error.message : String(error);
    return {
      check: {
        id: 'workflow.effective_config',
        title: 'Workflow effective config validates',
        status: 'failure',
        reason: code,
        summary: message,
        remediation: 'Fix WORKFLOW.md syntax/configuration before starting the dashboard.',
        details: { workflowPath: resolved.workflowPath }
      },
      effectiveConfig: null,
      configValid: false,
      envCheck: null
    };
  }
}

function runGit(cwd: string, args: readonly string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  };
}

function parseRemoteBaseRef(baseRef: string): { remote: string; ref: string } | null {
  const [remote, ...rest] = baseRef.split('/');
  if (!remote || rest.length === 0) {
    return null;
  }

  return { remote, ref: rest.join('/') };
}

function checkBaseRef(repoRoot: string, baseRef: string): DoctorFindingInput {
  const localRef = runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
  if (localRef.ok) {
    return {
      id: 'workspace.base_ref',
      title: 'Workspace base ref is ready',
      status: 'ok',
      reason: 'base_ref_exists',
      summary: `Base ref ${baseRef} resolves locally.`,
      details: { repoRoot, baseRef, source: 'local' }
    };
  }

  const remoteRef = parseRemoteBaseRef(baseRef);
  if (remoteRef) {
    const remote = runGit(repoRoot, ['ls-remote', '--exit-code', remoteRef.remote, remoteRef.ref]);
    if (remote.ok) {
      return {
        id: 'workspace.base_ref',
        title: 'Workspace base ref is ready',
        status: 'ok',
        reason: 'base_ref_fetchable',
        summary: `Base ref ${baseRef} is fetchable from ${remoteRef.remote}.`,
        details: { repoRoot, baseRef, source: 'remote', remote: remoteRef.remote, ref: remoteRef.ref }
      };
    }
  }

  return {
    id: 'workspace.base_ref',
    title: 'Workspace base ref is ready',
    status: 'failure',
    reason: 'base_ref_unavailable',
    summary: `Base ref ${baseRef} does not resolve locally and was not fetchable.`,
    remediation: 'Fetch the configured base ref or update workspace.provisioner.base_ref before running agents.',
    details: { repoRoot, baseRef, stderr: localRef.stderr.trim() }
  };
}

function checkCloneBaseRef(repoRoot: string, baseRef: string): DoctorFindingInput {
  const branchRef = `refs/heads/${baseRef}`;
  const branch = runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${branchRef}^{commit}`]);
  if (branch.ok) {
    return {
      id: 'workspace.base_ref',
      title: 'Workspace base ref is ready',
      status: 'ok',
      reason: 'base_ref_exists',
      summary: `Clone base ref ${baseRef} resolves to a source branch.`,
      details: { repoRoot, baseRef, source: 'clone_branch', ref: branchRef }
    };
  }

  const tagRef = `refs/tags/${baseRef}`;
  const tag = runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${tagRef}^{commit}`]);
  if (tag.ok) {
    return {
      id: 'workspace.base_ref',
      title: 'Workspace base ref is ready',
      status: 'ok',
      reason: 'base_ref_exists',
      summary: `Clone base ref ${baseRef} resolves to a source tag.`,
      details: { repoRoot, baseRef, source: 'clone_tag', ref: tagRef }
    };
  }

  return {
    id: 'workspace.base_ref',
    title: 'Workspace base ref is ready',
    status: 'failure',
    reason: 'base_ref_unavailable',
    summary: `Clone base ref ${baseRef} is not a source branch or tag.`,
    remediation: 'Set workspace.provisioner.base_ref to a branch or tag that git clone --branch can check out.',
    details: { repoRoot, baseRef, checkedRefs: [branchRef, tagRef], stderr: branch.stderr.trim() || tag.stderr.trim() }
  };
}

function addWorkspaceChecks(checks: DoctorFinding[], resolved: LocalCommandResolution, effectiveConfig: EffectiveConfig): void {
  const provisioner = effectiveConfig.workspace.provisioner;
  if (provisioner.type === 'none') {
    addCheck(checks, {
      id: 'workspace.provisioner',
      title: 'Workspace provisioner is configured',
      status: 'ok',
      reason: 'workspace_provisioner_disabled',
      summary: 'Workspace provisioning is disabled for this workflow.',
      details: { type: provisioner.type }
    });
    return;
  }

  const repoRoot = provisioner.repo_root;
  if (!repoRoot) {
    addCheck(checks, {
      id: 'workspace.git_repository',
      title: 'Workspace repository is ready',
      status: 'failure',
      reason: 'repo_root_missing',
      summary: 'workspace.provisioner.repo_root is not configured.',
      remediation: 'Set workspace.provisioner.repo_root to an existing git checkout.',
      details: { type: provisioner.type }
    });
    return;
  }

  const repoStat = fs.existsSync(repoRoot) ? fs.statSync(repoRoot) : null;
  if (!repoStat?.isDirectory()) {
    addCheck(checks, {
      id: 'workspace.git_repository',
      title: 'Workspace repository is ready',
      status: 'failure',
      reason: 'repo_root_missing',
      summary: `workspace.provisioner.repo_root is not a directory: ${repoRoot}`,
      remediation: 'Set workspace.provisioner.repo_root to an existing git checkout.',
      details: { type: provisioner.type, repoRoot }
    });
    return;
  }

  const insideWorkTree = runGit(repoRoot, ['rev-parse', '--is-inside-work-tree']);
  if (!insideWorkTree.ok || insideWorkTree.stdout.trim() !== 'true') {
    addCheck(checks, {
      id: 'workspace.git_repository',
      title: 'Workspace repository is ready',
      status: 'failure',
      reason: 'repo_root_not_git_repository',
      summary: `workspace.provisioner.repo_root is not a git work tree: ${repoRoot}`,
      remediation: 'Use a git checkout for workspace.provisioner.repo_root.',
      details: { type: provisioner.type, repoRoot, stderr: insideWorkTree.stderr.trim() }
    });
    return;
  }

  addCheck(checks, {
    id: 'workspace.git_repository',
    title: 'Workspace repository is ready',
    status: 'ok',
    reason: 'repo_root_git_repository',
    summary: `workspace.provisioner.repo_root is a git work tree: ${repoRoot}`,
    details: { type: provisioner.type, repoRoot }
  });

  if (provisioner.type === 'worktree') {
    const worktreeList = runGit(repoRoot, ['worktree', 'list', '--porcelain']);
    addCheck(checks, {
      id: 'workspace.worktree',
      title: 'Git worktree support is ready',
      status: worktreeList.ok ? 'ok' : 'failure',
      reason: worktreeList.ok ? 'worktree_list_ready' : 'worktree_list_failed',
      summary: worktreeList.ok ? 'Git worktree metadata can be inspected.' : 'Git worktree metadata could not be inspected.',
      remediation: worktreeList.ok ? undefined : 'Repair git worktree metadata before provisioning issue workspaces.',
      details: { repoRoot, stderr: worktreeList.stderr.trim() }
    });
  }

  addCheck(
    checks,
    provisioner.type === 'clone' ? checkCloneBaseRef(repoRoot, provisioner.base_ref) : checkBaseRef(repoRoot, provisioner.base_ref)
  );

  const status = runGit(repoRoot, ['status', '--porcelain']);
  const dirty = status.stdout.trim().length > 0;
  addCheck(checks, {
    id: 'workspace.dirty_policy',
    title: 'Dirty repository policy is satisfied',
    status: !dirty || provisioner.allow_dirty_repo ? 'ok' : 'failure',
    reason: dirty
      ? provisioner.allow_dirty_repo
        ? 'dirty_repo_allowed'
        : 'dirty_repo_blocked'
      : 'repo_clean',
    summary: dirty
      ? provisioner.allow_dirty_repo
        ? 'Repository has local changes and workflow allows dirty provisioning.'
        : 'Repository has local changes but workflow blocks dirty provisioning.'
      : 'Repository has no local changes.',
    remediation: dirty && !provisioner.allow_dirty_repo ? 'Commit, stash, or discard local changes before provisioning workspaces.' : undefined,
    details: {
      repoRoot,
      allowDirtyRepo: provisioner.allow_dirty_repo,
      dirtyEntries: status.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, 20)
    }
  });
}

function addCodexCommandCheck(checks: DoctorFinding[], effectiveConfig: EffectiveConfig, env: NodeJS.ProcessEnv): void {
  const command = effectiveConfig.codex.command;
  const executablePath = findCommandOnPath(command, env);
  addCheck(checks, {
    id: 'codex.command',
    title: 'Codex command is available',
    status: executablePath ? 'ok' : 'failure',
    reason: executablePath ? 'codex_command_available' : 'codex_command_missing',
    summary: executablePath ? `Codex command resolves to ${executablePath}.` : `Codex command is not executable: ${command}`,
    remediation: executablePath ? undefined : 'Install Codex or set codex.command to an executable command before starting agents.',
    details: { command, executablePath }
  });
}

function addTrackerCredentialCheck(checks: DoctorFinding[], effectiveConfig: EffectiveConfig): void {
  const tracker = effectiveConfig.tracker;
  if (tracker.kind === 'memory') {
    addCheck(checks, {
      id: 'tracker.credentials',
      title: 'Tracker credentials are ready',
      status: 'ok',
      reason: 'tracker_credentials_not_required',
      summary: 'Memory tracker mode does not require external tracker credentials.',
      details: { trackerKind: tracker.kind, required: false, present: true }
    });
    return;
  }

  const present = tracker.api_key.trim().length > 0;
  addCheck(checks, {
    id: 'tracker.credentials',
    title: 'Tracker credentials are ready',
    status: present ? 'ok' : 'failure',
    reason: present ? `${tracker.kind}_tracker_credentials_present` : `${tracker.kind}_tracker_credentials_missing`,
    summary: present
      ? `${tracker.kind} tracker credentials are present after environment resolution.`
      : `${tracker.kind} tracker credentials are missing after environment resolution.`,
    remediation: present ? undefined : `Set ${tracker.kind === 'linear' ? 'LINEAR_API_KEY' : 'GITHUB_TOKEN'} or tracker.api_key before starting Symphony.`,
    details: {
      trackerKind: tracker.kind,
      required: true,
      present
    }
  });
}

function addHookCommandReadinessCheck(checks: DoctorFinding[], effectiveConfig: EffectiveConfig, env: NodeJS.ProcessEnv): void {
  const hooks = [
    ['after_create', effectiveConfig.hooks.after_create],
    ['before_run', effectiveConfig.hooks.before_run],
    ['after_run', effectiveConfig.hooks.after_run],
    ['before_remove', effectiveConfig.hooks.before_remove]
  ]
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0)
    .map(([name, command]) => ({
      name,
      configured: true,
      commandPreview: command.split(/\r?\n/)[0].trim().slice(0, 120)
    }));
  const bashPath = findCommandOnPath('bash', env);
  const shellReady = Boolean(bashPath);

  addCheck(checks, {
    id: 'hooks.commands',
    title: 'Workspace hook command runner is ready',
    status: hooks.length === 0 ? 'ok' : shellReady ? 'ok' : 'failure',
    reason: shellReady
      ? hooks.length > 0
        ? 'hook_shell_ready'
        : 'no_hooks_configured'
      : hooks.length > 0
        ? 'hook_shell_missing'
        : 'no_hooks_configured',
    summary:
      hooks.length > 0
        ? shellReady
          ? `Found bash for ${hooks.length} configured workspace hook(s); hooks are reported but not executed by doctor.`
          : 'Workspace hooks are configured, but bash is not available for the runtime hook runner.'
        : shellReady
          ? 'No workspace hooks are configured.'
          : 'No workspace hooks are configured; bash was not found for future hook execution.',
    remediation:
      !shellReady && hooks.length > 0
        ? 'Install bash or adjust the runtime hook runner environment before provisioning workspaces.'
        : undefined,
    details: {
      bashPath,
      timeoutMs: effectiveConfig.hooks.timeout_ms,
      hooks,
      executed: false,
      guarantee: 'doctor verifies the hook shell is available and reports configured commands; it does not guarantee runtime hook success'
    }
  });
}

function renderHuman(result: DoctorJsonResult): string {
  const lines = [
    `Symphony doctor: ${result.status}`,
    `Reason: ${result.reason}`,
    `Exit code: ${result.exitCode}`,
    '',
    'Resolved context:',
    `  cwd: ${result.cwd}`,
    `  symphony checkout: ${result.symphonyCheckoutRoot}`,
    `  project root: ${result.resolution.projectRoot ?? '(unresolved)'}`,
    `  workflow: ${result.resolution.workflowPath ?? '(unresolved)'}`,
    `  env file: ${result.resolution.envFilePath ?? '(unresolved)'}`,
    `  profile: ${result.resolution.profile ?? '(unresolved)'}`,
    `  host: ${result.resolution.host ?? '(unresolved)'}`,
    `  port: ${
      result.resolution.port === null
        ? '(unresolved)'
        : `${result.resolution.port}${result.resolution.ephemeralPort ? ' (ephemeral)' : ''}`
    }`,
    `  consent: ${result.resolution.consent ?? '(unresolved)'}`,
    '',
    'Checks:'
  ];

  for (const check of result.findings) {
    lines.push(`  [${check.status}] ${check.title}: ${check.summary}`);
    if (check.remediation) {
      lines.push(`    next: ${check.remediation}`);
    }
  }

  if (result.fixes.length > 0) {
    lines.push('', 'Fix actions:');
    for (const fix of result.fixes) {
      lines.push(`  [${fix.status}] ${fix.id}: ${fix.summary}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export async function runLocalDoctor(options: RunLocalDoctorOptions): Promise<{
  result: DoctorJsonResult;
  human: string;
}> {
  const parsed = parseDoctorArgs(options.argv);
  const checks: DoctorFinding[] = [];
  const fixes: DoctorFixAction[] = [];
  const deps = options.deps;
  let resolved: LocalCommandResolution | null = null;
  let consentSource: SetupConsentSource | null = null;
  let layout: ProjectLayoutInspection | null = null;

  if ('error' in parsed) {
    addCheck(checks, {
      id: 'doctor.options',
      title: 'Doctor options parse',
      status: 'failure',
      reason: 'invalid_doctor_option',
      summary: parsed.error,
      remediation: 'Run `symphony doctor --help` for supported options.'
    });
  }

  const args = 'error' in parsed ? { json: false, ci: false, fix: false, yes: false, resolverArgv: [] } : parsed;
  const executablePath = findExecutableOnPath(deps.env);
  let shim: ShimMetadata | null = null;

  if (!executablePath) {
    addCheck(checks, {
      id: 'executable.discoverable',
      title: 'Local symphony executable is discoverable on PATH',
      status: 'failure',
      reason: 'path_missing',
      summary: '`symphony` was not found on PATH.',
      remediation: 'Run `npm run link:local` from the Symphony checkout, then ensure the linked bin directory is on PATH.'
    });
  } else {
    shim = parseShimMetadata(executablePath);
    if (!shim.owned) {
      addCheck(checks, {
        id: 'executable.discoverable',
        title: 'Local symphony executable is discoverable on PATH',
        status: 'failure',
        reason: 'link_unverifiable',
        summary: `Found ${executablePath}, but it is not a Symphony local shim.`,
        remediation: 'Run `npm run link:local` from the expected Symphony checkout or choose a PATH entry that points at the local shim.',
        details: { executablePath, verificationError: shim.verificationError }
      });
    } else if (shim.repoRoot && path.resolve(shim.repoRoot) !== path.resolve(deps.repoRoot)) {
      addCheck(checks, {
        id: 'executable.checkout',
        title: 'Local symphony executable points at this checkout',
        status: 'failure',
        reason: 'checkout_mismatch',
        summary: `PATH shim points at ${shim.repoRoot}, expected ${deps.repoRoot}.`,
        remediation: 'Refresh the local shim from this checkout with `npm run link:local`.',
        details: { executablePath, shimRepoRoot: shim.repoRoot, expectedRepoRoot: deps.repoRoot }
      });
    } else {
      addCheck(checks, {
        id: 'executable.checkout',
        title: 'Local symphony executable points at this checkout',
        status: 'ok',
        reason: 'checkout_match',
        summary: `PATH shim points at ${shim.repoRoot ?? deps.repoRoot}.`,
        details: { executablePath, shimRepoRoot: shim.repoRoot, shimEntrypoint: shim.entrypoint }
      });
    }
  }

  const shimRepoRoot = shim?.repoRoot ?? deps.repoRoot;
  addCheck(checks, checkCheckoutEntrypoint(shimRepoRoot, 'shim_checkout'));

  if (
    args.fix &&
    checks.some(
      (check) =>
        check.status !== 'ok' &&
        (check.id.startsWith('executable.') || check.reason === 'build_missing' || check.reason === 'checkout_missing')
    )
  ) {
    if (args.ci) {
      addFix(fixes, {
        id: 'link-local',
        status: 'skipped',
        summary: 'Link-local remediation was not run because `--ci` forbids doctor fix mutations.'
      });
    } else {
      const exitCode = await deps.runLinkLocal([]);
      addFix(fixes, {
        id: 'link-local',
        status: exitCode === 0 ? 'applied' : 'failed',
        summary:
          exitCode === 0
            ? 'Invoked `symphony link-local` remediation. Rerun doctor to verify PATH and shim state.'
            : `Link-local remediation failed with exit ${exitCode}.`,
        details: { exitCode }
      });
    }
  }

  try {
    resolved = deps.resolveLocalCommand({
      command: 'doctor',
      argv: args.resolverArgv,
      cwd: deps.cwd,
      env: deps.env,
      symphonyCheckoutRoot: deps.repoRoot
    });
    addCheck(checks, {
      id: 'resolver.workflow',
      title: 'Project workflow resolves',
      status: 'ok',
      reason: 'workflow_resolved',
      summary: `Resolved workflow ${resolved.workflowPath}.`,
      details: {
        projectRoot: resolved.currentProjectRoot,
        workflowPath: resolved.workflowPath,
        workflowSource: resolved.sources.workflowPath
      }
    });
    const dashboardEnv = {
      ...readEnvFileValues(resolved.envFilePath),
      ...deps.env
    };
    const workflowValidation = validateWorkflow(resolved, dashboardEnv);
    addCheck(checks, workflowValidation.check);
    if (workflowValidation.envCheck) {
      addCheck(checks, workflowValidation.envCheck);
    }
    if (workflowValidation.effectiveConfig) {
      addTrackerCredentialCheck(checks, workflowValidation.effectiveConfig);
      addHookCommandReadinessCheck(checks, workflowValidation.effectiveConfig, dashboardEnv);
      if (workflowValidation.configValid) {
        addCodexCommandCheck(checks, workflowValidation.effectiveConfig, dashboardEnv);
        addWorkspaceChecks(checks, resolved, workflowValidation.effectiveConfig);
      }
    }
    addCheck(checks, {
      id: 'env.path',
      title: 'Project env file path resolved',
      status: 'ok',
      reason: 'env_path_resolved',
      summary: `Would load ${resolved.envFilePath}.`,
      remediation: fs.existsSync(resolved.envFilePath)
        ? undefined
        : 'Create this .env file if the workflow requires local environment variables; doctor does not print secret values.',
      details: {
        envFilePath: resolved.envFilePath,
        source: resolved.sources.envFilePath,
        exists: fs.existsSync(resolved.envFilePath)
      }
    });

    layout = inspectProjectLayout(resolved.currentProjectRoot);
    if (args.fix && args.ci && !layout.ignoreAnalysis.hasNarrowSystemIgnore) {
      addFix(fixes, {
        id: 'layout.gitignore-system',
        status: 'skipped',
        summary: 'Runtime-state gitignore entry was not added because `--ci` forbids doctor fix mutations.'
      });
    } else if (args.fix && args.yes && !layout.ignoreAnalysis.hasNarrowSystemIgnore) {
      const fix = ensureSystemGitignoreEntry(resolved.currentProjectRoot);
      addFix(fixes, {
        id: 'layout.gitignore-system',
        status: fix.status,
        summary: fix.summary,
        details: fix.details
      });
      layout = inspectProjectLayout(resolved.currentProjectRoot);
    } else if (args.fix && !layout.ignoreAnalysis.hasNarrowSystemIgnore) {
      addFix(fixes, {
        id: 'layout.gitignore-system',
        status: 'skipped',
        summary: 'Runtime-state gitignore entry was not added because `--yes` was not provided.'
      });
    }
    addLayoutChecks(checks, layout);
    let workflowConfig: Record<string, unknown> = {};
    try {
      workflowConfig = new WorkflowLoader().load({ explicitPath: resolved.workflowPath }).config;
    } catch {
      workflowConfig = {};
    }
    addCustomizationChecks(checks, resolved, readWorkflowCustomizationMetadata(resolved.workflowPath, workflowConfig));

    const portAvailable = await canListen(resolved.host.host, resolved.port.port);
    addCheck(checks, {
      id: 'server.port',
      title: 'Dashboard host and port are available',
      status: portAvailable ? 'ok' : 'failure',
      reason: resolved.port.port === 0 ? 'ephemeral_port' : portAvailable ? 'fixed_port_available' : 'port_unavailable',
      summary:
        resolved.port.port === 0
          ? `Dashboard will request an ephemeral port on ${resolved.host.host}.`
          : portAvailable
            ? `Dashboard can bind ${resolved.host.host}:${resolved.port.port}.`
            : `Dashboard cannot bind ${resolved.host.host}:${resolved.port.port}.`,
      remediation: portAvailable ? undefined : 'Choose a different port with `--port <number>` or stop the process using that port.',
      details: { host: resolved.host.host, port: resolved.port.port, source: resolved.port.source }
    });

    const posture = deps.resolveWorkflowPosture(resolved.workflowPath, dashboardEnv);
    consentSource = args.resolverArgv.includes('--i-understand-that-this-will-be-running-without-the-usual-guardrails')
      ? 'flag'
      : 'missing';
    const setupConsentStoreInProject = isWithinPath(resolved.currentProjectRoot, deps.setupConsentStore.path);
    if (consentSource === 'missing' && !setupConsentStoreInProject) {
      const consent = findValidSetupConsent({ store: deps.setupConsentStore, resolved, posture });
      consentSource = consent ? 'setup' : 'missing';
    }
    if (consentSource === 'missing' && args.fix && args.ci) {
      addFix(fixes, {
        id: 'setup-consent',
        status: 'skipped',
        summary: 'Setup consent was not recorded because `--ci` forbids doctor fix mutations.'
      });
    } else if (consentSource === 'missing' && args.fix && args.yes) {
      if (setupConsentStoreInProject) {
        addFix(fixes, {
          id: 'setup-consent',
          status: 'failed',
          summary:
            'Refused to record setup consent because the configured local state path is inside the project checkout.',
          details: { storeLocation: 'project_checkout' }
        });
      } else {
        const record = buildSetupConsentRecord({
          resolved,
          posture,
          approvedAt: deps.clock().toISOString()
        });
        persistSetupConsent(deps.setupConsentStore, record);
        consentSource = 'setup';
        addFix(fixes, {
          id: 'setup-consent',
          status: 'applied',
          summary: `Recorded explicit setup consent for identity ${record.identity_key}.`
        });
      }
    } else if (consentSource === 'missing' && args.fix) {
      addFix(fixes, {
        id: 'setup-consent',
        status: 'skipped',
        summary: 'Setup consent was not recorded because `--yes` was not provided.'
      });
    }
    addCheck(checks, {
      id: 'setup.consent',
      title: 'High-trust setup consent is available',
      status: consentSource === 'missing' ? 'failure' : 'ok',
      reason: consentSource === 'missing' ? 'setup_consent_missing' : `setup_consent_${consentSource}`,
      summary:
        consentSource === 'missing'
          ? `No user-local setup consent exists for required posture ${posture.posture}.`
          : `Setup consent source is ${consentSource} for required posture ${posture.posture}.`,
      remediation:
        consentSource === 'missing'
          ? setupConsentStoreInProject
            ? 'Choose a user-local Symphony state path outside the project checkout, then rerun `symphony setup --yes` or `symphony doctor --fix --yes`.'
            : 'Run `symphony setup --yes` for this project/workflow, or rerun doctor with `--fix --yes` to record explicit local consent.'
          : undefined,
      safeFix: safeFixForFinding(
        { id: 'setup.consent', status: consentSource === 'missing' ? 'failure' : 'ok' },
        { setupConsentStorePath: deps.setupConsentStore.path }
      ),
      details: { posture: posture.posture, reason: posture.reason, evidence: posture.evidence }
    });
    addCheck(checks, {
      id: 'dashboard.prerequisites',
      title: 'Dashboard supervisor prerequisites are present',
      status: fs.existsSync(path.join(deps.repoRoot, 'scripts', 'start-dashboard-supervisor.js')) ? 'ok' : 'failure',
      reason: fs.existsSync(path.join(deps.repoRoot, 'scripts', 'start-dashboard-supervisor.js'))
        ? 'dashboard_supervisor_ready'
        : 'dashboard_supervisor_missing',
      summary: fs.existsSync(path.join(deps.repoRoot, 'scripts', 'start-dashboard-supervisor.js'))
        ? 'Dashboard supervisor script is present.'
        : 'Dashboard supervisor script is missing.',
      remediation: fs.existsSync(path.join(deps.repoRoot, 'scripts', 'start-dashboard-supervisor.js'))
        ? undefined
        : 'Refresh the Symphony checkout or rebuild before launching the dashboard.'
    });
  } catch (error) {
    const reason = error instanceof LocalCommandResolutionError ? error.code : 'resolver_failed';
    const message = error instanceof Error ? error.message : String(error);
    addCheck(checks, {
      id: 'resolver.workflow',
      title: 'Project workflow resolves',
      status: 'failure',
      reason,
      summary: message,
      remediation: 'Run from a project containing WORKFLOW.md or pass `--workflow <path>`.'
    });
  }

  const summary = summarizeStatus(checks);
  const result: DoctorJsonResult = {
    version: 1,
    command: 'doctor',
    status: summary.status,
    reason: summary.reason,
    exitCode: summary.exitCode,
    exitSemantics: {
      code: summary.exitCode,
      meaning:
        summary.reason === 'ready'
          ? 'ready'
          : summary.reason === 'warnings_present'
            ? 'warnings_non_blocking'
            : 'blockers_present',
      ci: {
        requested: args.ci,
        promptsAllowed: false,
        nonZeroOnBlocker: summary.status === 'failure'
      }
    },
    ci: args.ci,
    fix: args.fix,
    cwd: deps.cwd,
    symphonyCheckoutRoot: deps.repoRoot,
    resolution: {
      projectRoot: resolved?.currentProjectRoot ?? null,
      workflowPath: resolved?.workflowPath ?? null,
      envFilePath: resolved?.envFilePath ?? null,
      profile: resolved?.profile.name ?? null,
      host: resolved?.host.host ?? null,
      port: resolved?.port.port ?? null,
      ephemeralPort: resolved ? resolved.port.port === 0 : null,
      consent: consentSource
    },
    layout,
    findings: checks,
    checks,
    projectContext: {
      cwd: deps.cwd,
      symphonyCheckoutRoot: deps.repoRoot,
      projectRoot: resolved?.currentProjectRoot ?? null,
      workflowPath: resolved?.workflowPath ?? null,
      envFilePath: resolved?.envFilePath ?? null,
      envFileExists: resolved ? fs.existsSync(resolved.envFilePath) : null,
      profile: resolved?.profile.name ?? null
    },
    fixes
  };

  return { result, human: renderHuman(result) };
}
