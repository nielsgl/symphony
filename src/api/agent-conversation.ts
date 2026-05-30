import type { BlockedEntry, OrchestratorState, RetryEntry, RunningEntry } from '../orchestrator';
import type { AppServerEventLedgerExcerpt, DurableRunHistoryRecord, ExecutionGraphThreadLineage } from '../persistence';
import { redactUnknown } from '../security/redaction';
import { asIsoDate } from './snapshot-service/time';
import type { ApiAgentConversationMessage, ApiAgentConversationProjection } from './types';

const DEFAULT_MESSAGE_LIMIT = 80;
const DEFAULT_MESSAGE_MAX_CHARS = 600;

type RuntimeEvent = RunningEntry['recent_events'][number];

interface ConversationCandidate {
  at_ms: number;
  role: ApiAgentConversationMessage['role'];
  source: ApiAgentConversationMessage['source'];
  content: string;
  event?: string | null;
  thread_id?: string | null;
  turn_id?: string | null;
  session_id?: string | null;
  tool_name?: string | null;
  tool_call_id?: string | null;
  detail_status?: ApiAgentConversationMessage['detail_status'];
  truncated?: boolean;
}

function coerceTimestampMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function trimBounded(value: string | null | undefined, maxChars: number): { value: string | null; truncated: boolean } {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return { value: null, truncated: false };
  }
  const chars = Array.from(normalized);
  if (chars.length <= maxChars) {
    return { value: normalized, truncated: false };
  }
  return { value: `${chars.slice(0, Math.max(0, maxChars - 3)).join('').trim()}...`, truncated: true };
}

function roleFromEvent(event: RuntimeEvent): ApiAgentConversationMessage['role'] {
  const normalized = `${event.event} ${event.request_category ?? ''} ${event.request_method ?? ''}`.toLowerCase();
  if (event.tool_call_id || event.tool_name || normalized.includes('tool')) {
    return 'tool';
  }
  if (normalized.includes('input') || normalized.includes('user')) {
    return 'user';
  }
  if (normalized.includes('assistant') || normalized.includes('turn')) {
    return 'assistant';
  }
  if (normalized.includes('system') || normalized.includes('protocol')) {
    return 'system';
  }
  return 'runtime';
}

function roleFromLedgerEvent(event: AppServerEventLedgerExcerpt): ApiAgentConversationMessage['role'] {
  const explicitRole = event.summary_fields.role;
  if (
    explicitRole === 'system' ||
    explicitRole === 'user' ||
    explicitRole === 'assistant' ||
    explicitRole === 'tool' ||
    explicitRole === 'runtime'
  ) {
    return explicitRole;
  }

  switch (event.payload_class) {
    case 'assistant_text':
      return 'assistant';
    case 'tool_payload':
    case 'command_output':
    case 'filesystem_change':
      return 'tool';
    case 'conversation_transcript':
      return 'runtime';
    case 'protocol_lifecycle':
    case 'protocol_request_response':
    case 'environment':
    case 'account':
      return 'system';
    default:
      return 'runtime';
  }
}

