import fs from 'node:fs';
import path from 'node:path';

// Inspect descendants without following symlinks. The caller supplies the trusted root.
export function inspectOwnedPath(rootInput: string, targetInput: string, expect: 'file' | 'directory'): fs.Stats | null {
  const root = path.resolve(rootInput);
  const target = path.resolve(targetInput);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  try {
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
    let current = root;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return null;
      if (process.platform !== 'win32' && typeof process.getuid === 'function' && stat.uid !== process.getuid()) return null;
      if (current === target) return (expect === 'file' ? stat.isFile() : stat.isDirectory()) ? stat : null;
      if (!stat.isDirectory()) return null;
    }
  } catch {
    return null;
  }
  return null;
}
