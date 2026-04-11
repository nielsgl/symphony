import http, { type IncomingMessage, type ServerResponse } from 'node:http';

import type { StructuredLogger } from '../observability';
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

function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Symphony Runtime Dashboard</title>
  <style>
    :root { --bg: #f4f7f1; --ink: #132015; --panel: #ffffff; --ok: #2e7d32; --bad: #b71c1c; --accent: #005f73; }
    body { margin: 0; font-family: Georgia, 'Times New Roman', serif; color: var(--ink); background: radial-gradient(circle at top right, #d6eee8, var(--bg)); }
    header { padding: 20px; border-bottom: 1px solid #d3ddd0; background: rgba(255,255,255,0.8); backdrop-filter: blur(2px); }
    main { display: grid; grid-template-columns: 1fr; gap: 16px; padding: 20px; }
    section { background: var(--panel); border: 1px solid #d3ddd0; border-radius: 10px; padding: 16px; }
    h1, h2 { margin: 0 0 8px 0; }
    #health { font-weight: bold; }
    #health.ok { color: var(--ok); }
    #health.failed { color: var(--bad); }
    .row { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; }
    button { background: var(--accent); color: white; border: 0; padding: 8px 12px; border-radius: 6px; cursor: pointer; }
    input { padding: 8px; border: 1px solid #b8c3b8; border-radius: 6px; }
    pre { white-space: pre-wrap; word-break: break-word; background: #f2f6ef; padding: 10px; border-radius: 6px; }
  </style>
</head>
<body>
  <header>
    <h1>Symphony Local Control</h1>
    <div id="health" class="ok">Health: ok</div>
    <div id="last-error"></div>
  </header>
  <main>
    <section>
      <h2>Overview</h2>
      <div id="counts"></div>
      <div id="totals"></div>
      <div class="row">
        <button id="refresh-button" type="button">Trigger Refresh</button>
        <span id="refresh-status"></span>
      </div>
    </section>
    <section>
      <h2>Issue Detail</h2>
      <div class="row">
        <input id="issue-input" type="text" placeholder="ABC-123" />
        <button id="issue-button" type="button">Load</button>
      </div>
      <pre id="issue-output">No issue selected.</pre>
    </section>
  </main>
  <script>
    async function loadState() {
      const response = await fetch('/api/v1/state');
      const payload = await response.json();
      document.getElementById('counts').textContent = 'Running: ' + payload.counts.running + ' | Retrying: ' + payload.counts.retrying;
      document.getElementById('totals').textContent = 'Tokens: ' + payload.codex_totals.total_tokens + ' | Seconds: ' + payload.codex_totals.seconds_running;
      const healthEl = document.getElementById('health');
      const status = payload.health.dispatch_validation;
      healthEl.className = status;
      healthEl.textContent = 'Health: ' + status;
      document.getElementById('last-error').textContent = payload.health.last_error ? 'Last error: ' + payload.health.last_error : '';
    }

    async function refreshNow() {
      const response = await fetch('/api/v1/refresh', { method: 'POST' });
      const payload = await response.json();
      document.getElementById('refresh-status').textContent = payload.coalesced ? 'Refresh coalesced' : 'Refresh queued';
      await loadState();
    }

    async function loadIssue() {
      const identifier = document.getElementById('issue-input').value.trim();
      if (!identifier) {
        return;
      }
      const response = await fetch('/api/v1/' + encodeURIComponent(identifier));
      const payload = await response.json();
      document.getElementById('issue-output').textContent = JSON.stringify(payload, null, 2);
    }

    document.getElementById('refresh-button').addEventListener('click', refreshNow);
    document.getElementById('issue-button').addEventListener('click', loadIssue);
    loadState();
    setInterval(loadState, 5000);
  </script>
</body>
</html>`;
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
