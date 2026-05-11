import type {
  AppServerEventLedgerExcerpt,
  DurableIdentity,
  ExecutionGraphEntityStatus,
  HistorySchemaHealth,
  IssueRunRecord,
  TicketTimelineRecord
} from '../persistence';
import { REASON_CODES } from '../observability/reason-codes';

export type ProjectHistoryFactStatus = 'present' | 'missing' | 'degraded' | 'redacted' | 'truncated' | 'unavailable';

export interface ProjectHistoryFactState {
  fact: string;
  status: ProjectHistoryFactStatus;
  reason_code: string | null;
  detail: string | null;
}

export interface ProjectHistoryPage {
  limit: number;
  offset: number;
  has_more: boolean;
  total: number | null;
}

export interface ProjectHistoryTicketRow {
  project_identity: DurableIdentity['project'];
  ticket_identity: DurableIdentity['ticket'];
  state: 'active' | 'completed';
  current_status: string;
  last_known_status: string;
  latest_attempt: {
    attempt_id: string | null;
    attempt_number: number | null;
    status: ExecutionGraphEntityStatus | null;
    started_at: string | null;
    ended_at: string | null;
    outcome: string | null;
    outcome_reason_code: string | null;
  };
  summary: {
    issue_run_count: number;
    attempt_count: number;
    thread_count: number;
    turn_count: number;
    phase_count: number;
    state_transition_count: number;
    active_blocker_count: number;
    resolved_blocker_count: number;
    evidence_reference_count: number;
    tracker_snapshot_count: number;
    ticket_reference_count: number;
    operator_action_count: number;
    blocked_input_event_count: number;
    app_server_event_count: number;
    token_model_fact_count: number;
    total_tokens: number | null;
  };
  facts: ProjectHistoryFactState[];
  latest_observed_at: string | null;
}

export interface ProjectHistoryTicketListResponse {
  project_identity: {
    key: string;
  };
  page: ProjectHistoryPage;
  tickets: ProjectHistoryTicketRow[];
  facts: ProjectHistoryFactState[];
}

export interface ProjectHistoryTicketDetailResponse extends ProjectHistoryTicketRow {
  timeline: TicketTimelineRecord;
  attempts: TicketTimelineRecord['attempts'];
  phases: TicketTimelineRecord['phase_spans'];
  state_transitions: TicketTimelineRecord['state_transitions'];
  thread_references: Array<{ thread_id: string; attempt_id: string; started_at: string; ended_at: string | null; status: string }>;
  turn_references: Array<{ turn_id: string; thread_id: string; turn_index: number; started_at: string; ended_at: string | null; status: string }>;
  outcomes: TicketTimelineRecord['terminal_outcomes'];
  blockers: TicketTimelineRecord['blockers'];
  evidence_references: TicketTimelineRecord['evidence_references'];
  tracker_facts: TicketTimelineRecord['tracker_snapshots'];
  pr_and_reference_facts: TicketTimelineRecord['ticket_references'];
  operator_facts: TicketTimelineRecord['operator_actions'];
  blocked_input_events: TicketTimelineRecord['blocked_input_events'];
  app_server_lite_summaries: AppServerEventLedgerExcerpt[];
  token_model_summaries: TicketTimelineRecord['token_model_facts'];
}

export interface ProjectHistoryConsumerSummaryResponse {
  schema_version: 'symphony.project_history.consumer_summary.v1';
  read_only: true;
  deferred_capabilities: Array<'validation_reuse' | 'phase_handoff_packets' | 'drain_mode' | 'operator_steering'>;
  project_identity: DurableIdentity['project'];
  ticket_identity: DurableIdentity['ticket'];
  current_ticket_state: {
    state: ProjectHistoryTicketRow['state'];
    current_status: string;
    last_known_status: string;
    latest_observed_at: string | null;
    facts: ProjectHistoryFactState[];
  };
  attempts: {
    total: number;
    repeated: boolean;
    latest: ProjectHistoryTicketRow['latest_attempt'];
    recent: Array<{
      attempt_id: string;
      attempt_number: number;
      status: ExecutionGraphEntityStatus;
      started_at: string;
      ended_at: string | null;
      reason_code: string | null;
      reason_detail: string | null;
    }>;
  };
  recent_phases: Array<{
    phase: string;
    status: ExecutionGraphEntityStatus;
    started_at: string;
    ended_at: string | null;
    reason_code: string | null;
    reason_detail: string | null;
  }>;
  blockers: {
    active_count: number;
    resolved_count: number;
    recent: Array<{
      blocker_type: string;
      status: 'active' | 'resolved';
      reason_code: string;
      reason_detail: string | null;
      blocked_at: string;
      resolved_at: string | null;
    }>;
  };
  token_model: {
    status: 'present' | 'missing';
    total_tokens: number | null;
    requested_models: string[];
    effective_models: string[];
    telemetry_confidences: string[];
    recent: Array<{
      requested_model: string | null;
      effective_model: string | null;
      model_source: string | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cached_input_tokens: number | null;
      reasoning_output_tokens: number | null;
      total_tokens: number | null;
      model_context_window: number | null;
      telemetry_confidence: string;
      observed_at: string;
    }>;
  };
  app_server_lite: {
    status: 'present' | 'missing' | 'degraded';
    excerpts: Array<{
      source_event_id: string;
      source_event_name: string;
      observed_at: string;
      payload_class: string;
      detail_status: string;
      redaction_status: string;
      summary: string | null;
      summary_fields: Record<string, unknown>;
      redacted_excerpt: string | null;
      unavailable_reason_code: string | null;
      truncated: boolean;
      full_payload_stored: boolean;
    }>;
  };
  evidence_references: Array<{
    evidence_kind: string;
    uri: string;
    title: string | null;
    recorded_at: string;
    metadata: Record<string, unknown> | null;
  }>;
}

