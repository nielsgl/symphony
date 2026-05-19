import { afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { LocalApiServer } from '../../src/api';
import { LocalApiError } from '../../src/api/errors';
import type { EventLoopHealthMonitor, EventLoopHealthSummary } from '../../src/api/event-loop-health';
import { replayForensicsBundle, type ForensicsBundle } from '../../src/api/forensics';
import type { OrchestratorState, TranscriptToolCallDiagnostic, TranscriptToolCallLineage } from '../../src/orchestrator';
import { CANONICAL_EVENT, EVENT_VOCABULARY_VERSION } from '../../src/observability/events';
import { REASON_CODES } from '../../src/observability/reason-codes';
import type { DurableIdentity, ExecutionGraphThreadLineage, ProjectHistoryTicketSummaryProjection, TicketTimelineRecord } from '../../src/persistence';
import type { Issue } from '../../src/tracker';

export function makeRunningEntry(overrides: Record<string, unknown> = {}) {
  return {
    issue: makeIssue(),
    identifier: 'ABC-1',
    run_id: 'run-1',
    worker_handle: {},
    monitor_handle: {},
    retry_attempt: 0,
    workspace_path: '/tmp/symphony/ABC-1',
    provisioner_type: 'none',
    branch_name: null,
    repo_root: null,
    workspace_exists: true,
    workspace_git_status: 'unknown' as const,
    workspace_provisioned: false,
    workspace_is_git_worktree: false,
    session_id: 'thread-1-turn-1',
    thread_id: 'thread-1',
    turn_id: 'turn-1',
    codex_app_server_pid: '9999',
    turn_count: 2,
    last_event: CANONICAL_EVENT.codex.turnCompleted,
    last_event_summary: 'codex turn completed: completed work',
    last_message: 'completed work',
    tokens: {
      input_tokens: 12,
      output_tokens: 8,
      total_tokens: 20
    },
    last_reported_tokens: {
      input_tokens: 12,
      output_tokens: 8,
      total_tokens: 20
    },
    token_telemetry_status: 'available' as const,
    token_telemetry_last_source: 'terminal_turn_summary',
    token_telemetry_last_at_ms: Date.parse('2026-04-10T10:01:00.000Z'),
    token_telemetry_turn_started_at_ms: Date.parse('2026-04-10T10:00:30.000Z'),
    token_telemetry_warning_emitted: false,
    recent_events: [
      {
        at_ms: Date.parse('2026-04-10T10:00:30.000Z'),
        event: CANONICAL_EVENT.codex.turnStarted,
        message: null
      },
      {
        at_ms: Date.parse('2026-04-10T10:01:00.000Z'),
        event: CANONICAL_EVENT.codex.turnCompleted,
        message: 'completed work'
      }
    ],
    started_at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
    last_codex_timestamp_ms: Date.parse('2026-04-10T10:01:00.000Z'),
    ...overrides
  };
}

export function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    identifier: 'ABC-1',
    title: 'Issue ABC-1',
    description: null,
    priority: 1,
    state: 'In Progress',
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: new Date('2026-04-10T10:00:00.000Z'),
    updated_at: new Date('2026-04-10T10:00:00.000Z'),
    ...overrides
  };
}

export function makeProjectHistoryIdentity(overrides: {
  projectKey?: string;
  ticketKey?: string;
  remoteIssueId?: string;
  humanIssueIdentifier?: string;
} = {}): DurableIdentity {
  return {
    project: {
      key: overrides.projectKey ?? 'project-main',
      project_root: '/repo/main',
      workflow_path: '/repo/main/WORKFLOW.md',
      workflow_hash: { status: 'present', value: 'workflow-hash' },
      repository_remote: { status: 'present', value: 'git@github.com:nielsgl/symphony.git' }
    },
    ticket: {
      key: overrides.ticketKey ?? 'ticket-abc-1',
      tracker_kind: 'linear',
      tracker_scope: { status: 'present', value: 'symphony' },
      remote_issue_id: overrides.remoteIssueId ?? 'remote-abc-1',
      human_issue_identifier: overrides.humanIssueIdentifier ?? 'ABC-1'
    }
  };
}

