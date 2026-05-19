import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { CANONICAL_EVENT } from '../../observability/events';
import { REASON_CODES } from '../../observability/reason-codes';
import {
  createDynamicToolCapabilityMismatchDetail,
  extractUnsupportedDynamicToolConsoleMessage,
  serializeDynamicToolCapabilityMismatchDetail
} from '../../observability/dynamic-tool-capability';
import {
  extractCodexAppServerThreadActivity,
  type CodexAppServerThreadReadParamsV2,
  type CodexAppServerThreadReadResponseV2
} from '../app-server-protocol';
import type { DynamicToolExecutor } from '../dynamic-tools';
import { CodexRunnerError } from '../errors';
import type {
  CodexInputRequestPayload,
  CodexRunnerEvent,
  CodexTranscriptLookupMetadata,
  CodexModelRerouteEvidence,
  CodexProtocolWarningEvidence,
  CodexUsageTotals,
  TokenTelemetrySnapshot
} from '../types';

import {
  asRecord,
  isProtocolResponse,
  normalizeEpochMs,
  normalizeTimestampMs,
  parseJsonRecord,
  readNumber,
  readString,
  type ProtocolMessage
} from './common';
import {
  buildNonInteractiveInputAnswers,
  readOptionalToolCallId,
  readResponseItem,
  readToolCallId,
  toInputRequestPayload
} from './input-requests';
import type { RunnerProcess } from './process-lifecycle';
import { UsageTracker, usageSnapshotSignature } from './usage-tracker';

export interface WaitForTerminalResult {
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
  scannedDirectoryMtimes?: Array<{ directory: string; mtimeMs: number }>;
}

