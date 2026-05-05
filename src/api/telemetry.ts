import { createHash } from 'node:crypto';

import type { ApiStateResponse, DiagnosticsSource } from './types';

const QUERY_FILTERS = new Set([
  'from',
  'to',
  'start',
  'end',
  'issue_identifier',
  'thread_id',
  'reason_code',
  'classification',
  'tool_name',
  'worker_host',
  'model',
  'workflow_hash',
  'limit'
]);

type TelemetryClassification = string | null;

export interface TelemetryQueryFilters {
  from_ms: number | null;
  to_ms: number | null;
  issue_identifier: string | null;
  thread_id: string | null;
  reason_code: string | null;
  classification: string | null;
  tool_name: string | null;
  worker_host: string | null;
  model: string | null;
  workflow_hash: string | null;
  limit: number;
}

export interface TelemetryEventRow {
  observed_at: string;
  observed_at_ms: number;
  source: 'runtime_snapshot' | 'thread_lineage';
  issue_identifier: string | null;
  thread_id: string | null;
  reason_code: string | null;
  classification: TelemetryClassification;
  tool_name: string | null;
  worker_host: string | null;
  model: string | null;
  workflow_hash: string | null;
  status: string | null;
  latency_ms: number | null;
  time_to_first_progress_ms: number | null;
  tokens_total: number;
  progress_signal_state: string | null;
  burn_without_progress: boolean;
}

export interface TelemetryQueryResponse {
  generated_at: string;
  filters: TelemetryQueryFilters;
  result_count: number;
  events: TelemetryEventRow[];
}

export interface TelemetrySummaryResponse {
  generated_at: string;
  filters: TelemetryQueryFilters;
  sample_count: number;
  stuck_turn_rate: number;
  retry_loop_rate: number;
  time_to_first_progress_p50: number | null;
  time_to_first_progress_p95: number | null;
  time_to_first_progress_p99: number | null;
  tool_latency_p50: Record<string, number>;
  tool_latency_p95: Record<string, number>;
  tool_latency_p99: Record<string, number>;
  token_burn_rate: number;
  burn_without_progress_rate: number;
  top_blocker_classes: Array<{ classification: string; count: number; rate: number }>;
  worst_tools: Array<{ tool_name: string; p95_latency_ms: number; sample_count: number }>;
}

export class TelemetryQueryError extends Error {
  constructor(
    readonly code: 'invalid_time_window' | 'invalid_query_filter',
    message: string
  ) {
    super(message);
  }
}

function parseTimestamp(value: string | null, field: string): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new TelemetryQueryError('invalid_query_filter', `${field} must be an ISO timestamp`);
  }
  return parsed;
}

function parseLimit(value: string | null): number {
  if (!value) {
    return 500;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new TelemetryQueryError('invalid_query_filter', 'limit must be an integer between 1 and 10000');
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 10_000) {
    throw new TelemetryQueryError('invalid_query_filter', 'limit must be an integer between 1 and 10000');
  }
  return parsed;
}

export function parseTelemetryQuery(url: URL): TelemetryQueryFilters {
  for (const key of url.searchParams.keys()) {
    if (!QUERY_FILTERS.has(key)) {
      throw new TelemetryQueryError('invalid_query_filter', `unsupported telemetry filter: ${key}`);
    }
  }

  const fromMs = parseTimestamp(url.searchParams.get('from') ?? url.searchParams.get('start'), 'from');
  const toMs = parseTimestamp(url.searchParams.get('to') ?? url.searchParams.get('end'), 'to');
  if (fromMs !== null && toMs !== null && fromMs > toMs) {
    throw new TelemetryQueryError('invalid_time_window', 'from must be before or equal to to');
  }

  return {
    from_ms: fromMs,
    to_ms: toMs,
    issue_identifier: normalizedParam(url, 'issue_identifier'),
    thread_id: normalizedParam(url, 'thread_id'),
    reason_code: normalizedParam(url, 'reason_code'),
    classification: normalizedParam(url, 'classification'),
    tool_name: normalizedParam(url, 'tool_name'),
    worker_host: normalizedParam(url, 'worker_host'),
    model: normalizedParam(url, 'model'),
    workflow_hash: normalizedParam(url, 'workflow_hash'),
    limit: parseLimit(url.searchParams.get('limit'))
  };
}

export function buildTelemetryQueryResponse(params: {
  state: ApiStateResponse;
  diagnosticsSource?: DiagnosticsSource;
  filters: TelemetryQueryFilters;
  generatedAt?: string;
}): TelemetryQueryResponse {
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  const rows = collectFilteredTelemetryRows(params.state, params.diagnosticsSource, params.filters)
    .slice(0, params.filters.limit);

  return {
    generated_at: generatedAt,
    filters: params.filters,
    result_count: rows.length,
    events: rows
  };
}

