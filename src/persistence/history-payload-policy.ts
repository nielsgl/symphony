import { Buffer } from 'node:buffer';

import { REDACTED, redactUnknown } from '../security/redaction';
import type {
  HistoryPayloadClass,
  HistoryPayloadDetailStatus,
  HistoryPayloadDetails,
  HistoryPayloadRedactionStatus,
  HistoryPayloadTruncation
} from './types';

export const HISTORY_PAYLOAD_POLICY_VERSION = 1;
export const HISTORY_PAYLOAD_EXCERPT_MAX_BYTES = 512;

const PATH_REDACTED = '***REDACTED_PATH***';
const ACCOUNT_REDACTED = '***REDACTED_ACCOUNT***';
const ENV_REDACTED = '***REDACTED_ENV***';

const SENSITIVE_FIELD_PATTERN =
  /^(cwd|path|file|filename|filepath|workspace|workspace_path|project_root|workflow_path|home|homedir|env|environment|account|account_id|email|username|user|organization|org_id)$/i;
const ENV_ASSIGNMENT_PATTERN = /\b[A-Z][A-Z0-9_]{2,}=([^\s,;]+)/g;
const UNIX_PATH_PATTERN = /(?<![\w.-])(?:~|\/Users\/[^/\s,;]+|\/home\/[^/\s,;]+|\/tmp|\/var\/folders|\/private\/var)\/[^\s,;)]*/g;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

const SUMMARY_ONLY_CLASSES = new Set<HistoryPayloadClass>(['assistant_text']);
const POLICY_UNAVAILABLE_CLASSES = new Set<HistoryPayloadClass>([
  'tool_payload',
  'environment',
  'account',
  'conversation_transcript'
]);

export interface BuildHistoryPayloadDetailsInput {
  payloadClass: HistoryPayloadClass;
  sourceEventId: string;
  sourceEventName: string;
  rawPayload?: unknown;
  summary?: string | null;
  summaryFields?: Record<string, unknown>;
  unavailableReasonCode?: string | null;
  maxExcerptBytes?: number;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function truncateUtf8(value: string, maxBytes: number): { value: string; bytes: number; truncated: boolean } {
  const originalBytes = utf8Bytes(value);
  if (originalBytes <= maxBytes) {
    return { value, bytes: originalBytes, truncated: false };
  }

  let end = value.length;
  while (end > 0 && utf8Bytes(value.slice(0, end)) > maxBytes) {
    end -= 1;
  }
  const truncated = value.slice(0, end);
  return { value: truncated, bytes: utf8Bytes(truncated), truncated: true };
}

function sanitizeString(value: string): { value: string; changed: boolean } {
  const secretRedacted = redactUnknown(value) as string;
  const pathRedacted = secretRedacted
    .replace(UNIX_PATH_PATTERN, PATH_REDACTED)
    .replace(EMAIL_PATTERN, ACCOUNT_REDACTED)
    .replace(ENV_ASSIGNMENT_PATTERN, (_match, raw) => `ENV=${raw ? ENV_REDACTED : ENV_REDACTED}`);
  return { value: pathRedacted, changed: pathRedacted !== value };
}

function sanitizeUnknown(value: unknown): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    return sanitizeString(value);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const entries = value.map((entry) => {
      const sanitized = sanitizeUnknown(entry);
      changed = changed || sanitized.changed;
      return sanitized.value;
    });
    return { value: entries, changed };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_FIELD_PATTERN.test(key)) {
        out[key] = key.toLowerCase().includes('account') || key.toLowerCase().includes('email') ? ACCOUNT_REDACTED : REDACTED;
        changed = true;
        continue;
      }
      const sanitized = sanitizeUnknown(raw);
      out[key] = sanitized.value;
      changed = changed || sanitized.changed;
    }
    const redacted = redactUnknown(out) as Record<string, unknown>;
    return { value: redacted, changed: changed || JSON.stringify(redacted) !== JSON.stringify(out) };
  }
  return { value, changed: false };
}

