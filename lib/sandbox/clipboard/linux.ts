import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecFileSyncOptions } from 'node:child_process';

const PROBE_TIMEOUT_MS = 2_000;
const READ_IMAGE_TIMEOUT_MS = 5_000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type ExecFn = (cmd: string, args: string[], options?: ExecFileSyncOptions) => Buffer | string;
type ExecToFileFn = (cmd: string, args: string[], outputPath: string, timeout: number) => void;

type LinuxBackend =
  | { kind: 'wayland'; command: 'wl-paste' }
  | { kind: 'x11'; command: 'xclip' };

export type LinuxClipboardAdapter = {
  available(): { ok: true } | { ok: false; reason: string };
  readImagePng(): Buffer | null;
};

export function createLinuxClipboardAdapter({
  env = process.env,
  execFn = execFileSync,
  execToFileFn = execToFile,
  mkdtempFn = fs.mkdtempSync,
  readFileFn = fs.readFileSync,
  rmFn = fs.rmSync
}: {
  env?: NodeJS.ProcessEnv;
  execFn?: ExecFn;
  execToFileFn?: ExecToFileFn;
  mkdtempFn?: typeof fs.mkdtempSync;
  readFileFn?: typeof fs.readFileSync;
  rmFn?: typeof fs.rmSync;
} = {}): LinuxClipboardAdapter {
  return {
    available() {
      const backend = selectBackend(env);
      try {
        execFn(backend.command, versionArgs(backend), {
          encoding: 'utf8',
          timeout: PROBE_TIMEOUT_MS
        });
        return { ok: true };
      } catch {
        return { ok: false, reason: unavailableReason(backend) };
      }
    },
    readImagePng() {
      const backend = selectBackend(env);
      try {
        const mimeTypes = String(execFn(backend.command, mimeArgs(backend), {
          encoding: 'utf8',
          timeout: PROBE_TIMEOUT_MS
        }));
        if (!hasPngMime(mimeTypes)) {
          return null;
        }

        const tmpDir = mkdtempFn(path.join(os.tmpdir(), 'agent-infra-clipboard-'));
        const outputPath = path.join(tmpDir, 'clipboard.png');
        try {
          execToFileFn(backend.command, imageArgs(backend), outputPath, READ_IMAGE_TIMEOUT_MS);
          const png = Buffer.from(readFileFn(outputPath));
          return isPng(png) ? png : null;
        } finally {
          rmFn(tmpDir, { recursive: true, force: true });
        }
      } catch {
        return null;
      }
    }
  };
}

function selectBackend(env: NodeJS.ProcessEnv): LinuxBackend {
  return env.WAYLAND_DISPLAY?.trim()
    ? { kind: 'wayland', command: 'wl-paste' }
    : { kind: 'x11', command: 'xclip' };
}

function versionArgs(backend: LinuxBackend): string[] {
  return backend.kind === 'wayland' ? ['--version'] : ['-version'];
}

function mimeArgs(backend: LinuxBackend): string[] {
  return backend.kind === 'wayland'
    ? ['--list-types']
    : ['-selection', 'clipboard', '-t', 'TARGETS', '-o'];
}

function imageArgs(backend: LinuxBackend): string[] {
  return backend.kind === 'wayland'
    ? ['-t', 'image/png']
    : ['-selection', 'clipboard', '-t', 'image/png', '-o'];
}

function unavailableReason(backend: LinuxBackend): string {
  return backend.kind === 'wayland'
    ? 'Wayland clipboard tool wl-paste is unavailable; install wl-clipboard to enable image paste'
    : 'X11 clipboard tool xclip is unavailable; install xclip to enable image paste';
}

function hasPngMime(output: string): boolean {
  return output.split(/\s+/u).some((type) => type === 'image/png');
}

function execToFile(cmd: string, args: string[], outputPath: string, timeout: number): void {
  const fd = fs.openSync(outputPath, 'w', 0o600);
  try {
    execFileSync(cmd, args, {
      timeout,
      stdio: ['ignore', fd, 'pipe']
    });
  } finally {
    fs.closeSync(fd);
  }
}

function isPng(buffer: Buffer): boolean {
  return buffer.length >= PNG_MAGIC.length && PNG_MAGIC.every((byte, index) => buffer[index] === byte);
}
