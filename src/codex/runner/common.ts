export interface ProtocolMessage {
  id?: number;
  method?: string;
  result?: unknown;
  error?: unknown;
  params?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function normalizeEpochMs(value: unknown): number | undefined {
  const parsed = readNumber(value);
  if (parsed === undefined) {
    return undefined;
  }
  return parsed < 1_000_000_000_000 ? Math.round(parsed * 1000) : Math.round(parsed);
}

function normalizeTimestampMs(value: unknown): number | undefined {
  const timestamp = readString(value);
  if (!timestamp) {
    return undefined;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isProtocolResponse(message: ProtocolMessage): boolean {
  return (
    typeof message.id === 'number' &&
    (Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error'))
  );
}

function readNestedString(payload: Record<string, unknown> | null, paths: string[][]): string | undefined {
  for (const pathParts of paths) {
    let current: unknown = payload;
    let valid = true;
    for (const segment of pathParts) {
      const record = asRecord(current);
      if (!record) {
        valid = false;
        break;
      }
      current = record[segment];
    }
    if (!valid) {
      continue;
    }
    const parsed = readString(current);
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

export { asRecord, isProtocolResponse, normalizeEpochMs, normalizeTimestampMs, parseJsonRecord, readNestedString, readNumber, readString };
