import fs from 'node:fs';
import path from 'node:path';

export function removeDirRecursive(dir: string): void {
  if (!fs.existsSync(dir)) {
    return;
  }

  const pending = [dir];
  const directories: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fs.unlinkSync(current);
      continue;
    }

    directories.push(current);
    for (const entry of fs.readdirSync(current)) {
      pending.push(path.join(current, entry));
    }
  }

  for (const directory of directories.reverse()) {
    fs.rmdirSync(directory);
  }
}
