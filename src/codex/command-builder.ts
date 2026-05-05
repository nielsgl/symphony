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

export function buildCodexSpawnCommand(codex: CodexConfig): CodexSpawnCommand {
  if (codex.codex_resolution_mode === 'legacy') {
    return { command: codex.command };
  }

  const args = [...(codex.effective_extra_flags ?? [])];
  if (codex.effective_codex_model) {
    args.push('--config', `model="${codex.effective_codex_model}"`);
  }
  if (codex.effective_reasoning_effort) {
    args.push('--config', `model_reasoning_effort=${codex.effective_reasoning_effort}`);
  }
  args.push('app-server');

  return {
    command: 'codex',
    args,
    env: {
      CODEX_HOME: path.normalize(codex.effective_codex_home ?? `${process.env.HOME ?? ''}/.codex`)
    }
  };
}
