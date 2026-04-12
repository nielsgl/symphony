import type { StructuredLogger } from '../observability';
import { MultiSinkLogger } from '../observability';
import type { TrackerAdapter } from '../tracker';
import { createRuntimeEnvironment } from './bootstrap';
import { resolveCliRuntimeOptions } from './cli';

interface RuntimeLike {
  apiServer: { address: () => { host: string; port: number } } | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

interface RunnerDependencies {
  createRuntime: (options: {
    host: string;
    port: number | undefined;
    workflowPath: string;
    logger: StructuredLogger;
    trackerAdapter?: TrackerAdapter;
  }) => RuntimeLike;
  logger: StructuredLogger;
  onSignal: (signal: 'SIGINT' | 'SIGTERM', handler: () => void | Promise<void>) => void;
  onFatal: (event: 'uncaughtException' | 'unhandledRejection', handler: (error: unknown) => void) => void;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function createNoopTrackerAdapter(): TrackerAdapter {
  return {
    fetch_candidate_issues: async () => [],
    fetch_issues_by_states: async () => [],
    fetch_issue_states_by_ids: async () => []
  };
}

function defaultDependencies(): RunnerDependencies {
  return {
    createRuntime: (options) => createRuntimeEnvironment(options),
    logger: new MultiSinkLogger(),
    onSignal: (signal, handler) => {
      process.once(signal, handler);
    },
    onFatal: (event, handler) => {
      process.once(event, handler);
    },
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    cwd: process.cwd(),
    env: process.env
  };
}

export async function runDashboardCli(
  argv: readonly string[],
  depsOverrides: Partial<RunnerDependencies> = {}
): Promise<number> {
  const deps = {
    ...defaultDependencies(),
    ...depsOverrides
  };

  const resolved = resolveCliRuntimeOptions(argv, deps.env, deps.cwd);
  const offlineMode = resolved.offline.offlineMode;

  deps.logger.log({
    level: 'info',
    event: 'runtime_args_resolved',
    message: 'resolved startup arguments',
    context: {
      workflow_path: resolved.workflow.workflowPath,
      workflow_path_source: resolved.workflow.source,
      port: resolved.port.port ?? null,
      port_source: resolved.port.source,
      offline_mode: offlineMode,
      offline_mode_source: resolved.offline.source
    }
  });

  let runtime: RuntimeLike;
  try {
    runtime = deps.createRuntime({
      host: '127.0.0.1',
      port: resolved.port.port,
      workflowPath: resolved.workflow.workflowPath,
      logger: deps.logger,
      trackerAdapter: offlineMode ? createNoopTrackerAdapter() : undefined
    });
  } catch (error) {
    deps.stderr(`Failed to start dashboard: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  try {
    await runtime.start();
  } catch (error) {
    deps.stderr(`Failed to start dashboard: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (runtime.apiServer) {
    const address = runtime.apiServer.address();
    deps.stdout(`Symphony dashboard running at http://127.0.0.1:${address.port}/\n`);
  } else {
    deps.stdout('Symphony runtime started without HTTP dashboard (set --port or server.port).\n');
  }

  deps.stdout(`Workflow: ${resolved.workflow.workflowPath}\n`);
  deps.stdout(`Offline mode: ${offlineMode ? 'enabled' : 'disabled'}\n`);
  deps.stdout('Press Ctrl+C to stop.\n');

  return await new Promise<number>((resolve) => {
    let settled = false;

    const settle = (code: number) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(code);
    };

    const shutdown = async () => {
      try {
        await runtime.stop();
        settle(0);
      } catch (error) {
        deps.stderr(`Failed to stop dashboard cleanly: ${error instanceof Error ? error.message : String(error)}\n`);
        settle(1);
      }
    };

    const abnormalExit = (error: unknown) => {
      deps.stderr(`Dashboard runtime aborted: ${error instanceof Error ? error.message : String(error)}\n`);
      settle(1);
    };

    deps.onSignal('SIGINT', shutdown);
    deps.onSignal('SIGTERM', shutdown);
    deps.onFatal('uncaughtException', abnormalExit);
    deps.onFatal('unhandledRejection', abnormalExit);
  });
}