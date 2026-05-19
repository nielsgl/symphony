import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';

import type { StructuredLogger } from '../observability';
import { CANONICAL_EVENT } from '../observability/events';
import type { DurableRunHistoryRecord, ProjectHistoryTicketSummaryProjection } from '../persistence';
import { ControlPlaneHealthRecorder, type ControlPlaneHealthState, type ControlPlaneObservation } from './control-plane-health';
import { NodeEventLoopHealthMonitor, type EventLoopHealthMonitor, type EventLoopHealthSummary } from './event-loop-health';
import { renderDashboardClientJs, renderDashboardHtml, renderDashboardStylesCss } from './dashboard-assets';
import { LocalApiError } from './errors';
import { RefreshCoalescer } from './refresh-coalescer';
import { createApiDegradedDiagnostics } from './runtime-visibility';
import { SnapshotService } from './snapshot-service';
import { createForensicsBundle, type ForensicsTokenSnapshot } from './forensics';
import {
  buildTelemetryQueryResponse,
  buildTelemetrySummaryResponse,
  parseTelemetryQuery,
  TelemetryQueryError
} from './telemetry';
import {
  buildProjectHistoryConsumerSummaryResponse,
  buildProjectHistoryHealth,
  buildProjectHistoryListResponse,
  buildProjectHistoryTicketDetailResponse
} from './project-history';
import {
  buildThreadDiagnosticsByIssueIdentifier,
  buildThreadDiagnosticsByThreadId
} from './thread-diagnostics';
import type {
  ApiDiagnosticsResponse,
  ApiIssueResponse,
  ApiEventEnvelope,
  ApiIssueRuntimeDiagnosticsResponse,
  ApiStateResponse,
  ApiStateErrorResponse,
  ApiStateSnapshotResponse,
  LocalApiServerOptions
} from './types';
import type { OrchestratorState } from '../orchestrator';
import {
  sendCss,
  sendError,
  sendHtml,
  sendJson,
  sendJsonBody,
  sendScript,
  parseBoundedPositiveInteger,
  parseNonNegativeInteger,
  serializeJsonPayload
} from './server/responses';
import {
  ISSUE_DETAIL_ROUTES,
  type Endpoint,
  type RequestTiming,
  parseRuntimeDiagnosticsPage
} from './server/routing';
import {
  createStreamDiagnosticsState,
  serializeEventEnvelope,
  type StreamDiagnosticsState,
  writeEventMessage
} from './server/event-stream';
import {
  parseOperatorActionBody,
  readOptionalJsonObject,
  requireOperatorReasonNote,
  statusForOperatorActionFailure
} from './server/operator-actions';
import {
  enrichLiveTokenFallbackIssue,
  enrichLiveTokenFallbackState,
  type LiveTokenFallbackCacheEntry
} from './server/token-enrichment';
import {
  buildStoppedRunRecoveryResponse,
  diagnosticsFromTerminalRun,
  isCompletedTerminalRun
} from './server/stopped-run-recovery';
import {
  buildDiagnosticsPayload,
  type TimedDiagnosticsPayload
} from './server/diagnostics';

interface TimedStateSnapshot {
  payload: ApiStateSnapshotResponse;
  projectionDurationMs: number | null;
  enrichmentDurationMs: number | null;
  enrichmentStatus: string | null;
  enrichmentDegraded: boolean | null;
  enrichmentReasonCode: string | null;
  snapshotAgeMs: number | null;
  snapshotFreshnessState: ApiStateResponse['snapshot_freshness_state'] | null;
  snapshotErrorCode: ApiStateErrorResponse['error']['code'] | null;
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
  private readonly nowMs: () => number;
  private readonly requestTimingNowMs: () => number;
  private readonly controlPlaneHealth: ControlPlaneHealthRecorder;
  private readonly eventLoopHealth: EventLoopHealthMonitor;

