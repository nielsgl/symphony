import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { CANONICAL_EVENT } from '../observability/events';
import { CodexRunnerError } from './errors';
import { createDefaultDynamicToolExecutor, type DynamicToolExecutor, type DynamicToolSpec } from './dynamic-tools';
import type { CodexRunnerEvent, CodexRunnerStartInput, CodexTurnResult, CodexUsageTotals } from './types';

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

type SpawnProcess = (params: { command: string; cwd: string; workerHost?: string }) => RunnerProcess;

interface WaitForTerminalResult {
  terminal: 'turn/completed' | 'turn/failed' | 'turn/cancelled' | 'turn/input_required';
  usage: CodexUsageTotals;
  rate_limits: Record<string, unknown> | null;
}

const CONTINUATION_GUIDANCE = 'Continue working on the same issue thread. Provide concise progress and next actions.';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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

function parseTokenTotals(payload: Record<string, unknown> | null): CodexUsageTotals | null {
  if (!payload) {
    return null;
  }

  const input = payload.input_tokens;
  const output = payload.output_tokens;
  const total = payload.total_tokens;
  if (typeof input === 'number' && typeof output === 'number' && typeof total === 'number') {
    return {
      input_tokens: input,
      output_tokens: output,
      total_tokens: total
    };
  }

  return null;
}

class UsageTracker {
  private lastAbsolute: CodexUsageTotals | null = null;
  private aggregate: CodexUsageTotals = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0
  };

  observe(message: ProtocolMessage): void {
    const method = (message.method ?? '').toLowerCase();
    const params = asRecord(message.params);
    if (!params) {
      return;
    }

    let absolute: CodexUsageTotals | null = null;

    const totalTokenUsage = asRecord(params.total_token_usage) ?? asRecord(params.totalTokenUsage);
    absolute = parseTokenTotals(totalTokenUsage);

    if (!absolute && method.includes('tokenusage') && method.includes('updated')) {
      absolute =
        parseTokenTotals(asRecord(params.usage)) ??
        parseTokenTotals(asRecord(params.token_usage)) ??
        parseTokenTotals(asRecord(params.tokenUsage));
    }

    if (!absolute) {
      return;
    }

    if (!this.lastAbsolute) {
      this.aggregate = { ...absolute };
      this.lastAbsolute = { ...absolute };
      return;
    }

    this.aggregate.input_tokens += Math.max(0, absolute.input_tokens - this.lastAbsolute.input_tokens);
    this.aggregate.output_tokens += Math.max(0, absolute.output_tokens - this.lastAbsolute.output_tokens);
    this.aggregate.total_tokens += Math.max(0, absolute.total_tokens - this.lastAbsolute.total_tokens);
    this.lastAbsolute = { ...absolute };
  }

  snapshot(): CodexUsageTotals {
    return { ...this.aggregate };
  }
}

