import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { loadServerConfig } from './config.ts';
import type { ServerConfig } from './config.ts';
import { runDaemon } from './daemon.ts';

export type StartOptions = { foreground?: boolean };
export type LogsOptions = { follow?: boolean };

// How to terminate the daemon on a given platform. Pure + exported so the
// win32 branch can be asserted without running on Windows.
export type StopCommand =
  | { kind: 'signal'; signal: NodeJS.Signals }
  | { kind: 'exec'; command: string; args: string[] };

export function buildStopCommand(pid: number, platform: NodeJS.Platform): StopCommand {
  if (platform === 'win32') {
    return { kind: 'exec', command: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] };
  }
  return { kind: 'signal', signal: 'SIGTERM' };
}


// Liveness check that treats an exited-but-unreaped daemon as dead.
//
// The daemon is spawned detached and re-parented to init when `ai server start`
// exits. After it terminates, `process.kill(pid, 0)` still succeeds until init
// reaps the zombie. On Linux we therefore also check /proc state so status/stop
// /start don't treat an already-exited daemon as running. macOS reaps orphans
// via launchd and Windows has no zombies, so the kill(pid, 0) result is enough.
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    // EPERM means the process exists but we may not signal it → still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // The process state is the first token after the parenthesised comm.
      const state = stat.slice(stat.lastIndexOf(')') + 1).trim().charAt(0);
      if (state === 'Z') return false;
    } catch {
      return false; // /proc entry vanished → not alive
    }
  }
  return true;
}

function readPid(pidFile: string): number | null {
  try {
    const raw = fs.readFileSync(pidFile, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function removePidFile(pidFile: string): void {
  try {
    fs.unlinkSync(pidFile);
  } catch {
    // Already gone.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function enabledAdapterNames(config: ServerConfig): string[] {
  return Object.entries(config.adapters)
    .filter(([, adapter]) => adapter?.enabled === true)
    .map(([name]) => name);
}

export async function start({ foreground = false }: StartOptions = {}): Promise<void> {
  const config = loadServerConfig();
  const pidPath = config.pidFile;

  // Zombie PID cleanup: a stale PID file from a crashed daemon must not block a
  // fresh start.
  const existing = readPid(pidPath);
  if (existing !== null && isProcessAlive(existing)) {
    process.stdout.write(`server already running (pid ${existing})\n`);
    return;
  }
  if (existing !== null) {
    removePidFile(pidPath);
  }

  if (foreground) {
    await runDaemon();
    return;
  }

  const cliEntry = process.argv[1];
  if (!cliEntry) {
    throw new Error('server: unable to determine CLI entry point for daemon spawn');
  }

  // Re-spawn ourselves detached. process.execArgv is forwarded so the dev path
  // (node --experimental-strip-types ./bin/cli.ts) and the built path
  // (node dist/bin/cli.js) both work.
  const child = spawn(process.execPath, [...process.execArgv, cliEntry, 'server', '__daemon'], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  if (typeof child.pid !== 'number') {
    throw new Error('server: failed to spawn daemon process');
  }
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, `${child.pid}\n`);
  process.stdout.write(`server started (pid ${child.pid})\n`);
}

export async function stop(): Promise<void> {
  const config = loadServerConfig();
  const pid = readPid(config.pidFile);

  if (pid === null) {
    process.stdout.write('server is not running (no pid file)\n');
    return;
  }
  if (!isProcessAlive(pid)) {
    removePidFile(config.pidFile);
    process.stdout.write('server is not running (removed stale pid file)\n');
    return;
  }

  const command = buildStopCommand(pid, process.platform);
  if (command.kind === 'exec') {
    execFileSync(command.command, command.args);
  } else {
    process.kill(pid, command.signal);
    const deadline = Date.now() + 5000;
    while (isProcessAlive(pid) && Date.now() < deadline) {
      await delay(100);
    }
    if (isProcessAlive(pid)) {
      process.kill(pid, 'SIGKILL');
    }
  }

  removePidFile(config.pidFile);
  process.stdout.write(`server stopped (pid ${pid})\n`);
}

export function status(): void {
  const config = loadServerConfig();
  const pid = readPid(config.pidFile);

  if (pid === null || !isProcessAlive(pid)) {
    process.stdout.write('server: stopped\n');
    if (pid !== null) {
      process.stdout.write(`  (stale pid file references pid ${pid})\n`);
    }
    return;
  }

  let startedAt = 'unknown';
  try {
    startedAt = fs.statSync(config.pidFile).mtime.toISOString();
  } catch {
    // Leave as unknown.
  }
  const adapters = enabledAdapterNames(config);
  process.stdout.write(
    `server: running\n` +
      `  pid: ${pid}\n` +
      `  started: ${startedAt}\n` +
      `  adapters: ${adapters.length > 0 ? adapters.join(', ') : '(none)'}\n` +
      `  pid file: ${config.pidFile}\n` +
      `  log: ${config.log.path}\n`
  );
}

export async function logs({ follow = false }: LogsOptions = {}): Promise<void> {
  const config = loadServerConfig();
  const logPath = config.log.path;

  if (!fs.existsSync(logPath)) {
    process.stdout.write('server: no log file yet\n');
    return;
  }

  const initial = fs.readFileSync(logPath, 'utf8');
  process.stdout.write(initial);
  if (!follow) return;

  let position = Buffer.byteLength(initial);
  const watcher = fs.watch(logPath, () => {
    try {
      const { size } = fs.statSync(logPath);
      if (size < position) position = 0; // truncated or rotated
      if (size > position) {
        const fd = fs.openSync(logPath, 'r');
        try {
          const buffer = Buffer.alloc(size - position);
          fs.readSync(fd, buffer, 0, buffer.length, position);
          process.stdout.write(buffer.toString('utf8'));
        } finally {
          fs.closeSync(fd);
        }
        position = size;
      }
    } catch {
      // Transient read error during rotation; ignore and wait for next event.
    }
  });

  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => {
      watcher.close();
      resolve();
    });
  });
}