  private readonly server: http.Server;
  private readonly eventClients: Map<number, ServerResponse>;
  private nextClientId: number;
  private nextEventId: number;
  private heartbeatHandle: NodeJS.Timeout | null;
  private lastHealthSignature: string | null;
  private readonly streamDiagnostics: StreamDiagnosticsState;
  private readonly liveTokenFallbackCache: Map<string, LiveTokenFallbackCacheEntry>;

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
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.requestTimingNowMs = options.requestTimingNowMs ?? (() => performance.now());
    this.controlPlaneHealth = options.controlPlaneHealthRecorder ?? new ControlPlaneHealthRecorder(options.controlPlaneHealth);
    this.eventLoopHealth = options.eventLoopHealthMonitor ?? new NodeEventLoopHealthMonitor();
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
    this.liveTokenFallbackCache = new Map();
    this.streamDiagnostics = createStreamDiagnosticsState();

    this.server = http.createServer((req, res) => {
      void this.handle(req, res, {
        request_received_at_ms: this.requestTimingNowMs(),
        request_queue_delay_ms: 0
      });
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
    this.eventLoopHealth.close?.();
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

  private serializeEvent(type: ApiEventEnvelope['type'], payload: unknown): { message: string; bytes: number } {
    return serializeEventEnvelope(type, payload, () => this.nextEventId++, this.nowMs);
  }

  private writeEventMessage(message: string): { failedClientCount: number; error: string | null } {
    return writeEventMessage(this.eventClients, message);
  }

  private emitEvent(type: ApiEventEnvelope['type'], payload: unknown): void {
    if (this.eventClients.size === 0) {
      return;
    }

    this.writeEventMessage(this.serializeEvent(type, payload).message);
  }

  private summarizeEventLoopHealth(): EventLoopHealthSummary {
    const summary = this.eventLoopHealth.summarize(this.nowMs());
    this.controlPlaneHealth.recordEventLoop(summary);
    return summary;
  }

  private controlPlaneSummary() {
    this.summarizeEventLoopHealth();
    return this.controlPlaneHealth.summarize(this.nowMs());
  }

  private controlPlaneObservationTiming(timing: RequestTiming): Pick<
    ControlPlaneObservation,
    'request_queue_delay_ms' | 'event_loop_delay_ms' | 'event_loop_utilization'
  > {
    const eventLoop = this.summarizeEventLoopHealth();
    return {
      request_queue_delay_ms: timing.request_queue_delay_ms,
      event_loop_delay_ms: eventLoop.delay.max_ms,
      event_loop_utilization: eventLoop.utilization.utilization
    };
  }

  private markProjectionQueueDelay(timing: RequestTiming): void {
    timing.request_queue_delay_ms = Math.max(0, Math.round(this.requestTimingNowMs() - timing.request_received_at_ms));
  }

  private recordControlPlaneObservation(observation: ControlPlaneObservation): ControlPlaneHealthState {
    const health = this.controlPlaneHealth.record(observation);
    if (observation.endpoint === '/api/v1/state' && health !== 'ok') {
      this.logger?.log({
        level: health === 'degraded' ? 'warn' : 'info',
        event: CANONICAL_EVENT.api.stateSnapshotDegraded,
        message: 'state snapshot control-plane pressure observed',
        context: {
          endpoint: observation.endpoint,
          transport: observation.transport,
          duration_ms: Math.round(observation.duration_ms),
          payload_bytes: Math.round(observation.payload_bytes),
          request_queue_delay_ms: observation.request_queue_delay_ms,
          projection_duration_ms: observation.projection_duration_ms,
          enrichment_duration_ms: observation.enrichment_duration_ms,
          enrichment_status: observation.enrichment_status ?? null,
          enrichment_degraded: observation.enrichment_degraded ?? null,
          enrichment_reason_code: observation.enrichment_reason_code ?? null,
          serialization_duration_ms: observation.serialization_duration_ms,
          broadcast_client_count: observation.broadcast_client_count ?? null,
          snapshot_age_ms: observation.snapshot_age_ms ?? null,
          snapshot_freshness_state: observation.snapshot_freshness_state ?? null,
          snapshot_error_code: observation.snapshot_error_code ?? null,
          event_loop_delay_ms: observation.event_loop_delay_ms ?? null,
          event_loop_utilization: observation.event_loop_utilization ?? null,
          health
        }
      });
    }
    return health;
  }

  private buildStoppedRunRecoveryResponse(limit = 25): {
    stopped_runs: ApiStateResponse['stopped_runs'];
    counts: { stopped: number };
  } {
    return buildStoppedRunRecoveryResponse({
      limit,
      diagnosticsSource: this.diagnosticsSource,
      snapshotSource: this.snapshotSource,
      snapshotService: this.snapshotService
    });
  }

  private buildStateSnapshotResponse(): TimedStateSnapshot {
    const projectionStartedAtMs = this.nowMs();
    try {
      const state = this.snapshotSource.getStateSnapshot({ includeTranscriptToolCallDiagnostics: false });
      const payload = this.snapshotService.projectState(state);
      const projectionDurationMs = this.nowMs() - projectionStartedAtMs;
      const enrichmentStartedAtMs = this.nowMs();
      const enrichment = this.enrichLiveTokenFallbackState(payload);
      const enrichmentDurationMs = this.nowMs() - enrichmentStartedAtMs;
      return {
        payload,
        projectionDurationMs,
        enrichmentDurationMs,
        enrichmentStatus: enrichment.status,
        enrichmentDegraded: enrichment.degraded,
        enrichmentReasonCode: enrichment.reason_code,
        snapshotAgeMs: payload.snapshot_age_ms,
        snapshotFreshnessState: payload.snapshot_freshness_state,
        snapshotErrorCode: null
      };
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
        payload: {
          generated_at: new Date(this.nowMs()).toISOString(),
          error: {
            code,
            message
          }
        },
        projectionDurationMs: this.nowMs() - projectionStartedAtMs,
        enrichmentDurationMs: null,
        enrichmentStatus: null,
        enrichmentDegraded: null,
        enrichmentReasonCode: null,
        snapshotAgeMs: null,
        snapshotFreshnessState: null,
        snapshotErrorCode: code
      };
    }
  }

  private buildBoundedStateSnapshotResponse(): TimedStateSnapshot {
    const projectionStartedAtMs = this.nowMs();
    try {
      const state = this.snapshotSource.getStateSnapshot({ includeTranscriptToolCallDiagnostics: false });
      const payload = this.snapshotService.projectState(state);
      const projectionDurationMs = this.nowMs() - projectionStartedAtMs;
      const enrichmentStartedAtMs = this.nowMs();
      const enrichment = this.enrichLiveTokenFallbackState(payload);
      const enrichmentDurationMs = this.nowMs() - enrichmentStartedAtMs;
      return {
        payload,
        projectionDurationMs,
        enrichmentDurationMs,
        enrichmentStatus: enrichment.status,
        enrichmentDegraded: enrichment.degraded,
        enrichmentReasonCode: enrichment.reason_code,
        snapshotAgeMs: payload.snapshot_age_ms,
        snapshotFreshnessState: payload.snapshot_freshness_state,
        snapshotErrorCode: null
      };
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
        payload: {
          generated_at: new Date(this.nowMs()).toISOString(),
          error: {
            code,
            message
          }
        },
        projectionDurationMs: this.nowMs() - projectionStartedAtMs,
        enrichmentDurationMs: null,
        enrichmentStatus: null,
        enrichmentDegraded: null,
        enrichmentReasonCode: null,
        snapshotAgeMs: null,
        snapshotFreshnessState: null,
        snapshotErrorCode: code
      };
    }
  }

