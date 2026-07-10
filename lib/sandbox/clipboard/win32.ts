import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecFileSyncOptions } from 'node:child_process';

const PROBE_TIMEOUT_MS = 2_000;
const READ_IMAGE_TIMEOUT_MS = 5_000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-STA', '-Command'];

type ExecFn = (cmd: string, args: string[], options?: ExecFileSyncOptions) => Buffer | string;

export type Win32ClipboardAdapter = {
  available(): { ok: true } | { ok: false; reason: string };
  readImagePng(): Buffer | null;
};

export function createWin32ClipboardAdapter({
  execFn = execFileSync,
  mkdtempFn = fs.mkdtempSync,
  readFileFn = fs.readFileSync,
  rmFn = fs.rmSync
}: {
  execFn?: ExecFn;
  mkdtempFn?: typeof fs.mkdtempSync;
  readFileFn?: typeof fs.readFileSync;
  rmFn?: typeof fs.rmSync;
} = {}): Win32ClipboardAdapter {
  return {
    available() {
      try {
        execFn('powershell.exe', [...POWERSHELL_ARGS, clipboardProbeScript()], {
          encoding: 'utf8',
          timeout: PROBE_TIMEOUT_MS
        });
        return { ok: true };
      } catch {
        return {
          ok: false,
          reason: 'Windows PowerShell Get-Clipboard is unavailable; install or enable powershell.exe to use image paste'
        };
      }
    },
    readImagePng() {
      const tmpDir = mkdtempFn(path.join(os.tmpdir(), 'agent-infra-clipboard-'));
      const outputPath = path.join(tmpDir, 'clipboard.png');
      try {
        execFn('powershell.exe', [...POWERSHELL_ARGS, pngWriteScript(), outputPath], {
          encoding: 'utf8',
          timeout: READ_IMAGE_TIMEOUT_MS
        });
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

function clipboardProbeScript(): string {
  return 'if ($null -eq (Get-Command Get-Clipboard -ErrorAction SilentlyContinue)) { exit 1 }';
}

function pngWriteScript(): string {
  return [
    '$ErrorActionPreference = "Stop"',
    '$outputPath = $args[0]',
    '$image = $null',
    'try {',
    '  Add-Type -AssemblyName System.Drawing',
    '  $image = Get-Clipboard -Format Image -ErrorAction Stop',
    '  if ($null -eq $image) { throw "clipboard has no image" }',
    '  $image.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)',
    '} finally {',
    '  if ($null -ne $image -and $image -is [System.IDisposable]) { $image.Dispose() }',
    '}'
  ].join('\n');
}

function isPng(buffer: Buffer): boolean {
  return buffer.length >= PNG_MAGIC.length && PNG_MAGIC.every((byte, index) => buffer[index] === byte);
}
