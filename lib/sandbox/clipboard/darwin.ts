import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecFileSyncOptions } from 'node:child_process';

const HAS_IMAGE_TIMEOUT_MS = 500;
const READ_IMAGE_TIMEOUT_MS = 5_000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type ExecFn = (cmd: string, args: string[], options?: ExecFileSyncOptions) => Buffer | string;

export type DarwinClipboardAdapter = {
  available(): { ok: true } | { ok: false; reason: string };
  hasImage(): boolean;
  readImagePng(): Buffer | null;
};

export function createDarwinClipboardAdapter({
  execFn = execFileSync,
  mkdtempFn = fs.mkdtempSync,
  readFileFn = fs.readFileSync,
  rmFn = fs.rmSync
}: {
  execFn?: ExecFn;
  mkdtempFn?: typeof fs.mkdtempSync;
  readFileFn?: typeof fs.readFileSync;
  rmFn?: typeof fs.rmSync;
} = {}): DarwinClipboardAdapter {
  return {
    available() {
      try {
        execFn('osascript', ['-e', 'return "ok"'], { encoding: 'utf8', timeout: HAS_IMAGE_TIMEOUT_MS });
        return { ok: true };
      } catch {
        return { ok: false, reason: 'macOS osascript is unavailable' };
      }
    },
    hasImage() {
      try {
        const output = String(execFn('osascript', ['-e', 'clipboard info'], {
          encoding: 'utf8',
          timeout: HAS_IMAGE_TIMEOUT_MS
        }));
        return /\b(PNGf|TIFF|JPEG|GIFf)\b/.test(output);
      } catch {
        return false;
      }
    },
    readImagePng() {
      const tmpDir = mkdtempFn(path.join(os.tmpdir(), 'agent-infra-clipboard-'));
      const outputPath = path.join(tmpDir, 'clipboard.png');
      try {
        try {
          execFn('osascript', ['-e', pngWriteScript(outputPath)], {
            encoding: 'utf8',
            timeout: READ_IMAGE_TIMEOUT_MS
          });
        } catch {
          execFn('pngpaste', [outputPath], {
            encoding: 'utf8',
            timeout: READ_IMAGE_TIMEOUT_MS
          });
        }
        const png = Buffer.from(readFileFn(outputPath));
        return isPng(png) ? png : null;
      } catch {
        return null;
      } finally {
        rmFn(tmpDir, { recursive: true, force: true });
      }
    }
  };
}

function isPng(buffer: Buffer): boolean {
  return buffer.length >= PNG_MAGIC.length && PNG_MAGIC.every((byte, index) => buffer[index] === byte);
}

function pngWriteScript(outputPath: string): string {
  const escapedPath = outputPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return [
    'set pngData to the clipboard as «class PNGf»',
    `set outFile to POSIX file "${escapedPath}"`,
    'set fileRef to open for access outFile with write permission',
    'set eof fileRef to 0',
    'write pngData to fileRef',
    'close access fileRef'
  ].join('\n');
}
