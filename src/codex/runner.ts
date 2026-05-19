import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { CANONICAL_EVENT } from '../observability/events';
import { REASON_CODES } from '../observability/reason-codes';
import {
  createDynamicToolCapabilityMismatchDetail,
  extractUnsupportedDynamicToolConsoleMessage,
  serializeDynamicToolCapabilityMismatchDetail
} from '../observability/dynamic-tool-capability';
import {
  extractCodexAppServerThreadActivity,
  type CodexAppServerThreadReadParamsV2,
  type CodexAppServerThreadReadResponseV2
} from './app-server-protocol';
import { CodexRunnerError } from './errors';
import { createDefaultDynamicToolExecutor, type DynamicToolExecutor, type DynamicToolSpec } from './dynamic-tools';
import { buildSshSpawnArgs } from './ssh-target';
import type {
  CodexInputRequestPayload,
  CodexRunnerRecoveryInput,
  CodexRunnerEvent,
  CodexRunnerStartInput,
  CodexTranscriptLookupMetadata,
  CodexTurnResult,
  CodexModelRerouteEvidence,
  CodexProtocolWarningEvidence,
  CodexUsageTotals,
  TokenTelemetrySnapshot
} from './types';

interface ProtocolMessage {
  id?: number;
  method?: string;
  result?: unknown;
  error?: unknown;
  params?: Record<string, unknown>;
}

interface RunnerProcess {
  pid?: number | null;
  stdin: { write: (data: string) => void };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: NodeJS.Signals | number) => void;
  once: (event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void) => void;
}

type SpawnProcess = (params: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd: string;
  workerHost?: string;
}) => RunnerProcess;

interface WaitForTerminalResult {
  terminal: 'turn/completed' | 'turn/failed' | 'turn/cancelled' | 'turn/input_required';
  terminal_source: 'app_server_protocol' | 'session_transcript';
  usage: CodexUsageTotals;
  telemetry: TokenTelemetrySnapshot;
  rate_limits: Record<string, unknown> | null;
  protocol_warnings: CodexProtocolWarningEvidence[];
  model_reroute: CodexModelRerouteEvidence | null;
  requested_model: string | null;
  effective_model: string | null;
  last_agent_message?: string;
  completed_at_ms?: number;
  duration_ms?: number;
  time_to_first_token_ms?: number;
  input_required_detail?: string;
  input_required_payload?: CodexInputRequestPayload;
  transcript_lookup?: CodexTranscriptLookupMetadata;
}

const PROCESS_CANCEL_GRACE_MS = 500;
const PROCESS_CANCEL_FORCE_SETTLE_MS = 100;

interface TurnEventContext {
  thread_id: string;
  turn_id: string;
  session_id: string;
  turn_started_at_ms: number;
}

interface TranscriptTerminalEvidence {
  terminal: 'turn/completed' | 'turn/failed' | 'turn/cancelled' | 'turn/input_required';
  last_agent_message?: string;
  completed_at_ms?: number;
  duration_ms?: number;
  time_to_first_token_ms?: number;
}

interface TranscriptScanResult {
  terminal: TranscriptTerminalEvidence | null;
  observedProgress: boolean;
  lookup: TranscriptCandidateLookupResult | null;
}

interface TranscriptCandidateCache {
  identityKey: string;
  refreshedAtMs: number;
  paths: string[];
  stats: TranscriptCandidateLookupStats;
}

interface TranscriptCandidateLookupStats {
  source: 'indexed' | 'fallback' | 'cache' | 'missing' | 'budget_exhausted';
  cachedSource?: 'indexed' | 'fallback' | 'missing' | 'budget_exhausted';
  candidateCount: number;
  filesConsidered: number;
  filesParsed: number;
  bytesRead: number;
  exhausted: boolean;
  reasonCodes: string[];
}

interface TranscriptCandidateLookupResult {
  paths: string[];
  stats: TranscriptCandidateLookupStats;
  refreshedAtMs: number;
  expiresAtMs: number;
}

type UnsupportedServerRequestCategory =
  | 'approval'
  | 'permission'
  | 'authentication'
  | 'account'
  | 'safety_sensitive'
  | 'unsupported';

interface UnsupportedServerRequestClassification {
  category: UnsupportedServerRequestCategory;
  reason_code: string;
  terminal: boolean;
}

const CONTINUATION_GUIDANCE = 'Continue working on the same issue thread. Provide concise progress and next actions.';
const NON_INTERACTIVE_TOOL_INPUT_ANSWER = 'This is a non-interactive session. Operator input is unavailable.';

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

function buildTerminalMetadata(waitResult: WaitForTerminalResult): Partial<CodexTurnResult> {
  return {
    terminal_source: waitResult.terminal_source,
    ...(waitResult.last_agent_message !== undefined ? { last_agent_message: waitResult.last_agent_message } : {}),
    ...(waitResult.completed_at_ms !== undefined ? { completed_at_ms: waitResult.completed_at_ms } : {}),
    ...(waitResult.duration_ms !== undefined ? { duration_ms: waitResult.duration_ms } : {}),
    ...(waitResult.time_to_first_token_ms !== undefined ? { time_to_first_token_ms: waitResult.time_to_first_token_ms } : {}),
    ...(waitResult.transcript_lookup ? { transcript_lookup: waitResult.transcript_lookup } : {})
  };
}

function serializeTranscriptLookupMetadata(lookup: TranscriptCandidateLookupResult): CodexTranscriptLookupMetadata {
  return {
    source: lookup.stats.source,
    ...(lookup.stats.cachedSource ? { cached_source: lookup.stats.cachedSource } : {}),
    candidate_count: lookup.stats.candidateCount,
    files_considered: lookup.stats.filesConsidered,
    files_parsed: lookup.stats.filesParsed,
    bytes_read: lookup.stats.bytesRead,
    exhausted: lookup.stats.exhausted,
    reason_codes: [...lookup.stats.reasonCodes],
    cache_refreshed_at_ms: lookup.refreshedAtMs,
    cache_expires_at_ms: lookup.expiresAtMs
  };
}