export function buildProjectHistoryListResponse(params: {
  projectKey: string;
  timelines: TicketTimelineRecord[];
  page: ProjectHistoryPage;
  historySchemaHealth?: HistorySchemaHealth | null;
}): ProjectHistoryTicketListResponse {
  return {
    project_identity: {
      key: params.projectKey
    },
    page: params.page,
    tickets: params.timelines.map((timeline) => buildProjectHistoryTicketRow(timeline, params.historySchemaHealth)),
    facts: historyHealthFacts(params.historySchemaHealth)
  };
}

export function buildProjectHistoryTicketDetailResponse(
  timeline: TicketTimelineRecord,
  historySchemaHealth?: HistorySchemaHealth | null
): ProjectHistoryTicketDetailResponse {
  const row = buildProjectHistoryTicketRow(timeline, historySchemaHealth);
  return {
    ...row,
    timeline,
    attempts: timeline.attempts,
    phases: timeline.phase_spans,
    state_transitions: timeline.state_transitions,
    thread_references: timeline.threads.map((thread) => ({
      thread_id: thread.thread_id,
      attempt_id: thread.attempt_id,
      started_at: thread.started_at,
      ended_at: thread.ended_at,
      status: thread.status
    })),
    turn_references: timeline.turns.map((turn) => ({
      turn_id: turn.turn_id,
      thread_id: turn.thread_id,
      turn_index: turn.turn_index,
      started_at: turn.started_at,
      ended_at: turn.ended_at,
      status: turn.status
    })),
    outcomes: timeline.terminal_outcomes,
    blockers: timeline.blockers,
    evidence_references: timeline.evidence_references,
    tracker_facts: timeline.tracker_snapshots,
    pr_and_reference_facts: timeline.ticket_references,
    operator_facts: timeline.operator_actions,
    blocked_input_events: timeline.blocked_input_events,
    app_server_lite_summaries: timeline.app_server_events,
    token_model_summaries: timeline.token_model_facts
  };
}

