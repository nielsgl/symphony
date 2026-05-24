import fs from 'node:fs';
import path from 'node:path';

function realpathNearest(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  if (fs.existsSync(resolved)) {
    return fs.realpathSync(resolved);
  }

  const parent = path.dirname(resolved);
  if (parent === resolved) {
    return resolved;
  }

  return path.join(realpathNearest(parent), path.basename(resolved));
}

export function isWithinPath(root: string, candidate: string): boolean {
  const normalizedRoot = realpathNearest(root);
  const normalizedCandidate = realpathNearest(candidate);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
