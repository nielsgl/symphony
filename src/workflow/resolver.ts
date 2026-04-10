import os from 'node:os';
import path from 'node:path';

import type { EffectiveConfig, WorkflowDefinition } from './types';

interface ResolverOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  tmpdir?: () => string;
}

const DEFAULT_ACTIVE_STATES = ['Todo', 'In Progress'];
const DEFAULT_TERMINAL_STATES = ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done'];

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function readInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) {
    return parseInt(value, 10);
  }

  return fallback;
}

function readString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    return value;
  }

  return fallback;
}

function readStringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  return value.filter((entry): entry is string => typeof entry === 'string');
}

function resolveEnvToken(value: string, env: NodeJS.ProcessEnv): string {
  if (!value.startsWith('$')) {
    return value;
  }

  const varName = value.slice(1);
  if (!varName) {
    return '';
  }

  return env[varName] ?? '';
}

function expandHome(value: string, homedir: string): string {
  if (value === '~') {
    return homedir;
  }

  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homedir, value.slice(2));
  }

  return value;
}

function hasPathSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\') || value === '~' || value.startsWith('~/') || value.startsWith('~\\');
}

function resolvePathLikeValue(value: unknown, env: NodeJS.ProcessEnv, homedir: string, fallback: string): string {
  const raw = readString(value, fallback);
  const envResolved = resolveEnvToken(raw, env);
  const homeResolved = expandHome(envResolved, homedir);

  if (!hasPathSeparator(homeResolved)) {
    return homeResolved;
  }

  return path.normalize(homeResolved);
}

function normalizePerStateMap(value: unknown): Record<string, number> {
  const record = asRecord(value);
  const out: Record<string, number> = {};

  for (const [key, raw] of Object.entries(record)) {
    const parsed = readInt(raw, NaN);
    if (Number.isFinite(parsed) && parsed > 0) {
      out[key.toLowerCase()] = parsed;
    }
  }

  return out;
}

export class ConfigResolver {
  private readonly env: NodeJS.ProcessEnv;
  private readonly homedir: () => string;
  private readonly tmpdir: () => string;

  constructor(options: ResolverOptions = {}) {
    this.env = options.env ?? process.env;
    this.homedir = options.homedir ?? os.homedir;
    this.tmpdir = options.tmpdir ?? os.tmpdir;
  }

  resolve(workflowDefinition: WorkflowDefinition): EffectiveConfig {
    const config = asRecord(workflowDefinition.config);

    const tracker = asRecord(config.tracker);
    const polling = asRecord(config.polling);
    const workspace = asRecord(config.workspace);
    const hooks = asRecord(config.hooks);
    const agent = asRecord(config.agent);
    const codex = asRecord(config.codex);
    const server = asRecord(config.server);

    const trackerKind = readString(tracker.kind, '');
    const trackerEndpoint =
      readString(tracker.endpoint, '') ||
      (trackerKind === 'linear' ? 'https://api.linear.app/graphql' : '');

    const trackerApiKeySource =
      typeof tracker.api_key === 'string'
        ? tracker.api_key
        : trackerKind === 'linear'
          ? '$LINEAR_API_KEY'
          : '';
    const trackerApiKey = resolveEnvToken(trackerApiKeySource, this.env);

    const trackerProjectSlug = readString(tracker.project_slug, '');

    const workspaceRoot = resolvePathLikeValue(
      workspace.root,
      this.env,
      this.homedir(),
      path.join(this.tmpdir(), 'symphony_workspaces')
    );

    const hooksTimeoutCandidate = readInt(hooks.timeout_ms, 60000);
    const hooksTimeoutMs = hooksTimeoutCandidate > 0 ? hooksTimeoutCandidate : 60000;

    const codexCommand = readString(codex.command, 'codex app-server');

    const resolved: EffectiveConfig = {
      tracker: {
        kind: trackerKind,
        endpoint: trackerEndpoint,
        api_key: trackerApiKey,
        project_slug: trackerProjectSlug,
        active_states: readStringList(tracker.active_states, DEFAULT_ACTIVE_STATES),
        terminal_states: readStringList(tracker.terminal_states, DEFAULT_TERMINAL_STATES)
      },
      polling: {
        interval_ms: readInt(polling.interval_ms, 30000)
      },
      workspace: {
        root: workspaceRoot
      },
      hooks: {
        after_create: readString(hooks.after_create, '') || undefined,
        before_run: readString(hooks.before_run, '') || undefined,
        after_run: readString(hooks.after_run, '') || undefined,
        before_remove: readString(hooks.before_remove, '') || undefined,
        timeout_ms: hooksTimeoutMs
      },
      agent: {
        max_concurrent_agents: readInt(agent.max_concurrent_agents, 10),
        max_retry_backoff_ms: readInt(agent.max_retry_backoff_ms, 300000),
        max_turns: readInt(agent.max_turns, 20),
        max_concurrent_agents_by_state: normalizePerStateMap(agent.max_concurrent_agents_by_state)
      },
      codex: {
        command: codexCommand,
        approval_policy: readString(codex.approval_policy, '') || undefined,
        thread_sandbox: readString(codex.thread_sandbox, '') || undefined,
        turn_sandbox_policy: readString(codex.turn_sandbox_policy, '') || undefined,
        turn_timeout_ms: readInt(codex.turn_timeout_ms, 3600000),
        read_timeout_ms: readInt(codex.read_timeout_ms, 5000),
        stall_timeout_ms: readInt(codex.stall_timeout_ms, 300000)
      }
    };

    const serverPort = readInt(server.port, NaN);
    if (Number.isFinite(serverPort)) {
      resolved.server = { port: serverPort };
    }

    return resolved;
  }
}