export function buildProjectHistoryConsumerSummaryResponse(
  timeline: TicketTimelineRecord,
  historySchemaHealth?: HistorySchemaHealth | null
): ProjectHistoryConsumerSummaryResponse {
  const row = buildProjectHistoryTicketRow(timeline, historySchemaHealth);
  const recentAttempts = latestItems(timeline.attempts, (attempt) => attempt.started_at, 5).map((attempt) => ({
    attempt_id: attempt.attempt_id,
    attempt_number: attempt.attempt_number,
    status: attempt.status,
    started_at: attempt.started_at,
    ended_at: attempt.ended_at,
    reason_code: attempt.reason_code,
    reason_detail: attempt.reason_detail
  }));
  const recentPhases = latestItems(timeline.phase_spans, (phase) => phase.started_at, 8).map((phase) => ({
    phase: phase.phase,
    status: phase.status,
    started_at: phase.started_at,
    ended_at: phase.ended_at,
    reason_code: phase.reason_code,
    reason_detail: phase.reason_detail
  }));
  const recentBlockers = latestItems(timeline.blockers, (blocker) => blocker.blocked_at, 5).map((blocker) => ({
    blocker_type: blocker.blocker_type,
    status: blocker.status,
    reason_code: blocker.reason_code,
    reason_detail: blocker.reason_detail,
    blocked_at: blocker.blocked_at,
    resolved_at: blocker.resolved_at
  }));
  const recentTokenFacts = latestItems(timeline.token_model_facts, (fact) => fact.observed_at, 5);
  const appServerExcerpts = latestItems(timeline.app_server_events, (event) => event.observed_at, 5).map((event) => ({
    source_event_id: event.source_event_id,
    source_event_name: event.source_event_name,
    observed_at: event.observed_at,
    payload_class: event.payload_class,
    detail_status: event.detail_status,
    redaction_status: event.redaction_status,
    summary: event.summary,
    summary_fields: event.summary_fields,
    redacted_excerpt: event.redacted_excerpt,
    unavailable_reason_code: event.unavailable_reason_code,
    truncated: event.truncation.truncated,
    full_payload_stored: event.full_payload_stored
  }));

  return {
    schema_version: 'symphony.project_history.consumer_summary.v1',
    read_only: true,
    deferred_capabilities: ['validation_reuse', 'phase_handoff_packets', 'drain_mode', 'operator_steering'],
    project_identity: row.project_identity,
    ticket_identity: row.ticket_identity,
    current_ticket_state: {
      state: row.state,
      current_status: row.current_status,
      last_known_status: row.last_known_status,
      latest_observed_at: row.latest_observed_at,
      facts: row.facts
    },
    attempts: {
      total: row.summary.attempt_count,
      repeated: row.summary.attempt_count > 1,
      latest: row.latest_attempt,
      recent: recentAttempts
    },
    recent_phases: recentPhases,
    blockers: {
      active_count: row.summary.active_blocker_count,
      resolved_count: row.summary.resolved_blocker_count,
      recent: recentBlockers
    },
    token_model: {
      status: timeline.token_model_facts.length > 0 ? 'present' : 'missing',
      total_tokens: row.summary.total_tokens,
      requested_models: uniqueStrings(timeline.token_model_facts.map((fact) => fact.requested_model)),
      effective_models: uniqueStrings(timeline.token_model_facts.map((fact) => fact.effective_model)),
      telemetry_confidences: uniqueStrings(timeline.token_model_facts.map((fact) => fact.telemetry_confidence)),
      recent: recentTokenFacts.map((fact) => ({
        requested_model: fact.requested_model,
        effective_model: fact.effective_model,
        model_source: fact.model_source,
        input_tokens: fact.input_tokens,
        output_tokens: fact.output_tokens,
        cached_input_tokens: fact.cached_input_tokens,
        reasoning_output_tokens: fact.reasoning_output_tokens,
        total_tokens: fact.total_tokens,
        model_context_window: fact.model_context_window,
        telemetry_confidence: fact.telemetry_confidence,
        observed_at: fact.observed_at
      }))
    },
    app_server_lite: {
      status:
        appServerExcerpts.length === 0
          ? 'missing'
          : appServerExcerpts.some((event) => event.unavailable_reason_code || event.truncated || event.redaction_status !== 'not_required')
            ? 'degraded'
            : 'present',
      excerpts: appServerExcerpts
    },
    evidence_references: latestItems(timeline.evidence_references, (evidence) => evidence.recorded_at, 5).map((evidence) => ({
      evidence_kind: evidence.evidence_kind,
      uri: evidence.uri,
      title: evidence.title,
      recorded_at: evidence.recorded_at,
      metadata: evidence.metadata
    }))
  };
}

function buildProjectHistoryTicketRow(
  timeline: TicketTimelineRecord,
  historySchemaHealth?: HistorySchemaHealth | null
): ProjectHistoryTicketRow {
  const latestIssueRun = latestBy(timeline.issue_runs, (run) => run.started_at);
  const latestAttempt = latestBy(timeline.attempts, (attempt) => attempt.started_at);
  const latestOutcome = latestBy(timeline.terminal_outcomes, (outcome) => outcome.recorded_at);
  const latestTrackerSnapshot = latestBy(timeline.tracker_snapshots, (snapshot) => snapshot.last_observed_at);
  const latestTransition = latestBy(timeline.state_transitions, (transition) => transition.transitioned_at);
  const lastKnownStatus = latestTrackerSnapshot?.tracker_status ?? latestTransition?.to_status ?? latestIssueRun?.status ?? 'unknown';
  return {
    project_identity: timeline.identity.project,
    ticket_identity: timeline.identity.ticket,
    state: isTimelineActive(latestIssueRun) ? 'active' : 'completed',
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
      app_server_event_count: timeline.app_server_events.length,
      token_model_fact_count: timeline.token_model_facts.length,
      total_tokens: sumNullable(timeline.token_model_facts.map((fact) => fact.total_tokens))
    },
    facts: timelineFacts(timeline, historySchemaHealth),
    latest_observed_at: maxTimestamp([
      latestIssueRun?.started_at ?? null,
      latestAttempt?.started_at ?? null,
      latestOutcome?.recorded_at ?? null,
      latestTrackerSnapshot?.last_observed_at ?? null,
      latestTransition?.transitioned_at ?? null,
      latestBy(timeline.app_server_events, (event) => event.observed_at)?.observed_at ?? null
    ])
  };
}