export function buildTelemetrySummaryResponse(params: {
  state: ApiStateResponse;
  diagnosticsSource?: DiagnosticsSource;
  filters: TelemetryQueryFilters;
  generatedAt?: string;
}): TelemetrySummaryResponse {
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  const rows = collectFilteredTelemetryRows(params.state, params.diagnosticsSource, params.filters);
  const count = rows.length;
  const divisor = count || 1;
  const timeToProgress = rows
    .map((row) => row.time_to_first_progress_ms)
    .filter((value): value is number => typeof value === 'number');
  const toolLatencies = new Map<string, number[]>();
  for (const row of rows) {
    if (row.tool_name && typeof row.latency_ms === 'number') {
      const values = toolLatencies.get(row.tool_name) ?? [];
      values.push(row.latency_ms);
      toolLatencies.set(row.tool_name, values);
    }
  }

  const elapsedMs = resolveElapsedWindowMs(rows, params.filters);
  const totalTokens = rows.reduce((sum, row) => sum + row.tokens_total, 0);

  return {
    generated_at: generatedAt,
    filters: params.filters,
    sample_count: count,
    stuck_turn_rate: ratio(
      rows.filter((row) => row.classification === 'stalled_waiting' || row.progress_signal_state === 'stalled_waiting').length,
      divisor
    ),
    retry_loop_rate: ratio(rows.filter((row) => row.classification === 'retry_loop').length, divisor),
    time_to_first_progress_p50: percentile(timeToProgress, 50),
    time_to_first_progress_p95: percentile(timeToProgress, 95),
    time_to_first_progress_p99: percentile(timeToProgress, 99),
    tool_latency_p50: percentileByTool(toolLatencies, 50),
    tool_latency_p95: percentileByTool(toolLatencies, 95),
    tool_latency_p99: percentileByTool(toolLatencies, 99),
    token_burn_rate: elapsedMs > 0 ? totalTokens / (elapsedMs / 60_000) : 0,
    burn_without_progress_rate: ratio(rows.filter((row) => row.burn_without_progress).length, divisor),
    top_blocker_classes: topBlockerClasses(rows, divisor),
    worst_tools: Array.from(toolLatencies.entries())
      .map(([toolName, values]) => ({
        tool_name: toolName,
        p95_latency_ms: percentile(values, 95) ?? 0,
        sample_count: values.length
      }))
      .sort((left, right) => right.p95_latency_ms - left.p95_latency_ms || right.sample_count - left.sample_count)
      .slice(0, 10)
  };
}

function collectFilteredTelemetryRows(
  state: ApiStateResponse,
  diagnosticsSource: DiagnosticsSource | undefined,
  filters: TelemetryQueryFilters
): TelemetryEventRow[] {
  return collectTelemetryRows(state, diagnosticsSource)
    .filter((row) => matchesFilters(row, filters))
    .sort((left, right) => right.observed_at_ms - left.observed_at_ms);
}

function normalizedParam(url: URL, key: string): string | null {
  const value = url.searchParams.get(key);
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new TelemetryQueryError('invalid_query_filter', `${key} must not be empty`);
  }
  return trimmed;
}

