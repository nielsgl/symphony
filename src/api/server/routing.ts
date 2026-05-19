import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RequestTiming {
  request_received_at_ms: number;
  request_queue_delay_ms: number;
}

export interface Route {
  method: 'GET' | 'POST';
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    match: RegExpExecArray,
    timing: RequestTiming
  ) => Promise<void>;
}

export interface Endpoint {
  path: RegExp;
  routes: Route[];
}

export const ISSUE_DETAIL_ROUTES = ['/api/v1/:issue_identifier', '/api/v1/issues/:issue_identifier'];

export function parseRuntimeDiagnosticsPage(request: IncomingMessage): { limit?: number; offset?: number } {
  const requestUrl = new URL(request.url ?? '/', 'http://localhost');
  const limitRaw = requestUrl.searchParams.get('limit');
  const offsetRaw = requestUrl.searchParams.get('offset');
  return {
    limit: limitRaw ? Number.parseInt(limitRaw, 10) : undefined,
    offset: offsetRaw ? Number.parseInt(offsetRaw, 10) : undefined
  };
}
