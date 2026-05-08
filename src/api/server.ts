import http, { type IncomingMessage, type ServerResponse } from 'node:http';

import type { StructuredLogger } from '../observability';
import { CANONICAL_EVENT, EVENT_VOCABULARY_VERSION } from '../observability/events';
import type { DurableRunHistoryRecord } from '../persistence';
import { redactUnknown } from '../security/redaction';
import { renderDashboardClientJs, renderDashboardHtml, renderDashboardStylesCss } from './dashboard-assets';
import { LocalApiError } from './errors';
import { RefreshCoalescer } from './refresh-coalescer';
import { createApiDegradedDiagnostics } from './runtime-visibility';
import { SnapshotService } from './snapshot-service';
import { buildStoppedRunRecoveryEntries } from './dashboard-view-model';
import { createForensicsBundle, type ForensicsTokenSnapshot } from './forensics';
import {
  buildTelemetryQueryResponse,
  buildTelemetrySummaryResponse,
  parseTelemetryQuery,
  TelemetryQueryError
} from './telemetry';
import {
  buildThreadDiagnosticsByIssueIdentifier,
  buildThreadDiagnosticsByThreadId,
  buildThreadDiagnosticsFromLineage
} from './thread-diagnostics';
import type {
  ApiDiagnosticsResponse,
  ApiIssueResponse,
  ApiEventEnvelope,
  ApiStateResponse,
  ApiStateErrorResponse,
  ApiStateSnapshotResponse,
  ThreadDiagnosticsResponse,
  LocalApiErrorEnvelope,
  LocalApiServerOptions
} from './types';
import type { OrchestratorState } from '../orchestrator';

interface Route {
  method: 'GET' | 'POST';
  handler: (req: IncomingMessage, res: ServerResponse, match: RegExpExecArray) => Promise<void>;
}

interface Endpoint {
  path: RegExp;
  routes: Route[];
}

const ISSUE_DETAIL_ROUTES = ['/api/v1/:issue_identifier', '/api/v1/issues/:issue_identifier'];
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

function diagnosticsFromTerminalRun(run: DurableRunHistoryRecord): ThreadDiagnosticsResponse {
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

function isCompletedTerminalRun(run: DurableRunHistoryRecord): boolean {
  return run.ended_at !== null && run.terminal_status !== null;
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(redactUnknown(payload)));
}

function sendHtml(res: ServerResponse, statusCode: number, html: string): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(html);
}

function sendScript(res: ServerResponse, statusCode: number, script: string): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/javascript; charset=utf-8');
  res.end(script);
}

function sendCss(res: ServerResponse, statusCode: number, css: string): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'text/css; charset=utf-8');
  res.end(css);
}

function sendError(res: ServerResponse, statusCode: number, code: string, message: string): void {
  const payload: LocalApiErrorEnvelope = {
    error: {
      code,
      message
    }
  };
  sendJson(res, statusCode, payload);
}

interface OperatorActionBody {
  actor?: string;
  reason_note?: string;
  confirmed?: boolean;
  resume_override_reason?: string;
  cancel_reason?: string;
}

async function readOptionalJsonObject(request: IncomingMessage, errorCode: string): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const payloadText = Buffer.concat(chunks).toString('utf8').trim();
  if (!payloadText) {
    return {};
  }
  try {
    const parsed = JSON.parse(payloadText) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new LocalApiError(errorCode, 'Request body must be a JSON object', 400);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof LocalApiError) {
      throw error;
    }
    throw new LocalApiError(errorCode, 'Request body must be valid JSON', 400);
  }
}

function parseOperatorActionBody(payload: Record<string, unknown>): OperatorActionBody {
  return {
    actor: typeof payload.actor === 'string' ? payload.actor.trim() : undefined,
    reason_note: typeof payload.reason_note === 'string' ? payload.reason_note.trim() : undefined,
    confirmed: typeof payload.confirmed === 'boolean' ? payload.confirmed : undefined,
    resume_override_reason: typeof payload.resume_override_reason === 'string' ? payload.resume_override_reason.trim() : undefined,
    cancel_reason: typeof payload.cancel_reason === 'string' ? payload.cancel_reason.trim() : undefined
  };
}

function requireOperatorReasonNote(parsed: OperatorActionBody): string {
  if (!parsed.reason_note) {
    throw new LocalApiError('reason_note_required', 'reason_note is required', 400);
  }
  return parsed.reason_note;
}

function statusForOperatorActionFailure(code: string): number {
  if (code === 'reason_note_required') {
    return 400;
  }
  if (code === 'issue_not_found' || code === 'issue_not_blocked') {
    return 404;
  }
  if (code === 'confirmation_required' || code === 'issue_not_active' || code === 'unsupported_transition') {
    return 409;
  }
  if (code.endsWith('_unavailable')) {
    return 503;
  }
  return 422;
}

export class LocalApiServer {
  private readonly host: string;
  private readonly port: number;
  private readonly snapshotService: SnapshotService;
  private readonly snapshotSource: LocalApiServerOptions['snapshotSource'];
  private readonly refreshCoalescer: RefreshCoalescer;
  private readonly diagnosticsSource?: LocalApiServerOptions['diagnosticsSource'];
  private readonly workflowControlSource?: LocalApiServerOptions['workflowControlSource'];
  private readonly issueControlSource?: LocalApiServerOptions['issueControlSource'];
  private readonly dashboardConfig: NonNullable<LocalApiServerOptions['dashboardConfig']>;
  private readonly logger?: StructuredLogger;
  private readonly codexStateDbPath: string;

  private readonly server: http.Server;
  private readonly eventClients: Map<number, ServerResponse>;
  private nextClientId: number;
  private nextEventId: number;
  private heartbeatHandle: NodeJS.Timeout | null;
  private lastHealthSignature: string | null;