function collectTelemetryRows(state: ApiStateResponse, diagnosticsSource?: DiagnosticsSource): TelemetryEventRow[] {
  const generatedAtMs = Date.parse(state.generated_at);
  const runtime = runtimeDimensions(diagnosticsSource);
  const rows: TelemetryEventRow[] = [];

  for (const entry of state.running) {
    const observedAtMs = Date.parse(entry.last_event_at ?? entry.started_at);
    const timeToFirstProgress =
      entry.last_progress_transition_at_ms !== null ? Math.max(0, entry.last_progress_transition_at_ms - Date.parse(entry.started_at)) : null;
    const classification =
      entry.stalled_waiting
        ? 'stalled_waiting'
        : entry.awaiting_input
          ? 'input_required'
          : entry.operator_explainer_hint?.classification ?? 'running';
    rows.push({
      observed_at: new Date(observedAtMs).toISOString(),
      observed_at_ms: observedAtMs,
      source: 'runtime_snapshot',
      issue_identifier: entry.issue_identifier,
      thread_id: entry.thread_id,
      reason_code: entry.turn_control_reason_code ?? entry.stalled_waiting_reason ?? entry.not_blocked_explainer_code,
      classification,
      tool_name: null,
      worker_host: entry.worker_host,
      ...runtime,
      status: 'running',
      latency_ms: null,
      time_to_first_progress_ms: timeToFirstProgress,
      tokens_total: entry.tokens.total_tokens,
      progress_signal_state: entry.progress_signal_state,
      burn_without_progress: entry.tokens.total_tokens > 0 && entry.progress_signal_state !== 'advancing'
    });
  }

  for (const entry of state.retrying) {
    const observedAtMs = Date.parse(entry.due_at);
    rows.push({
      observed_at: entry.due_at,
      observed_at_ms: observedAtMs,
      source: 'runtime_snapshot',
      issue_identifier: entry.issue_identifier,
      thread_id: entry.previous_thread_id,
      reason_code: entry.stop_reason_code,
      classification: 'retry_loop',
      tool_name: null,
      worker_host: entry.worker_host,
      ...runtime,
      status: 'retrying',
      latency_ms: null,
      time_to_first_progress_ms: null,
      tokens_total: entry.budget_usage_tokens ?? 0,
      progress_signal_state: null,
      burn_without_progress: (entry.budget_usage_tokens ?? 0) > 0
    });
  }

  for (const entry of state.blocked) {
    const observedAtMs = Date.parse(entry.blocked_at);
    const classification = entry.operator_explainer_hint?.classification ?? 'blocked';
    rows.push({
      observed_at: entry.blocked_at,
      observed_at_ms: observedAtMs,
      source: 'runtime_snapshot',
      issue_identifier: entry.issue_identifier,
      thread_id: entry.previous_thread_id,
      reason_code: entry.stop_reason_code,
      classification,
      tool_name: null,
      worker_host: entry.worker_host,
      ...runtime,
      status: 'blocked',
      latency_ms: null,
      time_to_first_progress_ms: entry.last_progress_transition_at_ms
        ? Math.max(0, entry.last_progress_transition_at_ms - observedAtMs)
        : null,
      tokens_total: entry.budget_usage_tokens ?? 0,
      progress_signal_state: entry.progress_signal_state,
      burn_without_progress: (entry.budget_usage_tokens ?? 0) > 0 && entry.progress_signal_state !== 'advancing'
    });
  }

  for (const event of state.recent_runtime_events) {
    const observedAtMs = Date.parse(event.at);
    rows.push({
      observed_at: event.at,
      observed_at_ms: observedAtMs,
      source: 'runtime_snapshot',
      issue_identifier: event.issue_identifier ?? null,
      thread_id: event.session_id ?? null,
      reason_code: reasonFromEventDetail(event.detail ?? null),
      classification: event.severity,
      tool_name: null,
      worker_host: null,
      ...runtime,
      status: event.event,
      latency_ms: null,
      time_to_first_progress_ms: null,
      tokens_total: 0,
      progress_signal_state: null,
      burn_without_progress: false
    });
  }

  const lineageThreadIds = new Set<string>();
  for (const run of diagnosticsSource?.listRunHistory(10_000) ?? []) {
    for (const sessionId of run.session_ids) {
      lineageThreadIds.add(sessionId);
    }
  }
  for (const row of [...state.running, ...state.retrying, ...state.blocked]) {
    if ('thread_id' in row && row.thread_id) {
      lineageThreadIds.add(row.thread_id);
    }
    if ('previous_thread_id' in row && row.previous_thread_id) {
      lineageThreadIds.add(row.previous_thread_id);
    }
  }

  for (const threadId of lineageThreadIds) {
    const lineage = diagnosticsSource?.reconstructThreadLineage?.(threadId);
    if (!lineage) {
      continue;
    }
    for (const turn of lineage.turns) {
      const turnStartMs = Date.parse(turn.started_at);
      const firstProgressMs = turn.phase_spans.length
        ? Math.max(0, Date.parse(turn.phase_spans[0].started_at) - turnStartMs)
        : turn.ended_at
          ? Math.max(0, Date.parse(turn.ended_at) - turnStartMs)
          : null;
      rows.push({
        observed_at: turn.ended_at ?? turn.started_at,
        observed_at_ms: Date.parse(turn.ended_at ?? turn.started_at),
        source: 'thread_lineage',
        issue_identifier: lineage.issue_run.issue_identifier,
        thread_id: lineage.thread.thread_id,
        reason_code: turn.reason_code,
        classification: turn.status,
        tool_name: null,
        worker_host: null,
        ...runtime,
        status: turn.status,
        latency_ms: turn.ended_at ? Math.max(0, Date.parse(turn.ended_at) - turnStartMs) : null,
        time_to_first_progress_ms: firstProgressMs,
        tokens_total: 0,
        progress_signal_state: turn.status === 'succeeded' ? 'advancing' : null,
        burn_without_progress: false
      });

      for (const tool of turn.tool_spans) {
        const toolStartMs = Date.parse(tool.started_at);
        rows.push({
          observed_at: tool.ended_at ?? tool.started_at,
          observed_at_ms: Date.parse(tool.ended_at ?? tool.started_at),
          source: 'thread_lineage',
          issue_identifier: lineage.issue_run.issue_identifier,
          thread_id: lineage.thread.thread_id,
          reason_code: tool.reason_code,
          classification: tool.status,
          tool_name: tool.tool_name,
          worker_host: null,
          ...runtime,
          status: tool.status,
          latency_ms: tool.ended_at ? Math.max(0, Date.parse(tool.ended_at) - toolStartMs) : null,
          time_to_first_progress_ms: null,
          tokens_total: 0,
          progress_signal_state: tool.status === 'succeeded' ? 'advancing' : null,
          burn_without_progress: false
        });
      }
    }
  }

  return rows.filter((row) => Number.isFinite(row.observed_at_ms) && row.observed_at_ms <= (generatedAtMs || Date.now()));
}

