import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { CodexRunnerError } from './errors';
import type { CodexRunnerStartInput, CodexTurnResult } from './types';

interface ProtocolMessage {
  id?: number;
  method?: string;
  result?: Record<string, unknown>;
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

type SpawnProcess = (params: { command: string; cwd: string }) => RunnerProcess;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readNestedString(payload: Record<string, unknown> | null, path: string[]): string | undefined {
  let current: unknown = payload;
  for (const segment of path) {
    const record = asRecord(current);
    if (!record) {
      return undefined;
    }
    current = record[segment];
  }
  return readString(current);
}

function defaultSpawnProcess(params: { command: string; cwd: string }): RunnerProcess {
  const child: ChildProcessWithoutNullStreams = spawn('bash', ['-lc', params.command], {
    cwd: params.cwd,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  return child;
}

export class CodexRunner {
  private readonly spawnProcess: SpawnProcess;

  constructor(options: { spawnProcess?: SpawnProcess } = {}) {
    this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
  }

  async startSessionAndRunTurn(input: CodexRunnerStartInput): Promise<CodexTurnResult> {
    const processHandle = this.spawnProcess({ command: input.command, cwd: input.workspaceCwd });
    const protocol = new ProtocolClient(processHandle);

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
          approvalPolicy: input.approvalPolicy ?? 'never',
          sandbox: input.threadSandbox ?? 'workspace-write',
          cwd: input.workspaceCwd
        },
        input.readTimeoutMs
      );

      const thread_id =
        readNestedString(threadResponse, ['thread', 'id']) ??
        readNestedString(threadResponse, ['threadId']) ??
        readNestedString(threadResponse, ['id']);
      if (!thread_id) {
        throw new CodexRunnerError('response_error', 'Missing thread id in thread/start response');
      }

      const turnResponse = await protocol.request(
        'turn/start',
        {
          threadId: thread_id,
          input: [{ type: 'text', text: input.prompt }],
          cwd: input.workspaceCwd,
          title: input.title,
          approvalPolicy: input.approvalPolicy ?? 'never',
          sandboxPolicy: input.turnSandboxPolicy ?? { type: 'workspace-write' }
        },
        input.readTimeoutMs
      );

      const turn_id =
        readNestedString(turnResponse, ['turn', 'id']) ??
        readNestedString(turnResponse, ['turnId']) ??
        readNestedString(turnResponse, ['id']);
      if (!turn_id) {
        throw new CodexRunnerError('response_error', 'Missing turn id in turn/start response');
      }

      const terminal = await protocol.waitForTurnTerminal(input.turnTimeoutMs);
      const session_id = `${thread_id}-${turn_id}`;

      if (terminal === 'turn/completed') {
        return {
          status: 'completed',
          thread_id,
          turn_id,
          session_id,
          last_event: 'turn_completed'
        };
      }

      if (terminal === 'turn/failed') {
        return {
          status: 'failed',
          thread_id,
          turn_id,
          session_id,
          last_event: 'turn_failed',
          error_code: 'turn_failed'
        };
      }

      if (terminal === 'turn/cancelled') {
        return {
          status: 'failed',
          thread_id,
          turn_id,
          session_id,
          last_event: 'turn_cancelled',
          error_code: 'turn_cancelled'
        };
      }

      return {
        status: 'failed',
        thread_id,
        turn_id,
        session_id,
        last_event: 'turn_input_required',
        error_code: 'turn_input_required'
      };
    } catch (error) {
      if (error instanceof CodexRunnerError) {
        if (error.code === 'turn_timeout') {
          throw error;
        }
        throw error;
      }

      throw error;
    } finally {
      processHandle.kill('SIGKILL');
    }
  }
}

class ProtocolClient {
  private readonly processHandle: RunnerProcess;
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private readonly earlyResponses = new Map<number, ProtocolMessage>();
  private readonly notifications: ProtocolMessage[] = [];
  private readonly stderrLines: string[] = [];
  private readonly messageEmitter = new EventEmitter();
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private nextId = 1;

  constructor(processHandle: RunnerProcess) {
    this.processHandle = processHandle;

    this.processHandle.stdout.on('data', (chunk: Buffer | string) => {
      this.onStdout(chunk.toString('utf8'));
    });

    this.processHandle.stderr.on('data', (chunk: Buffer | string) => {
      this.onStderr(chunk.toString('utf8'));
    });

    this.processHandle.once('exit', () => {
      for (const pending of this.pending.values()) {
        pending.reject(new CodexRunnerError('response_error', 'Codex process exited before response'));
      }
      this.pending.clear();
      this.messageEmitter.emit('exit');
    });
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
            pending.reject(new CodexRunnerError('response_error', `Protocol error response for id ${id}`));
          } else {
            pending.resolve(asRecord(early.result) ?? {});
          }
        }
      }

      this.write({ id, method, params });
    });
  }

  waitForTurnTerminal(timeoutMs: number): Promise<'turn/completed' | 'turn/failed' | 'turn/cancelled' | 'turn/input_required'> {
    const existing = this.findTerminal(this.notifications);
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.messageEmitter.off('message', onMessage);
        this.messageEmitter.off('exit', onExit);
        reject(new CodexRunnerError('turn_timeout', 'Timed out waiting for turn terminal event'));
      }, timeoutMs);

      const onExit = () => {
        clearTimeout(timer);
        this.messageEmitter.off('message', onMessage);
        reject(new CodexRunnerError('turn_failed', 'Codex process exited before turn completed'));
      };

      const onMessage = () => {
        const terminal = this.findTerminal(this.notifications);
        if (!terminal) {
          return;
        }

        clearTimeout(timer);
        this.messageEmitter.off('message', onMessage);
        this.messageEmitter.off('exit', onExit);
        resolve(terminal);
      };

      this.messageEmitter.on('message', onMessage);
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

      if (typeof parsed.id === 'number') {
        const pending = this.pending.get(parsed.id);
        if (!pending) {
          this.earlyResponses.set(parsed.id, parsed);
          continue;
        }

        this.pending.delete(parsed.id);
        if (parsed.error) {
          pending.reject(new CodexRunnerError('response_error', `Protocol error response for id ${parsed.id}`));
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

  private findTerminal(messages: ProtocolMessage[]): 'turn/completed' | 'turn/failed' | 'turn/cancelled' | 'turn/input_required' | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const method = message.method ?? '';
      if (method === 'turn/completed') {
        return 'turn/completed';
      }
      if (method === 'turn/failed') {
        return 'turn/failed';
      }
      if (method === 'turn/cancelled') {
        return 'turn/cancelled';
      }
      if (method.includes('input') && method.includes('required')) {
        return 'turn/input_required';
      }
    }
    return null;
  }
}
