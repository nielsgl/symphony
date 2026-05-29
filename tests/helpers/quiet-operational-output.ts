import type { StdioOptions } from 'node:child_process';

export function shouldShowOperationalTestOutput(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.SYMPHONY_TEST_OPERATIONAL_OUTPUT === '1' ||
    env.SYMPHONY_TEST_OPERATIONAL_OUTPUT === 'true' ||
    env.SYMPHONY_TEST_LOGS === '1' ||
    env.SYMPHONY_TEST_LOGS === 'true' ||
    env.SYMPHONY_TEST_LOGS === 'stderr'
  );
}

export function operationalCommandStdio(env: NodeJS.ProcessEnv = process.env): StdioOptions {
  return shouldShowOperationalTestOutput(env) ? ['ignore', 'pipe', 'inherit'] : ['ignore', 'pipe', 'pipe'];
}