function runtimeDimensions(diagnosticsSource?: DiagnosticsSource): Pick<TelemetryEventRow, 'model' | 'workflow_hash'> {
  const runtime = diagnosticsSource?.getRuntimeResolution();
  const workflowPath = runtime?.workflow_path ?? null;
  return {
    model: runtime?.effective_codex_model ?? null,
    workflow_hash: workflowPath ? createHash('sha256').update(workflowPath).digest('hex').slice(0, 12) : null
  };
}

function reasonFromEventDetail(detail: string | null): string | null {
  if (!detail) {
    return null;
  }
  const match = /\breason_code=([^\s,;]+)/.exec(detail) ?? /\bcode=([^\s,;]+)/.exec(detail);
  return match?.[1] ?? null;
}

function matchesFilters(row: TelemetryEventRow, filters: TelemetryQueryFilters): boolean {
  if (filters.from_ms !== null && row.observed_at_ms < filters.from_ms) {
    return false;
  }
  if (filters.to_ms !== null && row.observed_at_ms > filters.to_ms) {
    return false;
  }
  return (
    matches(row.issue_identifier, filters.issue_identifier) &&
    matches(row.thread_id, filters.thread_id) &&
    matches(row.reason_code, filters.reason_code) &&
    matches(row.classification, filters.classification) &&
    matches(row.tool_name, filters.tool_name) &&
    matches(row.worker_host, filters.worker_host) &&
    matches(row.model, filters.model) &&
    matches(row.workflow_hash, filters.workflow_hash)
  );
}

function matches(actual: string | null, expected: string | null): boolean {
  return expected === null || actual === expected;
}

function percentileByTool(toolLatencies: Map<string, number[]>, p: number): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [toolName, values] of toolLatencies.entries()) {
    const value = percentile(values, p);
    if (value !== null) {
      result[toolName] = value;
    }
  }
  return result;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function resolveElapsedWindowMs(rows: TelemetryEventRow[], filters: TelemetryQueryFilters): number {
  if (filters.from_ms !== null && filters.to_ms !== null) {
    return Math.max(0, filters.to_ms - filters.from_ms);
  }
  if (rows.length < 2) {
    return 0;
  }
  const observed = rows.map((row) => row.observed_at_ms);
  return Math.max(...observed) - Math.min(...observed);
}

function topBlockerClasses(rows: TelemetryEventRow[], divisor: number): Array<{ classification: string; count: number; rate: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!isBlockerRow(row)) {
      continue;
    }
    counts.set(row.classification, (counts.get(row.classification) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([classification, count]) => ({
      classification,
      count,
      rate: ratio(count, divisor)
    }))
    .sort((left, right) => right.count - left.count || left.classification.localeCompare(right.classification))
    .slice(0, 10);
}

function isBlockerRow(row: TelemetryEventRow): row is TelemetryEventRow & { classification: string } {
  if (!row.classification) {
    return false;
  }
  if (['healthy', 'running', 'succeeded', 'completed', 'advancing', 'info'].includes(row.classification)) {
    return false;
  }
  if (['succeeded', 'completed'].includes(row.status ?? '')) {
    return false;
  }
  return (
    row.burn_without_progress ||
    row.classification === 'retry_loop' ||
    row.classification === 'stalled_waiting' ||
    row.classification === 'input_required' ||
    row.classification === 'blocked' ||
    row.classification === 'blocked_input' ||
    row.classification === 'failed' ||
    row.classification === 'error' ||
    row.classification === 'warn' ||
    row.reason_code?.startsWith('operator_action_required_') === true ||
    row.reason_code?.includes('blocked') === true ||
    row.reason_code?.includes('stalled') === true ||
    row.reason_code?.includes('retry') === true
  );
}