export function makeProjectHistoryTimeline(identity: DurableIdentity, overrides: Partial<TicketTimelineRecord> = {}): TicketTimelineRecord {
  const issueRunId = `${identity.ticket.key}-issue-run`;
  const attemptId = `${identity.ticket.key}-attempt-0`;
  const threadId = `${identity.ticket.key}-thread`;
  const turnId = `${identity.ticket.key}-turn`;
  return {
    identity,
    issue_runs: [
      {
        issue_run_id: issueRunId,
        issue_id: identity.ticket.remote_issue_id,
        issue_identifier: identity.ticket.human_issue_identifier,
        identity,
        started_at: '2026-04-10T10:00:00.000Z',
        ended_at: '2026-04-10T10:20:00.000Z',
        status: 'succeeded',
        reason_code: null,
        reason_detail: null
      }
    ],
    attempts: [
      {
        attempt_id: attemptId,
        issue_run_id: issueRunId,
        attempt_number: 0,
        started_at: '2026-04-10T10:00:01.000Z',
        ended_at: '2026-04-10T10:20:00.000Z',
        status: 'succeeded',
        reason_code: null,
        reason_detail: null
      }
    ],
    threads: [
      {
        thread_id: threadId,
        attempt_id: attemptId,
        started_at: '2026-04-10T10:00:02.000Z',
        ended_at: '2026-04-10T10:18:00.000Z',
        status: 'succeeded',
        reason_code: null,
        reason_detail: null
      }
    ],
    turns: [
      {
        turn_id: turnId,
        thread_id: threadId,
        turn_index: 0,
        started_at: '2026-04-10T10:00:03.000Z',
        ended_at: '2026-04-10T10:10:00.000Z',
        status: 'succeeded',
        reason_code: null,
        reason_detail: null
      }
    ],
    phase_spans: [
      {
        phase_span_id: `${identity.ticket.key}-phase`,
        turn_id: turnId,
        phase: 'implementation',
        started_at: '2026-04-10T10:01:00.000Z',
        ended_at: '2026-04-10T10:09:00.000Z',
        status: 'succeeded',
        reason_code: null,
        reason_detail: null
      }
    ],
    state_transitions: [
      {
        state_transition_id: `${identity.ticket.key}-state`,
        issue_run_id: issueRunId,
        attempt_id: attemptId,
        thread_id: threadId,
        turn_id: null,
        from_status: 'In Progress',
        to_status: 'Agent Review',
        transitioned_at: '2026-04-10T10:19:00.000Z',
        status: 'succeeded',
        reason_code: 'review_ready',
        reason_detail: null
      }
    ],
    terminal_outcomes: [
      {
        terminal_outcome_id: `${identity.ticket.key}-outcome`,
        issue_run_id: issueRunId,
        attempt_id: attemptId,
        thread_id: threadId,
        turn_id: turnId,
        outcome: 'succeeded',
        reason_code: 'agent_review_ready',
        reason_detail: null,
        recorded_at: '2026-04-10T10:20:00.000Z'
      }
    ],
    blockers: [],
    evidence_references: [],
    tracker_snapshots: [
      {
        tracker_snapshot_id: `${identity.ticket.key}-tracker`,
        project_key: identity.project.key,
        ticket_key: identity.ticket.key,
        issue_run_id: issueRunId,
        attempt_id: attemptId,
        thread_id: threadId,
        turn_id: turnId,
        tracker_kind: 'linear',
        tracker_scope_status: 'present',
        tracker_scope_value: 'symphony',
        tracker_scope_reason: null,
        remote_issue_id: identity.ticket.remote_issue_id,
        human_issue_identifier: identity.ticket.human_issue_identifier,
        title: `Ticket ${identity.ticket.human_issue_identifier}`,
        tracker_status: 'Agent Review',
        assignee_status: 'unknown',
        assignee_identifier: null,
        assignee_reason: null,
        labels: ['ready-for-agent'],
        project_status: 'available',
        project_identifier: identity.project.key,
        project_reason: null,
        team_status: 'available',
        team_identifier: 'Nielsgl',
        team_reason: null,
        observed_at: '2026-04-10T10:20:00.000Z',
        observation_hash: `${identity.ticket.key}-tracker-hash`,
        duplicate_count: 1,
        last_observed_at: '2026-04-10T10:20:00.000Z'
      }
    ],
    ticket_references: [],
    operator_actions: [],
    blocked_input_events: [],
    app_server_events: [],
    token_model_facts: [],
    ...overrides
  };
}

