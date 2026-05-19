import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ExecFileSyncOptions, StdioOptions, SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

type CommandOptions = {
  cwd?: string;
  encoding?: BufferEncoding;
  stdio?: StdioOptions;
  timeout?: number;
  shell?: boolean;
};

type RunProbeOptions = CommandOptions & {
  spawnFn?: typeof spawnSync;
};

function normalizeOptions(opts: CommandOptions = {}, stdio: StdioOptions): CommandOptions {
  return {
    cwd: opts.cwd,
    encoding: opts.encoding,
    stdio,
    timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS
  };
}

function resolveCommand(cmd: string): string {
  if (process.platform !== 'win32' || path.extname(cmd)) {
    return cmd;
  }

  const pathValue = process.env.Path || process.env.PATH || '';
  const extensions = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean);

  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${cmd}${extension.toLowerCase()}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
      const upperCandidate = path.join(dir, `${cmd}${extension.toUpperCase()}`);
      if (fs.existsSync(upperCandidate)) {
        return upperCandidate;
      }
    }
  }

  return cmd;
}

function commandOptions<T extends CommandOptions>(cmd: string, opts: T): T | (T & { shell: true }) {
  if (process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(cmd)) {
    return { ...opts, shell: true };
  }
  return opts;
}

export function run(cmd: string, args: string[], opts: CommandOptions = {}): string {
  const resolved = resolveCommand(cmd);
  return execFileSync(resolved, args, commandOptions(resolved, {
    ...normalizeOptions(opts, ['pipe', 'pipe', 'pipe']),
    encoding: 'utf8'
  })).trim();
}

export function runOk(cmd: string, args: string[], opts: CommandOptions = {}): boolean {
  const resolved = resolveCommand(cmd);
  const result = spawnSync(resolved, args, commandOptions(resolved, normalizeOptions(opts, 'pipe')));
  return result.status === 0;
}

export function restoreTerminal(): void {
  if (!process.stdout.isTTY) {
    return;
  }

  try {
    process.stdout.write([
      '\x1b[?1049l',
      '\x1b[?25h',
      '\x1b>',
      '\x1b[?1000l',
      '\x1b[?1002l',
      '\x1b[?1003l',
      '\x1b[?1006l'
    ].join(''));
  } catch {
    // Best-effort cleanup only; preserve the original command result.
  }

  if (process.platform === 'win32') {
    return;
  }

  try {
    execFileSync('stty', ['sane'], { stdio: 'inherit' });
  } catch {
    // Some environments do not provide stty or reject sane; ANSI reset still helps.
  }
}

export function runInteractive(cmd: string, args: string[], opts: CommandOptions = {}): number {
  const resolved = resolveCommand(cmd);
  try {
    const result = spawnSync(resolved, args, commandOptions(resolved, normalizeOptions(opts, 'inherit')));
    return result.status ?? 1;
  } finally {
    restoreTerminal();
  }
}

export function runVerbose(cmd: string, args: string[], opts: CommandOptions = {}): void {
  const resolved = resolveCommand(cmd);
  const result = spawnSync(resolved, args, commandOptions(resolved, normalizeOptions(opts, 'inherit')));

  if (result.status !== 0) {
    if (result.signal === 'SIGTERM') {
      throw new Error(`Command timed out after ${opts.timeout ?? DEFAULT_TIMEOUT_MS}ms: ${cmd}`);
    }
    throw new Error(`Command failed with exit code ${result.status}: ${cmd}`);
  }
}

export function runSafe(cmd: string, args: string[], opts: CommandOptions = {}): string {
  const resolved = resolveCommand(cmd);
  const result = spawnSync(resolved, args, commandOptions(resolved, {
    ...normalizeOptions(opts, ['pipe', 'pipe', 'pipe']),
    encoding: 'utf8',
  }));
  if (result.status !== 0 && result.stderr) {
    process.stderr.write(result.stderr);
  }
  return (result.stdout ?? '').trim();
}

export function commandForEngine(engine: string, cmd: string, args: string[] = []): { cmd: string; args: string[] } {
  if (engine === 'wsl2') {
    const resolvedWrapper = resolveCommand('wsl.exe');
    return { cmd: resolvedWrapper, args: ['--', cmd, ...args] };
  }

  return { cmd, args };
}

export function runEngine(engine: string, cmd: string, args: string[], opts: CommandOptions = {}): string {
  const command = commandForEngine(engine, cmd, args);
  return run(command.cmd, command.args, opts);
}

export function execEngine(engine: string, cmd: string, args: string[], opts: ExecFileSyncOptions = {}) {
  const command = commandForEngine(engine, cmd, args);
  return execFileSync(command.cmd, command.args, opts);
}

export function runOkEngine(engine: string, cmd: string, args: string[], opts: CommandOptions = {}): boolean {
  const command = commandForEngine(engine, cmd, args);
  return runOk(command.cmd, command.args, opts);
}

export function runSafeEngine(engine: string, cmd: string, args: string[], opts: CommandOptions = {}): string {
  const command = commandForEngine(engine, cmd, args);
  return runSafe(command.cmd, command.args, opts);
}

export function runVerboseEngine(engine: string, cmd: string, args: string[], opts: CommandOptions = {}): void {
  const command = commandForEngine(engine, cmd, args);
  return runVerbose(command.cmd, command.args, opts);
}

export function runInteractiveEngine(engine: string, cmd: string, args: string[], opts: CommandOptions = {}): number {
  const command = commandForEngine(engine, cmd, args);
  return runInteractive(command.cmd, command.args, opts);
}

export function runProbe(cmd: string, args: string[], opts: RunProbeOptions = {}): SpawnSyncReturns<string | Buffer> {
  const { spawnFn = spawnSync, ...commandOpts } = opts;
  const resolved = resolveCommand(cmd);
  return spawnFn(resolved, args, commandOptions(resolved, normalizeOptions(
    { encoding: 'utf8', ...commandOpts },
    commandOpts.stdio ?? ['pipe', 'pipe', 'pipe']
  )));
}