  private readTelemetryStateSnapshot(): OrchestratorState | ApiStateErrorResponse {
    try {
      return this.snapshotSource.getStateSnapshot({ includeTranscriptToolCallDiagnostics: false });
    } catch (error) {
      const code: ApiStateErrorResponse['error']['code'] =
        error instanceof LocalApiError && error.code === 'snapshot_timeout'
          ? 'snapshot_timeout'
          : 'snapshot_unavailable';
      return {
        generated_at: new Date(this.nowMs()).toISOString(),
        error: {
          code,
          message: code === 'snapshot_timeout' ? 'Snapshot timed out' : 'Snapshot unavailable'
        }
      };
    }
  }

  private broadcastStateSnapshot(source: string): void {
    const startedAtMs = this.nowMs();
    const snapshot = this.buildBoundedStateSnapshotResponse();
    const payload = snapshot.payload;
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
    if (this.eventClients.size === 0) {
      this.streamDiagnostics.lastSnapshotBroadcastAtMs = this.nowMs();
      this.streamDiagnostics.lastSnapshotBroadcastLatencyMs = this.nowMs() - startedAtMs;
      this.streamDiagnostics.lastSnapshotBroadcastStatus = 'no_clients';
      this.streamDiagnostics.lastSnapshotBroadcastError = null;
      return;
    }
    const serializationStartedAtMs = this.nowMs();
    const serialized = this.serializeEvent('state_snapshot', {
      source,
      state: payload
    });
    const serializationDurationMs = this.nowMs() - serializationStartedAtMs;
    const eventLoop = this.summarizeEventLoopHealth();
    this.recordControlPlaneObservation({
      endpoint: '/api/v1/events:state_snapshot',
      transport: 'sse',
      observed_at_ms: this.nowMs(),
      duration_ms: this.nowMs() - startedAtMs,
      status_code: 200,
      payload_bytes: serialized.bytes,
      request_queue_delay_ms: 0,
      event_loop_delay_ms: eventLoop.delay.max_ms,
      event_loop_utilization: eventLoop.utilization.utilization,
      projection_duration_ms: snapshot.projectionDurationMs,
      enrichment_duration_ms: snapshot.enrichmentDurationMs,
      enrichment_status: snapshot.enrichmentStatus,
      enrichment_degraded: snapshot.enrichmentDegraded,
      enrichment_reason_code: snapshot.enrichmentReasonCode,
      serialization_duration_ms: serializationDurationMs,
      broadcast_client_count: this.eventClients.size,
      snapshot_age_ms: snapshot.snapshotAgeMs,
      snapshot_freshness_state: snapshot.snapshotFreshnessState,
      snapshot_error_code: snapshot.snapshotErrorCode
    });
    const writeResult = this.writeEventMessage(serialized.message);
    this.streamDiagnostics.lastSnapshotBroadcastAtMs = this.nowMs();
    this.streamDiagnostics.lastSnapshotBroadcastLatencyMs = this.nowMs() - startedAtMs;
    this.streamDiagnostics.lastSnapshotBroadcastStatus = writeResult.failedClientCount > 0 ? 'failed' : 'ok';
    this.streamDiagnostics.lastSnapshotBroadcastError = writeResult.error;
  }