export function makeProjectHistorySummary(timeline: TicketTimelineRecord): ProjectHistoryTicketSummaryProjection {
  const latestIssueRun = timeline.issue_runs.at(-1) ?? null;
  const latestAttempt = timeline.attempts.at(-1) ?? null;
  const latestOutcome = timeline.terminal_outcomes.at(-1) ?? null;
  const latestTrackerSnapshot = timeline.tracker_snapshots.at(-1) ?? null;
  const latestTransition = timeline.state_transitions.at(-1) ?? null;
  const lastKnownStatus = latestTrackerSnapshot?.tracker_status ?? latestTransition?.to_status ?? latestIssueRun?.status ?? 'unknown';
  const appServerEvents = timeline.app_server_events;
  return {
    identity: timeline.identity,
    state: latestIssueRun && (latestIssueRun.ended_at === null || ['pending', 'running', 'retrying', 'blocked'].includes(latestIssueRun.status))
      ? 'active'
      : 'completed',
    current_status: lastKnownStatus,
    last_known_status: lastKnownStatus,
    latest_attempt: {
      attempt_id: latestAttempt?.attempt_id ?? null,
      attempt_number: latestAttempt?.attempt_number ?? null,
      status: latestAttempt?.status ?? null,
      started_at: latestAttempt?.started_at ?? null,
      ended_at: latestAttempt?.ended_at ?? null,
      outcome: latestOutcome?.outcome ?? null,
      outcome_reason_code: latestOutcome?.reason_code ?? null
    },
    summary: {
      issue_run_count: timeline.issue_runs.length,
      attempt_count: timeline.attempts.length,
      thread_count: timeline.threads.length,
      turn_count: timeline.turns.length,
      phase_count: timeline.phase_spans.length,
      state_transition_count: timeline.state_transitions.length,
      active_blocker_count: timeline.blockers.filter((blocker) => blocker.status === 'active').length,
      resolved_blocker_count: timeline.blockers.filter((blocker) => blocker.status === 'resolved').length,
      evidence_reference_count: timeline.evidence_references.length,
      tracker_snapshot_count: timeline.tracker_snapshots.length,
      ticket_reference_count: timeline.ticket_references.length,
      operator_action_count: timeline.operator_actions.length,
      blocked_input_event_count: timeline.blocked_input_events.length,
      app_server_event_count: appServerEvents.length,
      token_model_fact_count: timeline.token_model_facts.length,
      total_tokens: timeline.token_model_facts.reduce<number | null>((sum, fact) => {
        if (fact.total_tokens === null) {
          return sum;
        }
        return (sum ?? 0) + fact.total_tokens;
      }, null)
    },
    app_server_lite: {
      redacted_event_count: appServerEvents.filter((event) => event.redaction_status === 'redacted').length,
      truncated_event_count: appServerEvents.filter((event) => event.truncation.truncated).length,
      summary_only_event_count: appServerEvents.filter((event) => event.detail_status === 'summary_only').length,
      unavailable_event_count: appServerEvents.filter((event) => event.unavailable_reason_code).length,
      full_payload_stored_count: appServerEvents.filter((event) => event.full_payload_stored).length,
      degraded_event_count: appServerEvents.filter((event) => event.full_payload_stored).length,
      unavailable_reasons: []
    },
    latest_observed_at: [
      latestIssueRun?.started_at,
      latestAttempt?.started_at,
      latestOutcome?.recorded_at,
      latestTrackerSnapshot?.last_observed_at,
      latestTransition?.transitioned_at,
      appServerEvents.at(-1)?.observed_at
    ]
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null
  };
}

