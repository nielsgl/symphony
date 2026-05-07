import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { REASON_CODE_REGISTRY_VERSION } from '../observability/reason-codes';
import type { DurableRunHistoryRecord, ExecutionGraphThreadLineage } from '../persistence';
import { redactUnknown } from '../security/redaction';
import type { MissingToolOutputRecoveryEvidence } from './missing-tool-output-recovery';
import { buildThreadDiagnosticsFromLineage } from './thread-diagnostics';
import type {
  ApiDiagnosticsResponse,
  ThreadDiagnosticsEvent,
  ThreadDiagnosticsPhaseSpan,
  ThreadDiagnosticsResponse,
  ThreadDiagnosticsToolSpan,
  ThreadDiagnosticsWaitSpan
} from './types';

export const FORENSICS_BUNDLE_SCHEMA_VERSION = 'symphony.forensics.bundle.v1';

export interface ForensicsTokenSnapshot {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cached_input_tokens?: number | null;
  reasoning_output_tokens?: number | null;
  model_context_window?: number | null;
}

export interface ForensicsBundle {
  schema_version: typeof FORENSICS_BUNDLE_SCHEMA_VERSION;
  generated_at: string;
  generated_at_ms: number;
  source: {
    issue_identifier: string;
    thread_id: string;
    attempt: number;
  };
  timeline_events: ThreadDiagnosticsEvent[];
  spans: {
    phase: ThreadDiagnosticsPhaseSpan[];
    tool: ThreadDiagnosticsToolSpan[];
    wait: ThreadDiagnosticsWaitSpan[];
  };
  config_fingerprint: {
    algorithm: 'sha256';
    value: string;
  };
  workflow_hash: {
    algorithm: 'sha256';
    value: string;
    workflow_path: string | null;
  };
  reason_taxonomy_version: string;
  token_snapshot: ForensicsTokenSnapshot;
  diagnostics: ThreadDiagnosticsResponse;
  missing_tool_output_recovery: MissingToolOutputRecoveryEvidence | Record<string, unknown> | null;
  lineage: ExecutionGraphThreadLineage | null;
  terminal_run: DurableRunHistoryRecord | null;
}

export interface ForensicsReplayResult {
  schema_version: 'symphony.forensics.replay.v1';
  replayed_at: string;
  bundle_generated_at: string;
  deterministic: boolean;
  diagnostics: ThreadDiagnosticsResponse;
}

export interface ForensicsDiffResult {
  schema_version: 'symphony.forensics.diff.v1';
  equal: boolean;
  first_divergence: ForensicsDivergence | null;
}

