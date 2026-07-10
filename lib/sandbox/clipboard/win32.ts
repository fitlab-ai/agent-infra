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
type MkdtempFn = (prefix: string) => string;
type ReadFileFn = (filePath: fs.PathOrFileDescriptor) => Buffer | string;
type RmFn = (filePath: fs.PathLike, options: { recursive?: boolean; force?: boolean }) => void;
type ExistsFn = (filePath: fs.PathLike) => boolean;

export type Win32ClipboardAdapter = {
  available(): { ok: true } | { ok: false; reason: string };
  readImagePng(): Buffer | null;
  readImageFromPath(imagePath: string): Buffer | null;
  readImageFromText(text: string): Buffer | null;
};

export function createWin32ClipboardAdapter({
  execFn = execFileSync,
  mkdtempFn = fs.mkdtempSync,
  readFileFn = fs.readFileSync,
  rmFn = fs.rmSync,
  existsFn = fs.existsSync
}: {
  execFn?: ExecFn;
  mkdtempFn?: MkdtempFn;
  readFileFn?: ReadFileFn;
  rmFn?: RmFn;
  existsFn?: ExistsFn;
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
        execFn('powershell.exe', [...POWERSHELL_ARGS, pngWriteScript(outputPath)], {
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
    },
    readImageFromPath(imagePath) {
      const tmpDir = mkdtempFn(path.join(os.tmpdir(), 'agent-infra-clipboard-'));
      const outputPath = path.join(tmpDir, 'clipboard.png');
      try {
        execFn('powershell.exe', [...POWERSHELL_ARGS, pngFromPathScript(imagePath, outputPath)], {
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
    },
    readImageFromText(text) {
      const trimmed = text.trim();
      if (!isWindowsImagePath(trimmed)) {
        return null;
      }
      if (!existsFn(trimmed)) {
        return null;
      }
      return this.readImageFromPath(trimmed);
    }
  };
}

function clipboardProbeScript(): string {
  return 'if ($null -eq (Get-Command Get-Clipboard -ErrorAction SilentlyContinue)) { exit 1 }';
}

// Embed a filesystem path in a PowerShell single-quoted string literal.
// Single-quoted strings in PowerShell are verbatim (no variable expansion,
// no escape sequences). The only special character is a single quote itself,
// which is escaped by doubling it.
function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function pngWriteScript(outputPath: string): string {
  const psOutputPath = psLiteral(outputPath);
  return [
    '$ErrorActionPreference = "Stop"',
    `$outputPath = ${psOutputPath}`,
    '$image = $null',
    'try {',
    '  Add-Type -AssemblyName System.Drawing',
    '  $image = Get-Clipboard -Format Image -ErrorAction SilentlyContinue',
    '  if ($null -ne $image) {',
    '    $image.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)',
    '    return',
    '  }',
    '  $files = Get-Clipboard -Format FileDropList -ErrorAction SilentlyContinue',
    '  if ($null -ne $files) {',
    '    $allowed = @(".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tiff", ".tif", ".ico")',
    '    foreach ($file in $files) {',
    '      if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }',
    '      $ext = [System.IO.Path]::GetExtension($file)',
    '      if ($allowed -notcontains $ext) { continue }',
    '      try {',
    '        $image = [System.Drawing.Image]::FromFile($file)',
    '        $image.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)',
    '        return',
    '      } catch {}',
    '    }',
    '  }',
    '  throw "clipboard has no image"',
    '} finally {',
    '  if ($null -ne $image -and $image -is [System.IDisposable]) { $image.Dispose() }',
    '}'
  ].join('\n');
}

function pngFromPathScript(imagePath: string, outputPath: string): string {
  const psImagePath = psLiteral(imagePath);
  const psOutputPath = psLiteral(outputPath);
  return [
    '$ErrorActionPreference = "Stop"',
    `$imagePath = ${psImagePath}`,
    `$outputPath = ${psOutputPath}`,
    '$image = $null',
    'try {',
    '  Add-Type -AssemblyName System.Drawing',
    '  if (-not (Test-Path -LiteralPath $imagePath -PathType Leaf)) { throw "file not found: $imagePath" }',
    '  $image = [System.Drawing.Image]::FromFile($imagePath)',
    '  $image.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)',
    '} finally {',
    '  if ($null -ne $image -and $image -is [System.IDisposable]) { $image.Dispose() }',
    '}'
  ].join('\n');
}

const IMAGE_EXTENSIONS_RE = /\.(png|jpg|jpeg|gif|bmp|webp|tiff?|ico)$/i;

function isWindowsImagePath(text: string): boolean {
  // Must be a Windows absolute path: drive letter + colon + backslash/slash
  // followed by a path ending with a known image extension.
  return /^[A-Za-z]:[\\/].+$/.test(text) && IMAGE_EXTENSIONS_RE.test(text);
}

function isPng(buffer: Buffer): boolean {
  return buffer.length >= PNG_MAGIC.length && PNG_MAGIC.every((byte, index) => buffer[index] === byte);
}
