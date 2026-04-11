import http, { type IncomingMessage, type ServerResponse } from 'node:http';

import type { StructuredLogger } from '../observability';
import { renderDashboardClientJs, renderDashboardHtml, renderDashboardStylesCss } from './dashboard-assets';
import { LocalApiError } from './errors';
import { RefreshCoalescer } from './refresh-coalescer';
import { SnapshotService } from './snapshot-service';
import type { LocalApiErrorEnvelope, LocalApiServerOptions } from './types';

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
  res.end(JSON.stringify(payload));
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
  private readonly logger?: StructuredLogger;

  private readonly server: http.Server;

  constructor(options: LocalApiServerOptions) {
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 0;
    this.snapshotService = new SnapshotService({ nowMs: options.nowMs });
    this.snapshotSource = options.snapshotSource;
    this.logger = options.logger;
    this.refreshCoalescer = new RefreshCoalescer({
      refreshSource: options.refreshSource,
      nowMs: options.nowMs
    });

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
  }

  async close(): Promise<void> {
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
              sendHtml(response, 200, renderDashboardHtml());
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
              sendScript(response, 200, renderDashboardClientJs());
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
              const state = this.snapshotSource.getStateSnapshot();
              const payload = this.snapshotService.projectState(state);
              this.logger?.log({
                level: 'info',
                event: 'api_state_requested',
                message: 'served state snapshot',
                context: {
                  running: payload.counts.running,
                  retrying: payload.counts.retrying,
                  dispatch_validation: payload.health.dispatch_validation
                }
              });
              sendJson(response, 200, payload);
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
                event: 'api_refresh_requested',
                message: 'manual refresh requested',
                context: {
                  coalesced: payload.coalesced
                }
              });
              sendJson(response, 202, payload);
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
                event: 'api_issue_requested',
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
        event: 'api_route_not_found',
        message: `route not found for ${urlPath}`
      });
      sendError(res, 404, 'route_not_found', `Route ${urlPath} was not found`);
      return;
    }

    const matchingMethodRoute = endpointMatch.endpoint.routes.find((route) => route.method === method);
    if (!matchingMethodRoute) {
      this.logger?.log({
        level: 'warn',
        event: 'api_method_not_allowed',
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
          event: 'api_local_error',
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
        event: 'api_internal_error',
        message: error instanceof Error ? error.message : 'unknown internal server error'
      });

      sendError(res, 500, 'internal_error', 'Internal server error');
    }
  }
}
