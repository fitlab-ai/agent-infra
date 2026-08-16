import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { loadServerConfig } from './config.ts';
import type { ServerConfig } from './config.ts';
import { runDaemon } from './daemon.ts';
import {
  getProcessStartTime,
  isProcessAlive,
  processIdentityMatches,
  readProcessState,
  removePidFileIfMatches,
  writePidRecord
} from './process-state.ts';
import type { PidRecord } from './process-state.ts';

export { isProcessAlive } from './process-state.ts';

export type StartOptions = { foreground?: boolean };
export type LogsOptions = { follow?: boolean };

// How to terminate the daemon on a given platform. Pure + exported so the
// win32 branch can be asserted without running on Windows.
export type StopCommand =
  | { kind: 'signal'; signal: NodeJS.Signals }
  | { kind: 'exec'; command: string; args: string[] };

export type ProcessTreeStopCommand =
  | { kind: 'group-signal'; pid: number; signal: NodeJS.Signals }
  | { kind: 'exec'; command: string; args: string[] };

export function buildProcessTreeStopCommand(pid: number, platform: NodeJS.Platform): ProcessTreeStopCommand {
  if (platform === 'win32') {
    return { kind: 'exec', command: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] };
  }
  return { kind: 'group-signal', pid: -pid, signal: 'SIGTERM' };
}

export function buildStopCommand(pid: number, platform: NodeJS.Platform): StopCommand {
  if (platform === 'win32') {
    return { kind: 'exec', command: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] };
  }
  return { kind: 'signal', signal: 'SIGTERM' };
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForProcessIdentity(pid: number, timeoutMs = 2000): Promise<PidRecord | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const startTime = getProcessStartTime(pid);
    if (startTime !== null) return { version: 1, pid, startTime };
    await delay(25);
  }
  return null;
}

function terminateIfMatching(record: PidRecord): void {
  if (!processIdentityMatches(record)) return;
  const command = buildStopCommand(record.pid, process.platform);
  try {
    if (command.kind === 'exec') execFileSync(command.command, command.args);
    else process.kill(record.pid, command.signal);
  } catch {
    // Best effort cleanup for a daemon whose PID record could not be published.
  }
}

function enabledAdapterNames(config: ServerConfig): string[] {
  return Object.entries(config.adapters)
    .filter(([, adapter]) => adapter?.enabled === true)
    .map(([name]) => name);
}

export async function start({ foreground = false }: StartOptions = {}): Promise<void> {
  const config = loadServerConfig();
  const pidPath = config.pidFile;

  const existing = readProcessState(pidPath);
  if (existing.kind === 'running') {
    process.stdout.write(`server already running (pid ${existing.record.pid})\n`);
    return;
  }
  if (existing.kind !== 'missing') {
    removePidFileIfMatches(pidPath, existing.snapshot);
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

  // The initial check, spawn, and record publication are not a mutually
  // exclusive transaction. Atomic publication keeps the record complete, but
  // a separate locking design is required to serialize concurrent starts.
  const record = await waitForProcessIdentity(child.pid);
  if (record === null || !processIdentityMatches(record)) {
    throw new Error('server: unable to verify spawned daemon process identity');
  }
  try {
    writePidRecord(pidPath, record);
  } catch (error) {
    terminateIfMatching(record);
    throw error;
  }
  process.stdout.write(`server started (pid ${record.pid})\n`);
}

export async function stop(): Promise<void> {
  const config = loadServerConfig();
  const state = readProcessState(config.pidFile);

  if (state.kind === 'missing') {
    process.stdout.write('server is not running (no pid file)\n');
    return;
  }
  if (state.kind !== 'running') {
    removePidFileIfMatches(config.pidFile, state.snapshot);
    process.stdout.write('server is not running (removed stale pid file)\n');
    return;
  }

  const { record } = state;
  if (!processIdentityMatches(record)) {
    removePidFileIfMatches(config.pidFile, state.snapshot);
    process.stdout.write('server is not running (removed stale pid file)\n');
    return;
  }

  const command = buildStopCommand(record.pid, process.platform);
  if (command.kind === 'exec') {
    execFileSync(command.command, command.args);
  } else {
    process.kill(record.pid, command.signal);
    const deadline = Date.now() + 5000;
    while (isProcessAlive(record.pid) && Date.now() < deadline) {
      await delay(100);
    }
    if (isProcessAlive(record.pid) && processIdentityMatches(record)) {
      process.kill(record.pid, 'SIGKILL');
    }
  }

  removePidFileIfMatches(config.pidFile, state.snapshot);
  process.stdout.write(`server stopped (pid ${record.pid})\n`);
}

export function status(): void {
  const config = loadServerConfig();
  const state = readProcessState(config.pidFile);

  if (state.kind !== 'running') {
    if (state.kind !== 'missing') removePidFileIfMatches(config.pidFile, state.snapshot);
    process.stdout.write('server: stopped\n');
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
      `  pid: ${state.record.pid}\n` +
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
