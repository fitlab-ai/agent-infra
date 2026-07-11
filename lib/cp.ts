import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { platform as currentPlatform, tmpdir as defaultTmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createClipboardAdapter, type ClipboardAdapter } from './sandbox/clipboard/index.ts';
import { RECEIVER_CAPABILITY, receiveRemoteClipboardPng } from './sandbox/clipboard/inbox.ts';

const USAGE = 'Usage: ai cp <ssh-alias>\n\nCopy the local clipboard image (PNG) to a remote macOS clipboard or Linux sandbox over SSH.\n';
const COMMAND_TIMEOUT_MS = 30_000;

export type SpawnResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

type SpawnFn = (cmd: string, args: string[], input?: string) => SpawnResult;
type CreateAdapterFn = (options?: { platformName?: NodeJS.Platform }) => ClipboardAdapter | null;
type MkDTempFn = (prefix: string) => string;
type WriteFileFn = (file: string, data: Buffer) => void;
type RmFn = (target: string, options: { recursive: boolean; force: boolean }) => void;

export type CpDeps = {
  platform?: NodeJS.Platform;
  createAdapter?: CreateAdapterFn;
  spawnFn?: SpawnFn;
  randomId?: () => string;
  mkdtempFn?: MkDTempFn;
  writeFileFn?: WriteFileFn;
  rmFn?: RmFn;
  tmpdir?: () => string;
  writeStdout?: (chunk: string) => unknown;
  writeStderr?: (chunk: string) => unknown;
};

export function runCommand(cmd: string, args: string[], input?: string): SpawnResult {
  const result = spawnSync(cmd, args, {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: COMMAND_TIMEOUT_MS
  });

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error
  };
}

export async function cmdCp(args: string[], deps: CpDeps = {}): Promise<number> {
  const {
    platform = currentPlatform(),
    createAdapter = createClipboardAdapter,
    spawnFn = runCommand,
    randomId = randomUUID,
    mkdtempFn = fs.mkdtempSync,
    writeFileFn = fs.writeFileSync,
    rmFn = fs.rmSync,
    tmpdir = defaultTmpdir,
    writeStdout = (chunk: string) => process.stdout.write(chunk),
    writeStderr = (chunk: string) => process.stderr.write(chunk)
  } = deps;

  if (args.length === 1 && args[0] === '--remote-receive-capability') {
    if (platform === 'linux') writeStdout(`${RECEIVER_CAPABILITY}\n`);
    return platform === 'linux' ? 0 : 1;
  }
  if (args.length === 2 && args[0] === '--remote-receive-v1') {
    try {
      const result = receiveRemoteClipboardPng(process.env.HOME || process.env.USERPROFILE || '', args[1]!, platform);
      writeStdout(`${result}\n`);
      return 0;
    } catch (error) {
      writeStderr(`${error instanceof Error ? error.message : 'clipboard receive failed'}\n`);
      return 1;
    }
  }

  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    writeStdout(USAGE);
    return 0;
  }

  let positionals: string[];
  try {
    ({ positionals } = parseArgs({ args, allowPositionals: true, strict: true }));
  } catch {
    writeStderr(USAGE);
    return 1;
  }

  const alias = positionals[0];
  if (!alias || positionals.length !== 1) {
    writeStderr(USAGE);
    return 1;
  }
  if (alias.startsWith('-')) {
    writeStderr(`invalid ssh alias '${alias}': must not start with '-'\n`);
    return 1;
  }

  if (platform !== 'darwin') {
    writeStderr(`ai cp currently supports macOS senders only (got ${platform})\n`);
    return 1;
  }

  const adapter = createAdapter({ platformName: platform });
  const png = adapter?.readImagePng() ?? null;
  if (png === null) {
    writeStderr('no image on clipboard\n');
    return 1;
  }

  let uploaded = false;
  let localTmpDir: string | null = null;
  let remotePath: string | null = null;

  try {
    localTmpDir = mkdtempFn(path.join(tmpdir(), 'agent-infra-cp-'));
    const localPng = path.join(localTmpDir, 'clipboard.png');
    writeFileFn(localPng, png);

    remotePath = `/tmp/agent-infra-cp-${randomId()}.png`;
    const remoteSystem = spawnFn('ssh', [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', alias, 'uname', '-s'
    ]);
    if (remoteSystem.status !== 0) {
      writeStderr(`failed to detect remote platform on ${alias}:\n${commandDetail(remoteSystem)}\n`);
      return 1;
    }
    const remotePlatform = remoteSystem.stdout.trim();
    if (remotePlatform !== 'Darwin' && remotePlatform !== 'Linux') {
      writeStderr(`unsupported remote platform on ${alias}: ${remotePlatform || 'unknown'}\n`);
      return 1;
    }
    if (remotePlatform === 'Linux') {
      const homeCheck = spawnFn('ssh', [
        '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', alias, 'test', '-d', '$HOME/.agent-infra'
      ]);
      if (homeCheck.status !== 0) {
        writeStderr(`remote agent-infra installation is missing on ${alias}\n`);
        return 1;
      }
      const capability = spawnFn('ssh', [
        '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', alias, 'ai', 'cp', '--remote-receive-capability'
      ]);
      if (capability.status !== 0 || capability.stderr !== '' || capability.stdout.replace(/\n$/u, '') !== RECEIVER_CAPABILITY) {
        writeStderr(`remote agent-infra clipboard receiver is unavailable or incompatible on ${alias}; update agent-infra\n`);
        return 1;
      }
    }

    const upload = spawnFn('scp', [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      localPng,
      `${alias}:${remotePath}`
    ]);
    if (upload.status !== 0) {
      writeStderr(`failed to upload image to ${alias}:\n${commandDetail(upload)}\n`);
      return 1;
    }
    uploaded = true;

    const setRemote = remotePlatform === 'Darwin'
      ? spawnFn('ssh', [
        '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', alias, 'osascript', '-'
      ], remoteSetScript(remotePath))
      : spawnFn('ssh', [
        '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', alias, 'ai', 'cp', '--remote-receive-v1', remotePath
      ]);
    if (setRemote.status !== 0) {
      writeStderr(`failed to set remote clipboard on ${alias}:\n${commandDetail(setRemote)}\n`);
      return 1;
    }

    writeStdout(remotePlatform === 'Linux'
      ? `uploaded clipboard image to ${alias}; return to the SSH session and press Ctrl+V\n`
      : `copied clipboard image to ${alias}\n`);
    return 0;
  } finally {
    if (uploaded && remotePath) {
      spawnFn('ssh', [
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        alias,
        'rm',
        '-f',
        remotePath
      ]);
    }
    if (localTmpDir) {
      rmFn(localTmpDir, { recursive: true, force: true });
    }
  }
}

function commandDetail(result: SpawnResult): string {
  const detail = result.stderr || result.error?.message || result.stdout || 'unknown error';
  return detail.trimEnd();
}

function remoteSetScript(remotePath: string): string {
  const escapedPath = remotePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return [
    `set theFile to POSIX file "${escapedPath}"`,
    'set the clipboard to (read theFile as «class PNGf»)'
  ].join('\n');
}