export function makeState(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  return {
    poll_interval_ms: 30_000,
    max_concurrent_agents: 10,
    running: new Map(),
    claimed: new Set(),
    retry_attempts: new Map(),
    blocked_inputs: new Map(),
    circuit_breakers: new Map(),
    completed: new Set(),
    codex_totals: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      seconds_running: 0
    },
    codex_rate_limits: null,
    health: {
      dispatch_validation: 'ok',
      last_error: null
    },
    throughput: {
      current_tps: 0,
      avg_tps_60s: 0,
      window_seconds: 600,
      sparkline_10m: Array.from({ length: 24 }, () => 0),
      sample_count: 0
    },
    recent_runtime_events: [],
    ...overrides
  };
}

export function makeTranscriptDiagnostic(
  index: number,
  overrides: Partial<TranscriptToolCallDiagnostic> = {}
): TranscriptToolCallDiagnostic {
  const lineage = (['active_owned', 'prior_stale', 'external_manual', 'unattributed'] as TranscriptToolCallLineage[])[
    index % 4
  ];
  return {
    kind: index % 2 === 0 ? 'function_call' : 'function_call_output',
    call_id: `call-${index}`,
    tool_name: 'linear_graphql',
    thread_id: `thread-${index % 3}`,
    turn_id: `turn-${index % 5}`,
    session_id: `session-${index % 7}`,
    issue_id: `issue-${index % 2}`,
    issue_identifier: `ABC-${index % 2}`,
    run_id: `run-${index % 2}`,
    issue_run_id: `issue-run-${index % 2}`,
    attempt_id: `attempt-${index % 2}`,
    codex_app_server_pid: `${1000 + index}`,
    observed_at_ms: Date.parse('2026-04-10T10:01:00.000Z') + index * 1000,
    lineage,
    reason: `${lineage} diagnostic`,
    active_issue_id: 'issue-active',
    active_issue_identifier: 'ABC-ACTIVE',
    active_run_id: 'run-active',
    active_issue_run_id: 'issue-run-active',
    active_attempt_id: 'attempt-active',
    active_codex_app_server_pid: '9999',
    active_thread_id: 'thread-active',
    active_turn_id: 'turn-active',
    active_session_id: 'session-active',
    ...overrides
  };
}

