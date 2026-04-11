import path from 'node:path';

export interface BackendLaunchConfig {
  nodeBinary: string;
  scriptPath: string;
  args: string[];
  cwd: string;
}

export function parseDashboardUrl(line: string): string | null {
  const match = line.match(/Symphony dashboard running at (http:\/\/127\.0\.0\.1:\d+\/)$/);
  return match ? match[1] : null;
}

export function createBackendLaunchConfig(options: {
  repoRoot: string;
  workflowPath?: string;
  nodeBinary?: string;
  offlineMode?: boolean;
}): BackendLaunchConfig {
  const workflowPath = options.workflowPath || path.join(options.repoRoot, 'WORKFLOW.md');
  const nodeBinary = options.nodeBinary || process.execPath;
  const scriptPath = path.join(options.repoRoot, 'scripts', 'start-dashboard.js');
  const args = [scriptPath, '--port=0', `--workflow=${workflowPath}`];

  if (options.offlineMode) {
    args.push('--offline');
  }

  return {
    nodeBinary,
    scriptPath,
    args,
    cwd: options.repoRoot
  };
}