function serializeSafe(value: unknown): { value: string; changed: boolean } {
  const sanitized = sanitizeUnknown(value);
  if (typeof sanitized.value === 'string') {
    return { value: sanitized.value, changed: sanitized.changed };
  }
  return { value: JSON.stringify(sanitized.value), changed: sanitized.changed };
}

function emptyTruncation(maxExcerptBytes: number): HistoryPayloadTruncation {
  return {
    truncated: false,
    original_bytes: 0,
    excerpt_bytes: 0,
    max_excerpt_bytes: maxExcerptBytes
  };
}

export function buildHistoryPayloadDetails(input: BuildHistoryPayloadDetailsInput): HistoryPayloadDetails {
  const maxExcerptBytes = input.maxExcerptBytes ?? HISTORY_PAYLOAD_EXCERPT_MAX_BYTES;
  const summaryFields = sanitizeUnknown(input.summaryFields ?? {}).value as Record<string, unknown>;
  const summary = input.summary ? sanitizeString(input.summary).value : null;

  if (input.rawPayload === undefined || input.rawPayload === null) {
    const detailStatus: HistoryPayloadDetailStatus = summary || Object.keys(summaryFields).length > 0 ? 'summary_only' : 'absent';
    const redactionStatus: HistoryPayloadRedactionStatus = detailStatus === 'summary_only' ? 'redacted' : 'not_required';
    return {
      policy_version: HISTORY_PAYLOAD_POLICY_VERSION,
      payload_class: input.payloadClass,
      detail_status: detailStatus,
      redaction_status: redactionStatus,
      source_event_id: input.sourceEventId,
      source_event_name: input.sourceEventName,
      summary,
      summary_fields: summaryFields,
      redacted_excerpt: null,
      truncation: emptyTruncation(maxExcerptBytes),
      unavailable_reason_code: null,
      full_payload_stored: false
    };
  }

  if (POLICY_UNAVAILABLE_CLASSES.has(input.payloadClass)) {
    return {
      policy_version: HISTORY_PAYLOAD_POLICY_VERSION,
      payload_class: input.payloadClass,
      detail_status: 'unavailable_policy',
      redaction_status: 'unavailable_policy',
      source_event_id: input.sourceEventId,
      source_event_name: input.sourceEventName,
      summary,
      summary_fields: summaryFields,
      redacted_excerpt: null,
      truncation: emptyTruncation(maxExcerptBytes),
      unavailable_reason_code: input.unavailableReasonCode ?? `${input.payloadClass}_payload_not_stored`,
      full_payload_stored: false
    };
  }

  if (SUMMARY_ONLY_CLASSES.has(input.payloadClass)) {
    return {
      policy_version: HISTORY_PAYLOAD_POLICY_VERSION,
      payload_class: input.payloadClass,
      detail_status: 'summary_only',
      redaction_status: 'redacted',
      source_event_id: input.sourceEventId,
      source_event_name: input.sourceEventName,
      summary,
      summary_fields: summaryFields,
      redacted_excerpt: null,
      truncation: emptyTruncation(maxExcerptBytes),
      unavailable_reason_code: null,
      full_payload_stored: false
    };
  }

  const serialized = serializeSafe(input.rawPayload);
  const truncated = truncateUtf8(serialized.value, maxExcerptBytes);
  const detailStatus: HistoryPayloadDetailStatus = truncated.truncated ? 'redacted_truncated_excerpt' : 'redacted_excerpt';
  return {
    policy_version: HISTORY_PAYLOAD_POLICY_VERSION,
    payload_class: input.payloadClass,
    detail_status: detailStatus,
    redaction_status: serialized.changed ? 'redacted' : 'not_required',
    source_event_id: input.sourceEventId,
    source_event_name: input.sourceEventName,
    summary,
    summary_fields: summaryFields,
    redacted_excerpt: truncated.value,
    truncation: {
      truncated: truncated.truncated,
      original_bytes: utf8Bytes(serialized.value),
      excerpt_bytes: truncated.bytes,
      max_excerpt_bytes: maxExcerptBytes
    },
    unavailable_reason_code: null,
    full_payload_stored: false
  };
}
