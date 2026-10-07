import fs from 'node:fs';
import path from 'node:path';
import { resolveTaskRef } from './resolve-ref.ts';

export function resolveTaskRuntimeRoot(
  taskRef: string,
  options: Readonly<{ repoRoot?: string }> = {}
): string {
  const resolved = resolveTaskRef(taskRef, options);
  if (!resolved.ok) throw new Error(`${resolved.code}: ${resolved.message}`);
  return path.join(fs.realpathSync.native(resolved.taskDir), '.runtime');
}
