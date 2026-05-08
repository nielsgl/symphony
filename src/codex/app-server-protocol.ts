export type CodexAppServerThreadActivitySource = 'app_server_protocol_thread_updated_at';

export interface CodexAppServerThreadV2 {
  id?: string;
  threadId?: string;
  updatedAt?: number;
  status?: string;
}

export interface CodexAppServerThreadEnvelopeV2 {
  thread?: CodexAppServerThreadV2;
}

export interface CodexAppServerThreadReadParamsV2 extends Record<string, unknown> {
  threadId: string;
  includeTurns?: boolean;
}

export interface CodexAppServerThreadReadResponseV2 extends Record<string, unknown> {
  thread: CodexAppServerThreadV2;
}

export interface CodexAppServerThreadActivity {
  thread_id: string;
  updated_at_ms: number;
  source: CodexAppServerThreadActivitySource;
  status: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function readUnixSeconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value * 1000;
}

export function extractCodexAppServerThreadActivity(
  payload: unknown,
  activeThreadId?: string | null
): CodexAppServerThreadActivity | null {
  const record = asRecord(payload);
  const threadRecord = asRecord(record?.thread ?? payload);
  if (!threadRecord) {
    return null;
  }

  const threadId = readString(threadRecord.id) ?? readString(threadRecord.threadId) ?? activeThreadId ?? null;
  const updatedAtMs = readUnixSeconds(threadRecord.updatedAt);
  if (!threadId || updatedAtMs === null) {
    return null;
  }

  return {
    thread_id: threadId,
    updated_at_ms: updatedAtMs,
    source: 'app_server_protocol_thread_updated_at',
    status: readString(threadRecord.status)
  };
}
