import type { DurableRunHistoryRecord } from '../../persistence';
import { buildStoppedRunRecoveryEntries } from '../dashboard-view-model';
import { LocalApiError } from '../errors';
import { buildThreadDiagnosticsFromLineage } from '../thread-diagnostics';
import type {
  ApiStateResponse,
  LocalApiServerOptions,
  ThreadDiagnosticsResponse
} from '../types';
import type { SnapshotService } from '../snapshot-service';

const TERMINAL_RUN_TIMELINE_EVENT = {
  started: 'run.started',
  rootCauseDiagnostic: 'run.root_cause_diagnostic',
  terminal: 'run.terminal'
} as const;

function statusFromTerminalRun(run: DurableRunHistoryRecord): ThreadDiagnosticsResponse['status'] {
  switch (run.terminal_status) {
    case 'succeeded':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'stalled':
    case 'timed_out':
      return 'stalled';
    default:
      return 'completed';
  }
}

export function diagnosticsFromTerminalRun(run: DurableRunHistoryRecord): ThreadDiagnosticsResponse {
  const startedAtMs = Date.parse(run.started_at);
  const endedAtMs = run.ended_at ? Date.parse(run.ended_at) : Date.now();
  const rootCauseAtMs = run.root_cause_at ? Date.parse(run.root_cause_at) : NaN;
  const threadId = run.thread_id ?? run.session_id ?? run.session_ids[0] ?? run.run_id;
  return {
    thread_id: threadId,
    issue_identifier: run.issue_identifier,
    attempt: 0,
    status: statusFromTerminalRun(run),
    timeline: [
      {
        at_ms: Number.isFinite(startedAtMs) ? startedAtMs : 0,
        event: TERMINAL_RUN_TIMELINE_EVENT.started,
        reason_code: null,
        reason_detail: null,
        thread_id: threadId,
        turn_id: run.turn_id,
        session_id: run.session_id
      },
      ...(Number.isFinite(rootCauseAtMs)
        ? [
            {
              at_ms: rootCauseAtMs,
              event: TERMINAL_RUN_TIMELINE_EVENT.rootCauseDiagnostic,
              reason_code: run.root_cause_reason_code,
              reason_detail: run.root_cause_reason_detail,
              thread_id: threadId,
              turn_id: run.turn_id,
              session_id: run.session_id
            }
          ]
        : []),
      {
        at_ms: Number.isFinite(endedAtMs) ? endedAtMs : 0,
        event: TERMINAL_RUN_TIMELINE_EVENT.terminal,
        reason_code: run.terminal_reason_code ?? run.error_code,
        reason_detail: run.terminal_reason_detail,
        thread_id: threadId,
        turn_id: run.turn_id,
        session_id: run.session_id
      }
    ],
    phase_spans: [],
    tool_spans: [],
    wait_spans: [],
    capability_warnings: [],
    current_blocker: null,
    last_meaningful_progress_at_ms: Number.isFinite(rootCauseAtMs)
      ? rootCauseAtMs
      : Number.isFinite(startedAtMs)
        ? startedAtMs
        : null
  };
}

export function isCompletedTerminalRun(run: DurableRunHistoryRecord): boolean {
  return run.ended_at !== null && run.terminal_status !== null;
}

function buildCapabilityWarningsByThreadId(
  runs: ReturnType<NonNullable<LocalApiServerOptions['diagnosticsSource']>['listRunHistory']>,
  diagnosticsSource: LocalApiServerOptions['diagnosticsSource']
) {
  const warningsByThreadId = new Map<string, ReturnType<typeof buildThreadDiagnosticsFromLineage>['capability_warnings']>();
  if (!diagnosticsSource?.reconstructThreadLineage) {
    return warningsByThreadId;
  }
  for (const run of runs) {
    if (!run.thread_id || warningsByThreadId.has(run.thread_id)) {
      continue;
    }
    const lineage = diagnosticsSource.reconstructThreadLineage(run.thread_id);
    if (!lineage) {
      continue;
    }
    const diagnostics = buildThreadDiagnosticsFromLineage({ lineage });
    if (diagnostics.capability_warnings.length > 0) {
      warningsByThreadId.set(run.thread_id, diagnostics.capability_warnings);
    }
  }
  return warningsByThreadId;
}

export function buildStoppedRunRecoveryResponse(options: {
  limit?: number;
  diagnosticsSource: LocalApiServerOptions['diagnosticsSource'];
  snapshotSource: LocalApiServerOptions['snapshotSource'];
  snapshotService: SnapshotService;
}): {
  stopped_runs: ApiStateResponse['stopped_runs'];
  counts: { stopped: number };
} {
  if (!options.diagnosticsSource) {
    throw new LocalApiError('stopped_run_recovery_unavailable', 'Stopped-run recovery source is not configured', 503);
  }
  const state = options.snapshotSource.getStateSnapshot({ includeTranscriptToolCallDiagnostics: false });
  const payload = options.snapshotService.projectState(state);
  const runs = options.diagnosticsSource.listRunHistory(options.limit ?? 25);
  const activeIssueIdentifiers = new Set<string>([
    ...payload.running.map((entry) => entry.issue_identifier),
    ...payload.retrying.map((entry) => entry.issue_identifier),
    ...payload.blocked.map((entry) => entry.issue_identifier)
  ]);
  const blockedIssueIdentifiers = new Set<string>(payload.blocked.map((entry) => entry.issue_identifier));
  const stoppedRuns = buildStoppedRunRecoveryEntries({
    runs,
    activeIssueIdentifiers,
    blockedIssueIdentifiers,
    capabilityWarningsByThreadId: buildCapabilityWarningsByThreadId(runs, options.diagnosticsSource)
  });
  return {
    stopped_runs: stoppedRuns,
    counts: {
      stopped: stoppedRuns.filter((entry) => !entry.active_issue_present).length
    }
  };
}
