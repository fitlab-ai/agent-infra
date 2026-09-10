import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

/** The caller owns directory validation and the meaning of an existing target. */
export function writeDurableFile(
  target: string,
  content: string,
  options: Readonly<{ mode: number; replace: boolean }>
): void {
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const descriptor = fs.openSync(temporary, 'wx', options.mode);
    try {
      fs.writeFileSync(descriptor, content, { encoding: 'utf8' });
      fs.fchmodSync(descriptor, options.mode);
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    if (options.replace) fs.renameSync(temporary, target);
    else fs.linkSync(temporary, target);
    fsyncDirectory(directory);
  } finally { fs.rmSync(temporary, { force: true }); }
}