function isTimelineActive(latestIssueRun: IssueRunRecord | null): boolean {
  if (!latestIssueRun) {
    return false;
  }
  return latestIssueRun.ended_at === null || ['pending', 'running', 'retrying', 'blocked'].includes(latestIssueRun.status);
}

function timelineFacts(timeline: TicketTimelineRecord, historySchemaHealth?: HistorySchemaHealth | null): ProjectHistoryFactState[] {
  return [
    ...historyHealthFacts(historySchemaHealth),
    presenceFact('tracker_snapshot', timeline.tracker_snapshots.length, REASON_CODES.projectHistoryTrackerSnapshotMissing),
    presenceFact('terminal_outcome', timeline.terminal_outcomes.length, REASON_CODES.projectHistoryTerminalOutcomeMissing),
    presenceFact('thread_turn_references', timeline.threads.length + timeline.turns.length, REASON_CODES.projectHistoryThreadTurnReferencesMissing),
    presenceFact('evidence_references', timeline.evidence_references.length, REASON_CODES.projectHistoryEvidenceReferencesMissing),
    presenceFact(
      'tracker_pr_operator_facts',
      timeline.tracker_snapshots.length + timeline.ticket_references.length + timeline.operator_actions.length,
      REASON_CODES.projectHistoryOperationalFactsMissing
    ),
    presenceFact('token_model_summaries', timeline.token_model_facts.length, REASON_CODES.projectHistoryTokenModelSummariesMissing),
    ...appServerFactStates(timeline.app_server_events)
  ];
}

function historyHealthFacts(historySchemaHealth?: HistorySchemaHealth | null): ProjectHistoryFactState[] {
  if (!historySchemaHealth) {
    return [
      {
        fact: 'history_schema',
        status: 'unavailable',
        reason_code: REASON_CODES.projectHistorySchemaHealthUnavailable,
        detail: null
      }
    ];
  }
  if (historySchemaHealth.status === 'degraded') {
    return [
      {
        fact: 'history_schema',
        status: 'degraded',
        reason_code: historySchemaHealth.degraded_reason_code,
        detail: historySchemaHealth.degraded_detail
      }
    ];
  }
  return [{ fact: 'history_schema', status: 'present', reason_code: null, detail: null }];
}

function presenceFact(fact: string, count: number, missingReasonCode: string): ProjectHistoryFactState {
  return count > 0
    ? { fact, status: 'present', reason_code: null, detail: null }
    : { fact, status: 'missing', reason_code: missingReasonCode, detail: null };
}

function appServerFactStates(events: AppServerEventLedgerExcerpt[]): ProjectHistoryFactState[] {
  if (events.length === 0) {
    return [
      {
        fact: 'app_server_lite_summaries',
        status: 'missing',
        reason_code: REASON_CODES.projectHistoryAppServerLiteSummariesMissing,
        detail: null
      }
    ];
  }
  const states: ProjectHistoryFactState[] = [{ fact: 'app_server_lite_summaries', status: 'present', reason_code: null, detail: null }];
  if (events.some((event) => event.redaction_status === 'redacted')) {
    states.push({ fact: 'app_server_lite_payload', status: 'redacted', reason_code: REASON_CODES.projectHistoryPayloadRedacted, detail: null });
  }
  if (events.some((event) => event.truncation.truncated)) {
    states.push({ fact: 'app_server_lite_payload', status: 'truncated', reason_code: REASON_CODES.projectHistoryPayloadTruncated, detail: null });
  }
  const unavailable = events.find((event) => event.unavailable_reason_code);
  if (unavailable) {
    states.push({
      fact: 'app_server_lite_payload',
      status: 'unavailable',
      reason_code: unavailable.unavailable_reason_code,
      detail: unavailable.source_event_name
    });
  }
  return states;
}

function latestBy<T>(items: T[], timestamp: (item: T) => string | null): T | null {
  return items.reduce<T | null>((latest, item) => {
    const itemTimestamp = timestamp(item);
    const latestTimestamp = latest ? timestamp(latest) : null;
    if (!itemTimestamp) {
      return latest;
    }
    return !latestTimestamp || itemTimestamp > latestTimestamp ? item : latest;
  }, null);
}

function latestItems<T>(items: T[], timestamp: (item: T) => string | null, limit: number): T[] {
  return [...items]
    .filter((item) => timestamp(item) !== null)
    .sort((a, b) => String(timestamp(b)).localeCompare(String(timestamp(a))))
    .slice(0, limit);
}

function maxTimestamp(values: Array<string | null>): string | null {
  return values.filter((value): value is string => value !== null).sort().at(-1) ?? null;
}

function sumNullable(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => typeof value === 'number');
  if (present.length === 0) {
    return null;
  }
  return present.reduce((sum, value) => sum + value, 0);
}

function uniqueStrings(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))].sort();
}