function summarizeLedgerFields(fields: Record<string, unknown>): string | null {
  const preferred = ['message', 'text', 'summary', 'content', 'detail', 'type', 'status', 'name'];
  const parts: string[] = [];
  for (const key of preferred) {
    const value = fields[key];
    if (typeof value === 'string' && value.trim()) {
      parts.push(`${key}: ${value.trim()}`);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}: ${String(value)}`);
    }
  }
  return parts.length ? parts.join(' | ') : null;
}

function contentFromLedgerEvent(event: AppServerEventLedgerExcerpt, maxChars: number): { content: string | null; truncated: boolean } {
  const fieldSummary = summarizeLedgerFields(event.summary_fields);
  const raw =
    event.summary ??
    fieldSummary ??
    event.redacted_excerpt ??
    event.unavailable_reason_code ??
    `${event.source_event_name} (${event.payload_class})`;
  const bounded = trimBounded(raw, maxChars);
  return {
    content: bounded.value,
    truncated: bounded.truncated || event.truncation.truncated
  };
}

function pushRuntimeEvent(
  candidates: ConversationCandidate[],
  event: RuntimeEvent,
  context: {
    source: ApiAgentConversationMessage['source'];
    thread_id: string | null;
    turn_id: string | null;
    session_id: string | null;
    maxChars: number;
  }
): void {
  const content = trimBounded(event.message ?? event.reason_code ?? event.event, context.maxChars);
  if (!content.value) {
    return;
  }
  candidates.push({
    at_ms: event.at_ms,
    role: roleFromEvent(event),
    source: context.source,
    content: content.value,
    event: event.event,
    thread_id: context.thread_id,
    turn_id: context.turn_id,
    session_id: context.session_id,
    tool_name: event.tool_name ?? null,
    tool_call_id: event.tool_call_id ?? null,
    detail_status: 'summary',
    truncated: content.truncated
  });
}

function pushRunningMessages(candidates: ConversationCandidate[], entry: RunningEntry | null, maxChars: number): void {
  if (!entry) {
    return;
  }
  for (const event of entry.recent_events) {
    pushRuntimeEvent(candidates, event, {
      source: 'runtime_event',
      thread_id: entry.thread_id,
      turn_id: entry.turn_id,
      session_id: entry.session_id,
      maxChars
    });
  }
  if (entry.last_message) {
    const content = trimBounded(entry.last_message, maxChars);
    if (content.value) {
      candidates.push({
        at_ms: entry.last_codex_timestamp_ms ?? entry.started_at_ms,
        role: 'assistant',
        source: 'runtime_event',
        content: content.value,
        event: 'last_message',
        thread_id: entry.thread_id,
        turn_id: entry.turn_id,
        session_id: entry.session_id,
        detail_status: 'summary',
        truncated: content.truncated
      });
    }
  }
  if (entry.pending_input_preview?.prompt_preview) {
    const content = trimBounded(entry.pending_input_preview.prompt_preview, maxChars);
    if (content.value) {
      candidates.push({
        at_ms: entry.awaiting_input_since_ms ?? entry.last_codex_timestamp_ms ?? entry.started_at_ms,
        role: 'user',
        source: 'runtime_event',
        content: content.value,
        event: 'pending_input',
        thread_id: entry.thread_id,
        turn_id: entry.turn_id,
        session_id: entry.session_id,
        detail_status: 'summary',
        truncated: content.truncated
      });
    }
  }
}

function pushBlockedMessages(candidates: ConversationCandidate[], entry: BlockedEntry | null, maxChars: number): void {
  if (!entry) {
    return;
  }
  for (const event of entry.session_console ?? []) {
    pushRuntimeEvent(candidates, event, {
      source: 'runtime_event',
      thread_id: entry.previous_thread_id ?? null,
      turn_id: null,
      session_id: entry.previous_session_id ?? null,
      maxChars
    });
  }
  if (entry.pending_input?.prompt_text) {
    const content = trimBounded(entry.pending_input.prompt_text, maxChars);
    if (content.value) {
      candidates.push({
        at_ms: entry.pending_input.input_required_at_ms,
        role: 'user',
        source: 'runtime_event',
        content: content.value,
        event: 'pending_input',
        thread_id: entry.previous_thread_id ?? null,
        turn_id: null,
        session_id: entry.previous_session_id ?? null,
        detail_status: 'summary',
        truncated: content.truncated
      });
    }
  }
}

function pushRetryMessage(candidates: ConversationCandidate[], entry: RetryEntry | null, maxChars: number): void {
  if (!entry) {
    return;
  }
  const content = trimBounded(entry.stop_reason_detail ?? entry.error ?? entry.stop_reason_code ?? null, maxChars);
  if (!content.value) {
    return;
  }
  candidates.push({
    at_ms: entry.due_at_ms,
    role: 'runtime',
    source: 'runtime_event',
    content: content.value,
    event: 'retry_scheduled',
    thread_id: entry.previous_thread_id ?? null,
    turn_id: null,
    session_id: entry.previous_session_id ?? null,
    detail_status: 'summary',
    truncated: content.truncated
  });
}

function pushLineageMessages(
  candidates: ConversationCandidate[],
  lineage: ExecutionGraphThreadLineage,
  maxChars: number
): void {
  for (const transition of lineage.state_transitions) {
    const atMs = coerceTimestampMs(transition.transitioned_at);
    const content = trimBounded(
      transition.reason_detail ?? transition.reason_code ?? `state ${transition.from_status ?? 'n/a'} -> ${transition.to_status}`,
      maxChars
    );
    if (!atMs || !content.value) {
      continue;
    }
    candidates.push({
      at_ms: atMs,
      role: 'runtime',
      source: 'thread_diagnostics',
      content: content.value,
      event: 'state.transition',
      thread_id: transition.thread_id ?? lineage.thread.thread_id,
      turn_id: transition.turn_id ?? null,
      session_id: null,
      detail_status: 'summary',
      truncated: content.truncated
    });
  }
}

function pushHistoryMessages(
  candidates: ConversationCandidate[],
  runs: DurableRunHistoryRecord[],
  issueIdentifier: string,
  maxChars: number
): void {
  for (const run of runs) {
    if (run.issue_identifier !== issueIdentifier) {
      continue;
    }
    for (const event of run.app_server_events ?? []) {
      const atMs = coerceTimestampMs(event.observed_at);
      const content = contentFromLedgerEvent(event, maxChars);
      if (!atMs || !content.content) {
        continue;
      }
      candidates.push({
        at_ms: atMs,
        role: roleFromLedgerEvent(event),
        source: 'app_server_ledger',
        content: content.content,
        event: event.source_event_name,
        thread_id: event.thread_id ?? run.thread_id ?? null,
        turn_id: event.turn_id ?? run.turn_id ?? null,
        session_id: run.session_id ?? run.session_ids[0] ?? null,
        detail_status: event.detail_status,
        truncated: content.truncated
      });
    }
    if (run.terminal_reason_detail || run.terminal_reason_code || run.terminal_status) {
      const atMs = coerceTimestampMs(run.root_cause_at ?? run.completed_at ?? run.ended_at ?? run.started_at);
      const content = trimBounded(
        run.terminal_reason_detail ?? run.terminal_reason_code ?? `run ${run.terminal_status ?? 'recorded'}`,
        maxChars
      );
      if (atMs && content.value) {
        candidates.push({
          at_ms: atMs,
          role: 'runtime',
          source: 'run_history',
          content: content.value,
          event: 'run_history.terminal',
          thread_id: run.thread_id,
          turn_id: run.turn_id,
          session_id: run.session_id ?? run.session_ids[0] ?? null,
          detail_status: 'summary',
          truncated: content.truncated
        });
      }
    }
  }
}

function dedupeAndBound(
  candidates: ConversationCandidate[],
  limit: number
): ApiAgentConversationMessage[] {
  const byKey = new Map<string, ConversationCandidate>();
  for (const candidate of candidates.sort((left, right) => left.at_ms - right.at_ms)) {
    byKey.set(
      [
        candidate.at_ms,
        candidate.role,
        candidate.source,
        candidate.event ?? '',
        candidate.thread_id ?? '',
        candidate.turn_id ?? '',
        candidate.session_id ?? '',
        candidate.tool_call_id ?? '',
        candidate.content
      ].join('\0'),
      candidate
    );
  }
  const deduped = [...byKey.values()].sort((left, right) => left.at_ms - right.at_ms);
  const bounded = deduped.slice(Math.max(0, deduped.length - limit));
  return bounded.map((message, index) => ({
    id: `${message.source}:${message.at_ms}:${index}`,
    at: asIsoDate(message.at_ms),
    at_ms: message.at_ms,
    role: message.role,
    source: message.source,
    event: message.event ?? null,
    content: message.content,
    thread_id: message.thread_id ?? null,
    turn_id: message.turn_id ?? null,
    session_id: message.session_id ?? null,
    tool_name: message.tool_name ?? null,
    tool_call_id: message.tool_call_id ?? null,
    detail_status: message.detail_status ?? 'summary',
    truncated: Boolean(message.truncated)
  }));
}

function findRuntime(state: OrchestratorState, issueIdentifier: string) {
  const runningEntry = Array.from(state.running.entries()).find(([, entry]) => entry.identifier === issueIdentifier) ?? null;
  const retryEntry = Array.from(state.retry_attempts.values()).find((entry) => entry.identifier === issueIdentifier) ?? null;
  const blockedEntry = Array.from(state.blocked_inputs.values()).find((entry) => entry.issue_identifier === issueIdentifier) ?? null;
  return {
    issue_id: runningEntry?.[0] ?? retryEntry?.issue_id ?? blockedEntry?.issue_id ?? null,
    running: runningEntry?.[1] ?? null,
    retry: retryEntry ?? null,
    blocked: blockedEntry ?? null
  };
}

export function summarizeAgentConversationLatest(
  lastMessage: ApiAgentConversationMessage | null
): ApiAgentConversationProjection['latest'] {
  if (!lastMessage) {
    return {
      at: null,
      at_ms: null,
      role: null,
      source: null,
      summary: null
    };
  }
  return {
    at: lastMessage.at,
    at_ms: lastMessage.at_ms,
    role: lastMessage.role,
    source: lastMessage.source,
    summary: lastMessage.content
  };
}

export function buildRunningConversationLatest(
  _issueId: string,
  entry: RunningEntry
): ApiAgentConversationProjection['latest'] {
  const messages = dedupeAndBound(
    (() => {
      const candidates: ConversationCandidate[] = [];
      pushRunningMessages(candidates, entry, DEFAULT_MESSAGE_MAX_CHARS);
      return candidates;
    })(),
    1
  );
  const latest = summarizeAgentConversationLatest(messages.at(-1) ?? null);
  return latest;
}

export function buildAgentConversationProjection(params: {
  state: OrchestratorState;
  issueIdentifier: string;
  runHistory?: DurableRunHistoryRecord[];
  lineage?: ExecutionGraphThreadLineage | null;
  limit?: number;
  messageMaxChars?: number;
}): ApiAgentConversationProjection {
  const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_MESSAGE_LIMIT, DEFAULT_MESSAGE_LIMIT));
  const maxChars = Math.max(80, Math.min(params.messageMaxChars ?? DEFAULT_MESSAGE_MAX_CHARS, DEFAULT_MESSAGE_MAX_CHARS));
  const runtime = findRuntime(params.state, params.issueIdentifier);
  const candidates: ConversationCandidate[] = [];

  pushHistoryMessages(candidates, params.runHistory ?? [], params.issueIdentifier, maxChars);
  if (params.lineage) {
    pushLineageMessages(candidates, params.lineage, maxChars);
  }
  pushRunningMessages(candidates, runtime.running, maxChars);
  pushBlockedMessages(candidates, runtime.blocked, maxChars);
  pushRetryMessage(candidates, runtime.retry, maxChars);

  const totalAvailable = candidates.length;
  const messages = dedupeAndBound(candidates, limit);
  const latest = summarizeAgentConversationLatest(messages.at(-1) ?? null);
  const sources = Array.from(new Set(messages.map((message) => message.source))).sort();
  const roleCounts = messages.reduce<Record<ApiAgentConversationMessage['role'], number>>(
    (counts, message) => {
      counts[message.role] += 1;
      return counts;
    },
    { system: 0, user: 0, assistant: 0, tool: 0, runtime: 0 }
  );

  return redactUnknown({
    issue_identifier: params.issueIdentifier,
    issue_id: runtime.issue_id,
    latest,
    messages,
    metadata: {
      total_available_count: totalAvailable,
      included_count: messages.length,
      limit,
      truncated: totalAvailable > messages.length,
      sources,
      role_counts: roleCounts,
      detail: totalAvailable
        ? 'Conversation is reconstructed from bounded persisted and runtime evidence.'
        : 'No persisted or runtime conversation evidence is available yet.'
    }
  }) as ApiAgentConversationProjection;
}
