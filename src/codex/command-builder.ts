import path from 'node:path';

import type { CodexConfig } from '../workflow';

export interface CodexSpawnCommand {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function renderCodexCommandForDiagnostics(command: CodexSpawnCommand): string {
  if (!command.args) {
    return command.command;
  }

  const envPrefix = Object.entries(command.env ?? {})
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' ');
  const rendered = [command.command, ...command.args].map(shellQuote).join(' ');
  return envPrefix ? `${envPrefix} ${rendered}` : rendered;
}

function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }

    if ((char === "'" || char === '"') && (quote === null || quote === char)) {
      quote = quote === char ? null : char;
      continue;
    }

    if (/\s/.test(char) && quote === null) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaped) {
    current += '\\';
  }
  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function isEnvironmentAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function readLegacyCommandBase(command: string): { command: string; args: string[]; env: Record<string, string> } {
  const tokens = tokenizeShellCommand(command);
  const executableIndex = tokens.findIndex((token) => !isEnvironmentAssignment(token));
  if (executableIndex === -1) {
    return { command, args: [], env: {} };
  }

  const env = Object.fromEntries(
    tokens.slice(0, executableIndex).map((token) => {
      const separatorIndex = token.indexOf('=');
      return [token.slice(0, separatorIndex), token.slice(separatorIndex + 1)];
    })
  );
  const executable = tokens[executableIndex];
  const executableArgs = tokens.slice(executableIndex + 1);
  const appServerIndex = executableArgs.lastIndexOf('app-server');
  return {
    command: executable,
    args: appServerIndex === -1 ? executableArgs : executableArgs.slice(0, appServerIndex),
    env
  };
}

function buildTypedArgs(codex: CodexConfig): string[] {
  const args = [...(codex.effective_extra_flags ?? [])];
  if (codex.effective_codex_model) {
    args.push('--config', `model="${codex.effective_codex_model}"`);
  }
  if (codex.effective_reasoning_effort) {
    args.push('--config', `model_reasoning_effort=${codex.effective_reasoning_effort}`);
  }
  args.push('app-server');
  return args;
}

export function buildCodexSpawnCommand(codex: CodexConfig): CodexSpawnCommand {
  if (codex.codex_resolution_mode === 'legacy') {
    return { command: codex.command };
  }

  const legacyBase =
    codex.codex_resolution_mode === 'mixed'
      ? readLegacyCommandBase(codex.command)
      : { command: 'codex', args: [], env: {} };

  return {
    command: legacyBase.command,
    args: [...legacyBase.args, ...buildTypedArgs(codex)],
    env: {
      ...legacyBase.env,
      CODEX_HOME: path.normalize(codex.effective_codex_home ?? `${process.env.HOME ?? ''}/.codex`)
    }
  };
}
