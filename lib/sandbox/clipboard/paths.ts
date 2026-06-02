import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hostJoin } from '../engines/wsl2-paths.ts';

export const CONTAINER_CLIPBOARD_MOUNT = '/clipboard';
const DEFAULT_KEEP = 20;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function clipboardHostDir(home: string): string {
  return hostJoin(home, '.agent-infra', 'clipboard');
}

export function containerClipboardPath(filename: string): string {
  return path.posix.join(CONTAINER_CLIPBOARD_MOUNT, filename);
}

export function pngClipboardFilename(buffer: Buffer): string {
  return `${crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16)}.png`;
}

export function writeClipboardPngAtomic(dir: string, filename: string, buffer: Buffer): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best effort: existing directories may live on filesystems that ignore chmod.
  }

  const target = path.join(dir, filename);
  const tmp = path.join(dir, `.${filename}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, target);
  return target;
}

export function pruneClipboardDir(
  dir: string,
  { keep = DEFAULT_KEEP, maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now() }:
  { keep?: number; maxAgeMs?: number; now?: number } = {}
): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const entries = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.png'))
    .map((name) => {
      const fullPath = path.join(dir, name);
      const stat = fs.statSync(fullPath);
      return { fullPath, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const keepSet = new Set(entries.slice(0, keep).map((entry) => entry.fullPath));
  const removed: string[] = [];

  for (const entry of entries) {
    if (keepSet.has(entry.fullPath) && now - entry.mtimeMs <= maxAgeMs) {
      continue;
    }
    try {
      fs.rmSync(entry.fullPath, { force: true });
      removed.push(entry.fullPath);
    } catch {
      // Cleanup is opportunistic; a failed prune should not break paste.
    }
  }

  return removed;
}