interface TranscriptCandidateLookupStats {
  source: 'indexed' | 'filename' | 'fallback' | 'cache' | 'missing' | 'budget_exhausted';
  cachedSource?: 'indexed' | 'filename' | 'fallback' | 'missing' | 'budget_exhausted';
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

function parseCodexSessionsDirectoryRangeMs(
  directoryPath: string,
  sessionsRoot: string
): { startMs: number; endMs: number } | null {
  const relativePath = path.relative(sessionsRoot, directoryPath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }
  const [yearText, monthText, dayText] = relativePath.split(path.sep);
  if (!/^\d{4}$/.test(yearText ?? '')) {
    return null;
  }
  const year = Number(yearText);
  if (monthText === undefined) {
    return { startMs: Date.UTC(year, 0, 1), endMs: Date.UTC(year + 1, 0, 1) };
  }
  if (!/^\d{2}$/.test(monthText)) {
    return null;
  }
  const monthIndex = Number(monthText) - 1;
  if (monthIndex < 0 || monthIndex > 11) {
    return null;
  }
  if (dayText === undefined) {
    return { startMs: Date.UTC(year, monthIndex, 1), endMs: Date.UTC(year, monthIndex + 1, 1) };
  }
  if (!/^\d{2}$/.test(dayText)) {
    return null;
  }
  const day = Number(dayText);
  const startMs = Date.UTC(year, monthIndex, day);
  const startDate = new Date(startMs);
  if (
    startDate.getUTCFullYear() !== year ||
    startDate.getUTCMonth() !== monthIndex ||
    startDate.getUTCDate() !== day
  ) {
    return null;
  }
  return { startMs, endMs: Date.UTC(year, monthIndex, day + 1) };
}

function distanceToTimeRangeMs(activeStartedAtMs: number, range: { startMs: number; endMs: number }): number {
  if (activeStartedAtMs < range.startMs) {
    return range.startMs - activeStartedAtMs;
  }
  if (activeStartedAtMs >= range.endMs) {
    return activeStartedAtMs - range.endMs;
  }
  return 0;
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

export class ProtocolClient {
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
  private lastEmittedTranscriptUsageSignature: string | null = null;

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
  private static readonly TRANSCRIPT_MAX_FILENAME_DISCOVERY_FILES = 1000;
  private static readonly TRANSCRIPT_MAX_DISCOVERY_FILES = 20;
  private static readonly TRANSCRIPT_MAX_PROBE_BYTES = 256 * 1024;
  private static readonly TRANSCRIPT_MAX_FILE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  private static readonly TRANSCRIPT_MAX_WALL_CLOCK_MS = 50;
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
        this.observeTranscriptUsage(payload, context, emit, normalizeTimestampMs(record.timestamp) ?? Date.now());
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

    const filenameLookup = this.findFilenameMatchedTranscriptPaths(sessionsRoot, context, nowMs);
    if (filenameLookup.paths.length > 0) {
      return this.cacheTranscriptLookup(
        identityKey,
        nowMs,
        filenameLookup.paths,
        filenameLookup.stats,
        filenameLookup.scannedDirectoryMtimes
      );
    }

    const candidates: string[] = [];
    const deadlineAtMs = Date.now() + ProtocolClient.TRANSCRIPT_MAX_WALL_CLOCK_MS;
    const reasonCodes = new Set<string>();
    let filesConsidered = 0;
    let filesParsed = 0;
    let remainingProbeBytes = ProtocolClient.TRANSCRIPT_MAX_PROBE_BYTES;
    let foundFallbackContentMatch = false;
    const stack: Array<{ directory: string; depth: number }> = [{ directory: sessionsRoot, depth: 0 }];
    const scannedDirectoryMtimes = new Map<string, number>();

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
      try {
        const directoryStat = fs.statSync(current.directory);
        if (directoryStat.isDirectory()) {
          scannedDirectoryMtimes.set(current.directory, directoryStat.mtimeMs);
        }
      } catch {
        continue;
      }
      let entries: fs.Dirent[];
      try {
        entries = this.sortTranscriptDiscoveryEntries(
          fs.readdirSync(current.directory, { withFileTypes: true }),
          context.turn_started_at_ms,
          current.directory,
          sessionsRoot
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
    return this.cacheTranscriptLookup(
      identityKey,
      nowMs,
      candidates,
      {
        source: exhausted ? 'budget_exhausted' : candidates.length > 0 ? 'fallback' : 'missing',
        candidateCount: candidates.length,
        filesConsidered,
        filesParsed,
        bytesRead: ProtocolClient.TRANSCRIPT_MAX_PROBE_BYTES - remainingProbeBytes,
        exhausted,
        reasonCodes: [...reasonCodes].sort()
      },
      [...scannedDirectoryMtimes.entries()].map(([directory, mtimeMs]) => ({ directory, mtimeMs }))
    );
  }

  private cacheTranscriptLookup(
    identityKey: string,
    refreshedAtMs: number,
    paths: string[],
    stats: TranscriptCandidateLookupStats,
    scannedDirectoryMtimes?: Array<{ directory: string; mtimeMs: number }>
  ): TranscriptCandidateLookupResult {
    this.transcriptCandidateCache = {
      identityKey,
      refreshedAtMs,
      paths: [...paths],
      stats: { ...stats, reasonCodes: [...stats.reasonCodes] },
      scannedDirectoryMtimes
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
    if (cachedSource === 'budget_exhausted') {
      return this.areTranscriptScannedDirectoriesFresh();
    }
    if (cachedSource !== 'missing') {
      return true;
    }
    if (this.transcriptCandidateCache.scannedDirectoryMtimes?.length) {
      return this.areTranscriptScannedDirectoriesFresh();
    }
    if (!this.transcriptCandidateCache.stats.reasonCodes.includes('transcript_sessions_root_missing')) {
      return false;
    }
    const sessionsRoot = path.join(this.codexHome, 'sessions');
    try {
      const stat = fs.statSync(sessionsRoot);
      return stat.mtimeMs <= this.transcriptCandidateCache.refreshedAtMs;
    } catch {
      return true;
    }
  }

  private findFilenameMatchedTranscriptPaths(
    sessionsRoot: string,
    context: TurnEventContext,
    nowMs: number
  ): {
    paths: string[];
    stats: TranscriptCandidateLookupStats;
    scannedDirectoryMtimes: Array<{ directory: string; mtimeMs: number }>;
  } {
    const paths: string[] = [];
    const reasonCodes = new Set<string>();
    const scannedDirectoryMtimes = new Map<string, number>();
    const deadlineAtMs = Date.now() + ProtocolClient.TRANSCRIPT_MAX_WALL_CLOCK_MS;
    let filesConsidered = 0;
    const stack = this.likelyTranscriptSessionDirectories(sessionsRoot, context.turn_started_at_ms)
      .map((directory) => ({ directory, depth: 0 }));

    while (
      stack.length > 0 &&
      paths.length < ProtocolClient.TRANSCRIPT_MAX_CANDIDATE_FILES &&
      filesConsidered < ProtocolClient.TRANSCRIPT_MAX_FILENAME_DISCOVERY_FILES
    ) {
      if (Date.now() > deadlineAtMs) {
        reasonCodes.add('transcript_filename_discovery_wall_clock_budget_exhausted');
        break;
      }
      const current = stack.pop();
      if (!current) {
        continue;
      }
      try {
        const directoryStat = fs.statSync(current.directory);
        if (directoryStat.isDirectory()) {
          scannedDirectoryMtimes.set(current.directory, directoryStat.mtimeMs);
        }
      } catch {
        continue;
      }

      let entries: fs.Dirent[];
      try {
        entries = this.sortTranscriptDiscoveryEntries(
          fs.readdirSync(current.directory, { withFileTypes: true }),
          context.turn_started_at_ms,
          current.directory,
          sessionsRoot
        );
      } catch {
        continue;
      }

      const nextDirectories: Array<{ directory: string; depth: number }> = [];
      for (const entry of entries) {
        if (Date.now() > deadlineAtMs) {
          reasonCodes.add('transcript_filename_discovery_wall_clock_budget_exhausted');
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
        filesConsidered += 1;
        if (this.transcriptPathMayMatch(entryPath, context)) {
          paths.push(entryPath);
          if (paths.length >= ProtocolClient.TRANSCRIPT_MAX_CANDIDATE_FILES) {
            reasonCodes.add('transcript_candidate_file_budget_exhausted');
            break;
          }
        }
        if (filesConsidered >= ProtocolClient.TRANSCRIPT_MAX_FILENAME_DISCOVERY_FILES) {
          reasonCodes.add('transcript_filename_discovery_file_count_budget_exhausted');
          break;
        }
      }
      for (const nextDirectory of nextDirectories.reverse()) {
        stack.push(nextDirectory);
      }
    }

    const exhausted = reasonCodes.size > 0;
    return {
      paths,
      stats: {
        source: 'filename',
        candidateCount: paths.length,
        filesConsidered,
        filesParsed: 0,
        bytesRead: 0,
        exhausted,
        reasonCodes: [...reasonCodes].sort()
      },
      scannedDirectoryMtimes: [...scannedDirectoryMtimes.entries()].map(([directory, mtimeMs]) => ({ directory, mtimeMs }))
    };
  }

  private likelyTranscriptSessionDirectories(sessionsRoot: string, startedAtMs: number): string[] {
    const directories = new Set<string>();
    const addDate = (date: Date, utc: boolean): void => {
      const year = utc ? date.getUTCFullYear() : date.getFullYear();
      const month = (utc ? date.getUTCMonth() : date.getMonth()) + 1;
      const day = utc ? date.getUTCDate() : date.getDate();
      directories.add(
        path.join(
          sessionsRoot,
          String(year).padStart(4, '0'),
          String(month).padStart(2, '0'),
          String(day).padStart(2, '0')
        )
      );
    };

    const dayMs = 24 * 60 * 60 * 1000;
    for (const offset of [-dayMs, 0, dayMs]) {
      const date = new Date(startedAtMs + offset);
      addDate(date, false);
      addDate(date, true);
    }
    return [...directories];
  }

  private areTranscriptScannedDirectoriesFresh(): boolean {
    if (!this.transcriptCandidateCache?.scannedDirectoryMtimes?.length) {
      return false;
    }
    for (const scannedDirectory of this.transcriptCandidateCache.scannedDirectoryMtimes) {
      try {
        const stat = fs.statSync(scannedDirectory.directory);
        if (!stat.isDirectory() || stat.mtimeMs !== scannedDirectory.mtimeMs) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
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

  private sortTranscriptDiscoveryEntries(
    entries: fs.Dirent[],
    activeStartedAtMs?: number,
    currentDirectory?: string,
    sessionsRoot?: string
  ): fs.Dirent[] {
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
      if (leftDirectory && rightDirectory && activeStartedAtMs !== undefined && currentDirectory && sessionsRoot) {
        const leftRange = parseCodexSessionsDirectoryRangeMs(path.join(currentDirectory, left.name), sessionsRoot);
        const rightRange = parseCodexSessionsDirectoryRangeMs(path.join(currentDirectory, right.name), sessionsRoot);
        if (leftRange || rightRange) {
          if (!leftRange) {
            return 1;
          }
          if (!rightRange) {
            return -1;
          }
          const proximity =
            distanceToTimeRangeMs(activeStartedAtMs, leftRange) - distanceToTimeRangeMs(activeStartedAtMs, rightRange);
          if (proximity !== 0) {
            return proximity;
          }
        }
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

  private observeTranscriptUsage(
    payload: Record<string, unknown>,
    context: TurnEventContext,
    emit: (event: Omit<CodexRunnerEvent, 'timestamp' | 'codex_app_server_pid'>) => void,
    observedAtMs: number
  ): void {
    const payloadType = readString(payload.type);
    if (payloadType !== 'token_count') {
      return;
    }
    const message: ProtocolMessage = {
      method: 'token/count',
      params: payload
    };
    this.usageTracker.observe(message, observedAtMs);
    const rateLimits = this.extractRateLimits(message);
    if (rateLimits) {
      this.latestRateLimits = rateLimits;
    }
    const usage = this.usageTracker.snapshot();
    if (usage.total_tokens <= 0) {
      return;
    }
    const signature = usageSnapshotSignature(usage);
    if (signature === this.lastEmittedTranscriptUsageSignature) {
      return;
    }
    this.lastEmittedTranscriptUsageSignature = signature;
    emit({
      event: CANONICAL_EVENT.codex.tokenUsageUpdated,
      thread_id: context.thread_id,
      turn_id: context.turn_id,
      session_id: context.session_id,
      usage,
      token_telemetry_status: 'available',
      token_telemetry_last_source: 'transcript_token_count',
      token_telemetry_last_at_ms: observedAtMs,
      ...(this.latestRateLimits ? { rate_limits: this.latestRateLimits } : {})
    });
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