export interface ForensicsDivergence {
  category: 'phase' | 'tool' | 'reason' | 'tokens' | 'timeline' | 'bundle';
  index: number | null;
  field: string;
  left: unknown;
  right: unknown;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashWorkflow(workflowPath: string | null | undefined): string {
  if (!workflowPath) {
    return sha256('workflow_path:null');
  }
  try {
    return sha256(fs.readFileSync(workflowPath, 'utf8'));
  } catch {
    return sha256(`workflow_path:${workflowPath}`);
  }
}

function buildConfigFingerprint(diagnostics: ApiDiagnosticsResponse | null): string {
  if (!diagnostics) {
    return sha256('diagnostics:null');
  }
  return sha256(
    stableStringify({
      active_profile: diagnostics.active_profile,
      runtime_resolution: diagnostics.runtime_resolution,
      token_accounting: diagnostics.token_accounting,
      phase_markers: diagnostics.phase_markers,
      workspace_provisioner: diagnostics.workspace_provisioner,
      workspace_copy_ignored: diagnostics.workspace_copy_ignored
    })
  );
}

function normalizeTokens(tokens?: Partial<ForensicsTokenSnapshot> | null): ForensicsTokenSnapshot {
  return {
    input_tokens: typeof tokens?.input_tokens === 'number' ? tokens.input_tokens : null,
    output_tokens: typeof tokens?.output_tokens === 'number' ? tokens.output_tokens : null,
    total_tokens: typeof tokens?.total_tokens === 'number' ? tokens.total_tokens : null,
    ...(typeof tokens?.cached_input_tokens === 'number' ? { cached_input_tokens: tokens.cached_input_tokens } : {}),
    ...(typeof tokens?.reasoning_output_tokens === 'number' ? { reasoning_output_tokens: tokens.reasoning_output_tokens } : {}),
    ...(typeof tokens?.model_context_window === 'number' ? { model_context_window: tokens.model_context_window } : {})
  };
}

export function createForensicsBundle(params: {
  diagnostics: ThreadDiagnosticsResponse;
  api_diagnostics: ApiDiagnosticsResponse | null;
  lineage?: ExecutionGraphThreadLineage | null;
  token_snapshot?: Partial<ForensicsTokenSnapshot> | null;
  terminal_run?: DurableRunHistoryRecord | null;
  generated_at_ms?: number;
}): ForensicsBundle {
  const generatedAtMs = params.generated_at_ms ?? Date.now();
  const workflowPath = params.api_diagnostics?.runtime_resolution.workflow_path ?? null;
  const bundle: ForensicsBundle = {
    schema_version: FORENSICS_BUNDLE_SCHEMA_VERSION,
    generated_at: new Date(generatedAtMs).toISOString(),
    generated_at_ms: generatedAtMs,
    source: {
      issue_identifier: params.diagnostics.issue_identifier,
      thread_id: params.diagnostics.thread_id,
      attempt: params.diagnostics.attempt
    },
    timeline_events: params.diagnostics.timeline,
    spans: {
      phase: params.diagnostics.phase_spans,
      tool: params.diagnostics.tool_spans,
      wait: params.diagnostics.wait_spans
    },
    config_fingerprint: {
      algorithm: 'sha256',
      value: buildConfigFingerprint(params.api_diagnostics)
    },
    workflow_hash: {
      algorithm: 'sha256',
      value: hashWorkflow(workflowPath),
      workflow_path: workflowPath
    },
    reason_taxonomy_version: REASON_CODE_REGISTRY_VERSION,
    token_snapshot: normalizeTokens(params.token_snapshot),
    diagnostics: params.diagnostics,
    missing_tool_output_recovery:
      params.diagnostics.current_blocker?.missing_tool_output_recovery ?? params.terminal_run?.missing_tool_output_recovery ?? null,
    lineage: params.lineage ?? null,
    terminal_run: params.terminal_run ?? null
  };

  return redactUnknown(bundle) as ForensicsBundle;
}

export function replayForensicsBundle(bundle: ForensicsBundle, replayedAtMs: number = bundle.generated_at_ms): ForensicsReplayResult {
  assertForensicsBundle(bundle);
  const diagnostics = bundle.lineage
    ? buildThreadDiagnosticsFromLineage({
        lineage: bundle.lineage,
        now_ms: bundle.generated_at_ms
      })
    : {
        ...bundle.diagnostics,
        timeline: bundle.timeline_events,
        phase_spans: bundle.spans.phase,
        tool_spans: bundle.spans.tool,
        wait_spans: bundle.spans.wait
      };

  return {
    schema_version: 'symphony.forensics.replay.v1',
    replayed_at: new Date(replayedAtMs).toISOString(),
    bundle_generated_at: bundle.generated_at,
    deterministic: stableStringify(diagnostics) === stableStringify(replayForensicsDiagnostics(bundle)),
    diagnostics
  };
}

function replayForensicsDiagnostics(bundle: ForensicsBundle): ThreadDiagnosticsResponse {
  return bundle.lineage
    ? buildThreadDiagnosticsFromLineage({
        lineage: bundle.lineage,
        now_ms: bundle.generated_at_ms
      })
    : {
        ...bundle.diagnostics,
        timeline: bundle.timeline_events,
        phase_spans: bundle.spans.phase,
        tool_spans: bundle.spans.tool,
        wait_spans: bundle.spans.wait
      };
}

export function diffForensicsBundles(left: ForensicsBundle, right: ForensicsBundle): ForensicsDiffResult {
  assertForensicsBundle(left);
  assertForensicsBundle(right);
  const checks: Array<ForensicsDivergence | null> = [
    compareScalar('bundle', 'schema_version', left.schema_version, right.schema_version),
    compareScalar('bundle', 'config_fingerprint.value', left.config_fingerprint.value, right.config_fingerprint.value),
    compareScalar('bundle', 'workflow_hash.value', left.workflow_hash.value, right.workflow_hash.value),
    compareScalar('reason', 'reason_taxonomy_version', left.reason_taxonomy_version, right.reason_taxonomy_version),
    compareSequence('phase', left.spans.phase, right.spans.phase, ['phase', 'status', 'reason_code', 'reason_detail', 'started_at_ms', 'ended_at_ms']),
    compareSequence('tool', left.spans.tool, right.spans.tool, ['tool_name', 'status', 'reason_code', 'reason_detail', 'started_at_ms', 'ended_at_ms']),
    compareSequence('reason', left.timeline_events, right.timeline_events, ['event', 'reason_code', 'reason_detail', 'turn_id']),
    compareScalar('tokens', 'token_snapshot', left.token_snapshot, right.token_snapshot)
  ];
  const first = checks.find((check): check is ForensicsDivergence => check !== null) ?? null;
  return {
    schema_version: 'symphony.forensics.diff.v1',
    equal: first === null,
    first_divergence: first
  };
}

function compareScalar(
  category: ForensicsDivergence['category'],
  field: string,
  left: unknown,
  right: unknown
): ForensicsDivergence | null {
  return stableStringify(left) === stableStringify(right)
    ? null
    : {
        category,
        index: null,
        field,
        left,
        right
      };
}

function compareSequence(
  category: ForensicsDivergence['category'],
  left: unknown[],
  right: unknown[],
  fields: string[]
): ForensicsDivergence | null {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftEntry = (left[index] ?? null) as Record<string, unknown> | null;
    const rightEntry = (right[index] ?? null) as Record<string, unknown> | null;
    if (!leftEntry || !rightEntry) {
      return { category, index, field: 'length', left: leftEntry, right: rightEntry };
    }
    for (const field of fields) {
      if (stableStringify(leftEntry[field]) !== stableStringify(rightEntry[field])) {
        return {
          category,
          index,
          field,
          left: leftEntry[field],
          right: rightEntry[field]
        };
      }
    }
  }
  return null;
}

export function assertForensicsBundle(value: unknown): asserts value is ForensicsBundle {
  if (!value || typeof value !== 'object') {
    throw new Error('Forensics bundle must be a JSON object');
  }
  const bundle = value as Partial<ForensicsBundle>;
  if (bundle.schema_version !== FORENSICS_BUNDLE_SCHEMA_VERSION) {
    throw new Error(`Unsupported forensics bundle schema_version: ${String(bundle.schema_version)}`);
  }
  if (!bundle.diagnostics || !Array.isArray(bundle.timeline_events) || !bundle.spans) {
    throw new Error('Forensics bundle is missing diagnostics, timeline_events, or spans');
  }
  if (!bundle.config_fingerprint?.value || !bundle.workflow_hash?.value || !bundle.reason_taxonomy_version) {
    throw new Error('Forensics bundle is missing fingerprint, workflow hash, or reason taxonomy version');
  }
}
