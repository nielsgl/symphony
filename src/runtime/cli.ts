import path from 'node:path';

export type WorkflowPathSource = 'positional' | 'flag' | 'env' | 'default';
export type PortSource = 'cli' | 'env' | 'unset';
export type OfflineModeSource = 'flag' | 'env' | 'default';
export type GuardrailAckSource = 'flag' | 'missing';

export const GUARDRAIL_ACK_FLAG = '--i-understand-that-this-will-be-running-without-the-usual-guardrails';

export interface ParsedWorkflowPath {
  workflowPath: string;
  source: WorkflowPathSource;
}

export interface ParsedPort {
  port: number | undefined;
  source: PortSource;
}

export interface ParsedOfflineMode {
  offlineMode: boolean;
  source: OfflineModeSource;
}

export interface CliRuntimeOptions {
  workflow: ParsedWorkflowPath;
  port: ParsedPort;
  offline: ParsedOfflineMode;
  guardrails: ParsedGuardrailAck;
}

export interface ParsedGuardrailAck {
  acknowledged: boolean;
  source: GuardrailAckSource;
}

function parseInteger(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    return undefined;
  }

  return value;
}

function readFlagValue(argv: readonly string[], flag: string): string | undefined {
  const equalsPrefix = `${flag}=`;
  const equalsForm = argv.find((arg) => arg.startsWith(equalsPrefix));
  if (equalsForm) {
    return equalsForm.slice(equalsPrefix.length);
  }

  const splitIndex = argv.findIndex((arg) => arg === flag);
  if (splitIndex === -1) {
    return undefined;
  }

  const splitValue = argv[splitIndex + 1];
  if (!splitValue || splitValue.startsWith('-')) {
    return undefined;
  }

  return splitValue;
}

function readPositionalWorkflowPath(argv: readonly string[]): string | undefined {
  const flagsWithValue = new Set(['--workflow', '--port']);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (flagsWithValue.has(token)) {
      index += 1;
      continue;
    }

    if (!token.startsWith('-')) {
      return token;
    }
  }

  return undefined;
}

export function parseWorkflowPath(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string
): ParsedWorkflowPath {
  const positional = readPositionalWorkflowPath(argv);
  if (positional) {
    return { workflowPath: positional, source: 'positional' };
  }

  const workflowValue = readFlagValue(argv, '--workflow');
  if (workflowValue) {
    return {
      workflowPath: workflowValue,
      source: 'flag'
    };
  }

  if (env.SYMPHONY_WORKFLOW_PATH) {
    return {
      workflowPath: env.SYMPHONY_WORKFLOW_PATH,
      source: 'env'
    };
  }

  return {
    workflowPath: path.join(cwd, 'WORKFLOW.md'),
    source: 'default'
  };
}

export function parsePort(argv: readonly string[], env: NodeJS.ProcessEnv): ParsedPort {
  const cliPort = parseInteger(readFlagValue(argv, '--port'));
  if (cliPort !== undefined) {
    return { port: cliPort, source: 'cli' };
  }

  const envPort = parseInteger(env.SYMPHONY_PORT);
  if (envPort !== undefined) {
    return { port: envPort, source: 'env' };
  }

  return { port: undefined, source: 'unset' };
}

export function parseOfflineMode(argv: readonly string[], env: NodeJS.ProcessEnv): ParsedOfflineMode {
  if (argv.includes('--offline')) {
    return { offlineMode: true, source: 'flag' };
  }

  const value = env.SYMPHONY_OFFLINE;
  if (value === '1' || value === 'true') {
    return { offlineMode: true, source: 'env' };
  }

  return { offlineMode: false, source: 'default' };
}

export function parseGuardrailAck(argv: readonly string[]): ParsedGuardrailAck {
  if (argv.includes(GUARDRAIL_ACK_FLAG)) {
    return { acknowledged: true, source: 'flag' };
  }

  return { acknowledged: false, source: 'missing' };
}

export function resolveCliRuntimeOptions(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string
): CliRuntimeOptions {
  return {
    workflow: parseWorkflowPath(argv, env, cwd),
    port: parsePort(argv, env),
    offline: parseOfflineMode(argv, env),
    guardrails: parseGuardrailAck(argv)
  };
}