export function makeThreadLineage(overrides: {
  thread_id?: string;
  issue_identifier?: string;
  thread_status?: 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'retrying';
  thread_ended_at?: string | null;
} = {}): ExecutionGraphThreadLineage {
  const threadId = overrides.thread_id ?? 'thread-complete';
  const issueIdentifier = overrides.issue_identifier ?? 'ABC-1';
  const threadStatus = overrides.thread_status ?? 'succeeded';
  return {
    issue_run: {
      issue_run_id: 'issue_run_1',
      issue_id: 'issue-1',
      issue_identifier: issueIdentifier,
      started_at: '2026-04-10T10:00:00.000Z',
      ended_at: overrides.thread_ended_at ?? '2026-04-10T10:02:00.000Z',
      status: threadStatus,
      reason_code: null,
      reason_detail: null
    },
    attempt: {
      attempt_id: 'attempt_1',
      issue_run_id: 'issue_run_1',
      attempt_number: 2,
      started_at: '2026-04-10T10:00:01.000Z',
      ended_at: overrides.thread_ended_at ?? '2026-04-10T10:02:00.000Z',
      status: threadStatus,
      reason_code: null,
      reason_detail: null
    },
    thread: {
      thread_id: threadId,
      attempt_id: 'attempt_1',
      started_at: '2026-04-10T10:00:02.000Z',
      ended_at: overrides.thread_ended_at ?? '2026-04-10T10:02:00.000Z',
      status: threadStatus,
      reason_code: null,
      reason_detail: null
    },
    turns: [
      {
        turn_id: 'turn-1',
        thread_id: threadId,
        turn_index: 0,
        started_at: '2026-04-10T10:00:04.000Z',
        ended_at: '2026-04-10T10:01:00.000Z',
        status: 'succeeded',
        reason_code: 'turn_completed',
        reason_detail: null,
        phase_spans: [
          {
            phase_span_id: 'phase-1',
            turn_id: 'turn-1',
            phase: 'implementation',
            started_at: '2026-04-10T10:00:05.000Z',
            ended_at: '2026-04-10T10:00:15.000Z',
            status: 'succeeded',
            reason_code: null,
            reason_detail: null
          }
        ],
        tool_spans: [
          {
            tool_span_id: 'tool-1',
            turn_id: 'turn-1',
            tool_name: 'exec_command',
            started_at: '2026-04-10T10:00:10.000Z',
            ended_at: '2026-04-10T10:00:12.000Z',
            status: 'succeeded',
            reason_code: null,
            reason_detail: null
          }
        ],
        state_transitions: []
      }
    ],
    state_transitions: [
      {
        state_transition_id: 'state-1',
        issue_run_id: 'issue_run_1',
        attempt_id: 'attempt_1',
        thread_id: threadId,
        turn_id: null,
        from_status: 'running',
        to_status: threadStatus,
        transitioned_at: '2026-04-10T10:02:00.000Z',
        status: threadStatus,
        reason_code: threadStatus === 'succeeded' ? 'completed' : null,
        reason_detail: null
      }
    ]
  };
}

export function makeDiagnosticsSource(overrides: Record<string, unknown> = {}) {
  return {
    getActiveProfile: () => ({
      name: 'balanced',
      approval_policy: 'on-request',
      thread_sandbox: 'workspace-write',
      turn_sandbox_policy: { type: 'workspace' },
      user_input_policy: 'fail_attempt'
    }),
    getPersistenceHealth: () => ({
      enabled: true,
      db_path: '/tmp/runtime.sqlite',
      retention_days: 14,
      run_count: 1,
      last_pruned_at: null,
      last_prune_failure_at: null,
      last_prune_failure_reason: null,
      last_prune_failure_detail: null,
      integrity_ok: true
    }),
    getLoggingHealth: () => ({
      root: '/tmp/log',
      active_file: '/tmp/log/symphony.log',
      rotation: { max_bytes: 10485760, max_files: 5 },
      sinks: ['stderr']
    }),
    listRunHistory: () => [],
    getUiState: () => null,
    setUiState: () => undefined,
    getPromptFallbackActive: () => false,
    getRuntimeResolution: () => ({
      workflow_path: '/tmp/WORKFLOW.md',
      workflow_dir: '/tmp',
      workspace_root: '/tmp/workspaces',
      workspace_root_source: 'workflow',
      server: { host: '127.0.0.1', port: 3000 },
      provisioner_type: 'none',
      repo_root: null,
      base_ref: null,
      branch_name_template: null
    }),
    getWorkspaceProvisioner: () => ({
      provisioner_type: 'none',
      repo_root: null,
      base_ref: null,
      branch_name_template: null,
      last_provision_result: null,
      last_teardown_result: null,
      last_error_code: null,
      last_verification_result: null,
      last_cleanup_on_failure_result: null,
      verification_mode: 'none',
      last_integrity_status: null,
      last_integrity_reason_code: null,
      last_integrity_checked_at: null,
      last_integrity_reconciled_at: null
    }),
    getWorkspaceCopyIgnored: () => ({
      enabled: false,
      include_file: '/tmp/.worktreeinclude',
      from: 'primary_worktree',
      conflict_policy: 'skip',
      require_gitignored: true,
      max_files: 10000,
      max_total_bytes: 5 * 1024 * 1024 * 1024,
      last_status: null,
      last_error_code: null,
      last_error_message: null,
      source_path: null,
      copied_files: 0,
      skipped_existing: 0,
      blocked_files: 0,
      bytes_copied: 0,
      duration_ms: 0
    }),
    ...overrides
  } as never;
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: () => {
      resolvePromise?.();
    }
  };
}