  constructor(options: LocalApiServerOptions) {
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 0;
    this.snapshotService = new SnapshotService({ nowMs: options.nowMs });
    this.snapshotSource = options.snapshotSource;
    this.diagnosticsSource = options.diagnosticsSource;
    this.workflowControlSource = options.workflowControlSource;
    this.issueControlSource = options.issueControlSource;
    this.dashboardConfig = options.dashboardConfig ?? {
      dashboard_enabled: true,
      refresh_ms: 4000,
      render_interval_ms: 1000,
      phase_stale_warn_ms: 45000
    };
    this.logger = options.logger;
    const codexHome = (process.env.SYMPHONY_CODEX_HOME || `${process.env.HOME || ''}/.codex`).trim();
    this.codexStateDbPath = options.codexStateDbPath ?? `${codexHome.replace(/\/+$/, '')}/state_5.sqlite`;
    this.refreshCoalescer = new RefreshCoalescer({
      refreshSource: options.refreshSource,
      nowMs: options.nowMs
    });
    this.eventClients = new Map();
    this.nextClientId = 1;
    this.nextEventId = 1;
    this.heartbeatHandle = null;
    this.lastHealthSignature = null;

    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });

    const address = this.address();
    this.startHeartbeat();
    this.logger?.log({
      level: 'info',
      event: CANONICAL_EVENT.api.serverListening,
      message: 'local HTTP API server is listening',
      context: {
        configured_host: this.host,
        configured_port: this.port,
        host: address.host,
        port: address.port,
        ephemeral_port: this.port === 0
      }
    });
  }

  async close(): Promise<void> {
    if (this.heartbeatHandle) {
      clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }

    for (const response of this.eventClients.values()) {
      response.end();
    }
    this.eventClients.clear();

    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  address(): { host: string; port: number } {
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Server is not listening');
    }

    return {
      host: address.address,
      port: address.port
    };
  }

  notifyStateChanged(source: string = 'runtime'): void {
    this.broadcastStateSnapshot(source);
  }

  private startHeartbeat(): void {
    if (this.heartbeatHandle) {
      return;
    }

    this.heartbeatHandle = setInterval(() => {
      this.emitEvent('heartbeat', {
        source: 'api_server',
        clients: this.eventClients.size
      });
    }, 15_000);
  }

  private emitEvent(type: ApiEventEnvelope['type'], payload: unknown): void {
    if (this.eventClients.size === 0) {
      return;
    }

    const envelope: ApiEventEnvelope = {
      event_id: this.nextEventId++,
      generated_at: new Date().toISOString(),
      type,
      payload: redactUnknown(payload)
    };
    const message = `id: ${envelope.event_id}\nevent: symphony\ndata: ${JSON.stringify(envelope)}\n\n`;

    for (const [clientId, response] of this.eventClients.entries()) {
      try {
        response.write(message);
      } catch {
        this.eventClients.delete(clientId);
      }
    }
  }

  private buildCapabilityWarningsByThreadId(runs: ReturnType<NonNullable<LocalApiServerOptions['diagnosticsSource']>['listRunHistory']>) {
    const warningsByThreadId = new Map<string, ReturnType<typeof buildThreadDiagnosticsFromLineage>['capability_warnings']>();
    if (!this.diagnosticsSource?.reconstructThreadLineage) {
      return warningsByThreadId;
    }
    for (const run of runs) {
      if (!run.thread_id || warningsByThreadId.has(run.thread_id)) {
        continue;
      }
      const lineage = this.diagnosticsSource.reconstructThreadLineage(run.thread_id);
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

  private enrichStoppedRunRecoveryState(payload: ApiStateResponse, state: OrchestratorState): void {
    if (!this.diagnosticsSource) {
      payload.stopped_runs = [];
      payload.counts.stopped = 0;
      return;
    }
    const runs = this.diagnosticsSource.listRunHistory(25);
    const activeIssueIdentifiers = new Set<string>([
      ...payload.running.map((entry) => entry.issue_identifier),
      ...payload.retrying.map((entry) => entry.issue_identifier),
      ...payload.blocked.map((entry) => entry.issue_identifier)
    ]);
    const blockedIssueIdentifiers = new Set<string>(payload.blocked.map((entry) => entry.issue_identifier));
    payload.stopped_runs = buildStoppedRunRecoveryEntries({
      runs,
      activeIssueIdentifiers,
      blockedIssueIdentifiers,
      capabilityWarningsByThreadId: this.buildCapabilityWarningsByThreadId(runs)
    });
    payload.counts.stopped = payload.stopped_runs.filter((entry) => !entry.active_issue_present).length;
    void state;
  }

  private buildStateSnapshotResponse(): ApiStateSnapshotResponse {
    try {
      const state = this.snapshotSource.getStateSnapshot();
      const payload = this.snapshotService.projectState(state);
      this.enrichLiveTokenFallbackState(payload);
      this.enrichStoppedRunRecoveryState(payload, state);
      return payload;
    } catch (error) {
      const code: ApiStateErrorResponse['error']['code'] =
        error instanceof LocalApiError && error.code === 'snapshot_timeout'
          ? 'snapshot_timeout'
          : 'snapshot_unavailable';
      const message = code === 'snapshot_timeout' ? 'Snapshot timed out' : 'Snapshot unavailable';
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.api.stateSnapshotUnavailable,
        message,
        context: {
          code,
          detail: error instanceof Error ? error.message : 'unknown'
        }
      });
      return {
        generated_at: new Date().toISOString(),
        error: {
          code,
          message
        }
      };
    }
  }

  private buildBoundedStateSnapshotResponse(): ApiStateSnapshotResponse {
    try {
      const state = this.snapshotSource.getStateSnapshot();
      const payload = this.snapshotService.projectState(state);
      this.enrichLiveTokenFallbackState(payload);
      return payload;
    } catch (error) {
      const code: ApiStateErrorResponse['error']['code'] =
        error instanceof LocalApiError && error.code === 'snapshot_timeout'
          ? 'snapshot_timeout'
          : 'snapshot_unavailable';
      const message = code === 'snapshot_timeout' ? 'Snapshot timed out' : 'Snapshot unavailable';
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.api.stateSnapshotUnavailable,
        message,
        context: {
          code,
          detail: error instanceof Error ? error.message : 'unknown'
        }
      });
      return {
        generated_at: new Date().toISOString(),
        error: {
          code,
          message
        }
      };
    }
  }

  private readTelemetryStateSnapshot(): OrchestratorState | ApiStateErrorResponse {
    try {
      return this.snapshotSource.getStateSnapshot();
    } catch (error) {
      const code: ApiStateErrorResponse['error']['code'] =
        error instanceof LocalApiError && error.code === 'snapshot_timeout'
          ? 'snapshot_timeout'
          : 'snapshot_unavailable';
      return {
        generated_at: new Date().toISOString(),
        error: {
          code,
          message: code === 'snapshot_timeout' ? 'Snapshot timed out' : 'Snapshot unavailable'
        }
      };
    }
  }

  private broadcastStateSnapshot(source: string): void {
    const payload = this.buildBoundedStateSnapshotResponse();
    if (!('error' in payload)) {
      const healthSignature = `${payload.health.dispatch_validation}:${payload.health.last_error ?? ''}`;
      if (this.lastHealthSignature !== null && this.lastHealthSignature !== healthSignature) {
        this.emitEvent('runtime_health_changed', {
          source,
          health: payload.health
        });
      }
      this.lastHealthSignature = healthSignature;
    }
    this.emitEvent('state_snapshot', {
      source,
      state: payload
    });
  }

  private resolveLiveThreadTokenTotals(threadIds: string[]): Map<string, number> {
    const result = new Map<string, number>();
    if (threadIds.length === 0) {
      return result;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sqlite = require('node:sqlite') as {
        DatabaseSync: new (path: string, options?: { readonly?: boolean }) => {
          prepare: (sql: string) => {
            get: (...params: unknown[]) => { tokens_used?: number } | undefined;
          };
          close: () => void;
        };
      };
      const db = new sqlite.DatabaseSync(this.codexStateDbPath, { readonly: true });
      const statement = db.prepare('SELECT tokens_used FROM threads WHERE id = ?');
      for (const threadId of threadIds) {
        const row = statement.get(threadId);
        if (row && typeof row.tokens_used === 'number' && row.tokens_used > 0) {
          result.set(threadId, row.tokens_used);
        }
      }
      db.close();
    } catch {
      return result;
    }

    return result;
  }

  private enrichLiveTokenFallbackState(payload: ApiStateResponse): void {
    if (payload.running.length === 0) {
      return;
    }
    const threadIds = payload.running
      .map((row) => row.thread_id)
      .filter((threadId): threadId is string => typeof threadId === 'string' && threadId.length > 0);
    const liveTotals = this.resolveLiveThreadTokenTotals(threadIds);
    if (liveTotals.size === 0) {
      return;
    }

    let liveAggregate = 0;
    for (const row of payload.running) {
      if (row.tokens.total_tokens > 0 || !row.thread_id) {
        continue;
      }
      const liveTotal = liveTotals.get(row.thread_id);
      if (typeof liveTotal === 'number' && liveTotal > 0) {
        row.tokens.total_tokens = liveTotal;
        row.token_telemetry_status = 'available';
        row.token_telemetry_last_source = 'codex_home_state_sqlite';
        row.token_telemetry_last_at_ms = Date.now();
        row.token_telemetry_confidence = 'backfilled';
        row.token_telemetry_source = 'codex_home_state_sqlite';
        row.token_telemetry_last_observed_at_ms = row.token_telemetry_last_at_ms;
        liveAggregate += liveTotal;
      }
    }

    if (payload.codex_totals.total_tokens === 0 && liveAggregate > 0) {
      payload.codex_totals.total_tokens = liveAggregate;
    }
  }

  private enrichLiveTokenFallbackIssue(payload: ApiIssueResponse): void {
    if (payload.status !== 'running' || !payload.running?.thread_id) {
      return;
    }
    if (payload.running.tokens.total_tokens > 0) {
      return;
    }
    const threadId = payload.running.thread_id;
    const liveTotal = this.resolveLiveThreadTokenTotals([threadId]).get(threadId);
    if (typeof liveTotal === 'number' && liveTotal > 0) {
      payload.running.tokens.total_tokens = liveTotal;
      payload.running.token_telemetry_status = 'available';
      payload.running.token_telemetry_last_source = 'codex_home_state_sqlite';
      payload.running.token_telemetry_last_at_ms = Date.now();
      payload.running.token_telemetry_confidence = 'backfilled';
      payload.running.token_telemetry_source = 'codex_home_state_sqlite';
      payload.running.token_telemetry_last_observed_at_ms = payload.running.token_telemetry_last_at_ms;
    }
  }

  private summarizeTokenTelemetry(payload: ApiStateResponse): Pick<
    ApiDiagnosticsResponse,
    'token_telemetry_status' | 'token_telemetry_last_source' | 'token_telemetry_last_at_ms'
  > {
    const rank = {
      unavailable: 0,
      pending: 1,
      available: 2
    } as const;
    let selected: ApiStateResponse['running'][number] | null = null;
    for (const row of payload.running) {
      if (!selected) {
        selected = row;
        continue;
      }
      const rowRank = rank[row.token_telemetry_status];
      const selectedRank = rank[selected.token_telemetry_status];
      const rowAt = row.token_telemetry_last_at_ms ?? Number.NEGATIVE_INFINITY;
      const selectedAt = selected.token_telemetry_last_at_ms ?? Number.NEGATIVE_INFINITY;
      if (rowRank > selectedRank || (rowRank === selectedRank && rowAt > selectedAt)) {
        selected = row;
      }
    }

    return {
      token_telemetry_status: selected?.token_telemetry_status ?? 'unavailable',
      token_telemetry_last_source: selected?.token_telemetry_last_source ?? null,
      token_telemetry_last_at_ms: selected?.token_telemetry_last_at_ms ?? null
    };
  }

  private buildDiagnosticsPayload(): ApiDiagnosticsResponse {
    if (!this.diagnosticsSource) {
      throw new LocalApiError('diagnostics_unavailable', 'Diagnostics source is not configured', 503);
    }

    let observedDimensions = {
      cached_input_tokens: false,
      reasoning_output_tokens: false,
      model_context_window: false
    };
    let tokenTelemetry: Pick<
      ApiDiagnosticsResponse,
      'token_telemetry_status' | 'token_telemetry_last_source' | 'token_telemetry_last_at_ms'
    > = {
      token_telemetry_status: 'unavailable',
      token_telemetry_last_source: null,
      token_telemetry_last_at_ms: null
    };
    try {
      const snapshot = this.snapshotSource.getStateSnapshot();
      const projected = this.snapshotService.projectState(snapshot);
      this.enrichLiveTokenFallbackState(projected);
      observedDimensions = {
        cached_input_tokens: typeof projected.codex_totals.cached_input_tokens === 'number',
        reasoning_output_tokens: typeof projected.codex_totals.reasoning_output_tokens === 'number',
        model_context_window: typeof projected.codex_totals.model_context_window === 'number'
      };
      tokenTelemetry = this.summarizeTokenTelemetry(projected);
    } catch {
      // Diagnostics should remain available even when state snapshotting is degraded.
    }

    const runtimeResolution = this.diagnosticsSource.getRuntimeResolution();

    return {
      active_profile: this.diagnosticsSource.getActiveProfile(),
      persistence: this.diagnosticsSource.getPersistenceHealth(),
      logging: this.diagnosticsSource.getLoggingHealth(),
      event_vocabulary_version: EVENT_VOCABULARY_VERSION,
      token_accounting: {
        mode: 'strict_canonical',
        canonical_precedence: [
          'terminal_turn_summary',
          'thread/tokenUsage/updated.params.tokenUsage.total',
          'params.info.total_token_usage',
          'params.info.totalTokenUsage',
          'params.total_token_usage',
          'params.totalTokenUsage',
          'params.usage.total_token_usage',
          'params.usage.totalTokenUsage',
          'last_token_usage',
          'persisted_fallback_usage'
        ],
        excludes_generic_usage_for_totals: true,
        excludes_last_usage_for_totals: false,
        no_telemetry_warning_threshold_ms: 120_000,
        optional_dimensions: [
          'cached_input_tokens',
          'reasoning_output_tokens',
          'model_context_window'
        ],
        observed_dimensions: observedDimensions
      },
      ...tokenTelemetry,
      workflow: {
        prompt_fallback_active: this.diagnosticsSource.getPromptFallbackActive()
      },
      phase_markers: this.diagnosticsSource.getPhaseMarkers
        ? this.diagnosticsSource.getPhaseMarkers()
        : {
            enabled: true,
            timeline_limit: 30,
            last_emit_error_code: null
          },
      breaker_statuses: this.diagnosticsSource.getBreakerStatuses
        ? this.diagnosticsSource.getBreakerStatuses()
        : [],
      blocked_latch: this.diagnosticsSource.getBlockedLatchStats
        ? this.diagnosticsSource.getBlockedLatchStats()
        : {
            blocked_latch_active_count: 0,
            blocked_event_quarantine_total: 0,
            blocked_event_allowlist_total: 0,
            blocked_event_reject_total: 0,
            blocked_latch_violation_total: 0
          },
      runtime_resolution: {
        ...runtimeResolution,
        effective_codex_home: runtimeResolution.effective_codex_home ?? null,
        effective_codex_model: runtimeResolution.effective_codex_model ?? null,
        effective_reasoning_effort: runtimeResolution.effective_reasoning_effort ?? null,
        effective_extra_flags_count: runtimeResolution.effective_extra_flags_count ?? 0,
        codex_resolution_mode: runtimeResolution.codex_resolution_mode ?? 'typed'
      },
      workspace_provisioner: this.diagnosticsSource.getWorkspaceProvisioner(),
      workspace_copy_ignored: this.diagnosticsSource.getWorkspaceCopyIgnored()
    };
  }

  private resolveIssueTokenSnapshot(issueIdentifier: string): Partial<ForensicsTokenSnapshot> | null {
    try {
      const issue = this.snapshotService.projectIssue(this.snapshotSource.getStateSnapshot(), issueIdentifier);
      this.enrichLiveTokenFallbackIssue(issue);
      return issue.running?.tokens ?? null;
    } catch {
      return null;
    }
  }

  private registerEventStream(_request: IncomingMessage, response: ServerResponse): void {
    response.statusCode = 200;
    response.setHeader('content-type', 'text/event-stream; charset=utf-8');
    response.setHeader('cache-control', 'no-cache, no-transform');
    response.setHeader('connection', 'keep-alive');
    response.setHeader('x-accel-buffering', 'no');
    response.write(': connected\n\n');

    const clientId = this.nextClientId++;
    this.eventClients.set(clientId, response);
    this.broadcastStateSnapshot('stream_connected');

    response.on('close', () => {
      this.eventClients.delete(clientId);
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const urlPath = new URL(req.url ?? '/', 'http://localhost').pathname;

    const endpoints: Endpoint[] = [
      {
        path: /^\/$/,
        routes: [
          {
            method: 'GET',
            handler: async (_request, response) => {
              sendHtml(response, 200, renderDashboardHtml(this.dashboardConfig));
            }
          }
        ]
      },
      {
        path: /^\/dashboard\/client\.js$/,
        routes: [
          {
            method: 'GET',
            handler: async (_request, response) => {
              sendScript(response, 200, renderDashboardClientJs(this.dashboardConfig));
            }
          }
        ]
      },
      {
        path: /^\/dashboard\/styles\.css$/,
        routes: [
          {
            method: 'GET',
            handler: async (_request, response) => {
              sendCss(response, 200, renderDashboardStylesCss());
            }
          }
        ]
      },
      {
        path: /^\/api\/v1\/state$/,
        routes: [
          {
            method: 'GET',
            handler: async (_request, response) => {
              const payload = this.buildStateSnapshotResponse();
              if (!('error' in payload)) {
                this.logger?.log({
                  level: 'info',
                  event: CANONICAL_EVENT.api.stateRequested,
                  message: 'served state snapshot',
                  context: {
                    running: payload.counts.running,
                    retrying: payload.counts.retrying,
                    blocked: payload.counts.blocked,
                    dispatch_validation: payload.health.dispatch_validation
                  }
                });
              }
              sendJson(response, 200, payload);
            }
          }
        ]
      },
      {
        path: /^\/api\/v1\/events$/,
        routes: [
          {
            method: 'GET',
            handler: async (request, response) => {
              this.registerEventStream(request, response);
            }
          }
        ]
      },
      {
        path: /^\/api\/v1\/refresh$/,
        routes: [
          {
            method: 'POST',
            handler: async (_request, response) => {
              const payload = this.refreshCoalescer.requestRefresh();
              this.logger?.log({
                level: 'info',
                event: CANONICAL_EVENT.api.refreshRequested,
                message: 'manual refresh requested',
                context: {
                  coalesced: payload.coalesced
                }
              });
              this.emitEvent('refresh_accepted', {
                source: 'api_refresh',
                accepted: payload
              });
              sendJson(response, 202, payload);
            }
          }
        ]
      },
      {
        path: /^\/api\/v1\/telemetry\/summary$/,
        routes: [
          {
            method: 'GET',
            handler: async (request, response) => {
              const requestUrl = new URL(request.url ?? '/', 'http://localhost');
              const filters = parseTelemetryQuery(requestUrl);
              const state = this.readTelemetryStateSnapshot();
              if ('error' in state) {
                sendJson(response, 503, state);
                return;
              }
              sendJson(response, 200, buildTelemetrySummaryResponse({
                state,
                diagnosticsSource: this.diagnosticsSource,
                filters
              }));
            }
          }
        ]
      },
      {
        path: /^\/api\/v1\/telemetry\/query$/,
        routes: [
          {
            method: 'GET',
            handler: async (request, response) => {
              const requestUrl = new URL(request.url ?? '/', 'http://localhost');
              const filters = parseTelemetryQuery(requestUrl);
              const state = this.readTelemetryStateSnapshot();
              if ('error' in state) {
                sendJson(response, 503, state);
                return;
              }
              sendJson(response, 200, buildTelemetryQueryResponse({
                state,
                diagnosticsSource: this.diagnosticsSource,
                filters
              }));
            }
          }
        ]
      },
      {
        path: /^\/api\/v1\/workflow\/path$/,
        routes: [
          {
            method: 'POST',
            handler: async (request, response) => {
              if (!this.workflowControlSource) {
                throw new LocalApiError('workflow_control_unavailable', 'Workflow control source is not configured', 503);
              }

              const chunks: Buffer[] = [];
              for await (const chunk of request) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              }

              const payloadText = Buffer.concat(chunks).toString('utf8').trim();
              if (!payloadText) {
                throw new LocalApiError('invalid_workflow_path', 'Request body is required', 400);
              }

              let parsed: { workflow_path?: string };
              try {
                parsed = JSON.parse(payloadText) as { workflow_path?: string };
              } catch {
                throw new LocalApiError('invalid_workflow_path', 'Request body must be valid JSON', 400);
              }

              if (typeof parsed.workflow_path !== 'string' || parsed.workflow_path.trim().length === 0) {
                throw new LocalApiError('invalid_workflow_path', 'workflow_path is required', 400);
              }

              const result = await this.workflowControlSource.switchWorkflowPath(parsed.workflow_path);
              if (!result.applied) {
                throw new LocalApiError(
                  'workflow_reload_failed',
                  result.error ?? 'workflow path switch failed',
                  422
                );
              }

              sendJson(response, 202, result);
            }
          }
        ]
      },
      {
        path: /^\/api\/v1\/workflow\/reload$/,
        routes: [
          {
            method: 'POST',
            handler: async (_request, response) => {
              if (!this.workflowControlSource) {
                throw new LocalApiError('workflow_control_unavailable', 'Workflow control source is not configured', 503);
              }

              const result = await this.workflowControlSource.forceReload();
              if (!result.applied) {
                throw new LocalApiError(
                  'workflow_reload_failed',
                  result.error ?? 'workflow reload failed',
                  422
                );
              }

              sendJson(response, 202, result);
            }
          }
        ]
      },
      {
        path: /^\/api\/v1\/diagnostics$/,
        routes: [
          {
            method: 'GET',
            handler: async (_request, response) => {
              sendJson(response, 200, this.buildDiagnosticsPayload());
            }
          }
        ]
      },
      {
        path: /^\/api\/v1\/history\/threads\/([^/]+)$/,
        routes: [
          {
            method: 'GET',
            handler: async (request, response) => {
              if (!this.diagnosticsSource?.reconstructThreadLineage) {
                throw new LocalApiError('thread_lineage_unavailable', 'Thread lineage source is not configured', 503);
              }

              const requestUrl = new URL(request.url ?? '/', 'http://localhost');
              const [, encodedThreadId] = requestUrl.pathname.match(/^\/api\/v1\/history\/threads\/([^/]+)$/) ?? [];
              const threadId = encodedThreadId ? decodeURIComponent(encodedThreadId) : '';
              const lineage = this.diagnosticsSource.reconstructThreadLineage(threadId);
              if (!lineage) {
                throw new LocalApiError('thread_lineage_not_found', `Thread ${threadId} was not found in persisted lineage`, 404);
              }

              sendJson(response, 200, {
                lineage
              });
            }
          }
        ]
      },
      {
        path: /^\/api\/v1\/history$/,
        routes: [
          {
            method: 'GET',
            handler: async (request, response) => {
              if (!this.diagnosticsSource) {
                throw new LocalApiError('history_unavailable', 'Run history source is not configured', 503);
              }

              const requestUrl = new URL(request.url ?? '/', 'http://localhost');
              const limitRaw = requestUrl.searchParams.get('limit');
              const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
              const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50;
              sendJson(response, 200, {
                runs: this.diagnosticsSource.listRunHistory(limit)
              });
            }
          }
        ]
      },
      {
        path: /^\/api\/v1\/threads\/([^/]+)$/,
        routes: [
          {
            method: 'GET',
            handler: async (_request, response, match) => {
              const threadId = decodeURIComponent(match[1]);
              const lineage = this.diagnosticsSource?.reconstructThreadLineage
                ? this.diagnosticsSource.reconstructThreadLineage(threadId)
                : null;
              const payload = buildThreadDiagnosticsByThreadId({
                state: this.snapshotSource.getStateSnapshot(),
                thread_id: threadId,
                lineage
              });
              if (!payload) {
                throw new LocalApiError('thread_diagnostics_not_found', `Thread ${threadId} was not found`, 404);
              }

              sendJson(response, 200, payload);
            }
          }
        ]
      },
      {
        path: /^\/api\/v1\/issues\/([^/]+)\/diagnostics$/,
        routes: [
          {
            method: 'GET',
            handler: async (_request, response, match) => {
              const issueIdentifier = decodeURIComponent(match[1]);
              const payload = buildThreadDiagnosticsByIssueIdentifier({
                state: this.snapshotSource.getStateSnapshot(),
                issue_identifier: issueIdentifier,
                reconstructThreadLineage: this.diagnosticsSource?.reconstructThreadLineage,
                reconstructLatestThreadLineageByIssueIdentifier:
                  this.diagnosticsSource?.reconstructLatestThreadLineageByIssueIdentifier
              });
              if (!payload) {
                throw new LocalApiError('thread_diagnostics_not_found', `Issue ${issueIdentifier} has no thread diagnostics`, 404);
              }

              sendJson(response, 200, payload);
            }
          }
        ]
      },
      {
        path: /^\/api\/v1\/issues\/([^/]+)\/forensics\/export$/,
        routes: [
          {
            method: 'GET',
            handler: async (_request, response, match) => {
              const issueIdentifier = decodeURIComponent(match[1]);
              const generatedAtMs = Date.now();
              const state = this.snapshotSource.getStateSnapshot();
              const runtimeDiagnostics = this.buildDiagnosticsPayload();
              const latestLineage = this.diagnosticsSource?.reconstructLatestThreadLineageByIssueIdentifier?.(issueIdentifier) ?? null;
              let terminalRun: DurableRunHistoryRecord | null = null;
              let payload = buildThreadDiagnosticsByIssueIdentifier({
                state,
                issue_identifier: issueIdentifier,
                reconstructThreadLineage: this.diagnosticsSource?.reconstructThreadLineage,
                reconstructLatestThreadLineageByIssueIdentifier:
                  this.diagnosticsSource?.reconstructLatestThreadLineageByIssueIdentifier,
                now_ms: generatedAtMs
              });
              if (!payload && this.diagnosticsSource) {
                terminalRun =
                  this.diagnosticsSource
                    .listRunHistory(10_000)
                    .find((run) =>
                      isCompletedTerminalRun(run) &&
                      (run.issue_identifier === issueIdentifier || run.issue_id === issueIdentifier)
                    ) ?? null;
                payload = terminalRun ? diagnosticsFromTerminalRun(terminalRun) : null;
              }
              if (!payload) {
                throw new LocalApiError('forensics_bundle_not_found', `Issue ${issueIdentifier} has no forensics data`, 404);
              }
              const lineage = payload.thread_id && this.diagnosticsSource?.reconstructThreadLineage
                ? this.diagnosticsSource.reconstructThreadLineage(payload.thread_id) ?? latestLineage
                : latestLineage;

              sendJson(response, 200, createForensicsBundle({
                diagnostics: payload,
                api_diagnostics: runtimeDiagnostics,
                lineage,
                terminal_run: terminalRun,
                token_snapshot: this.resolveIssueTokenSnapshot(issueIdentifier),
                generated_at_ms: generatedAtMs
              }));
            }
          }
        ]
      },
      {
        path: /^\/api\/v1\/ui-state$/,
        routes: [
          {
            method: 'GET',
            handler: async (_request, response) => {
              if (!this.diagnosticsSource) {
                throw new LocalApiError('ui_state_unavailable', 'UI state source is not configured', 503);
              }

              sendJson(response, 200, {
                state: this.diagnosticsSource.getUiState()
              });
            }
          },
          {
            method: 'POST',
            handler: async (request, response) => {
              if (!this.diagnosticsSource) {
                throw new LocalApiError('ui_state_unavailable', 'UI state source is not configured', 503);
              }

              const chunks: Buffer[] = [];
              for await (const chunk of request) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              }

              const payloadText = Buffer.concat(chunks).toString('utf8').trim();
              if (!payloadText) {
                throw new LocalApiError('invalid_ui_state', 'Request body is required', 400);
              }

              let parsed: {
                state?: {
                  selected_issue?: string | null;
                  filters?: { status?: 'all' | 'running' | 'retrying' | 'blocked'; query?: string };
                  event_feed_filter?: 'all' | 'warn' | 'error';
                  panels?: { throughput_open?: boolean; runtime_events_open?: boolean };
                  panel_state?: { issue_detail_open?: boolean };
                };
              };
              try {
                parsed = JSON.parse(payloadText) as {
                  state?: {
                    selected_issue?: string | null;
                    filters?: { status?: 'all' | 'running' | 'retrying' | 'blocked'; query?: string };
                    event_feed_filter?: 'all' | 'warn' | 'error';
                    panels?: { throughput_open?: boolean; runtime_events_open?: boolean };
                    panel_state?: { issue_detail_open?: boolean };
                  };
                };
              } catch {
                throw new LocalApiError('invalid_ui_state', 'Request body must be valid JSON', 400);
              }

              const state = parsed.state;
              if (!state) {
                throw new LocalApiError('invalid_ui_state', 'state object is required', 400);
              }

              this.diagnosticsSource.setUiState({
                selected_issue: state.selected_issue ?? null,
                filters: {
                  status: state.filters?.status ?? 'all',
                  query: state.filters?.query ?? ''
                },
                event_feed_filter: state.event_feed_filter ?? 'all',
                panels: {
                  throughput_open: state.panels?.throughput_open ?? true,
                  runtime_events_open: state.panels?.runtime_events_open ?? true
                },
                panel_state: {
                  issue_detail_open: state.panel_state?.issue_detail_open ?? false
                }
              });

              sendJson(response, 202, { saved: true });
            }
          }
        ]
      },
      {
        path: /^\/api\/v1\/issues\/([^/]+)\/input$/,
        routes: [
          {
            method: 'POST',
            handler: async (request, response, match) => {
              if (!this.issueControlSource) {
                throw new LocalApiError('input_submit_failed', 'Issue control source is not configured', 503);
              }

              const chunks: Buffer[] = [];
              for await (const chunk of request) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              }
              const payloadText = Buffer.concat(chunks).toString('utf8').trim();
              if (!payloadText) {
                throw new LocalApiError('invalid_input_submit', 'Request body is required', 400);
              }
              let parsed: {
                request_id?: string;
                actor?: string;
                reason_note?: string;
                answer?: { question_id?: string; option_label?: string; text?: string };
              };
              try {
                parsed = JSON.parse(payloadText) as {
                  request_id?: string;
                  actor?: string;
                  reason_note?: string;
                  answer?: { question_id?: string; option_label?: string; text?: string };
                };
              } catch {
                throw new LocalApiError('invalid_input_submit', 'Request body must be valid JSON', 400);
              }
              if (!parsed.request_id || !parsed.answer) {
                throw new LocalApiError('invalid_input_submit', 'request_id and answer are required', 400);
              }
              const operatorAction = parseOperatorActionBody(parsed as Record<string, unknown>);
              const reasonNote = requireOperatorReasonNote(operatorAction);
              const issueIdentifier = decodeURIComponent(match[1]);
              const result = await this.issueControlSource.submitBlockedIssueInput({
                issueIdentifier,
                request_id: parsed.request_id,
                actor: operatorAction.actor,
                reason_note: reasonNote,
                answer: parsed.answer
              });
              if (!result.ok) {
                const status =
                  result.code === 'issue_not_blocked'
                    ? 404
                    : result.code === 'input_submission_expired'
                      ? 409
                      : result.code === 'input_submission_transport_unavailable'
                        ? 503
                        : 422;
                throw new LocalApiError(result.code, result.message, status);
              }

              sendJson(response, 202, {
                resumed: true,
                issue_identifier: issueIdentifier,
                request_id: result.request_id,
                resume_mode: result.resume_mode,
                resume_reason_code: result.resume_reason_code,
                request_lineage: result.request_lineage,
                requested_at: result.requested_at
              });
            }
          }
        ]
      },
      {
        path: /^\/api\/v1\/issues\/([^/]+)\/cancel-turn$/,
        routes: [
          {
            method: 'POST',
            handler: async (request, response, match) => {
              if (!this.issueControlSource?.cancelCurrentTurn) {
                throw new LocalApiError('cancel_failed', 'Issue control source is not configured', 503);
              }
              const parsed = parseOperatorActionBody(await readOptionalJsonObject(request, 'invalid_cancel_submit'));
              const reasonNote = requireOperatorReasonNote({
                ...parsed,
                reason_note: parsed.reason_note ?? parsed.cancel_reason
              });
              const issueIdentifier = decodeURIComponent(match[1]);
              const result = await this.issueControlSource.cancelCurrentTurn(issueIdentifier, {
                actor: parsed.actor,
                reason_note: reasonNote,
                confirmed: parsed.confirmed
              });
              if (!result.ok) {
                throw new LocalApiError(result.code, result.message, statusForOperatorActionFailure(result.code));
              }
              sendJson(response, 202, {
                cancelled: true,
                issue_identifier: issueIdentifier,
                requested_at: new Date().toISOString()
              });
            }
          }
        ]
      },
      {
        path: /^\/api\/v1\/issues\/([^/]+)\/requeue$/,
        routes: [
          {
            method: 'POST',
            handler: async (request, response, match) => {
              if (!this.issueControlSource?.requeueIssue) {
                throw new LocalApiError('requeue_failed', 'Issue control source is not configured', 503);
              }
              const parsed = parseOperatorActionBody(await readOptionalJsonObject(request, 'invalid_requeue_submit'));
              const reasonNote = requireOperatorReasonNote(parsed);
              const issueIdentifier = decodeURIComponent(match[1]);
              const result = await this.issueControlSource.requeueIssue(issueIdentifier, {
                actor: parsed.actor,
                reason_note: reasonNote,
                confirmed: parsed.confirmed
              });
              if (!result.ok) {
                throw new LocalApiError(result.code, result.message, statusForOperatorActionFailure(result.code));
              }
              sendJson(response, 202, {
                requeued: true,
                issue_identifier: issueIdentifier,
                retry_attempt: result.retry_attempt,
                requested_at: new Date().toISOString()
              });
            }
          }
        ]
      },
      {
        path: /^\/api\/v1\/issues\/([^/]+)\/retry-step$/,
        routes: [
          {
            method: 'POST',
            handler: async (request, response, match) => {
              if (!this.issueControlSource?.retryLastFailedStep) {
                throw new LocalApiError('retry_step_failed', 'Issue control source is not configured', 503);
              }
              const parsed = parseOperatorActionBody(await readOptionalJsonObject(request, 'invalid_retry_step_submit'));
              const reasonNote = requireOperatorReasonNote(parsed);
              const issueIdentifier = decodeURIComponent(match[1]);
              const result = await this.issueControlSource.retryLastFailedStep(issueIdentifier, {
                actor: parsed.actor,
                reason_note: reasonNote
              });
              if (!result.ok) {
                throw new LocalApiError(result.code, result.message, statusForOperatorActionFailure(result.code));
              }
              sendJson(response, 202, {
                retry_step: true,
                issue_identifier: issueIdentifier,
                retry_attempt: result.retry_attempt,
                requested_at: new Date().toISOString()
              });
            }
          }
        ]
      },
      {
        path: /^\/api\/v1\/issues\/([^/]+)\/resume$/,
        routes: [
          {
            method: 'POST',
            handler: async (request, response, match) => {
              if (!this.issueControlSource) {
                throw new LocalApiError('resume_failed', 'Issue control source is not configured', 503);
              }
              const parsed = parseOperatorActionBody(await readOptionalJsonObject(request, 'invalid_resume_submit'));
              const reasonNote = requireOperatorReasonNote(parsed);

              const issueIdentifier = decodeURIComponent(match[1]);
              const result = parsed.resume_override_reason
                ? await this.issueControlSource.resumeBlockedIssue(issueIdentifier, {
                    resume_override_reason: parsed.resume_override_reason,
                    actor: parsed.actor,
                    reason_note: reasonNote
                  })
                : await this.issueControlSource.resumeBlockedIssue(issueIdentifier, {
                    actor: parsed.actor,
                    reason_note: reasonNote
                  });
              if (!result.ok) {
                throw new LocalApiError(result.code, result.message, statusForOperatorActionFailure(result.code));
              }

              sendJson(response, 202, {
                resumed: true,
                issue_identifier: issueIdentifier,
                requested_at: new Date().toISOString()
              });
            }
          }
        ]
      },
      {
        path: /^\/api\/v1\/issues\/([^/]+)\/cancel$/,
        routes: [
          {
            method: 'POST',
            handler: async (request, response, match) => {
              if (!this.issueControlSource) {
                throw new LocalApiError('cancel_failed', 'Issue control source is not configured', 503);
              }
              const parsed = parseOperatorActionBody(await readOptionalJsonObject(request, 'invalid_cancel_submit'));
              const reasonNote = requireOperatorReasonNote({
                ...parsed,
                reason_note: parsed.reason_note ?? parsed.cancel_reason
              });
              if (parsed.confirmed !== true) {
                throw new LocalApiError('confirmation_required', 'Cancel requires explicit confirmation', 409);
              }
              const issueIdentifier = decodeURIComponent(match[1]);
              const result = await this.issueControlSource.cancelBlockedIssue(issueIdentifier, {
                cancel_reason: parsed.cancel_reason ?? reasonNote,
                actor: parsed.actor,
                reason_note: reasonNote,
                confirmed: parsed.confirmed
              });
              if (!result.ok) {
                throw new LocalApiError(result.code, result.message, statusForOperatorActionFailure(result.code));
              }
              sendJson(response, 202, {
                cancelled: true,
                issue_identifier: issueIdentifier,
                moved_to_state: result.moved_to_state,
                requested_at: new Date().toISOString()
              });
            }
          }
        ]
      },
      {
        path: /^\/api\/v1\/issues\/([^/]+)$/,
        routes: [
          {
            method: 'GET',
            handler: async (_request, response, match) => {
              const issueIdentifier = decodeURIComponent(match[1]);
              const state = this.snapshotSource.getStateSnapshot();
              const payload = this.snapshotService.projectIssue(state, issueIdentifier);
              this.enrichLiveTokenFallbackIssue(payload);
              this.logger?.log({
                level: 'info',
                event: CANONICAL_EVENT.api.issueRequested,
                message: 'served issue snapshot',
                context: {
                  issue_id: payload.issue_id,
                  issue_identifier: payload.issue_identifier,
                  session_id: payload.running?.session_id ?? null,
                  route: '/api/v1/issues/:issue_identifier'
                }
              });
              sendJson(response, 200, payload);
            }
          }
        ]
      },
      {
        path: /^\/api\/v1\/([^/]+)$/,
        routes: [
          {
            method: 'GET',
            handler: async (_request, response, match) => {
              const issueIdentifier = decodeURIComponent(match[1]);
              const state = this.snapshotSource.getStateSnapshot();
              const payload = this.snapshotService.projectIssue(state, issueIdentifier);
              this.enrichLiveTokenFallbackIssue(payload);
              this.logger?.log({
                level: 'info',
                event: CANONICAL_EVENT.api.issueRequested,
                message: 'served issue snapshot',
                context: {
                  issue_id: payload.issue_id,
                  issue_identifier: payload.issue_identifier,
                  session_id: payload.running?.session_id ?? null
                }
              });
              sendJson(response, 200, payload);
            }
          }
        ]
      }
    ];

    const endpointMatch = endpoints
      .map((endpoint) => ({ endpoint, match: endpoint.path.exec(urlPath) }))
      .find((entry) => entry.match !== null) as { endpoint: Endpoint; match: RegExpExecArray } | undefined;

    if (!endpointMatch) {
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.api.degradedRouteNotFound,
        message: `route not found for ${urlPath}`
      });
      sendJson(res, 404, {
        error: {
          code: 'api_degraded_route_not_found',
          message: `Route ${urlPath} was not found`
        },
        ...createApiDegradedDiagnostics('route_not_found', ISSUE_DETAIL_ROUTES)
      });
      return;
    }

    const matchingMethodRoute = endpointMatch.endpoint.routes.find((route) => route.method === method);
    if (!matchingMethodRoute) {
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.api.methodNotAllowed,
        message: `method ${method} is not supported for ${urlPath}`
      });
      sendError(res, 405, 'method_not_allowed', `Method ${method} is not supported for ${urlPath}`);
      return;
    }

    try {
      await matchingMethodRoute.handler(req, res, endpointMatch.match);
    } catch (error) {
      if (error instanceof TelemetryQueryError) {
        sendError(res, 400, error.code, error.message);
        return;
      }

      if (error instanceof LocalApiError) {
        this.logger?.log({
          level: 'warn',
          event: CANONICAL_EVENT.api.localError,
          message: error.message,
          context: {
            code: error.code,
            status: error.http_status
          }
        });
        sendError(res, error.http_status, error.code, error.message);
        return;
      }

      this.logger?.log({
        level: 'error',
        event: CANONICAL_EVENT.api.internalError,
        message: error instanceof Error ? error.message : 'unknown internal server error'
      });

      sendError(res, 500, 'internal_error', 'Internal server error');
    }
  }
}
