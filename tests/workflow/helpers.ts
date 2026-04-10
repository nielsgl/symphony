import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeWorkflowFile(dir: string, content: string, filename = 'WORKFLOW.md'): string {
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