export function makeEventLoopSummary(overrides: Partial<EventLoopHealthSummary> = {}): EventLoopHealthSummary {
  return {
    observed_at: '2026-05-13T15:04:00.000Z',
    sample_window_ms: 30_000,
    delay: {
      resolution_ms: 20,
      min_ms: 1,
      mean_ms: 25,
      max_ms: 5_250,
      p50_ms: 10,
      p95_ms: 4_100,
      p99_ms: 5_250
    },
    utilization: {
      idle_ms: 1,
      active_ms: 999,
      utilization: 0.999
    },
    ...overrides
  };
}

export class StaticEventLoopHealthMonitor implements EventLoopHealthMonitor {
  readonly summaries: EventLoopHealthSummary[] = [];

  constructor(private readonly summary: EventLoopHealthSummary) {}

  summarize(nowMs: number): EventLoopHealthSummary {
    const summary = {
      ...this.summary,
      observed_at: new Date(nowMs).toISOString(),
      delay: { ...this.summary.delay },
      utilization: { ...this.summary.utilization }
    };
    this.summaries.push(summary);
    return summary;
  }
}

export async function readSseEvents(
  response: Response,
  expectedCount: number,
  timeoutMs: number = 4000
): Promise<Array<{ id?: number; event?: string; data: Record<string, unknown> }>> {
  if (!response.body) {
    throw new Error('expected stream body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ id?: number; event?: string; data: Record<string, unknown> }> = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;

  while (events.length < expectedCount && Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), 250)
      )
    ]);

    if (result.done || !result.value) {
      continue;
    }

    buffer += decoder.decode(result.value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const lines = block.split('\n');
      let id: number | undefined;
      let eventName: string | undefined;
      let dataLine = '';
      for (const line of lines) {
        if (line.startsWith('id: ')) {
          id = Number.parseInt(line.slice(4), 10);
          continue;
        }
        if (line.startsWith('event: ')) {
          eventName = line.slice(7);
          continue;
        }
        if (line.startsWith('data: ')) {
          dataLine += line.slice(6);
        }
      }
      if (!dataLine) {
        continue;
      }
      events.push({
        id,
        event: eventName,
        data: JSON.parse(dataLine) as Record<string, unknown>
      });
      if (events.length >= expectedCount) {
        break;
      }
    }
  }

  await reader.cancel();
  return events;
}


export { LocalApiServer } from '../../src/api';
export { LocalApiError } from '../../src/api/errors';
export { replayForensicsBundle } from '../../src/api/forensics';
export { CANONICAL_EVENT, EVENT_VOCABULARY_VERSION } from '../../src/observability/events';
export { REASON_CODES } from '../../src/observability/reason-codes';
export type { EventLoopHealthSummary } from '../../src/api/event-loop-health';
export type { ForensicsBundle } from '../../src/api/forensics';
export type { DurableIdentity } from '../../src/persistence';

export function closeServerAfterEach(
  getServer: () => LocalApiServer | null,
  setServer: (server: LocalApiServer | null) => void
): void {
  afterEach(async () => {
    const server = getServer();
    if (server) {
      await server.close();
      setServer(null);
    }
  });
}
