import type { ServerResponse } from 'node:http';

import { redactUnknown } from '../../security/redaction';
import { LocalApiError } from '../errors';
import type { LocalApiErrorEnvelope } from '../types';

export function serializeJsonPayload(payload: unknown): { body: string; bytes: number } {
  const body = JSON.stringify(redactUnknown(payload));
  return {
    body,
    bytes: Buffer.byteLength(body, 'utf8')
  };
}

export function sendJsonBody(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(body);
}

export function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  sendJsonBody(res, statusCode, serializeJsonPayload(payload).body);
}

export function sendHtml(res: ServerResponse, statusCode: number, html: string): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(html);
}

export function sendScript(res: ServerResponse, statusCode: number, script: string): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/javascript; charset=utf-8');
  res.end(script);
}

export function sendCss(res: ServerResponse, statusCode: number, css: string): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'text/css; charset=utf-8');
  res.end(css);
}

export function sendError(res: ServerResponse, statusCode: number, code: string, message: string): void {
  const payload: LocalApiErrorEnvelope = {
    error: {
      code,
      message
    }
  };
  sendJson(res, statusCode, payload);
}

export function parseBoundedPositiveInteger(value: string | null, fallback: number, max: number): number {
  if (!value) {
    return fallback;
  }
  if (!/^\d+$/.test(value)) {
    throw new LocalApiError('invalid_pagination', 'Pagination parameters must be positive integers', 400);
  }
  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? Math.min(parsed, max) : fallback;
}

export function parseNonNegativeInteger(value: string | null): number {
  if (!value) {
    return 0;
  }
  if (!/^\d+$/.test(value)) {
    throw new LocalApiError('invalid_pagination', 'Pagination parameters must be non-negative integers', 400);
  }
  return Number.parseInt(value, 10);
}