function parseCodexRolloutTimestampMs(filename: string): number | null {
  const match = filename.match(/rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:[.-](\d{3}))?/);
  if (!match) {
    return null;
  }
  const [, date, hour, minute, second, millis = '000'] = match;
  const parsed = Date.parse(`${date}T${hour}:${minute}:${second}.${millis}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCodexHome(input: CodexRunnerStartInput): string {
  const envHome =
    input.commandEnv?.CODEX_HOME?.trim() ||
    input.commandEnv?.SYMPHONY_CODEX_HOME?.trim() ||
    readEnvAssignment(input.command, 'CODEX_HOME') ||
    readEnvAssignment(input.command, 'SYMPHONY_CODEX_HOME') ||
    process.env.SYMPHONY_CODEX_HOME?.trim() ||
    process.env.CODEX_HOME?.trim() ||
    path.join(process.env.HOME ?? '', '.codex');
  return path.normalize(envHome);
}

function readEnvAssignment(command: string, name: string): string | null {
  const pattern = new RegExp(`(?:^|\\s)${name}=([^\\s]+)`);
  const match = command.match(pattern);
  return match?.[1]?.replace(/^['"]|['"]$/g, '') ?? null;
}

function readToolCallId(message: ProtocolMessage): string {
  const params = asRecord(message.params);
  return readString(params?.call_id) ?? readString(params?.callId) ?? readString(params?.id) ?? String(message.id);
}

function readOptionalToolCallId(value: Record<string, unknown> | null): string | null {
  if (!value) {
    return null;
  }
  return readString(value.call_id) ?? readString(value.callId) ?? readString(value.id) ?? null;
}

function readResponseItem(message: ProtocolMessage): Record<string, unknown> | null {
  const params = asRecord(message.params);
  if (!params) {
    return null;
  }

  return (
    asRecord(params.item) ??
    asRecord(params.rawResponseItem) ??
    asRecord(params.raw_response_item) ??
    asRecord(params.responseItem) ??
    asRecord(params.response_item) ??
    params
  );
}

function normalizeOptionText(value: string): string {
  return value.trim().toLowerCase();
}

function optionCandidateStrings(option: Record<string, unknown> | null): string[] {
  if (!option) {
    return [];
  }
  const candidates: string[] = [];
  for (const key of ['label', 'value', 'title', 'name', 'text']) {
    const parsed = readString(option[key]);
    if (parsed) {
      candidates.push(parsed);
    }
  }
  return candidates;
}

function describeProtocolError(error: unknown): string {
  const record = asRecord(error);
  if (!record) {
    return '';
  }

  const code = readString(record.code);
  const message = readString(record.message);
  const data = record.data;

  const details: string[] = [];
  if (code) {
    details.push(`code=${code}`);
  }
  if (message) {
    details.push(`message=${message}`);
  }
  if (data !== undefined) {
    try {
      details.push(`data=${JSON.stringify(data)}`);
    } catch {
      details.push('data=[unserializable]');
    }
  }

  return details.length > 0 ? ` (${details.join(' ')})` : '';
}

function requiresExperimentalApiCapability(error: unknown): boolean {
  if (!(error instanceof CodexRunnerError) || error.code !== 'response_error') {
    return false;
  }

  return error.message.toLowerCase().includes('requires experimentalapi capability');
}

function normalizeTurnSandboxPolicy(policy: Record<string, unknown> | undefined): Record<string, unknown> {
  const candidateType = readString(policy?.type);

  const mappedType =
    candidateType === 'workspace-write' || candidateType === 'workspace'
      ? 'workspaceWrite'
      : candidateType === 'read-only'
        ? 'readOnly'
        : candidateType === 'danger-full-access'
          ? 'dangerFullAccess'
          : candidateType;

  if (!mappedType) {
    return { type: 'workspaceWrite' };
  }

  return {
    ...policy,
    type: mappedType
  };
}

function normalizeApprovalPolicy(
  policy:
    | string
    | {
        reject?: {
          sandbox_approval?: boolean;
          rules?: boolean;
          mcp_elicitations?: boolean;
        };
      }
    | undefined
): string | Record<string, unknown> {
  if (!policy) {
    return 'never';
  }

  if (typeof policy === 'string') {
    return policy;
  }

  return policy as Record<string, unknown>;
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

function selectApprovalOptionLabel(options: unknown[]): string | null {
  const optionRecords = options.map((option) => asRecord(option));
  const denyPatterns = [/\bdeny\b/i, /\breject\b/i, /\bcancel\b/i, /\bblock\b/i, /\bstop\b/i, /\bno\b/i];
  const exactApprovalLabels = ['Approve this Session', 'Approve Once'];
  const permissiveApprovalPatterns = [/\bapprove\b/i, /\ballow\b/i, /\brun\b/i, /\bcontinue\b/i, /\byes\b/i, /\bok\b/i];

  for (const preferred of exactApprovalLabels) {
    for (const option of optionRecords) {
      const candidates = optionCandidateStrings(option);
      if (candidates.some((candidate) => candidate === preferred)) {
        return readString(option?.label) ?? preferred;
      }
    }
  }

  interface Candidate {
    answerLabel: string;
    rank: number;
  }

  let best: Candidate | null = null;
  for (const option of optionRecords) {
    const answerLabel = readString(option?.label);
    if (!answerLabel) {
      continue;
    }
    const candidates = optionCandidateStrings(option);
    if (candidates.length === 0) {
      continue;
    }
    if (candidates.some((candidate) => denyPatterns.some((pattern) => pattern.test(candidate)))) {
      continue;
    }

    const normalized = candidates.map(normalizeOptionText);
    let rank = Number.POSITIVE_INFINITY;
    normalized.forEach((candidate) => {
      permissiveApprovalPatterns.forEach((pattern, index) => {
        if (pattern.test(candidate) && index < rank) {
          rank = index;
        }
      });
    });
    if (!Number.isFinite(rank)) {
      continue;
    }
    if (!best || rank < best.rank) {
      best = {
        answerLabel,
        rank
      };
    }
  }

  return best?.answerLabel ?? null;
}

type NonInteractiveInputAnswerMode =
  | 'approval_option_exact'
  | 'approval_option_permissive'
  | 'non_interactive_fallback';

interface NonInteractiveInputAnswers {
  answers: Record<string, { answers: string[] }>;
  mode: NonInteractiveInputAnswerMode;
}

function buildNonInteractiveInputAnswers(params: Record<string, unknown>): NonInteractiveInputAnswers | null {
  const questions = Array.isArray(params.questions) ? params.questions : null;
  if (!questions || questions.length === 0) {
    return null;
  }

  const answers: Record<string, { answers: string[] }> = {};
  let validQuestionCount = 0;
  let usedFallback = false;
  let usedPermissiveApproval = false;

  for (const question of questions) {
    const questionRecord = asRecord(question);
    const questionId = readString(questionRecord?.id);
    if (!questionId) {
      return null;
    }

    validQuestionCount += 1;
    const options = Array.isArray(questionRecord?.options) ? questionRecord.options : null;
    const approvalLabel = options ? selectApprovalOptionLabel(options) : null;
    const answerLabel = approvalLabel ?? NON_INTERACTIVE_TOOL_INPUT_ANSWER;
    if (!approvalLabel) {
      usedFallback = true;
    } else if (approvalLabel !== 'Approve this Session' && approvalLabel !== 'Approve Once') {
      usedPermissiveApproval = true;
    }
    answers[questionId] = { answers: [answerLabel] };
  }

  if (validQuestionCount === 0) {
    return null;
  }

  if (usedFallback) {
    return { answers, mode: 'non_interactive_fallback' };
  }
  if (usedPermissiveApproval) {
    return { answers, mode: 'approval_option_permissive' };
  }

  return { answers, mode: 'approval_option_exact' };
}

function parseTokenTotals(payload: Record<string, unknown> | null): CodexUsageTotals | null {
  if (!payload) {
    return null;
  }

  const input = readNumberLike(payload.input_tokens ?? payload.inputTokens);
  const output = readNumberLike(payload.output_tokens ?? payload.outputTokens);
  const total = readNumberLike(payload.total_tokens ?? payload.totalTokens);
  if (input !== null && output !== null && total !== null) {
    const cached = readNumberLike(payload.cached_input_tokens ?? payload.cachedInputTokens);
    const reasoning = readNumberLike(payload.reasoning_output_tokens ?? payload.reasoningOutputTokens);
    const contextWindow = readNumberLike(payload.model_context_window ?? payload.modelContextWindow);
    return {
      input_tokens: input,
      output_tokens: output,
      total_tokens: total,
      ...(cached !== null ? { cached_input_tokens: cached } : {}),
      ...(reasoning !== null ? { reasoning_output_tokens: reasoning } : {}),
      ...(contextWindow !== null ? { model_context_window: contextWindow } : {})
    };
  }

  return null;
}

function readNumberLike(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function mergeTokenUsageMetadata(
  absolute: CodexUsageTotals,
  tokenUsageContainer: Record<string, unknown> | null
): CodexUsageTotals {
  if (!tokenUsageContainer) {
    return absolute;
  }

  if (typeof absolute.model_context_window === 'number') {
    return absolute;
  }

  const containerContextWindow = tokenUsageContainer.model_context_window ?? tokenUsageContainer.modelContextWindow;
  if (typeof containerContextWindow === 'number') {
    return {
      ...absolute,
      model_context_window: containerContextWindow
    };
  }

  return absolute;
}

function parseLastTokenUsage(params: Record<string, unknown>): CodexUsageTotals | null {
  const info = asRecord(params.info);
  const usage = asRecord(params.usage);
  const tokenUsage = asRecord(params.tokenUsage) ?? asRecord(params.token_usage);

  return (
    parseTokenTotals(asRecord(info?.last_token_usage) ?? asRecord(info?.lastTokenUsage)) ??
    parseTokenTotals(asRecord(info?.delta_token_usage) ?? asRecord(info?.deltaTokenUsage)) ??
    parseTokenTotals(asRecord(params.last_token_usage) ?? asRecord(params.lastTokenUsage)) ??
    parseTokenTotals(asRecord(params.delta_token_usage) ?? asRecord(params.deltaTokenUsage) ?? asRecord(params.delta)) ??
    parseTokenTotals(asRecord(usage?.last_token_usage) ?? asRecord(usage?.lastTokenUsage)) ??
    parseTokenTotals(asRecord(usage?.delta_token_usage) ?? asRecord(usage?.deltaTokenUsage) ?? asRecord(usage?.delta)) ??
    parseTokenTotals(asRecord(tokenUsage?.last) ?? asRecord(tokenUsage?.last_usage)) ??
    parseTokenTotals(asRecord(tokenUsage?.delta) ?? asRecord(tokenUsage?.delta_usage))
  );
}

function parseTerminalSummaryUsage(method: string, params: Record<string, unknown>): CodexUsageTotals | null {
  if (method !== 'turn/completed' && method !== 'turn.completed' && method !== 'turn/failed' && method !== 'turn.failed') {
    return null;
  }

  const usage = asRecord(params.usage);
  const summary = asRecord(params.summary);
  const info = asRecord(params.info);
  return (
    parseTokenTotals(usage) ??
    parseTokenTotals(asRecord(usage?.total_token_usage) ?? asRecord(usage?.totalTokenUsage)) ??
    parseTokenTotals(asRecord(summary?.usage)) ??
    parseTokenTotals(asRecord(summary?.total_token_usage) ?? asRecord(summary?.totalTokenUsage)) ??
    parseTokenTotals(asRecord(info?.total_token_usage) ?? asRecord(info?.totalTokenUsage)) ??
    parseTokenTotals(asRecord(params.total_token_usage) ?? asRecord(params.totalTokenUsage))
  );
}

function parsePersistedFallbackUsage(params: Record<string, unknown>): CodexUsageTotals | null {
  const usage = asRecord(params.usage);
  return (
    parseTokenTotals(asRecord(params.persisted_usage) ?? asRecord(params.persistedUsage)) ??
    parseTokenTotals(asRecord(params.persisted_fallback_usage) ?? asRecord(params.persistedFallbackUsage)) ??
    parseTokenTotals(asRecord(usage?.persisted_usage) ?? asRecord(usage?.persistedUsage)) ??
    parseTokenTotals(asRecord(usage?.persisted_fallback_usage) ?? asRecord(usage?.persistedFallbackUsage))
  );
}

interface UsageObservation {
  usage: CodexUsageTotals;
  source: string;
  // Canonical precedence: terminal turn summary > incremental turn usage > persisted fallback usage.
  precedence: 1 | 2 | 3;
  absolute: boolean;
}

class UsageTracker {
  private lastAbsolute: CodexUsageTotals | null = null;
  private highestPrecedence: UsageObservation['precedence'] | null = null;
  private lastIncrementalSignature: string | null = null;
  private aggregate: CodexUsageTotals = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0
  };
  private telemetry: TokenTelemetrySnapshot = {
    token_telemetry_status: 'unavailable',
    token_telemetry_last_source: null,
    token_telemetry_last_at_ms: null
  };

  observe(message: ProtocolMessage, observedAtMs: number = Date.now()): void {
    const observation = this.extractObservation(message);
    if (!observation) {
      return;
    }

    if (this.highestPrecedence !== null && observation.precedence > this.highestPrecedence) {
      return;
    }
    if (this.highestPrecedence !== null && observation.precedence < this.highestPrecedence) {
      this.aggregate = {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0
      };
      this.lastAbsolute = null;
      this.lastIncrementalSignature = null;
    }

    if (observation.precedence === 1) {
      this.aggregate = { ...observation.usage };
      this.lastAbsolute = { ...observation.usage };
      this.recordTelemetry(observation.source, observedAtMs);
      this.highestPrecedence = observation.precedence;
      this.lastIncrementalSignature = null;
      return;
    }

    if (observation.precedence === 3) {
      this.aggregate = { ...observation.usage };
      this.lastAbsolute = { ...observation.usage };
      this.recordTelemetry(observation.source, observedAtMs);
      this.highestPrecedence = observation.precedence;
      return;
    }

    const signature = JSON.stringify(observation.usage);
    if (!observation.absolute && signature === this.lastIncrementalSignature) {
      return;
    }

    if (observation.absolute) {
      if (!this.lastAbsolute) {
        this.aggregate = { ...observation.usage };
      } else {
        this.addAbsoluteDelta(observation.usage);
      }
      this.lastAbsolute = { ...observation.usage };
    } else {
      this.addIncrementalUsage(observation.usage);
      this.lastIncrementalSignature = signature;
    }

    this.recordTelemetry(observation.source, observedAtMs);
    this.highestPrecedence = observation.precedence;
  }

  private extractObservation(message: ProtocolMessage): UsageObservation | null {
    const method = (message.method ?? '').toLowerCase();
    const params = asRecord(message.params);
    if (!params) {
      return null;
    }

    const terminalSummary = parseTerminalSummaryUsage(method, params);
    if (terminalSummary) {
      return {
        usage: terminalSummary,
        source: 'terminal_turn_summary',
        precedence: 1,
        absolute: true
      };
    }

    let absolute: CodexUsageTotals | null = null;
    let source = 'incremental_usage';
    if (method === 'thread/tokenusage/updated') {
      const tokenUsage = asRecord(params.tokenUsage) ?? asRecord(params.token_usage);
      const parsedTotal = parseTokenTotals(asRecord(tokenUsage?.total));
      absolute = parsedTotal ? mergeTokenUsageMetadata(parsedTotal, tokenUsage) : null;
      source = 'thread/tokenUsage/updated.params.tokenUsage.total';
    }

    if (!absolute) {
      const info = asRecord(params.info);
      const infoTotalTokenUsage = asRecord(info?.total_token_usage) ?? asRecord(info?.totalTokenUsage);
      absolute = parseTokenTotals(infoTotalTokenUsage);
      source = 'params.info.total_token_usage';
    }

    if (!absolute) {
      const totalTokenUsage = asRecord(params.total_token_usage) ?? asRecord(params.totalTokenUsage);
      absolute = parseTokenTotals(totalTokenUsage);
      source = 'params.total_token_usage';
    }

    if (!absolute) {
      const usage = asRecord(params.usage);
      const usageTotalTokenUsage = asRecord(usage?.total_token_usage) ?? asRecord(usage?.totalTokenUsage);
      absolute = parseTokenTotals(usageTotalTokenUsage);
      source = 'params.usage.total_token_usage';
    }

    if (absolute) {
      return {
        usage: absolute,
        source,
        precedence: 2,
        absolute: true
      };
    }

    const lastUsage = parseLastTokenUsage(params);
    if (lastUsage) {
      return {
        usage: lastUsage,
        source: 'last_token_usage',
        precedence: 2,
        absolute: false
      };
    }

    const persistedUsage = parsePersistedFallbackUsage(params);
    if (persistedUsage) {
      return {
        usage: persistedUsage,
        source: 'persisted_fallback_usage',
        precedence: 3,
        absolute: true
      };
    }

    return null;
  }

  private addAbsoluteDelta(absolute: CodexUsageTotals): void {
    const previous = this.lastAbsolute;
    if (!previous) {
      this.aggregate = { ...absolute };
      return;
    }
    this.aggregate.input_tokens += Math.max(0, absolute.input_tokens - previous.input_tokens);
    this.aggregate.output_tokens += Math.max(0, absolute.output_tokens - previous.output_tokens);
    this.aggregate.total_tokens += Math.max(0, absolute.total_tokens - previous.total_tokens);
    if (typeof absolute.cached_input_tokens === 'number' && typeof previous.cached_input_tokens === 'number') {
      this.aggregate.cached_input_tokens = (this.aggregate.cached_input_tokens ?? 0) +
        Math.max(0, absolute.cached_input_tokens - previous.cached_input_tokens);
    } else if (typeof absolute.cached_input_tokens === 'number' && this.aggregate.cached_input_tokens === undefined) {
      this.aggregate.cached_input_tokens = absolute.cached_input_tokens;
    }

    if (
      typeof absolute.reasoning_output_tokens === 'number' &&
      typeof previous.reasoning_output_tokens === 'number'
    ) {
      this.aggregate.reasoning_output_tokens = (this.aggregate.reasoning_output_tokens ?? 0) +
        Math.max(0, absolute.reasoning_output_tokens - previous.reasoning_output_tokens);
    } else if (typeof absolute.reasoning_output_tokens === 'number' && this.aggregate.reasoning_output_tokens === undefined) {
      this.aggregate.reasoning_output_tokens = absolute.reasoning_output_tokens;
    }

    if (typeof absolute.model_context_window === 'number') {
      this.aggregate.model_context_window = absolute.model_context_window;
    }
  }

  private addIncrementalUsage(usage: CodexUsageTotals): void {
    this.aggregate.input_tokens += Math.max(0, usage.input_tokens);
    this.aggregate.output_tokens += Math.max(0, usage.output_tokens);
    this.aggregate.total_tokens += Math.max(0, usage.total_tokens);
    if (typeof usage.cached_input_tokens === 'number') {
      this.aggregate.cached_input_tokens = (this.aggregate.cached_input_tokens ?? 0) + Math.max(0, usage.cached_input_tokens);
    }
    if (typeof usage.reasoning_output_tokens === 'number') {
      this.aggregate.reasoning_output_tokens =
        (this.aggregate.reasoning_output_tokens ?? 0) + Math.max(0, usage.reasoning_output_tokens);
    }
    if (typeof usage.model_context_window === 'number') {
      this.aggregate.model_context_window = usage.model_context_window;
    }
  }

  private recordTelemetry(source: string, observedAtMs: number): void {
    this.telemetry = {
      token_telemetry_status: 'available',
      token_telemetry_last_source: source,
      token_telemetry_last_at_ms: observedAtMs
    };
  }

  snapshot(): CodexUsageTotals {
    return { ...this.aggregate };
  }

  telemetrySnapshot(): TokenTelemetrySnapshot {
    return { ...this.telemetry };
  }
}

function renderShellCommand(command: string, args?: string[], env?: Record<string, string>): string {
  const commandWithArgs = args ? [command, ...args].map(shellEscape).join(' ') : command;
  const envPrefix = Object.entries(env ?? {})
    .map(([key, value]) => `${key}=${shellEscape(value)}`)
    .join(' ');
  return envPrefix ? `${envPrefix} ${commandWithArgs}` : commandWithArgs;
}

function readModelValue(value: unknown): string | null {
  const parsed = readString(value);
  return parsed && parsed.trim() ? parsed.trim() : null;
}

function readFirstModelValue(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = readModelValue(payload[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function stripConfigQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '');
}

function readModelFromConfigAssignment(value: string): string | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^model\s*=\s*(.+)$/);
  return match ? stripConfigQuotes(match[1].trim()) : null;
}

function extractRequestedModel(input: CodexRunnerStartInput): string | null {
  const args = input.commandArgs ?? [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--config' || arg === '-c') {
      const next = args[index + 1];
      if (next) {
        const parsed = readModelFromConfigAssignment(next);
        if (parsed) {
          return parsed;
        }
      }
    }
    const inlineConfig = arg.match(/^--config=(.+)$/)?.[1];
    if (inlineConfig) {
      const parsed = readModelFromConfigAssignment(inlineConfig);
      if (parsed) {
        return parsed;
      }
    }
  }

  const commandMatch = input.command.match(/(?:^|\s)(?:--config|-c)\s+['"]?model\s*=\s*["']?([^'"\s]+)["']?/);
  return commandMatch ? stripConfigQuotes(commandMatch[1]) : null;
}

function buildProtocolMetadata(waitResult: WaitForTerminalResult): Partial<CodexTurnResult> {
  return {
    protocol_warnings: waitResult.protocol_warnings,
    model_reroute: waitResult.model_reroute,
    requested_model: waitResult.requested_model,
    effective_model: waitResult.effective_model
  };
}

function defaultSpawnProcess(params: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd: string;
  workerHost?: string;
}): RunnerProcess {
  const workerHost = params.workerHost?.trim();
  if (workerHost) {
    const remoteCommand = `cd ${shellEscape(params.cwd)} && exec ${renderShellCommand(params.command, params.args, params.env)}`;
    const child: ChildProcessWithoutNullStreams = spawn('ssh', buildSshSpawnArgs(workerHost, remoteCommand), {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    return child;
  }

  const child: ChildProcessWithoutNullStreams = params.args
    ? spawn(params.command, params.args, {
        cwd: params.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...(params.env ?? {})
        }
      })
    : spawn('bash', ['-lc', params.command], {
        cwd: params.cwd,
        stdio: ['pipe', 'pipe', 'pipe']
      });

  return child;
}

function abortReason(signal: AbortSignal | undefined): string {
  const reason = signal?.reason;
  return typeof reason === 'string' && reason.trim().length > 0 ? reason : 'worker_cancelled';
}

function createCancellationError(signal: AbortSignal | undefined, outcome = 'requested'): CodexRunnerError {
  return new CodexRunnerError('turn_cancelled', `worker_cancelled:${abortReason(signal)}:${outcome}`);
}

function waitForProcessExit(
  processHandle: RunnerProcess,
  timeoutMs: number
): Promise<'exited' | 'timeout'> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve('timeout'), timeoutMs);
    processHandle.once('exit', () => {
      clearTimeout(timeout);
      resolve('exited');
    });
  });
}

function createProcessCancellation(params: {
  processHandle: RunnerProcess;
  signal?: AbortSignal;
}): {
  withCancellation: <T>(promise: Promise<T>) => Promise<T>;
  cancellationRequested: () => boolean;
  waitForCancellation: () => Promise<CodexRunnerError | null>;
  dispose: () => void;
} {
  const { processHandle, signal } = params;
  let cancellationSettled: Promise<void> | null = null;
  let rejectCancellation: ((error: CodexRunnerError) => void) | null = null;
  let cancellationRejected = false;
  let cancellationError: CodexRunnerError | null = null;

  const cancellationPromise = new Promise<never>((_, reject) => {
    rejectCancellation = (error) => {
      if (!cancellationRejected) {
        cancellationRejected = true;
        cancellationError = error;
        reject(error);
      }
    };
  });
  // Prevent late aborts after a completed turn from surfacing as unhandled rejections.
  cancellationPromise.catch(() => undefined);

  const requestCancellation = () => {
    if (cancellationSettled) {
      return;
    }

    cancellationSettled = (async () => {
      processHandle.kill('SIGTERM');
      const gracefulExit = await waitForProcessExit(processHandle, PROCESS_CANCEL_GRACE_MS);
      if (gracefulExit !== 'exited') {
        processHandle.kill('SIGKILL');
        const forcedExit = await waitForProcessExit(processHandle, PROCESS_CANCEL_FORCE_SETTLE_MS);
        rejectCancellation?.(
          createCancellationError(signal, forcedExit === 'exited' ? 'forced_kill_exited' : 'forced_kill_requested')
        );
        return;
      }
      rejectCancellation?.(createCancellationError(signal, 'graceful_exit'));
    })();
  };

  if (signal?.aborted) {
    requestCancellation();
  } else {
    signal?.addEventListener('abort', requestCancellation, { once: true });
  }

  return {
    withCancellation: <T>(promise: Promise<T>): Promise<T> => {
      if (!signal) {
        return promise;
      }
      if (signal.aborted) {
        requestCancellation();
      }
      return Promise.race([promise, cancellationPromise]);
    },
    cancellationRequested: () => Boolean(signal?.aborted),
    waitForCancellation: async () => {
      await cancellationSettled;
      return cancellationError;
    },
    dispose: () => {
      signal?.removeEventListener('abort', requestCancellation);
    }
  };
}

function assertWorkspaceCwd(workspaceCwd: string): void {
  if (!path.isAbsolute(workspaceCwd)) {
    throw new CodexRunnerError('invalid_workspace_cwd', 'Workspace cwd must be an absolute path');
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(workspaceCwd);
  } catch {
    throw new CodexRunnerError('invalid_workspace_cwd', `Workspace cwd does not exist: ${workspaceCwd}`);
  }

  if (!stat.isDirectory()) {
    throw new CodexRunnerError('invalid_workspace_cwd', `Workspace cwd is not a directory: ${workspaceCwd}`);
  }
}

function assertRemoteWorkspaceCwd(workspaceCwd: string): void {
  if (!workspaceCwd.trim()) {
    throw new CodexRunnerError('invalid_remote_workspace_cwd', 'Remote workspace cwd must be non-empty');
  }

  if (workspaceCwd.includes('\n') || workspaceCwd.includes('\r') || workspaceCwd.includes('\u0000')) {
    throw new CodexRunnerError('invalid_remote_workspace_cwd', 'Remote workspace cwd contains invalid characters');
  }
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export class CodexRunner {
  private readonly spawnProcess: SpawnProcess;
  private readonly dynamicToolExecutor: DynamicToolExecutor;
  private readonly pendingNativeInputSessions = new Map<
    string,
    {
      processHandle: RunnerProcess;
      protocol: ProtocolClient;
      request_id: string;
      thread_id: string;
      turn_id: string;
    }
  >();

  constructor(options: { spawnProcess?: SpawnProcess; dynamicToolExecutor?: DynamicToolExecutor } = {}) {
    this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
    this.dynamicToolExecutor =
      options.dynamicToolExecutor ??
      createDefaultDynamicToolExecutor({
        trackerEndpoint: '',
        trackerApiKey: ''
      });
  }

  async startSessionAndRunTurn(input: CodexRunnerStartInput): Promise<CodexTurnResult> {
    if (input.workerHost) {
      assertRemoteWorkspaceCwd(input.workspaceCwd);
    } else {
      assertWorkspaceCwd(input.workspaceCwd);
    }

    let processHandle: RunnerProcess;
    let shouldTerminateProcess = true;
    try {
      processHandle = this.spawnProcess({
        command: input.command,
        args: input.commandArgs,
        env: input.commandEnv,
        cwd: input.workspaceCwd,
        workerHost: input.workerHost
      });
    } catch {
      throw new CodexRunnerError('invalid_workspace_cwd', `Failed to launch codex process in cwd: ${input.workspaceCwd}`);
    }

    const protocol = new ProtocolClient(
      processHandle,
      this.dynamicToolExecutor,
      normalizeCodexHome(input),
      extractRequestedModel(input)
    );
    const emit = this.makeEmitter(input.onEvent, processHandle.pid ?? null);
    const cancellation = createProcessCancellation({ processHandle, signal: input.cancellationSignal });
    protocol.setEventEmitter(emit);

    try {
      await cancellation.withCancellation(
        protocol.request(
          'initialize',
          {
            clientInfo: { name: 'symphony', version: '0.1.0' },
            capabilities: {
              experimentalApi: true
            }
          },
          input.readTimeoutMs
        )
      );

      protocol.notify('initialized', {});

      const baseThreadStartParams = {
        approvalPolicy: normalizeApprovalPolicy(input.approvalPolicy),
        sandbox: input.threadSandbox ?? 'workspace-write',
        cwd: input.workspaceCwd
      };

      let threadResponse: Record<string, unknown>;
      try {
        threadResponse = await cancellation.withCancellation(
          protocol.request(
            'thread/start',
            {
              ...baseThreadStartParams,
              dynamicTools: this.dynamicToolExecutor.toolSpecs()
            },
            input.readTimeoutMs
          )
        );
      } catch (error) {
        if (!requiresExperimentalApiCapability(error)) {
          throw error;
        }

        threadResponse = await cancellation.withCancellation(
          protocol.request('thread/start', baseThreadStartParams, input.readTimeoutMs)
        );
      }

      const thread_id = readNestedString(threadResponse, [
        ['thread', 'id'],
        ['thread', 'threadId'],
        ['threadId'],
        ['thread_id'],
        ['id']
      ]);
      if (!thread_id) {
        throw new CodexRunnerError('response_error', 'Missing thread id in thread/start response');
      }

      emit({ event: CANONICAL_EVENT.codex.sessionStarted, thread_id });
      protocol.emitThreadActivity(threadResponse, thread_id, emit);

      const maxTurns = Math.max(1, input.maxTurns ?? 1);
      let turnsCompleted = 0;

      for (let turnIndex = 0; turnIndex < maxTurns; turnIndex += 1) {
        const promptText = turnIndex === 0 ? input.prompt : input.continuationPrompt ?? CONTINUATION_GUIDANCE;
        const sandboxPolicy = normalizeTurnSandboxPolicy(input.turnSandboxPolicy);
        emit({
          event: CANONICAL_EVENT.codex.promptSent,
          thread_id,
          detail: turnIndex === 0 ? 'initial_prompt' : 'continuation_prompt'
        });
        const turnResponse = await cancellation.withCancellation(
          protocol.request(
            'turn/start',
            {
              threadId: thread_id,
              input: [{ type: 'text', text: promptText }],
              cwd: input.workspaceCwd,
              title: input.title,
              approvalPolicy: normalizeApprovalPolicy(input.approvalPolicy),
              sandboxPolicy
            },
            input.readTimeoutMs
          )
        );

        const turn_id = readNestedString(turnResponse, [
          ['turn', 'id'],
          ['turn', 'turnId'],
          ['turnId'],
          ['turn_id'],
          ['id']
        ]);
        if (!turn_id) {
          throw new CodexRunnerError('response_error', 'Missing turn id in turn/start response');
        }

        emit({
          event: CANONICAL_EVENT.codex.turnStarted,
          thread_id,
          turn_id,
          session_id: `${thread_id}-${turn_id}`
        });
        protocol.setTurnContext({
          thread_id,
          turn_id,
          session_id: `${thread_id}-${turn_id}`,
          turn_started_at_ms: Date.now()
        });
        void protocol.refreshThreadActivity(thread_id, input.readTimeoutMs, emit);

        const waitResult = await cancellation.withCancellation(protocol.waitForTurnTerminal(input.turnTimeoutMs, emit));
        const session_id = `${thread_id}-${turn_id}`;
        const usage = waitResult.usage;
        const telemetry = waitResult.telemetry;
        const rate_limits = waitResult.rate_limits;
        const terminalMetadata = buildTerminalMetadata(waitResult);
        const protocolMetadata = buildProtocolMetadata(waitResult);

        if (waitResult.terminal === 'turn/completed') {
          turnsCompleted += 1;
          emit({
            event: CANONICAL_EVENT.codex.phaseValidation,
            thread_id,
            turn_id,
            session_id
          });

          emit({
            event: CANONICAL_EVENT.codex.turnCompleted,
            thread_id,
            turn_id,
            session_id,
            usage,
            ...telemetry,
            rate_limits,
            ...protocolMetadata,
            terminal_source: waitResult.terminal_source
          });

          if (turnIndex < maxTurns - 1) {
            continue;
          }

          return {
            status: 'completed',
            thread_id,
            turn_id,
            session_id,
            last_event: CANONICAL_EVENT.codex.turnCompleted,
            turns_completed: turnsCompleted,
            usage,
            ...telemetry,
            rate_limits,
            ...protocolMetadata,
            ...terminalMetadata
          };
        }

        if (waitResult.terminal === 'turn/failed') {
          emit({ event: CANONICAL_EVENT.codex.turnFailed, thread_id, turn_id, session_id, usage, ...telemetry, rate_limits, ...protocolMetadata });
          return {
            status: 'failed',
            thread_id,
            turn_id,
            session_id,
            last_event: CANONICAL_EVENT.codex.turnFailed,
            error_code: 'turn_failed',
            turns_completed: turnsCompleted,
            usage,
            ...telemetry,
            rate_limits,
            ...protocolMetadata,
            ...terminalMetadata
          };
        }

        if (waitResult.terminal === 'turn/cancelled') {
          emit({ event: CANONICAL_EVENT.codex.turnCancelled, thread_id, turn_id, session_id, usage, ...telemetry, rate_limits, ...protocolMetadata });
          return {
            status: 'failed',
            thread_id,
            turn_id,
            session_id,
            last_event: CANONICAL_EVENT.codex.turnCancelled,
            error_code: 'turn_cancelled',
            turns_completed: turnsCompleted,
            usage,
            ...telemetry,
            rate_limits,
            ...protocolMetadata,
            ...terminalMetadata
          };
        }

        emit({ event: CANONICAL_EVENT.codex.turnInputRequired, thread_id, turn_id, session_id, usage, ...telemetry, rate_limits, ...protocolMetadata });
        const inputRequestId = waitResult.input_required_payload?.request_id ?? null;
        if (inputRequestId) {
          this.pendingNativeInputSessions.set(session_id, {
            processHandle,
            protocol,
            request_id: inputRequestId,
            thread_id,
            turn_id
          });
          shouldTerminateProcess = false;
        }
        return {
          status: 'failed',
          thread_id,
          turn_id,
          session_id,
          last_event: CANONICAL_EVENT.codex.turnInputRequired,
          error_code: REASON_CODES.turnInputRequired,
          error_detail: waitResult.input_required_detail ?? 'input_required_unanswerable',
          input_required_payload: waitResult.input_required_payload,
          turns_completed: turnsCompleted,
          usage,
          ...telemetry,
          rate_limits,
          ...protocolMetadata,
          ...terminalMetadata
        };
      }

      throw new CodexRunnerError('response_error', 'Reached unexpected end of turn loop');
    } catch (error) {
      if (error instanceof CodexRunnerError) {
        if (cancellation.cancellationRequested()) {
          const cancellationError = await cancellation.waitForCancellation();
          emit({ event: CANONICAL_EVENT.codex.turnCancelled, detail: abortReason(input.cancellationSignal) });
          if (error.code === 'turn_cancelled' && error.message.startsWith('worker_cancelled:')) {
            throw error;
          }
          throw cancellationError ?? createCancellationError(input.cancellationSignal);
        }
        if (error.code === 'port_exit' && protocol.sawCodexNotFound()) {
          throw new CodexRunnerError('codex_not_found', 'codex app-server command was not found');
        }
        if (error.code === REASON_CODES.turnTimeout) {
          throw error;
        }
        emit({ event: CANONICAL_EVENT.codex.startupFailed, detail: error.message });
        throw error;
      }

      throw error;
    } finally {
      if (shouldTerminateProcess) {
        if (cancellation.cancellationRequested()) {
          await cancellation.waitForCancellation();
        } else {
          processHandle.kill('SIGKILL');
        }
      }
      cancellation.dispose();
    }
  }

  async resumeThreadInterruptAndRunTurn(input: CodexRunnerRecoveryInput): Promise<CodexTurnResult> {
    if (input.workerHost) {
      assertRemoteWorkspaceCwd(input.workspaceCwd);
    } else {
      assertWorkspaceCwd(input.workspaceCwd);
    }

    let processHandle: RunnerProcess;
    try {
      processHandle = this.spawnProcess({
        command: input.command,
        args: input.commandArgs,
        env: input.commandEnv,
        cwd: input.workspaceCwd,
        workerHost: input.workerHost
      });
    } catch {
      throw new CodexRunnerError('invalid_workspace_cwd', `Failed to launch codex process in cwd: ${input.workspaceCwd}`);
    }

    const protocol = new ProtocolClient(
      processHandle,
      this.dynamicToolExecutor,
      normalizeCodexHome(input),
      extractRequestedModel(input)
    );
    const emit = this.makeEmitter(input.onEvent, processHandle.pid ?? null);
    const cancellation = createProcessCancellation({ processHandle, signal: input.cancellationSignal });
    protocol.setEventEmitter(emit);

    try {
      await cancellation.withCancellation(
        protocol.request(
          'initialize',
          {
            clientInfo: { name: 'symphony', version: '0.1.0' },
            capabilities: {
              experimentalApi: true
            }
          },
          input.readTimeoutMs
        )
      );
      protocol.notify('initialized', {});

      const threadResponse = await cancellation.withCancellation(
        protocol.request(
          'thread/resume',
          {
            threadId: input.previousThreadId,
            cwd: input.workspaceCwd,
            approvalPolicy: normalizeApprovalPolicy(input.approvalPolicy),
            sandbox: input.threadSandbox ?? 'workspace-write',
            persistExtendedHistory: true
          },
          input.readTimeoutMs
        )
      );
      const thread_id =
        readNestedString(threadResponse, [
          ['thread', 'id'],
          ['thread', 'threadId'],
          ['threadId'],
          ['thread_id'],
          ['id']
        ]) ?? input.previousThreadId;

      emit({ event: CANONICAL_EVENT.codex.sessionStarted, thread_id });

      await cancellation.withCancellation(
        protocol.request(
          'turn/interrupt',
          {
            threadId: thread_id,
            turnId: input.previousTurnId
          },
          input.readTimeoutMs
        )
      );
      emit({
        event: CANONICAL_EVENT.codex.turnCancelled,
        thread_id,
        turn_id: input.previousTurnId,
        session_id: input.previousSessionId ?? `${thread_id}-${input.previousTurnId}`,
        detail: REASON_CODES.missingToolOutputRecoveryInterrupted
      });

      emit({
        event: CANONICAL_EVENT.codex.promptSent,
        thread_id,
        detail: 'guarded_recovery_prompt'
      });
      const turnResponse = await cancellation.withCancellation(
        protocol.request(
          'turn/start',
          {
            threadId: thread_id,
            input: [{ type: 'text', text: input.prompt }],
            cwd: input.workspaceCwd,
            title: input.title,
            approvalPolicy: normalizeApprovalPolicy(input.approvalPolicy),
            sandboxPolicy: normalizeTurnSandboxPolicy(input.turnSandboxPolicy)
          },
          input.readTimeoutMs
        )
      );
      const turn_id = readNestedString(turnResponse, [
        ['turn', 'id'],
        ['turn', 'turnId'],
        ['turnId'],
        ['turn_id'],
        ['id']
      ]);
      if (!turn_id) {
        throw new CodexRunnerError('response_error', 'Missing turn id in recovery turn/start response');
      }

      const session_id = `${thread_id}-${turn_id}`;
      emit({ event: CANONICAL_EVENT.codex.turnStarted, thread_id, turn_id, session_id });
      protocol.setTurnContext({ thread_id, turn_id, session_id, turn_started_at_ms: Date.now() });

      const waitResult = await cancellation.withCancellation(protocol.waitForTurnTerminal(input.turnTimeoutMs, emit));
      const usage = waitResult.usage;
      const telemetry = waitResult.telemetry;
      const rate_limits = waitResult.rate_limits;
      const terminalMetadata = buildTerminalMetadata(waitResult);
      const protocolMetadata = buildProtocolMetadata(waitResult);
      if (waitResult.terminal === 'turn/completed') {
        emit({ event: CANONICAL_EVENT.codex.phaseValidation, thread_id, turn_id, session_id });
        emit({
          event: CANONICAL_EVENT.codex.turnCompleted,
          thread_id,
          turn_id,
          session_id,
          usage,
          ...telemetry,
          rate_limits,
          ...protocolMetadata,
          terminal_source: waitResult.terminal_source
        });
        return {
          status: 'completed',
          thread_id,
          turn_id,
          session_id,
          last_event: CANONICAL_EVENT.codex.turnCompleted,
          turns_completed: 1,
          usage,
          ...telemetry,
          rate_limits,
          ...protocolMetadata,
          ...terminalMetadata
        };
      }
      if (waitResult.terminal === 'turn/failed') {
        emit({ event: CANONICAL_EVENT.codex.turnFailed, thread_id, turn_id, session_id, usage, ...telemetry, rate_limits, ...protocolMetadata });
        return {
          status: 'failed',
          thread_id,
          turn_id,
          session_id,
          last_event: CANONICAL_EVENT.codex.turnFailed,
          error_code: 'turn_failed',
          turns_completed: 0,
          usage,
          ...telemetry,
          rate_limits,
          ...protocolMetadata,
          ...terminalMetadata
        };
      }
      if (waitResult.terminal === 'turn/cancelled') {
        emit({ event: CANONICAL_EVENT.codex.turnCancelled, thread_id, turn_id, session_id, usage, ...telemetry, rate_limits, ...protocolMetadata });
        return {
          status: 'failed',
          thread_id,
          turn_id,
          session_id,
          last_event: CANONICAL_EVENT.codex.turnCancelled,
          error_code: 'turn_cancelled',
          turns_completed: 0,
          usage,
          ...telemetry,
          rate_limits,
          ...protocolMetadata,
          ...terminalMetadata
        };
      }

      emit({ event: CANONICAL_EVENT.codex.turnInputRequired, thread_id, turn_id, session_id, usage, ...telemetry, rate_limits, ...protocolMetadata });
      return {
        status: 'failed',
        thread_id,
        turn_id,
        session_id,
        last_event: CANONICAL_EVENT.codex.turnInputRequired,
        error_code: REASON_CODES.turnInputRequired,
        error_detail: waitResult.input_required_detail ?? 'input_required_unanswerable',
        input_required_payload: waitResult.input_required_payload,
        turns_completed: 0,
        usage,
        ...telemetry,
        rate_limits,
        ...protocolMetadata,
        ...terminalMetadata
      };
    } catch (error) {
      if (error instanceof CodexRunnerError) {
        if (cancellation.cancellationRequested()) {
          const cancellationError = await cancellation.waitForCancellation();
          emit({ event: CANONICAL_EVENT.codex.turnCancelled, detail: abortReason(input.cancellationSignal) });
          if (error.code === 'turn_cancelled' && error.message.startsWith('worker_cancelled:')) {
            throw error;
          }
          throw cancellationError ?? createCancellationError(input.cancellationSignal);
        }
        if (error.code === 'port_exit' && protocol.sawCodexNotFound()) {
          throw new CodexRunnerError('codex_not_found', 'codex app-server command was not found');
        }
        if (error.code === REASON_CODES.turnTimeout) {
          throw error;
        }
        emit({ event: CANONICAL_EVENT.codex.startupFailed, detail: error.message });
        throw error;
      }
      throw error;
    } finally {
      if (cancellation.cancellationRequested()) {
        await cancellation.waitForCancellation();
      } else {
        processHandle.kill('SIGKILL');
      }
      cancellation.dispose();
    }
  }

  async submitBlockedInputNative(params: {
    previous_session_id: string | null;
    previous_thread_id: string | null;
    request_id: string;
    answer: { question_id?: string; option_label?: string; text?: string };
  }): Promise<{ applied: boolean; code: 'native_applied' | 'session_expired' | 'request_not_found' | 'native_submit_failed'; message?: string }> {
    const sessionId = params.previous_session_id?.trim() ?? '';
    if (!sessionId) {
      return { applied: false, code: 'session_expired', message: 'missing previous_session_id for native submit' };
    }
    const pending = this.pendingNativeInputSessions.get(sessionId);
    if (!pending) {
      return { applied: false, code: 'session_expired', message: `native session ${sessionId} is not active` };
    }
    if (params.previous_thread_id && params.previous_thread_id !== pending.thread_id) {
      this.cleanupPendingNativeSession(sessionId, pending);
      return { applied: false, code: 'session_expired', message: 'previous_thread_id does not match active native session' };
    }
    if (pending.request_id !== params.request_id) {
      return { applied: false, code: 'request_not_found', message: 'request_id does not match active native request' };
    }

    const answerText = params.answer.option_label?.trim() || params.answer.text?.trim() || '';
    if (!answerText) {
      return { applied: false, code: 'native_submit_failed', message: 'missing answer text for native submit' };
    }
    const questionId = params.answer.question_id?.trim() || 'q1';

    const protocolRequestId = Number(params.request_id);
    if (!Number.isFinite(protocolRequestId)) {
      return { applied: false, code: 'request_not_found', message: 'request_id is not a numeric protocol id' };
    }

    try {
      pending.protocol.sendRequestResponse(protocolRequestId, {
        answers: {
          [questionId]: {
            answers: [answerText]
          }
        }
      });
    } catch (error) {
      this.cleanupPendingNativeSession(sessionId, pending);
      return { applied: false, code: 'native_submit_failed', message: error instanceof Error ? error.message : 'failed to submit native answer' };
    }

    this.cleanupPendingNativeSession(sessionId, pending);
    return { applied: true, code: 'native_applied' };
  }

  private cleanupPendingNativeSession(
    sessionId: string,
    pending: {
      processHandle: RunnerProcess;
      protocol: ProtocolClient;
      request_id: string;
      thread_id: string;
      turn_id: string;
    }
  ): void {
    this.pendingNativeInputSessions.delete(sessionId);
    pending.processHandle.kill('SIGKILL');
  }

  private makeEmitter(onEvent: ((event: CodexRunnerEvent) => void) | undefined, pid: number | null) {
    return (event: Omit<CodexRunnerEvent, 'timestamp' | 'codex_app_server_pid'>): void => {
      onEvent?.({
        ...event,
        timestamp: new Date().toISOString(),
        codex_app_server_pid: pid
      });
    };
  }
}

class ProtocolClient {
  private readonly processHandle: RunnerProcess;
  private readonly dynamicToolExecutor: DynamicToolExecutor;
  private readonly codexHome: string;
  private readonly requestedModel: string | null;
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private readonly earlyResponses = new Map<number, ProtocolMessage>();
  private readonly notifications: ProtocolMessage[] = [];
  private readonly messageEmitter = new EventEmitter();
  private readonly usageTracker = new UsageTracker();
  private readonly transcriptOffsets = new Map<string, number>();
  private readonly transcriptTails = new Map<string, string>();
  private transcriptCandidateCache: TranscriptCandidateCache | null = null;
  private lastTranscriptLookupDiagnosticKey: string | null = null;

  private latestRateLimits: Record<string, unknown> | null = null;
  private latestModelReroute: CodexModelRerouteEvidence | null = null;
  private protocolWarnings: CodexProtocolWarningEvidence[] = [];
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private nextId = 1;
  private nextNotificationIndex = 0;
  private stderrLines: string[] = [];
  private emitEvent?: (event: Omit<CodexRunnerEvent, 'timestamp' | 'codex_app_server_pid'>) => void;
  private activeTurnContext: TurnEventContext | null = null;
  private static readonly TURN_WAITING_HEARTBEAT_MS = 5000;
  private static readonly TRANSCRIPT_SCAN_INTERVAL_MS = 100;
  private static readonly TRANSCRIPT_CANDIDATE_CACHE_TTL_MS = 15_000;
  private static readonly TRANSCRIPT_MAX_CANDIDATE_FILES = 40;
  private static readonly TRANSCRIPT_MAX_DISCOVERY_FILES = 20;
  private static readonly TRANSCRIPT_MAX_PROBE_BYTES = 256 * 1024;
  private static readonly TRANSCRIPT_MAX_FILE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  private static readonly TRANSCRIPT_MAX_WALL_CLOCK_MS = 20;
  private static readonly TRANSCRIPT_MAX_DEPTH = 5;

  constructor(
    processHandle: RunnerProcess,
    dynamicToolExecutor: DynamicToolExecutor,
    codexHome: string,
    requestedModel: string | null
  ) {
    this.processHandle = processHandle;
    this.dynamicToolExecutor = dynamicToolExecutor;
    this.codexHome = codexHome;
    this.requestedModel = requestedModel;

    this.processHandle.stdout.on('data', (chunk: Buffer | string) => {
      this.onStdout(chunk.toString('utf8'));
    });

    this.processHandle.stderr.on('data', (chunk: Buffer | string) => {
      this.onStderr(chunk.toString('utf8'));
    });

    this.processHandle.once('exit', () => {
      for (const pending of this.pending.values()) {
        pending.reject(new CodexRunnerError('port_exit', 'Codex process exited before response'));
      }
      this.pending.clear();
      this.messageEmitter.emit('exit');
    });
  }

  sawCodexNotFound(): boolean {
    return this.stderrLines.some((line) => /\bcodex\b.*(command not found|not found)/i.test(line));
  }

  setEventEmitter(emit: (event: Omit<CodexRunnerEvent, 'timestamp' | 'codex_app_server_pid'>) => void): void {
    this.emitEvent = emit;
  }

  setTurnContext(context: TurnEventContext | null): void {
    this.activeTurnContext = context;
  }

  emitThreadActivity(
    payload: unknown,
    threadId: string | null | undefined,
    emit: (event: Omit<CodexRunnerEvent, 'timestamp' | 'codex_app_server_pid'>) => void
  ): void {
    const activity = extractCodexAppServerThreadActivity(payload, threadId);
    if (!activity) {
      return;
    }

    emit({
      event: CANONICAL_EVENT.codex.threadActivityUpdated,
      thread_id: activity.thread_id,
      codex_thread_activity_at_ms: activity.updated_at_ms,
      codex_thread_activity_source: activity.source,
      codex_thread_activity_status: activity.status
    });
  }

  async refreshThreadActivity(
    threadId: string,
    timeoutMs: number,
    emit: (event: Omit<CodexRunnerEvent, 'timestamp' | 'codex_app_server_pid'>) => void
  ): Promise<void> {
    const params: CodexAppServerThreadReadParamsV2 = { threadId, includeTurns: false };
    try {
      const response = (await this.request('thread/read', params, timeoutMs, { unrefTimer: true })) as CodexAppServerThreadReadResponseV2;
      this.emitThreadActivity(response, threadId, emit);
    } catch {
      // Thread metadata is diagnostic dashboard data; absence must not fail the run.
    }
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.write({ method, params });
  }

  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    options: { unrefTimer?: boolean } = {}
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRunnerError('response_timeout', `Timed out waiting for ${method} response`));
      }, timeoutMs);
      if (options.unrefTimer) {
        timer.unref?.();
      }

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });

      const early = this.earlyResponses.get(id);
      if (early) {
        this.earlyResponses.delete(id);
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          if (early.error) {
            pending.reject(
              new CodexRunnerError('response_error', `Protocol error response for id ${id}${describeProtocolError(early.error)}`)
            );
          } else {
            pending.resolve(asRecord(early.result) ?? {});
          }
        }
      }

      this.write({ id, method, params });
    });
  }

  waitForTurnTerminal(
    timeoutMs: number,
    emit: (event: Omit<CodexRunnerEvent, 'timestamp' | 'codex_app_server_pid'>) => void
  ): Promise<WaitForTerminalResult> {
    const consume = async (): Promise<WaitForTerminalResult | null> => {
      while (this.nextNotificationIndex < this.notifications.length) {
        const message = this.notifications[this.nextNotificationIndex++];
        this.usageTracker.observe(message);
        this.emitThreadActivity(message.params, this.activeTurnContext?.thread_id, emit);

        const rateLimits = this.extractRateLimits(message);
        if (rateLimits) {
          this.latestRateLimits = rateLimits;
          emit({
            event: CANONICAL_EVENT.codex.rateLimitsUpdated,
            rate_limits: rateLimits,
            ...(this.activeTurnContext ? this.activeTurnContext : {})
          });
        }
        this.observeProtocolSignals(message, emit);

        const approvalResponse = this.approvalResponse(message);
        if (approvalResponse) {
          this.write({ id: message.id, result: approvalResponse.result });
          emit({ event: CANONICAL_EVENT.codex.approvalAutoApproved, detail: approvalResponse.detail });
          continue;
        }

        if (this.isToolCallRequest(message)) {
          const params = asRecord(message.params);
          const toolName = readString(params?.tool) ?? readString(params?.name);
          const argumentsValue = params?.arguments ?? {};
          const toolCallId = readToolCallId(message);
          const emittedToolName = toolName ?? 'unknown_tool';
          emit({
            event: CANONICAL_EVENT.codex.toolCallStarted,
            detail: emittedToolName,
            tool_call_id: toolCallId,
            tool_name: emittedToolName
          });
          const toolResult = await this.dynamicToolExecutor.execute(toolName, argumentsValue);
          this.write({ id: message.id, result: toolResult });
          if (toolResult.success) {
            emit({
              event: CANONICAL_EVENT.codex.toolCallCompleted,
              detail: emittedToolName,
              tool_call_id: toolCallId,
              tool_name: emittedToolName
            });
            emit({ event: CANONICAL_EVENT.codex.phaseImplementation, detail: toolName ?? 'unknown_tool' });
          } else if (toolName) {
            const unsupportedCapabilityMessage = extractUnsupportedDynamicToolConsoleMessage(toolResult.output);
            if (unsupportedCapabilityMessage) {
              emit({
                event: CANONICAL_EVENT.codex.dynamicToolCapabilityMismatch,
                thread_id: this.activeTurnContext?.thread_id,
                turn_id: this.activeTurnContext?.turn_id,
                session_id: this.activeTurnContext?.session_id,
                tool_call_id: toolCallId,
                tool_name: toolName,
                detail: serializeDynamicToolCapabilityMismatchDetail(
                  createDynamicToolCapabilityMismatchDetail({
                    attempted_tool_name: toolName,
                    call_id: toolCallId,
                    unsupported_capability_message: unsupportedCapabilityMessage
                  })
                )
              });
            } else {
              emit({
                event: CANONICAL_EVENT.codex.toolCallFailed,
                detail: toolName,
                tool_call_id: toolCallId,
                tool_name: toolName
              });
            }
          } else {
            emit({
              event: CANONICAL_EVENT.codex.unsupportedToolCall,
              tool_call_id: toolCallId,
              tool_name: emittedToolName
            });
          }
          continue;
        }

        if (this.emitFunctionCallLedgerEvent(message, emit)) {
          continue;
        }

        if (this.isToolRequestUserInput(message)) {
          const params = asRecord(message.params);
          const response = params ? buildNonInteractiveInputAnswers(params) : null;
          if (response) {
            this.write({ id: message.id, result: { answers: response.answers } });
            emit({
              event: CANONICAL_EVENT.codex.toolInputAutoAnswered,
              detail: response.mode
            });
            continue;
          }

          emit({ event: CANONICAL_EVENT.codex.turnInputRequired, detail: 'tool requestUserInput input_required_unanswerable' });
          return {
            terminal: 'turn/input_required',
            terminal_source: 'app_server_protocol',
            usage: this.usageTracker.snapshot(),
            telemetry: this.usageTracker.telemetrySnapshot(),
            rate_limits: this.latestRateLimits,
            ...this.protocolEvidenceSnapshot(),
            input_required_detail: 'tool requestUserInput input_required_unanswerable',
            input_required_payload: toInputRequestPayload(message) ?? undefined
          };
        }

        if (this.isMcpElicitationRequest(message)) {
          const params = asRecord(message.params);
          const response = params ? buildNonInteractiveInputAnswers(params) : null;
          if (response) {
            this.write({ id: message.id, result: { answers: response.answers } });
            emit({
              event: CANONICAL_EVENT.codex.toolInputAutoAnswered,
              detail: response.mode
            });
            continue;
          }

          emit({ event: CANONICAL_EVENT.codex.turnInputRequired, detail: 'mcp elicitation request input_required_unanswerable' });
          return {
            terminal: 'turn/input_required',
            terminal_source: 'app_server_protocol',
            usage: this.usageTracker.snapshot(),
            telemetry: this.usageTracker.telemetrySnapshot(),
            rate_limits: this.latestRateLimits,
            ...this.protocolEvidenceSnapshot(),
            input_required_detail: 'mcp elicitation request input_required_unanswerable',
            input_required_payload: toInputRequestPayload(message) ?? undefined
          };
        }

        const terminal = this.readTerminal(message);
        if (terminal) {
          return {
            terminal,
            terminal_source: 'app_server_protocol',
            usage: this.usageTracker.snapshot(),
            telemetry: this.usageTracker.telemetrySnapshot(),
            rate_limits: this.latestRateLimits,
            ...this.protocolEvidenceSnapshot()
          };
        }

        if (this.isUnhandledServerRequest(message)) {
          const method = message.method ?? 'unknown';
          const classification = this.unsupportedServerRequestClassification(message);
          this.write({
            id: message.id,
            result: {
              success: false,
              error: REASON_CODES.unsupportedServerRequest,
              method,
              category: classification.category,
              reason_code: classification.reason_code
            }
          });
          emit({
            event: CANONICAL_EVENT.codex.unsupportedServerRequest,
            detail: method,
            request_method: method,
            request_category: classification.category,
            reason_code: classification.reason_code
          });
          if (classification.terminal) {
            return {
              terminal: 'turn/input_required',
              terminal_source: 'app_server_protocol',
              usage: this.usageTracker.snapshot(),
              telemetry: this.usageTracker.telemetrySnapshot(),
              rate_limits: this.latestRateLimits,
              ...this.protocolEvidenceSnapshot(),
              input_required_detail: `unsupported safety-sensitive server request: ${method}`
            };
          }
          continue;
        }
      }

      const transcriptScanResult = this.consumeTranscriptTerminalEvidence(emit);
      if (transcriptScanResult.observedProgress) {
        markProgress();
      }
      if (transcriptScanResult.terminal) {
        return {
          ...transcriptScanResult.terminal,
          terminal_source: 'session_transcript',
          usage: this.usageTracker.snapshot(),
          telemetry: this.usageTracker.telemetrySnapshot(),
          rate_limits: this.latestRateLimits,
          ...this.protocolEvidenceSnapshot(),
          ...(transcriptScanResult.lookup
            ? { transcript_lookup: serializeTranscriptLookupMetadata(transcriptScanResult.lookup) }
            : {})
        };
      }

      return null;
    };

    let markProgress = (): void => {};

    return new Promise((resolve, reject) => {
      const waitStartedAtMs = Date.now();
      const hardDeadlineAtMs = waitStartedAtMs + timeoutMs;
      let lastProgressAtMs = waitStartedAtMs;
      let settled = false;
      let timer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        clearInterval(heartbeat);
        clearInterval(transcriptScan);
        if (timer) {
          clearTimeout(timer);
        }
        this.messageEmitter.off('message', onMessageWrapper);
        this.messageEmitter.off('exit', onExit);
      };

      const scheduleHardTimeout = () => {
        if (timer) {
          clearTimeout(timer);
        }
        const delayMs = Math.max(1, hardDeadlineAtMs - Date.now());
        timer = setTimeout(() => {
          if (settled) {
            return;
          }
          const nowMs = Date.now();
          if (nowMs < hardDeadlineAtMs) {
            scheduleHardTimeout();
            return;
          }
          settled = true;
          cleanup();
          const elapsedMs = nowMs - waitStartedAtMs;
          const idleMs = nowMs - lastProgressAtMs;
          const detail = `hard_wall_clock_turn_timeout timeout_ms=${timeoutMs} elapsed_ms=${elapsedMs} idle_ms=${idleMs}`;
          emit({
            event: CANONICAL_EVENT.codex.turnTimedOut,
            detail,
            reason_code: REASON_CODES.turnTimeout,
            ...(this.activeTurnContext ? this.activeTurnContext : {})
          });
          reject(new CodexRunnerError(REASON_CODES.turnTimeout, `Timed out waiting for turn terminal event at hard wall-clock deadline: ${detail}`));
        }, delayMs);
      };

      markProgress = () => {
        lastProgressAtMs = Date.now();
      };

      const heartbeat = setInterval(() => {
        const elapsedSeconds = Math.floor((Date.now() - waitStartedAtMs) / 1000);
        emit({ event: CANONICAL_EVENT.codex.phasePlanning, detail: `waiting_for_turn_completion elapsed_s=${elapsedSeconds}` });
        emit({ event: CANONICAL_EVENT.codex.turnWaiting, detail: `waiting_for_turn_completion elapsed_s=${elapsedSeconds}` });
      }, ProtocolClient.TURN_WAITING_HEARTBEAT_MS);
      const transcriptScan = setInterval(() => {
        void onMessage();
      }, ProtocolClient.TRANSCRIPT_SCAN_INTERVAL_MS);

      const onMessageWrapper = () => {
        void onMessage();
      };

      scheduleHardTimeout();

      const onExit = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(new CodexRunnerError('port_exit', 'Codex process exited before turn completed'));
      };

      let handlingMessage = false;
      const onMessage = async () => {
        if (handlingMessage) {
          return;
        }
        handlingMessage = true;
        const beforeIndex = this.nextNotificationIndex;
        const terminal = await consume();
        handlingMessage = false;
        if (this.nextNotificationIndex > beforeIndex) {
          markProgress();
        }
        if (!terminal) {
          return;
        }

        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(terminal);
      };

      void onMessage();
      this.messageEmitter.on('message', onMessageWrapper);
      this.messageEmitter.on('exit', onExit);
    });
  }

  private consumeTranscriptTerminalEvidence(
    emit: (event: Omit<CodexRunnerEvent, 'timestamp' | 'codex_app_server_pid'>) => void
  ): TranscriptScanResult {
    const context = this.activeTurnContext;
    if (!context) {
      return { terminal: null, observedProgress: false, lookup: null };
    }
    let observedProgress = false;

    const lookup = this.findCandidateTranscriptPaths(context);
    this.emitTranscriptLookupDiagnostic(lookup, context, emit);

    for (const transcriptPath of lookup.paths) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(transcriptPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) {
        continue;
      }

      const storedOffset = this.transcriptOffsets.get(transcriptPath) ?? 0;
      const previousOffset = Math.min(storedOffset, stat.size);
      if (stat.size < storedOffset) {
        this.transcriptTails.delete(transcriptPath);
      }
      if (stat.size <= previousOffset) {
        continue;
      }
      observedProgress = true;

      let content = '';
      try {
        const fd = fs.openSync(transcriptPath, 'r');
        try {
          const buffer = Buffer.alloc(stat.size - previousOffset);
          fs.readSync(fd, buffer, 0, buffer.length, previousOffset);
          content = buffer.toString('utf8');
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        continue;
      }
      const previousTail = this.transcriptTails.get(transcriptPath) ?? '';
      const combined = previousTail + content;
      const endsWithNewline = combined.endsWith('\n');
      const rawLines = combined.split('\n');
      const completeLines = rawLines.slice(0, -1);
      const nextTail = endsWithNewline ? '' : rawLines.at(-1) ?? '';
      this.transcriptOffsets.set(transcriptPath, stat.size);
      if (nextTail) {
        this.transcriptTails.set(transcriptPath, nextTail);
      } else {
        this.transcriptTails.delete(transcriptPath);
      }

      for (const line of completeLines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        const record = parseJsonRecord(trimmed);
        if (!record) {
          continue;
        }

        const payload = asRecord(record.payload) ?? record;
        this.observeTranscriptUsage(payload);
        const terminalEvidence = this.readTranscriptTerminalEvidence(record, transcriptPath, context, emit);
        if (terminalEvidence) {
          return { terminal: terminalEvidence, observedProgress, lookup };
        }
      }
    }

    return { terminal: null, observedProgress, lookup };
  }

  private findCandidateTranscriptPaths(context: TurnEventContext): TranscriptCandidateLookupResult {
    const identityKey = this.transcriptCandidateIdentityKey(context);
    const nowMs = Date.now();
    if (
      this.transcriptCandidateCache &&
      this.transcriptCandidateCache.identityKey === identityKey &&
      nowMs - this.transcriptCandidateCache.refreshedAtMs < ProtocolClient.TRANSCRIPT_CANDIDATE_CACHE_TTL_MS &&
      this.isTranscriptCandidateCacheFresh()
    ) {
      const cachedStats = this.transcriptCandidateCache.stats;
      return {
        paths: [...this.transcriptCandidateCache.paths],
        stats: {
          ...cachedStats,
          source: 'cache',
          cachedSource: cachedStats.source === 'cache' ? cachedStats.cachedSource : cachedStats.source,
          reasonCodes: [...cachedStats.reasonCodes]
        },
        refreshedAtMs: this.transcriptCandidateCache.refreshedAtMs,
        expiresAtMs: this.transcriptCandidateCache.refreshedAtMs + ProtocolClient.TRANSCRIPT_CANDIDATE_CACHE_TTL_MS
      };
    }

    const indexedPaths = [...this.transcriptOffsets.keys()].filter((transcriptPath) =>
      this.transcriptPathMayMatch(transcriptPath, context)
    );
    if (indexedPaths.length > 0) {
      const limitedPaths = indexedPaths.slice(0, ProtocolClient.TRANSCRIPT_MAX_CANDIDATE_FILES);
      const stats: TranscriptCandidateLookupStats = {
        source: 'indexed',
        candidateCount: limitedPaths.length,
        filesConsidered: indexedPaths.length,
        filesParsed: 0,
        bytesRead: 0,
        exhausted: indexedPaths.length > limitedPaths.length,
        reasonCodes: indexedPaths.length > limitedPaths.length ? ['transcript_candidate_file_budget_exhausted'] : []
      };
      return this.cacheTranscriptLookup(identityKey, nowMs, limitedPaths, stats);
    }

    const sessionsRoot = path.join(this.codexHome, 'sessions');
    let rootStat: fs.Stats;
    try {
      rootStat = fs.statSync(sessionsRoot);
    } catch {
      return this.cacheTranscriptLookup(identityKey, nowMs, [], {
        source: 'missing',
        candidateCount: 0,
        filesConsidered: 0,
        filesParsed: 0,
        bytesRead: 0,
        exhausted: false,
        reasonCodes: ['transcript_sessions_root_missing']
      });
    }
    if (!rootStat.isDirectory()) {
      return this.cacheTranscriptLookup(identityKey, nowMs, [], {
        source: 'missing',
        candidateCount: 0,
        filesConsidered: 0,
        filesParsed: 0,
        bytesRead: 0,
        exhausted: false,
        reasonCodes: ['transcript_sessions_root_missing']
      });
    }

    const candidates: string[] = [];
    const deadlineAtMs = Date.now() + ProtocolClient.TRANSCRIPT_MAX_WALL_CLOCK_MS;
    const reasonCodes = new Set<string>();
    let filesConsidered = 0;
    let filesParsed = 0;
    let remainingProbeBytes = ProtocolClient.TRANSCRIPT_MAX_PROBE_BYTES;
    let foundFallbackContentMatch = false;
    const stack: Array<{ directory: string; depth: number }> = [{ directory: sessionsRoot, depth: 0 }];

    while (
      stack.length > 0 &&
      !foundFallbackContentMatch &&
      candidates.length < ProtocolClient.TRANSCRIPT_MAX_CANDIDATE_FILES &&
      filesConsidered < ProtocolClient.TRANSCRIPT_MAX_DISCOVERY_FILES
    ) {
      if (Date.now() > deadlineAtMs) {
        reasonCodes.add('transcript_discovery_wall_clock_budget_exhausted');
        break;
      }
      const current = stack.pop();
      if (!current) {
        continue;
      }
      let entries: fs.Dirent[];
      try {
        entries = this.sortTranscriptDiscoveryEntries(
          fs.readdirSync(current.directory, { withFileTypes: true }),
          context.turn_started_at_ms
        );
      } catch {
        continue;
      }
      const nextDirectories: Array<{ directory: string; depth: number }> = [];
      for (const entry of entries) {
        if (Date.now() > deadlineAtMs) {
          reasonCodes.add('transcript_discovery_wall_clock_budget_exhausted');
          break;
        }
        const entryPath = path.join(current.directory, entry.name);
        if (entry.isDirectory()) {
          if (current.depth < ProtocolClient.TRANSCRIPT_MAX_DEPTH) {
            nextDirectories.push({ directory: entryPath, depth: current.depth + 1 });
          }
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
          continue;
        }
        if (filesConsidered >= ProtocolClient.TRANSCRIPT_MAX_DISCOVERY_FILES) {
          reasonCodes.add('transcript_discovery_file_count_budget_exhausted');
          break;
        }
        filesConsidered += 1;
        if (this.transcriptPathMayMatch(entryPath, context)) {
          candidates.push(entryPath);
          if (candidates.length >= ProtocolClient.TRANSCRIPT_MAX_CANDIDATE_FILES) {
            reasonCodes.add('transcript_candidate_file_budget_exhausted');
            break;
          }
          continue;
        }

        let fileStat: fs.Stats;
        try {
          fileStat = fs.statSync(entryPath);
        } catch {
          continue;
        }
        if (nowMs - fileStat.mtimeMs > ProtocolClient.TRANSCRIPT_MAX_FILE_AGE_MS) {
          reasonCodes.add('transcript_discovery_age_budget_skipped');
          continue;
        }
        if (remainingProbeBytes <= 0) {
          reasonCodes.add('transcript_probe_byte_budget_exhausted');
          continue;
        }
        const probe = this.transcriptContentMayMatchContext(entryPath, context, {
          remainingBytes: remainingProbeBytes,
          deadlineAtMs
        });
        remainingProbeBytes = probe.remainingBytes;
        if (probe.bytesRead > 0) {
          filesParsed += 1;
        }
        for (const reason of probe.reasonCodes) {
          reasonCodes.add(reason);
        }
        if (probe.matched) {
          candidates.push(entryPath);
          foundFallbackContentMatch = true;
          if (candidates.length >= ProtocolClient.TRANSCRIPT_MAX_CANDIDATE_FILES) {
            reasonCodes.add('transcript_candidate_file_budget_exhausted');
          }
          break;
        }
      }
      for (const nextDirectory of nextDirectories.reverse()) {
        stack.push(nextDirectory);
      }
    }

    if (candidates.length >= ProtocolClient.TRANSCRIPT_MAX_CANDIDATE_FILES) {
      reasonCodes.add('transcript_candidate_file_budget_exhausted');
    }
    if (filesConsidered >= ProtocolClient.TRANSCRIPT_MAX_DISCOVERY_FILES) {
      reasonCodes.add('transcript_discovery_file_count_budget_exhausted');
    }

    const exhausted = reasonCodes.size > 0;
    return this.cacheTranscriptLookup(identityKey, nowMs, candidates, {
      source: exhausted ? 'budget_exhausted' : candidates.length > 0 ? 'fallback' : 'missing',
      candidateCount: candidates.length,
      filesConsidered,
      filesParsed,
      bytesRead: ProtocolClient.TRANSCRIPT_MAX_PROBE_BYTES - remainingProbeBytes,
      exhausted,
      reasonCodes: [...reasonCodes].sort()
    });
  }

  private cacheTranscriptLookup(
    identityKey: string,
    refreshedAtMs: number,
    paths: string[],
    stats: TranscriptCandidateLookupStats
  ): TranscriptCandidateLookupResult {
    this.transcriptCandidateCache = {
      identityKey,
      refreshedAtMs,
      paths: [...paths],
      stats: { ...stats, reasonCodes: [...stats.reasonCodes] }
    };
    return {
      paths: [...paths],
      stats,
      refreshedAtMs,
      expiresAtMs: refreshedAtMs + ProtocolClient.TRANSCRIPT_CANDIDATE_CACHE_TTL_MS
    };
  }

  private isTranscriptCandidateCacheFresh(): boolean {
    if (!this.transcriptCandidateCache || this.transcriptCandidateCache.paths.length > 0) {
      return true;
    }
    const cachedSource =
      this.transcriptCandidateCache.stats.source === 'cache'
        ? this.transcriptCandidateCache.stats.cachedSource
        : this.transcriptCandidateCache.stats.source;
    if (cachedSource !== 'missing') {
      return true;
    }
    const sessionsRoot = path.join(this.codexHome, 'sessions');
    try {
      const stat = fs.statSync(sessionsRoot);
      return stat.mtimeMs <= this.transcriptCandidateCache.refreshedAtMs;
    } catch {
      return true;
    }
  }

  private emitTranscriptLookupDiagnostic(
    lookup: TranscriptCandidateLookupResult,
    context: TurnEventContext,
    emit: (event: Omit<CodexRunnerEvent, 'timestamp' | 'codex_app_server_pid'>) => void
  ): void {
    const metadata = serializeTranscriptLookupMetadata(lookup);
    const diagnosticKey = [
      context.session_id,
      metadata.source,
      metadata.cached_source ?? '',
      metadata.candidate_count,
      metadata.files_considered,
      metadata.files_parsed,
      metadata.bytes_read,
      metadata.exhausted,
      metadata.reason_codes.join(',')
    ].join('|');
    if (diagnosticKey === this.lastTranscriptLookupDiagnosticKey) {
      return;
    }
    this.lastTranscriptLookupDiagnosticKey = diagnosticKey;
    emit({
      event: CANONICAL_EVENT.codex.transcriptLookup,
      thread_id: context.thread_id,
      turn_id: context.turn_id,
      session_id: context.session_id,
      detail: `transcript_lookup source=${metadata.source} candidates=${metadata.candidate_count} files_considered=${metadata.files_considered} exhausted=${metadata.exhausted} reasons=${metadata.reason_codes.join(',') || 'none'}`,
      transcript_lookup_source: metadata.source,
      ...(metadata.cached_source ? { transcript_lookup_cached_source: metadata.cached_source } : {}),
      transcript_lookup_candidate_count: metadata.candidate_count,
      transcript_lookup_files_considered: metadata.files_considered,
      transcript_lookup_files_parsed: metadata.files_parsed,
      transcript_lookup_bytes_read: metadata.bytes_read,
      transcript_lookup_exhausted: metadata.exhausted,
      transcript_lookup_reason_codes: metadata.reason_codes,
      transcript_lookup_cache_refreshed_at_ms: metadata.cache_refreshed_at_ms,
      transcript_lookup_cache_expires_at_ms: metadata.cache_expires_at_ms
    });
  }

  private transcriptCandidateIdentityKey(context: TurnEventContext): string {
    return [context.session_id, context.thread_id, context.turn_id].join('|');
  }

  private transcriptPathMayMatch(transcriptPath: string, context: TurnEventContext): boolean {
    const normalized = transcriptPath.toLowerCase();
    return [context.session_id, context.thread_id, context.turn_id].some((identifier) =>
      normalized.includes(identifier.toLowerCase())
    );
  }

  private sortTranscriptDiscoveryEntries(entries: fs.Dirent[], activeStartedAtMs?: number): fs.Dirent[] {
    return [...entries].sort((left, right) => {
      const leftTranscript = left.isFile() && left.name.endsWith('.jsonl');
      const rightTranscript = right.isFile() && right.name.endsWith('.jsonl');
      if (leftTranscript !== rightTranscript) {
        return leftTranscript ? -1 : 1;
      }
      if (leftTranscript && rightTranscript) {
        const leftTimestampMs = parseCodexRolloutTimestampMs(left.name);
        const rightTimestampMs = parseCodexRolloutTimestampMs(right.name);
        if (activeStartedAtMs !== undefined && (leftTimestampMs !== null || rightTimestampMs !== null)) {
          if (leftTimestampMs === null) {
            return 1;
          }
          if (rightTimestampMs === null) {
            return -1;
          }
          const proximity = Math.abs(leftTimestampMs - activeStartedAtMs) - Math.abs(rightTimestampMs - activeStartedAtMs);
          if (proximity !== 0) {
            return proximity;
          }
          return rightTimestampMs - leftTimestampMs;
        }
        return right.name.localeCompare(left.name);
      }
      const leftDirectory = left.isDirectory();
      const rightDirectory = right.isDirectory();
      if (leftDirectory !== rightDirectory) {
        return leftDirectory ? -1 : 1;
      }
      return right.name.localeCompare(left.name);
    });
  }

  private transcriptContentMayMatchContext(
    transcriptPath: string,
    context: TurnEventContext,
    budget: { remainingBytes: number; deadlineAtMs: number }
  ): { matched: boolean; bytesRead: number; remainingBytes: number; reasonCodes: string[] } {
    const reasonCodes: string[] = [];
    let stat: fs.Stats;
    try {
      stat = fs.statSync(transcriptPath);
    } catch {
      return { matched: false, bytesRead: 0, remainingBytes: budget.remainingBytes, reasonCodes };
    }
    const bytesToRead = Math.min(stat.size, budget.remainingBytes);
    let content = '';
    try {
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        const buffer = Buffer.alloc(bytesToRead);
        fs.readSync(fd, buffer, 0, buffer.length, 0);
        content = buffer.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return { matched: false, bytesRead: 0, remainingBytes: budget.remainingBytes, reasonCodes };
    }
    if (bytesToRead < stat.size) {
      reasonCodes.push('transcript_probe_file_byte_budget_exhausted');
    }
    for (const line of content.split(/\r?\n/)) {
      if (Date.now() > budget.deadlineAtMs) {
        reasonCodes.push('transcript_discovery_wall_clock_budget_exhausted');
        return { matched: false, bytesRead: bytesToRead, remainingBytes: budget.remainingBytes - bytesToRead, reasonCodes };
      }
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const parsed = parseJsonRecord(trimmed);
      if (!parsed) {
        continue;
      }
      const payload = asRecord(parsed.payload);
      const item = this.readTranscriptProbeResponseItem(parsed);
      const threadId = this.readTranscriptProbeString(['thread_id', 'threadId'], parsed, payload, item);
      const turnId = this.readTranscriptProbeString(['turn_id', 'turnId'], parsed, payload, item);
      const sessionId = this.readTranscriptProbeString(['session_id', 'sessionId'], parsed, payload, item);
      if (threadId === context.thread_id || turnId === context.turn_id || sessionId === context.session_id) {
        return { matched: true, bytesRead: bytesToRead, remainingBytes: budget.remainingBytes - bytesToRead, reasonCodes };
      }
    }
    return { matched: false, bytesRead: bytesToRead, remainingBytes: budget.remainingBytes - bytesToRead, reasonCodes };
  }

  private readTranscriptProbeResponseItem(record: Record<string, unknown>): Record<string, unknown> | null {
    const payload = asRecord(record.payload);
    if (payload?.type === 'response_item') {
      return asRecord(payload.item);
    }
    if (record.type === 'response_item') {
      return payload;
    }
    return null;
  }

  private readTranscriptProbeString(
    keys: string[],
    ...records: Array<Record<string, unknown> | null | undefined>
  ): string | undefined {
    for (const record of records) {
      if (!record) {
        continue;
      }
      for (const key of keys) {
        const value = readString(record[key]);
        if (value) {
          return value;
        }
      }
    }
    return undefined;
  }

  private observeTranscriptUsage(payload: Record<string, unknown>): void {
    const payloadType = readString(payload.type);
    if (payloadType !== 'token_count') {
      return;
    }
    const message: ProtocolMessage = {
      method: 'token/count',
      params: payload
    };
    this.usageTracker.observe(message);
    const rateLimits = this.extractRateLimits(message);
    if (rateLimits) {
      this.latestRateLimits = rateLimits;
    }
  }

  private readTranscriptTerminalEvidence(
    record: Record<string, unknown>,
    transcriptPath: string,
    context: TurnEventContext,
    emit: (event: Omit<CodexRunnerEvent, 'timestamp' | 'codex_app_server_pid'>) => void
  ): TranscriptTerminalEvidence | null {
    const payload = asRecord(record.payload) ?? record;
    const payloadType = readString(payload.type);
    const terminal = this.mapTranscriptTerminalType(payloadType);
    if (!terminal) {
      return null;
    }

    const lineageMismatch = this.describeTranscriptLineageMismatch(payload, transcriptPath, context);
    if (lineageMismatch) {
      emit({
        event: CANONICAL_EVENT.codex.sideOutput,
        detail: this.detailExcerpt(`session_transcript_terminal_ignored ${lineageMismatch}`),
        thread_id: context.thread_id,
        turn_id: context.turn_id,
        session_id: context.session_id,
        terminal_source: 'session_transcript'
      });
      return null;
    }

    return {
      terminal,
      last_agent_message: readString(payload.last_agent_message) ?? readString(payload.lastAgentMessage),
      completed_at_ms: normalizeEpochMs(payload.completed_at ?? payload.completedAt) ?? normalizeTimestampMs(record.timestamp),
      duration_ms: readNumber(payload.duration_ms ?? payload.durationMs),
      time_to_first_token_ms: readNumber(payload.time_to_first_token_ms ?? payload.timeToFirstTokenMs)
    };
  }

  private describeTranscriptLineageMismatch(
    payload: Record<string, unknown>,
    transcriptPath: string,
    context: TurnEventContext
  ): string | null {
    const eventThreadId = readString(payload.thread_id) ?? readString(payload.threadId);
    const eventTurnId = readString(payload.turn_id) ?? readString(payload.turnId);
    const eventSessionId = readString(payload.session_id) ?? readString(payload.sessionId);
    const pathContainsThread = transcriptPath.includes(context.thread_id);

    if (eventTurnId !== context.turn_id) {
      return `reason=turn_mismatch active_turn_id=${context.turn_id} event_turn_id=${eventTurnId ?? 'missing'}`;
    }
    if (eventThreadId && eventThreadId !== context.thread_id) {
      return `reason=thread_mismatch active_thread_id=${context.thread_id} event_thread_id=${eventThreadId}`;
    }
    if (!eventThreadId && !pathContainsThread) {
      return `reason=thread_unattributed active_thread_id=${context.thread_id}`;
    }
    if (eventSessionId && eventSessionId !== context.session_id) {
      return `reason=session_mismatch active_session_id=${context.session_id} event_session_id=${eventSessionId}`;
    }
    return null;
  }

  private mapTranscriptTerminalType(
    type: string | undefined
  ): 'turn/completed' | 'turn/failed' | 'turn/cancelled' | 'turn/input_required' | null {
    if (type === 'task_complete') {
      return 'turn/completed';
    }
    if (type === 'task_failed' || type === 'turn_failed' || type === 'turn/failed') {
      return 'turn/failed';
    }
    if (type === 'task_cancelled' || type === 'turn_cancelled' || type === 'turn/cancelled') {
      return 'turn/cancelled';
    }
    if (type === 'task_input_required' || type === REASON_CODES.turnInputRequired || type === 'turn/input_required') {
      return 'turn/input_required';
    }
    return null;
  }

  private write(payload: ProtocolMessage): void {
    this.processHandle.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  sendRequestResponse(id: number, result: Record<string, unknown>): void {
    this.write({ id, result });
  }

  private detailExcerpt(value: string, maxLength = 180): string {
    if (value.length <= maxLength) {
      return value;
    }

    return `${value.slice(0, maxLength)}...`;
  }

  private emitCodexEvent(event: string, detail: string): void {
    this.emitEvent?.({
      event,
      detail: this.detailExcerpt(detail),
      ...(this.activeTurnContext ? this.activeTurnContext : {})
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;

    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) {
        break;
      }

      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) {
        continue;
      }

      let parsed: ProtocolMessage;
      try {
        parsed = JSON.parse(line) as ProtocolMessage;
      } catch {
        this.emitCodexEvent(CANONICAL_EVENT.codex.protocolMalformedLine, line);
        continue;
      }

      if (isProtocolResponse(parsed) && typeof parsed.id === 'number') {
        const pending = this.pending.get(parsed.id);
        if (!pending) {
          this.earlyResponses.set(parsed.id, parsed);
          continue;
        }

        this.pending.delete(parsed.id);
        if (parsed.error) {
          pending.reject(
            new CodexRunnerError(
              'response_error',
              `Protocol error response for id ${parsed.id}${describeProtocolError(parsed.error)}`
            )
          );
        } else {
          pending.resolve(asRecord(parsed.result) ?? {});
        }
        continue;
      }

      this.notifications.push(parsed);
      this.messageEmitter.emit('message');
    }
  }

  private onStderr(chunk: string): void {
    this.stderrBuffer += chunk;

    while (true) {
      const newline = this.stderrBuffer.indexOf('\n');
      if (newline < 0) {
        break;
      }

      const line = this.stderrBuffer.slice(0, newline).trim();
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      this.stderrLines.push(line);
      this.emitCodexEvent(CANONICAL_EVENT.codex.sideOutput, line);
    }
  }

  private extractRateLimits(message: ProtocolMessage): Record<string, unknown> | null {
    const method = (message.method ?? '').toLowerCase();
    const params = asRecord(message.params);
    if (!params) {
      return null;
    }

    const direct = asRecord(params.rate_limits) ?? asRecord(params.rateLimits);
    if (direct) {
      return direct;
    }

    const account = asRecord(params.account);
    const accountRateLimits = asRecord(account?.rate_limits) ?? asRecord(account?.rateLimits);
    if (accountRateLimits) {
      return accountRateLimits;
    }

    const data = asRecord(params.data);
    const dataRateLimits = asRecord(data?.rate_limits) ?? asRecord(data?.rateLimits);
    if (dataRateLimits) {
      return dataRateLimits;
    }

    const limits = asRecord(params.limits) ?? asRecord(params.rate_limit) ?? asRecord(params.rateLimit);
    if (limits) {
      return limits;
    }

    const nestedUsage = asRecord(params.usage);
    const usageRateLimits = asRecord(nestedUsage?.rate_limits) ?? asRecord(nestedUsage?.rateLimits);
    if (usageRateLimits) {
      return usageRateLimits;
    }

    const hasKnownContainer =
      'rate_limits' in params ||
      'rateLimits' in params ||
      'rate_limit' in params ||
      'rateLimit' in params ||
      'limits' in params ||
      'account' in params ||
      'data' in params ||
      'usage' in params;
    if (method === 'account/ratelimits/updated' && !hasKnownContainer && Object.keys(params).length > 0) {
      return params;
    }

    return null;
  }

  private approvalResponse(message: ProtocolMessage): { result: Record<string, string>; detail: string } | null {
    if (typeof message.id !== 'number') {
      return null;
    }

    const method = (message.method ?? '').toLowerCase();
    if (method === 'item/commandexecution/requestapproval') {
      return { result: { decision: 'acceptForSession' }, detail: 'acceptForSession' };
    }
    if (method === 'item/filechange/requestapproval') {
      return { result: { decision: 'acceptForSession' }, detail: 'acceptForSession' };
    }
    if (method === 'execcommandapproval') {
      return { result: { decision: 'approved_for_session' }, detail: 'approved_for_session' };
    }
    if (method === 'applypatchapproval') {
      return { result: { decision: 'approved_for_session' }, detail: 'approved_for_session' };
    }
    return null;
  }

  private isApprovalLikeServerRequest(message: ProtocolMessage): boolean {
    if (typeof message.id !== 'number') {
      return false;
    }

    const method = (message.method ?? '').toLowerCase();
    return method.includes('approval') && (method.includes('request') || method.includes('required'));
  }

  private unsupportedServerRequestClassification(message: ProtocolMessage): UnsupportedServerRequestClassification {
    const method = (message.method ?? '').toLowerCase();
    const safetySensitiveTerminal = true;

    if (method.includes('permission') && (method.includes('approval') || method.includes('request') || method.includes('required'))) {
      return {
        category: 'permission',
        reason_code: REASON_CODES.unsupportedPermissionServerRequest,
        terminal: safetySensitiveTerminal
      };
    }

    if (method.startsWith('account/') || method.includes('token')) {
      return {
        category: 'account',
        reason_code: REASON_CODES.unsupportedAccountServerRequest,
        terminal: safetySensitiveTerminal
      };
    }

    if (method.includes('auth') || method.includes('oauth') || method.includes('login')) {
      return {
        category: 'authentication',
        reason_code: REASON_CODES.unsupportedAuthenticationServerRequest,
        terminal: safetySensitiveTerminal
      };
    }

    if (method.includes('credential') || method.includes('secret') || method.includes('session')) {
      return {
        category: 'safety_sensitive',
        reason_code: REASON_CODES.unsupportedSafetySensitiveServerRequest,
        terminal: safetySensitiveTerminal
      };
    }

    if (this.isApprovalLikeServerRequest(message)) {
      return {
        category: 'approval',
        reason_code: REASON_CODES.unsupportedApprovalServerRequest,
        terminal: false
      };
    }

    return {
      category: 'unsupported',
      reason_code: REASON_CODES.unsupportedServerRequest,
      terminal: false
    };
  }

  private isToolCallRequest(message: ProtocolMessage): boolean {
    if (typeof message.id !== 'number') {
      return false;
    }

    const method = (message.method ?? '').toLowerCase();
    return method.includes('tool') && method.includes('call');
  }

  private emitFunctionCallLedgerEvent(
    message: ProtocolMessage,
    emit: (event: Omit<CodexRunnerEvent, 'timestamp' | 'codex_app_server_pid'>) => void
  ): boolean {
    const method = (message.method ?? '').toLowerCase();
    const observesResponseItem =
      method === 'item/started' ||
      method === 'item/completed' ||
      method === 'rawresponseitem/completed' ||
      method === 'raw_response_item/completed' ||
      method === 'responseitem/completed' ||
      method === 'response_item/completed' ||
      method === 'rawresponseitem.completed' ||
      method === 'responseitem.completed';
    if (!observesResponseItem) {
      return false;
    }

    const item = readResponseItem(message);
    const itemType = readString(item?.type);
    const callId = readOptionalToolCallId(item);
    if (!itemType || !callId) {
      return false;
    }

    if (itemType === 'function_call') {
      const toolName = readString(item?.name) ?? readString(item?.tool_name) ?? readString(item?.toolName) ?? 'unknown_tool';
      emit({
        event: CANONICAL_EVENT.codex.toolCallStarted,
        detail: toolName,
        tool_call_id: callId,
        tool_name: toolName,
        tool_call_evidence_source: 'app_server_protocol',
        ...(this.activeTurnContext ? this.activeTurnContext : {})
      });
      return true;
    }

    if (itemType === 'function_call_output') {
      emit({
        event: CANONICAL_EVENT.codex.toolCallCompleted,
        detail: 'function_call_output',
        tool_call_id: callId,
        tool_call_evidence_source: 'app_server_protocol',
        ...(this.activeTurnContext ? this.activeTurnContext : {})
      });
      return true;
    }

    return false;
  }

  private protocolEvidenceSnapshot(): Pick<
    WaitForTerminalResult,
    'protocol_warnings' | 'model_reroute' | 'requested_model' | 'effective_model'
  > {
    return {
      protocol_warnings: [...this.protocolWarnings],
      model_reroute: this.latestModelReroute,
      requested_model: this.latestModelReroute?.requested_model ?? this.requestedModel,
      effective_model: this.latestModelReroute?.effective_model ?? this.requestedModel
    };
  }

  private observeProtocolSignals(
    message: ProtocolMessage,
    emit: (event: Omit<CodexRunnerEvent, 'timestamp' | 'codex_app_server_pid'>) => void
  ): void {
    const warning = this.extractProtocolWarning(message);
    if (warning) {
      this.protocolWarnings.push(warning);
      emit({
        event: CANONICAL_EVENT.codex.protocolWarning,
        detail: warning.message ?? warning.reason_code,
        protocol_warning: warning,
        protocol_warnings: [...this.protocolWarnings],
        ...(this.activeTurnContext ? this.activeTurnContext : {})
      });
    }

    const modelReroute = this.extractModelReroute(message);
    if (modelReroute) {
      this.latestModelReroute = modelReroute;
      emit({
        event: CANONICAL_EVENT.codex.modelRerouted,
        detail: modelReroute.reason_code,
        model_reroute: modelReroute,
        requested_model: modelReroute.requested_model,
        effective_model: modelReroute.effective_model,
        ...(this.activeTurnContext ? this.activeTurnContext : {})
      });
    }
  }

  private extractProtocolWarning(message: ProtocolMessage): CodexProtocolWarningEvidence | null {
    const method = message.method ?? '';
    const normalized = method.toLowerCase();
    const reasonCode =
      normalized === 'warning'
        ? REASON_CODES.codexProtocolWarning
        : normalized === 'guardianwarning'
          ? REASON_CODES.codexProtocolGuardianWarning
          : normalized === 'deprecationnotice'
            ? REASON_CODES.codexProtocolDeprecationNotice
            : normalized === 'configwarning'
              ? REASON_CODES.codexProtocolConfigWarning
              : null;
    if (!reasonCode) {
      return null;
    }

    const params = asRecord(message.params);
    const messageText =
      readString(params?.message) ??
      readString(params?.detail) ??
      readString(params?.text) ??
      readString(params?.title) ??
      null;
    const severity = readString(params?.severity)?.toLowerCase() === 'info' ? 'info' : 'warn';
    return {
      method,
      reason_code: reasonCode,
      message: messageText,
      severity,
      source: 'app_server_protocol'
    };
  }

  private extractModelReroute(message: ProtocolMessage): CodexModelRerouteEvidence | null {
    if ((message.method ?? '').toLowerCase() !== 'model/rerouted') {
      return null;
    }

    const params = asRecord(message.params);
    if (!params) {
      return null;
    }

    const requested_model =
      readFirstModelValue(params, ['requested_model', 'requestedModel', 'from_model', 'fromModel', 'source_model', 'sourceModel']) ??
      this.requestedModel;
    const effective_model = readFirstModelValue(params, [
      'effective_model',
      'effectiveModel',
      'to_model',
      'toModel',
      'target_model',
      'targetModel',
      'rerouted_model',
      'reroutedModel',
      'model'
    ]);
    if (!effective_model) {
      return null;
    }

    return {
      requested_model,
      effective_model,
      reason_code: REASON_CODES.codexModelRerouted,
      source: 'app_server_protocol'
    };
  }

  private isMcpElicitationRequest(message: ProtocolMessage): boolean {
    if (typeof message.id !== 'number') {
      return false;
    }

    return (message.method ?? '').toLowerCase() === 'mcpserver/elicitation/request';
  }

  private isToolRequestUserInput(message: ProtocolMessage): boolean {
    if (typeof message.id !== 'number') {
      return false;
    }

    const method = (message.method ?? '').toLowerCase();
    return method === 'item/tool/requestuserinput';
  }

  private isUnhandledServerRequest(message: ProtocolMessage): boolean {
    return typeof message.id === 'number' && typeof message.method === 'string';
  }

  private readTerminal(
    message: ProtocolMessage
  ): 'turn/completed' | 'turn/failed' | 'turn/cancelled' | 'turn/input_required' | null {
    const method = message.method ?? '';
    const normalizedMethod = method.toLowerCase();

    if (method === 'turn/completed' || normalizedMethod === 'turn.completed') {
      return 'turn/completed';
    }

    if (method === 'turn/failed' || normalizedMethod === 'turn.failed') {
      return 'turn/failed';
    }

    if (method === 'turn/cancelled' || normalizedMethod === 'turn.cancelled') {
      return 'turn/cancelled';
    }

    if (
      (normalizedMethod.includes('input') && normalizedMethod.includes('required')) ||
      normalizedMethod.includes('requestuserinput') ||
      normalizedMethod.includes('elicitation/request')
    ) {
      return 'turn/input_required';
    }

    const params = asRecord(message.params);
    if (!params) {
      return null;
    }

    const inputRequired = params.input_required ?? params.inputRequired;
    if (inputRequired === true) {
      return 'turn/input_required';
    }

    return null;
  }
}

export { CONTINUATION_GUIDANCE };
function toInputRequestPayload(message: ProtocolMessage): CodexInputRequestPayload | null {
  const params = asRecord(message.params);
  if (!params || typeof message.id !== 'number') {
    return null;
  }
  const questionsRaw = Array.isArray(params.questions) ? params.questions : [];
  const questions = questionsRaw
    .map((question) => {
      const q = asRecord(question);
      const id = readString(q?.id);
      if (!id) {
        return null;
      }
      const optionsRaw = Array.isArray(q?.options) ? q.options : [];
      const options = optionsRaw
        .map((option) => {
          const o = asRecord(option);
          const label = readString(o?.label);
          if (!label) {
            return null;
          }
          const value = readString(o?.value);
          return value ? { label, value } : { label };
        })
        .filter((option): option is { label: string; value?: string } => option !== null);
      return {
        id,
        ...(readString(q?.question) ? { prompt: readString(q?.question) } : {}),
        ...(options.length > 0 ? { options } : {})
      };
    })
    .filter((question): question is { id: string; prompt?: string; options?: Array<{ label: string; value?: string }> } => question !== null);

  const promptText = readString(params.prompt) ?? readString(params.message) ?? null;
  const flattenedOptions = questions.flatMap((question) => (question.options ?? []).map((option) => option.label));
  const inputSchemaType = flattenedOptions.length > 0 ? 'options' : promptText || questions.length > 0 ? 'text' : 'unknown';

  return {
    request_id: String(message.id),
    request_method: readString(message.method) ?? 'unknown',
    prompt_text: promptText,
    questions,
    options: flattenedOptions,
    input_schema_type: inputSchemaType,
    input_required_at: new Date().toISOString()
  };
}
