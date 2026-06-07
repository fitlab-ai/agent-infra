import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecFileSyncOptions } from 'node:child_process';

// Quick "is osascript callable at all" probe used by available(). Not for
// clipboard work — clipboard work shares READ_IMAGE_TIMEOUT_MS below.
// Generous 2s budget: this is a once-per-session bridge enablement check;
// failing it just disables the clipboard bridge for that session, so we'd
// rather tolerate a cold osascript spawn than misreport "unavailable".
const OSASCRIPT_PROBE_TIMEOUT_MS = 2_000;
const READ_IMAGE_TIMEOUT_MS = 5_000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type ExecFn = (cmd: string, args: string[], options?: ExecFileSyncOptions) => Buffer | string;

export type DarwinClipboardAdapter = {
  available(): { ok: true } | { ok: false; reason: string };
  // Returns PNG bytes when the clipboard holds (or can synthesize) an image,
  // null otherwise. No separate hasImage(): a probing `clipboard info` call
  // forces NSPasteboard to materialize TIFF/BMP/8BPS representations to
  // report their sizes, which can take seconds when the clipboard holds a
  // Retina screenshot. Letting AppleScript's `as «class PNGf»` either succeed
  // (image present, possibly auto-converted from TIFF/JPEG/GIF) or error
  // (nothing PNG-coercible) keeps the path O(PNG size) regardless of how
  // many other representations the source declared.
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
        execFn('osascript', ['-e', 'return "ok"'], { encoding: 'utf8', timeout: OSASCRIPT_PROBE_TIMEOUT_MS });
        return { ok: true };
      } catch {
        return { ok: false, reason: 'macOS osascript is unavailable' };
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
