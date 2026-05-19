import { EventEmitter } from 'node:events';

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

import { asRecord, isProtocolResponse, readString, type ProtocolMessage } from './common';
import {
  approvalResponse,
  buildNonInteractiveInputAnswers,
  isMcpElicitationRequest,
  isToolRequestUserInput,
  isUnhandledServerRequest,
  readOptionalToolCallId,
  readResponseItem,
  readToolCallId,
  toInputRequestPayload,
  unsupportedServerRequestClassification
} from './input-requests';
import type { RunnerProcess } from './process-lifecycle';
import { TranscriptLookup, serializeTranscriptLookupMetadata, type TurnEventContext } from './transcript-lookup';
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
  private readonly pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly earlyResponses = new Map<number, ProtocolMessage>();
  private readonly notifications: ProtocolMessage[] = [];
  private readonly messageEmitter = new EventEmitter();
  private readonly usageTracker = new UsageTracker();
  private readonly transcriptLookup: TranscriptLookup;
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

  constructor(processHandle: RunnerProcess, dynamicToolExecutor: DynamicToolExecutor, codexHome: string, requestedModel: string | null) {
    this.processHandle = processHandle;
    this.dynamicToolExecutor = dynamicToolExecutor;
    this.codexHome = codexHome;
    this.requestedModel = requestedModel;
    this.transcriptLookup = new TranscriptLookup(codexHome);

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
    const params: CodexAppServerThreadReadParamsV2 = {
      threadId,
      includeTurns: false
    };
    try {
      const response = (await this.request('thread/read', params, timeoutMs, {
        unrefTimer: true
      })) as CodexAppServerThreadReadResponseV2;
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

        const approvalResponseResult = approvalResponse(message);
        if (approvalResponseResult) {
          this.write({ id: message.id, result: approvalResponseResult.result });
          emit({
            event: CANONICAL_EVENT.codex.approvalAutoApproved,
            detail: approvalResponseResult.detail
          });
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
            emit({
              event: CANONICAL_EVENT.codex.phaseImplementation,
              detail: toolName ?? 'unknown_tool'
            });
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

        if (isToolRequestUserInput(message)) {
          const params = asRecord(message.params);
          const response = params ? buildNonInteractiveInputAnswers(params) : null;
          if (response) {
            this.write({
              id: message.id,
              result: { answers: response.answers }
            });
            emit({
              event: CANONICAL_EVENT.codex.toolInputAutoAnswered,
              detail: response.mode
            });
            continue;
          }

          emit({
            event: CANONICAL_EVENT.codex.turnInputRequired,
            detail: 'tool requestUserInput input_required_unanswerable'
          });
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

        if (isMcpElicitationRequest(message)) {
          const params = asRecord(message.params);
          const response = params ? buildNonInteractiveInputAnswers(params) : null;
          if (response) {
            this.write({
              id: message.id,
              result: { answers: response.answers }
            });
            emit({
              event: CANONICAL_EVENT.codex.toolInputAutoAnswered,
              detail: response.mode
            });
            continue;
          }

          emit({
            event: CANONICAL_EVENT.codex.turnInputRequired,
            detail: 'mcp elicitation request input_required_unanswerable'
          });
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

        if (isUnhandledServerRequest(message)) {
          const method = message.method ?? 'unknown';
          const classification = unsupportedServerRequestClassification(message);
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

      const context = this.activeTurnContext;
      const transcriptScanResult = context
        ? this.transcriptLookup.consumeTerminalEvidence(context, emit, (payload, observedAtMs) =>
            this.observeTranscriptUsage(payload, context, emit, observedAtMs)
          )
        : { terminal: null, observedProgress: false, lookup: null };
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
            ? {
                transcript_lookup: serializeTranscriptLookupMetadata(transcriptScanResult.lookup)
              }
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
          reject(
            new CodexRunnerError(
              REASON_CODES.turnTimeout,
              `Timed out waiting for turn terminal event at hard wall-clock deadline: ${detail}`
            )
          );
        }, delayMs);
      };

      markProgress = () => {
        lastProgressAtMs = Date.now();
      };

      const heartbeat = setInterval(() => {
        const elapsedSeconds = Math.floor((Date.now() - waitStartedAtMs) / 1000);
        emit({
          event: CANONICAL_EVENT.codex.phasePlanning,
          detail: `waiting_for_turn_completion elapsed_s=${elapsedSeconds}`
        });
        emit({
          event: CANONICAL_EVENT.codex.turnWaiting,
          detail: `waiting_for_turn_completion elapsed_s=${elapsedSeconds}`
        });
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
            new CodexRunnerError('response_error', `Protocol error response for id ${parsed.id}${describeProtocolError(parsed.error)}`)
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
      readString(params?.message) ?? readString(params?.detail) ?? readString(params?.text) ?? readString(params?.title) ?? null;
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

  private readTerminal(message: ProtocolMessage): 'turn/completed' | 'turn/failed' | 'turn/cancelled' | 'turn/input_required' | null {
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