function defaultSpawnProcess(params: { command: string; cwd: string; workerHost?: string }): RunnerProcess {
  const workerHost = params.workerHost?.trim();
  if (workerHost) {
    const remoteCommand = `cd ${shellEscape(params.cwd)} && exec ${params.command}`;
    const child: ChildProcessWithoutNullStreams = spawn('ssh', [workerHost, remoteCommand], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    return child;
  }

  const child: ChildProcessWithoutNullStreams = spawn('bash', ['-lc', params.command], {
    cwd: params.cwd,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  return child;
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
    try {
      processHandle = this.spawnProcess({ command: input.command, cwd: input.workspaceCwd, workerHost: input.workerHost });
    } catch {
      throw new CodexRunnerError('invalid_workspace_cwd', `Failed to launch codex process in cwd: ${input.workspaceCwd}`);
    }

    const protocol = new ProtocolClient(processHandle, this.dynamicToolExecutor);
    const emit = this.makeEmitter(input.onEvent, processHandle.pid ?? null);

    try {
      await protocol.request(
        'initialize',
        {
          clientInfo: { name: 'symphony', version: '0.1.0' },
          capabilities: {}
        },
        input.readTimeoutMs
      );

      protocol.notify('initialized', {});

      const threadResponse = await protocol.request(
        'thread/start',
        {
          approvalPolicy: normalizeApprovalPolicy(input.approvalPolicy),
          sandbox: input.threadSandbox ?? 'workspace-write',
          cwd: input.workspaceCwd,
          dynamicTools: this.dynamicToolExecutor.toolSpecs()
        },
        input.readTimeoutMs
      );

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

      const maxTurns = Math.max(1, input.maxTurns ?? 1);
      let turnsCompleted = 0;

      for (let turnIndex = 0; turnIndex < maxTurns; turnIndex += 1) {
        const promptText = turnIndex === 0 ? input.prompt : input.continuationPrompt ?? CONTINUATION_GUIDANCE;
        const sandboxPolicy = normalizeTurnSandboxPolicy(input.turnSandboxPolicy);
        const turnResponse = await protocol.request(
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

        const waitResult = await protocol.waitForTurnTerminal(input.turnTimeoutMs, emit);
        const session_id = `${thread_id}-${turn_id}`;
        const usage = waitResult.usage;
        const rate_limits = waitResult.rate_limits;

        if (waitResult.terminal === 'turn/completed') {
          turnsCompleted += 1;

          emit({
            event: CANONICAL_EVENT.codex.turnCompleted,
            thread_id,
            turn_id,
            session_id,
            usage,
            rate_limits
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
            rate_limits
          };
        }

        if (waitResult.terminal === 'turn/failed') {
          emit({ event: CANONICAL_EVENT.codex.turnFailed, thread_id, turn_id, session_id, usage, rate_limits });
          return {
            status: 'failed',
            thread_id,
            turn_id,
            session_id,
            last_event: CANONICAL_EVENT.codex.turnFailed,
            error_code: 'turn_failed',
            turns_completed: turnsCompleted,
            usage,
            rate_limits
          };
        }

        if (waitResult.terminal === 'turn/cancelled') {
          emit({ event: CANONICAL_EVENT.codex.turnCancelled, thread_id, turn_id, session_id, usage, rate_limits });
          return {
            status: 'failed',
            thread_id,
            turn_id,
            session_id,
            last_event: CANONICAL_EVENT.codex.turnCancelled,
            error_code: 'turn_cancelled',
            turns_completed: turnsCompleted,
            usage,
            rate_limits
          };
        }

        emit({ event: CANONICAL_EVENT.codex.turnInputRequired, thread_id, turn_id, session_id, usage, rate_limits });
        return {
          status: 'failed',
          thread_id,
          turn_id,
          session_id,
          last_event: CANONICAL_EVENT.codex.turnInputRequired,
          error_code: 'turn_input_required',
          turns_completed: turnsCompleted,
          usage,
          rate_limits
        };
      }

      throw new CodexRunnerError('response_error', 'Reached unexpected end of turn loop');
    } catch (error) {
      if (error instanceof CodexRunnerError) {
        if (error.code === 'port_exit' && protocol.sawCodexNotFound()) {
          throw new CodexRunnerError('codex_not_found', 'codex app-server command was not found');
        }
        emit({ event: CANONICAL_EVENT.codex.startupFailed, detail: error.message });
        throw error;
      }

      throw error;
    } finally {
      processHandle.kill('SIGKILL');
    }
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
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private readonly earlyResponses = new Map<number, ProtocolMessage>();
  private readonly notifications: ProtocolMessage[] = [];
  private readonly messageEmitter = new EventEmitter();
  private readonly usageTracker = new UsageTracker();

  private latestRateLimits: Record<string, unknown> | null = null;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private nextId = 1;
  private nextNotificationIndex = 0;
  private stderrLines: string[] = [];
  private static readonly TURN_WAITING_HEARTBEAT_MS = 5000;

  constructor(processHandle: RunnerProcess, dynamicToolExecutor: DynamicToolExecutor) {
    this.processHandle = processHandle;
    this.dynamicToolExecutor = dynamicToolExecutor;

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

  notify(method: string, params: Record<string, unknown>): void {
    this.write({ method, params });
  }

  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRunnerError('response_timeout', `Timed out waiting for ${method} response`));
      }, timeoutMs);

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

        const rateLimits = this.extractRateLimits(message);
        if (rateLimits) {
          this.latestRateLimits = rateLimits;
        }

        if (this.isApprovalRequest(message)) {
          this.write({ id: message.id, result: { approved: true } });
          emit({ event: CANONICAL_EVENT.codex.approvalAutoApproved });
          continue;
        }

        if (this.isToolCallRequest(message)) {
          const params = asRecord(message.params);
          const toolName = readString(params?.tool) ?? readString(params?.name);
          const argumentsValue = params?.arguments ?? {};
          const toolResult = await this.dynamicToolExecutor.execute(toolName, argumentsValue);
          this.write({ id: message.id, result: toolResult });
          if (toolResult.success) {
            emit({ event: CANONICAL_EVENT.codex.toolCallCompleted, detail: toolName ?? 'unknown_tool' });
          } else if (toolName) {
            emit({ event: CANONICAL_EVENT.codex.toolCallFailed, detail: toolName });
          } else {
            emit({ event: CANONICAL_EVENT.codex.unsupportedToolCall });
          }
          continue;
        }

        if (this.isMcpElicitationRequest(message)) {
          this.write({ id: message.id, result: { action: 'cancel' } });
          emit({ event: CANONICAL_EVENT.codex.turnInputRequired, detail: 'mcp elicitation request cancelled' });
          return {
            terminal: 'turn/input_required',
            usage: this.usageTracker.snapshot(),
            rate_limits: this.latestRateLimits
          };
        }

        const terminal = this.readTerminal(message);
        if (terminal) {
          return {
            terminal,
            usage: this.usageTracker.snapshot(),
            rate_limits: this.latestRateLimits
          };
        }

        if (this.isUnhandledServerRequest(message)) {
          const method = message.method ?? 'unknown';
          this.write({ id: message.id, result: { success: false, error: 'unsupported_server_request', method } });
          emit({ event: CANONICAL_EVENT.codex.unsupportedServerRequest, detail: method });
          continue;
        }
      }

      return null;
    };

    return new Promise((resolve, reject) => {
      const waitStartedAtMs = Date.now();
      const heartbeat = setInterval(() => {
        const elapsedSeconds = Math.floor((Date.now() - waitStartedAtMs) / 1000);
        emit({ event: CANONICAL_EVENT.codex.turnWaiting, detail: `waiting_for_turn_completion elapsed_s=${elapsedSeconds}` });
      }, ProtocolClient.TURN_WAITING_HEARTBEAT_MS);

      const onMessageWrapper = () => {
        void onMessage();
      };

      const timer = setTimeout(() => {
        clearInterval(heartbeat);
        this.messageEmitter.off('message', onMessageWrapper);
        this.messageEmitter.off('exit', onExit);
        reject(new CodexRunnerError('turn_timeout', 'Timed out waiting for turn terminal event'));
      }, timeoutMs);

      const onExit = () => {
        clearInterval(heartbeat);
        clearTimeout(timer);
        this.messageEmitter.off('message', onMessageWrapper);
        reject(new CodexRunnerError('port_exit', 'Codex process exited before turn completed'));
      };

      let handlingMessage = false;
      const onMessage = async () => {
        if (handlingMessage) {
          return;
        }
        handlingMessage = true;
        const terminal = await consume();
        handlingMessage = false;
        if (!terminal) {
          return;
        }

        clearInterval(heartbeat);
        clearTimeout(timer);
        this.messageEmitter.off('message', onMessageWrapper);
        this.messageEmitter.off('exit', onExit);
        resolve(terminal);
      };

      void onMessage();
      this.messageEmitter.on('message', onMessageWrapper);
      this.messageEmitter.on('exit', onExit);
    });
  }

  private write(payload: ProtocolMessage): void {
    this.processHandle.stdin.write(`${JSON.stringify(payload)}\n`);
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
    }
  }

  private extractRateLimits(message: ProtocolMessage): Record<string, unknown> | null {
    const params = asRecord(message.params);
    if (!params) {
      return null;
    }

    const direct = asRecord(params.rate_limits) ?? asRecord(params.rateLimits);
    if (direct) {
      return direct;
    }

    const nestedUsage = asRecord(params.usage);
    if (!nestedUsage) {
      return null;
    }

    return asRecord(nestedUsage.rate_limits) ?? asRecord(nestedUsage.rateLimits) ?? null;
  }

  private isApprovalRequest(message: ProtocolMessage): boolean {
    if (typeof message.id !== 'number') {
      return false;
    }

    const method = (message.method ?? '').toLowerCase();
    return method.includes('approval') && (method.includes('request') || method.includes('required'));
  }

  private isToolCallRequest(message: ProtocolMessage): boolean {
    if (typeof message.id !== 'number') {
      return false;
    }

    const method = (message.method ?? '').toLowerCase();
    return method.includes('tool') && method.includes('call');
  }

  private isMcpElicitationRequest(message: ProtocolMessage): boolean {
    if (typeof message.id !== 'number') {
      return false;
    }

    return (message.method ?? '').toLowerCase() === 'mcpserver/elicitation/request';
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
