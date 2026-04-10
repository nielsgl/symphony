import http, { type IncomingMessage, type ServerResponse } from 'node:http';

import { LocalApiError } from './errors';
import { RefreshCoalescer } from './refresh-coalescer';
import { SnapshotService } from './snapshot-service';
import type { LocalApiErrorEnvelope, LocalApiServerOptions } from './types';

interface Route {
  method: 'GET' | 'POST';
  path: RegExp;
  handler: (req: IncomingMessage, res: ServerResponse, match: RegExpExecArray) => Promise<void>;
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
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

  private readonly server: http.Server;

  constructor(options: LocalApiServerOptions) {
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 0;
    this.snapshotService = new SnapshotService({ nowMs: options.nowMs });
    this.snapshotSource = options.snapshotSource;
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

    const routes: Route[] = [
      {
        method: 'GET',
        path: /^\/api\/v1\/state$/,
        handler: async (_request, response) => {
          const state = this.snapshotSource.getStateSnapshot();
          const payload = this.snapshotService.projectState(state);
          sendJson(response, 200, payload);
        }
      },
      {
        method: 'GET',
        path: /^\/api\/v1\/([^/]+)$/,
        handler: async (_request, response, match) => {
          const issueIdentifier = decodeURIComponent(match[1]);
          const state = this.snapshotSource.getStateSnapshot();
          const payload = this.snapshotService.projectIssue(state, issueIdentifier);
          sendJson(response, 200, payload);
        }
      },
      {
        method: 'POST',
        path: /^\/api\/v1\/refresh$/,
        handler: async (_request, response) => {
          const payload = this.refreshCoalescer.requestRefresh();
          sendJson(response, 202, payload);
        }
      }
    ];

    const routeMatches = routes
      .map((route) => ({ route, match: route.path.exec(urlPath) }))
      .filter((entry) => entry.match !== null) as Array<{ route: Route; match: RegExpExecArray }>;

    if (routeMatches.length === 0) {
      sendError(res, 404, 'route_not_found', `Route ${urlPath} was not found`);
      return;
    }

    const matchingMethodRoute = routeMatches.find((entry) => entry.route.method === method);
    if (!matchingMethodRoute) {
      sendError(res, 405, 'method_not_allowed', `Method ${method} is not supported for ${urlPath}`);
      return;
    }

    try {
      await matchingMethodRoute.route.handler(req, res, matchingMethodRoute.match);
    } catch (error) {
      if (error instanceof LocalApiError) {
        sendError(res, error.http_status, error.code, error.message);
        return;
      }

      sendError(res, 500, 'internal_error', 'Internal server error');
    }
  }
}