  private enrichLiveTokenFallbackState(payload: ApiStateResponse): ApiDiagnosticsResponse['token_enrichment'] {
    return enrichLiveTokenFallbackState({
      payload,
      cache: this.liveTokenFallbackCache,
      nowMs: this.nowMs,
      codexStateDbPath: this.codexStateDbPath
    });
  }

  private enrichLiveTokenFallbackIssue(payload: ApiIssueResponse): void {
    enrichLiveTokenFallbackIssue({
      payload,
      nowMs: this.nowMs,
      codexStateDbPath: this.codexStateDbPath
    });
  }

  private buildDiagnosticsPayload(): TimedDiagnosticsPayload {
    return buildDiagnosticsPayload({
      diagnosticsSource: this.diagnosticsSource,
      snapshotSource: this.snapshotSource,
      snapshotService: this.snapshotService,
      nowMs: this.nowMs,
      streamDiagnostics: this.streamDiagnostics,
      liveClientCount: this.eventClients.size,
      controlPlaneSummary: () => this.controlPlaneSummary(),
      enrichLiveTokenFallbackState: (payload) => this.enrichLiveTokenFallbackState(payload)
    });
  }

  private resolveIssueTokenSnapshot(issueIdentifier: string): Partial<ForensicsTokenSnapshot> | null {
    try {
      const issue = this.snapshotService.projectIssue(
        this.snapshotSource.getStateSnapshot({ includeTranscriptToolCallDiagnostics: false }),
        issueIdentifier
      );
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
    this.streamDiagnostics.lastClientConnectedAtMs = this.nowMs();
    this.broadcastStateSnapshot('stream_connected');

    response.on('close', () => {
      this.eventClients.delete(clientId);
      this.streamDiagnostics.lastClientDisconnectedAtMs = this.nowMs();
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse, timing: RequestTiming): Promise<void> {
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
            handler: async (_request, response, _match, timing) => {
              const startedAtMs = this.nowMs();
              this.markProjectionQueueDelay(timing);
              const snapshot = this.buildStateSnapshotResponse();
              const payload = snapshot.payload;
              if (!('error' in payload)) {
                payload.health.control_plane = this.controlPlaneSummary();
              }
              const serializationStartedAtMs = this.nowMs();
              const serialized = serializeJsonPayload(payload);
              const serializationDurationMs = this.nowMs() - serializationStartedAtMs;
              const observationTiming = this.controlPlaneObservationTiming(timing);
              const health = this.recordControlPlaneObservation({
                endpoint: '/api/v1/state',
                transport: 'http',
                observed_at_ms: this.nowMs(),
                duration_ms: this.nowMs() - startedAtMs,
                status_code: 200,
                payload_bytes: serialized.bytes,
                ...observationTiming,
                projection_duration_ms: snapshot.projectionDurationMs,
                enrichment_duration_ms: snapshot.enrichmentDurationMs,
                enrichment_status: snapshot.enrichmentStatus,
                enrichment_degraded: snapshot.enrichmentDegraded,
                enrichment_reason_code: snapshot.enrichmentReasonCode,
                serialization_duration_ms: serializationDurationMs,
                snapshot_age_ms: snapshot.snapshotAgeMs,
                snapshot_freshness_state: snapshot.snapshotFreshnessState,
                snapshot_error_code: snapshot.snapshotErrorCode
              });
              if (!('error' in payload)) {
                this.logger?.log({
                  level: 'info',
                  event: CANONICAL_EVENT.api.stateRequested,
                  message: 'served state snapshot',
                  context: {
                    running: payload.counts.running,
                    retrying: payload.counts.retrying,
                    blocked: payload.counts.blocked,
                    dispatch_validation: payload.health.dispatch_validation,
                    duration_ms: this.nowMs() - startedAtMs,
                    payload_bytes: serialized.bytes,
                    request_queue_delay_ms: timing.request_queue_delay_ms,
                    projection_duration_ms: snapshot.projectionDurationMs,
                    enrichment_duration_ms: snapshot.enrichmentDurationMs,
                    enrichment_status: snapshot.enrichmentStatus,
                    enrichment_degraded: snapshot.enrichmentDegraded,
                    enrichment_reason_code: snapshot.enrichmentReasonCode,
                    serialization_duration_ms: serializationDurationMs,
                    snapshot_age_ms: snapshot.snapshotAgeMs,
                    snapshot_freshness_state: snapshot.snapshotFreshnessState,
                    event_loop_delay_ms: observationTiming.event_loop_delay_ms ?? null,
                    event_loop_utilization: observationTiming.event_loop_utilization ?? null,
                    control_plane_health: health
                  }
                });
              }
              sendJsonBody(response, 200, serialized.body);
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
            handler: async (_request, response, _match, timing) => {
              const startedAtMs = this.nowMs();
              this.markProjectionQueueDelay(timing);
              const diagnostics = this.buildDiagnosticsPayload();
              const payload = diagnostics.payload;
              const serializationStartedAtMs = this.nowMs();
              const serialized = serializeJsonPayload(payload);
              const serializationDurationMs = this.nowMs() - serializationStartedAtMs;
              this.recordControlPlaneObservation({
                endpoint: '/api/v1/diagnostics',
                transport: 'http',
                observed_at_ms: this.nowMs(),
                duration_ms: this.nowMs() - startedAtMs,
                status_code: 200,
                payload_bytes: serialized.bytes,
                ...this.controlPlaneObservationTiming(timing),
                projection_duration_ms: diagnostics.projectionDurationMs,
                enrichment_duration_ms: diagnostics.enrichmentDurationMs,
                enrichment_status: diagnostics.enrichmentStatus,
                enrichment_degraded: diagnostics.enrichmentDegraded,
                enrichment_reason_code: diagnostics.enrichmentReasonCode,
                serialization_duration_ms: serializationDurationMs
              });
              sendJsonBody(response, 200, serialized.body);
            }
          }
        ]
      },
      {
        path: /^\/api\/v1\/stopped-runs\/recovery$/,
        routes: [
          {
            method: 'GET',
            handler: async (request, response) => {
              const requestUrl = new URL(request.url ?? '/', 'http://localhost');
              const limitRaw = requestUrl.searchParams.get('limit');
              const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
              const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 25;
              sendJson(response, 200, this.buildStoppedRunRecoveryResponse(limit));
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
        path: /^\/api\/v1\/projects\/([^/]+)\/history\/tickets$/,
        routes: [
          {
            method: 'GET',
            handler: async (request, response, match) => {
              if (!this.diagnosticsSource?.listProjectTicketSummaries) {
                throw new LocalApiError('project_history_unavailable', 'Project ticket history source is not configured', 503);
              }

              const projectKey = decodeURIComponent(match[1]);
              const requestUrl = new URL(request.url ?? '/', 'http://localhost');
              const limit = parseBoundedPositiveInteger(requestUrl.searchParams.get('limit'), 50, 100);
              const offset = parseNonNegativeInteger(requestUrl.searchParams.get('offset'));
              const page = this.diagnosticsSource.listProjectTicketSummaries(projectKey, { limit, offset });
              const persistenceHealth = this.diagnosticsSource.getPersistenceHealth();

              sendJson(response, 200, buildProjectHistoryListResponse({
                projectKey,
                summaries: page.items,
                page: {
                  limit: page.limit,
                  offset: page.offset,
                  has_more: page.has_more,
                  total: page.total
                },
                persistenceHealth
              }));
            }
          }
        ]
      },
      {
        path: /^\/api\/v1\/projects\/([^/]+)\/history\/health$/,
        routes: [
          {
            method: 'GET',
            handler: async (_request, response, match) => {
              if (!this.diagnosticsSource) {
                sendJson(response, 200, buildProjectHistoryHealth({
                  persistenceHealth: null,
                  projectionAvailable: false,
                  projectionFailureReasonCode: 'project_history_unavailable',
                  projectionFailureDetail: 'Diagnostics source is not configured'
                }));
                return;
              }

              const projectKey = decodeURIComponent(match[1]);
              const projectionAvailable = !!this.diagnosticsSource.listProjectTicketSummaries;
              let summaries: ProjectHistoryTicketSummaryProjection[] = [];
              let ticketCount: number | null = null;
              let projectionFailureReasonCode: string | null = null;
              let projectionFailureDetail: string | null = null;
              if (projectionAvailable) {
                try {
                  const page = this.diagnosticsSource.listProjectTicketSummaries!(projectKey, { limit: 100, offset: 0 });
                  summaries = page.items;
                  ticketCount = page.total;
                } catch (error) {
                  projectionFailureReasonCode = 'project_history_projection_failed';
                  projectionFailureDetail = error instanceof Error ? error.message : String(error);
                }
              } else {
                projectionFailureReasonCode = 'project_history_projection_unavailable';
              }

              sendJson(response, 200, buildProjectHistoryHealth({
                persistenceHealth: this.diagnosticsSource.getPersistenceHealth(),
                summaries,
                ticketCount,
                projectionAvailable: projectionAvailable && projectionFailureReasonCode === null,
                projectionFailureReasonCode,
                projectionFailureDetail
              }));
            }
          }
        ]
      },
      {
        path: /^\/api\/v1\/projects\/([^/]+)\/history\/tickets\/([^/]+)\/consumer-summary$/,
        routes: [
          {
            method: 'GET',
            handler: async (_request, response, match) => {
              if (!this.diagnosticsSource?.getProjectTicketIdentity || !this.diagnosticsSource.reconstructTicketTimeline) {
                throw new LocalApiError('project_history_unavailable', 'Project ticket history source is not configured', 503);
              }

              const projectKey = decodeURIComponent(match[1]);
              const ticketKey = decodeURIComponent(match[2]);
              const identity = this.diagnosticsSource.getProjectTicketIdentity(projectKey, ticketKey);
              if (!identity) {
                throw new LocalApiError('project_history_ticket_not_found', `Ticket ${ticketKey} was not found for project ${projectKey}`, 404);
              }
              const persistenceHealth = this.diagnosticsSource.getPersistenceHealth();

              sendJson(
                response,
                200,
                buildProjectHistoryConsumerSummaryResponse(
                  this.diagnosticsSource.reconstructTicketTimeline(identity),
                  persistenceHealth.history_schema ?? null,
                  persistenceHealth
                )
              );
            }
          }
        ]
      },
      {
        path: /^\/api\/v1\/projects\/([^/]+)\/history\/tickets\/([^/]+)$/,
        routes: [
          {
            method: 'GET',
            handler: async (_request, response, match) => {
              if (!this.diagnosticsSource?.getProjectTicketIdentity || !this.diagnosticsSource.reconstructTicketTimeline) {
                throw new LocalApiError('project_history_unavailable', 'Project ticket history source is not configured', 503);
              }

              const projectKey = decodeURIComponent(match[1]);
              const ticketKey = decodeURIComponent(match[2]);
              const identity = this.diagnosticsSource.getProjectTicketIdentity(projectKey, ticketKey);
              if (!identity) {
                throw new LocalApiError('project_history_ticket_not_found', `Ticket ${ticketKey} was not found for project ${projectKey}`, 404);
              }
              const persistenceHealth = this.diagnosticsSource.getPersistenceHealth();

              sendJson(response, 200, buildProjectHistoryTicketDetailResponse(
                this.diagnosticsSource.reconstructTicketTimeline(identity),
                persistenceHealth.history_schema ?? null,
                persistenceHealth
              ));
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
            handler: async (request, response, match) => {
              const issueIdentifier = decodeURIComponent(match[1]);
              const stateSnapshot = this.snapshotSource.getStateSnapshot();
              let runtimeDiagnostics: ApiIssueRuntimeDiagnosticsResponse | null = null;
              try {
                runtimeDiagnostics = this.snapshotService.projectIssueRuntimeDiagnostics(
                  stateSnapshot,
                  issueIdentifier,
                  parseRuntimeDiagnosticsPage(request)
                );
              } catch (error) {
                if (!(error instanceof LocalApiError && error.code === 'issue_diagnostics_not_found')) {
                  throw error;
                }
              }
              const payload = buildThreadDiagnosticsByIssueIdentifier({
                state: stateSnapshot,
                issue_identifier: issueIdentifier,
                reconstructThreadLineage: this.diagnosticsSource?.reconstructThreadLineage,
                reconstructLatestThreadLineageByIssueIdentifier:
                  this.diagnosticsSource?.reconstructLatestThreadLineageByIssueIdentifier,
                now_ms: this.nowMs()
              });
              if (!payload && !runtimeDiagnostics) {
                throw new LocalApiError('thread_diagnostics_not_found', `Issue ${issueIdentifier} has no thread diagnostics`, 404);
              }

              sendJson(response, 200, payload ? { ...payload, runtime_diagnostics: runtimeDiagnostics } : runtimeDiagnostics);
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
              const runtimeDiagnostics = this.buildDiagnosticsPayload().payload;
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
              const state = this.snapshotSource.getStateSnapshot({ includeTranscriptToolCallDiagnostics: false });
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
              const state = this.snapshotSource.getStateSnapshot({ includeTranscriptToolCallDiagnostics: false });
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
      await matchingMethodRoute.handler(req, res, endpointMatch.match, timing);
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
