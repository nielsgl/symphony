import path from 'node:path';

import { CANONICAL_EVENT } from '../observability/events';
import { REASON_CODES } from '../observability/reason-codes';
import { createDefaultDynamicToolExecutor, type DynamicToolExecutor } from './dynamic-tools';
import { CodexRunnerError } from './errors';
import { readNestedString, readString } from './runner/common';
import {
  abortReason,
  assertRemoteWorkspaceCwd,
  assertWorkspaceCwd,
  createCancellationError,
  createProcessCancellation,
  defaultSpawnProcess,
  type RunnerProcess,
  type SpawnProcess
} from './runner/process-lifecycle';
import { ProtocolClient, type WaitForTerminalResult } from './runner/protocol-client';
import type {
  CodexRunnerRecoveryInput,
  CodexRunnerEvent,
  CodexRunnerStartInput,
  CodexTurnResult
} from './types';

const CONTINUATION_GUIDANCE = 'Continue working on the same issue thread. Provide concise progress and next actions.';

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

export { CONTINUATION_GUIDANCE };
