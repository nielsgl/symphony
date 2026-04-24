import http, { type IncomingMessage, type ServerResponse } from 'node:http';

import type { StructuredLogger } from '../observability';
import { CANONICAL_EVENT, EVENT_VOCABULARY_VERSION } from '../observability/events';
import { redactUnknown } from '../security/redaction';
import { renderDashboardClientJs, renderDashboardHtml, renderDashboardStylesCss } from './dashboard-assets';
import { LocalApiError } from './errors';
import { RefreshCoalescer } from './refresh-coalescer';
import { SnapshotService } from './snapshot-service';
import type {
  ApiEventEnvelope,
  ApiStateErrorResponse,
  ApiStateSnapshotResponse,
  LocalApiErrorEnvelope,
  LocalApiServerOptions
} from './types';

interface Route {
  method: 'GET' | 'POST';
  handler: (req: IncomingMessage, res: ServerResponse, match: RegExpExecArray) => Promise<void>;
}

interface Endpoint {
  path: RegExp;
  routes: Route[];
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

export class LocalApiServer {
  private readonly host: string;
  private readonly port: number;
  private readonly snapshotService: SnapshotService;
  private readonly snapshotSource: LocalApiServerOptions['snapshotSource'];
  private readonly refreshCoalescer: RefreshCoalescer;
  private readonly diagnosticsSource?: LocalApiServerOptions['diagnosticsSource'];
  private readonly workflowControlSource?: LocalApiServerOptions['workflowControlSource'];
  private readonly dashboardConfig: NonNullable<LocalApiServerOptions['dashboardConfig']>;
  private readonly logger?: StructuredLogger;

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
    this.dashboardConfig = options.dashboardConfig ?? {
      dashboard_enabled: true,
      refresh_ms: 4000,
      render_interval_ms: 1000
    };
    this.logger = options.logger;
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

  private buildStateSnapshotResponse(): ApiStateSnapshotResponse {
    try {
      const state = this.snapshotSource.getStateSnapshot();
      return this.snapshotService.projectState(state);
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

  private broadcastStateSnapshot(source: string): void {
    const payload = this.buildStateSnapshotResponse();
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
              if (!this.diagnosticsSource) {
                throw new LocalApiError('diagnostics_unavailable', 'Diagnostics source is not configured', 503);
              }

              let observedDimensions = {
                cached_input_tokens: false,
                reasoning_output_tokens: false,
                model_context_window: false
              };
              try {
                const snapshot = this.snapshotSource.getStateSnapshot();
                observedDimensions = {
                  cached_input_tokens: typeof snapshot.codex_totals.cached_input_tokens === 'number',
                  reasoning_output_tokens: typeof snapshot.codex_totals.reasoning_output_tokens === 'number',
                  model_context_window: typeof snapshot.codex_totals.model_context_window === 'number'
                };
              } catch {
                // Diagnostics should remain available even when state snapshotting is degraded.
              }

              sendJson(response, 200, {
                active_profile: this.diagnosticsSource.getActiveProfile(),
                persistence: this.diagnosticsSource.getPersistenceHealth(),
                logging: this.diagnosticsSource.getLoggingHealth(),
                event_vocabulary_version: EVENT_VOCABULARY_VERSION,
                token_accounting: {
                  mode: 'strict_canonical',
                  canonical_precedence: [
                    'thread/tokenUsage/updated.params.tokenUsage.total',
                    'params.info.total_token_usage',
                    'params.info.totalTokenUsage',
                    'params.total_token_usage',
                    'params.totalTokenUsage'
                  ],
                  excludes_generic_usage_for_totals: true,
                  excludes_last_usage_for_totals: true,
                  optional_dimensions: [
                    'cached_input_tokens',
                    'reasoning_output_tokens',
                    'model_context_window'
                  ],
                  observed_dimensions: observedDimensions
                },
                workflow: {
                  prompt_fallback_active: this.diagnosticsSource.getPromptFallbackActive()
                }
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
                  filters?: { status?: 'all' | 'running' | 'retrying'; query?: string };
                  event_feed_filter?: 'all' | 'warn' | 'error';
                  panels?: { throughput_open?: boolean; runtime_events_open?: boolean };
                  panel_state?: { issue_detail_open?: boolean };
                };
              };
              try {
                parsed = JSON.parse(payloadText) as {
                  state?: {
                    selected_issue?: string | null;
                    filters?: { status?: 'all' | 'running' | 'retrying'; query?: string };
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
        path: /^\/api\/v1\/([^/]+)$/,
        routes: [
          {
            method: 'GET',
            handler: async (_request, response, match) => {
              const issueIdentifier = decodeURIComponent(match[1]);
              const state = this.snapshotSource.getStateSnapshot();
              const payload = this.snapshotService.projectIssue(state, issueIdentifier);
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
        event: CANONICAL_EVENT.api.routeNotFound,
        message: `route not found for ${urlPath}`
      });
      sendError(res, 404, 'route_not_found', `Route ${urlPath} was not found`);
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
