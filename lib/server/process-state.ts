import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export type PidRecord = {
  version: 1;
  pid: number;
  startTime: string;
};

export type ProcessStartTimeQuery = { command: string; args: string[] };

export type ProcessState =
  | { kind: 'missing'; snapshot: null }
  | { kind: 'invalid'; snapshot: string }
  | { kind: 'legacy'; snapshot: string; pid: number }
  | { kind: 'stale'; snapshot: string; record: PidRecord }
  | { kind: 'running'; snapshot: string; record: PidRecord };

export type LinuxProcessStat = { state: string; startTime: string };

export function parseLinuxProcessStat(raw: string): LinuxProcessStat | null {
  const closeParen = raw.lastIndexOf(')');
  if (closeParen < 0) return null;
  const fields = raw.slice(closeParen + 1).trim().split(/\s+/);
  const state = fields[0];
  const startTime = fields[19];
  if (typeof state !== 'string' || state.length !== 1 || !/^\d+$/.test(startTime ?? '')) {
    return null;
  }
  return { state, startTime: startTime! };
}

export function buildProcessStartTimeQuery(
  pid: number,
  platform: NodeJS.Platform
): ProcessStartTimeQuery | null {
  if (platform === 'darwin') {
    return { command: 'ps', args: ['-p', String(pid), '-o', 'lstart='] };
  }
  if (platform === 'win32') {
    const script =
      `$process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; ` +
      `if ($null -ne $process) { $process.CreationDate.ToUniversalTime().ToString('o') }`;
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', script]
    };
  }
  return null;
}

export function isProcessAlive(pid: number, platform: NodeJS.Platform = process.platform): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (platform === 'linux') {
    try {
      const stat = parseLinuxProcessStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
      return stat !== null && stat.state !== 'Z';
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function getProcessStartTime(
  pid: number,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === 'linux') {
    try {
      const stat = parseLinuxProcessStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
      return stat !== null && stat.state !== 'Z' ? stat.startTime : null;
    } catch {
      return null;
    }
  }
  if (!isProcessAlive(pid, platform)) return null;
  const query = buildProcessStartTimeQuery(pid, platform);
  if (query === null) return null;
  try {
    const output = execFileSync(query.command, query.args, { encoding: 'utf8' }).trim();
    if (output.length === 0) return null;
    if (platform === 'win32') {
      const timestamp = new Date(output);
      return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
    }
    return output;
  } catch {
    return null;
  }
}

function parsePidRecord(raw: string): { kind: 'invalid' } | { kind: 'legacy'; pid: number } | { kind: 'record'; record: PidRecord } {
  const trimmed = raw.trim();
  if (/^[1-9]\d*$/.test(trimmed)) {
    const pid = Number(trimmed);
    return Number.isSafeInteger(pid) ? { kind: 'legacy', pid } : { kind: 'invalid' };
  }
  try {
    const value = JSON.parse(trimmed) as Partial<PidRecord> | null;
    if (
      value !== null &&
      value.version === 1 &&
      Number.isSafeInteger(value.pid) &&
      (value.pid ?? 0) > 0 &&
      typeof value.startTime === 'string' &&
      value.startTime.length > 0
    ) {
      return {
        kind: 'record',
        record: { version: 1, pid: value.pid!, startTime: value.startTime }
      };
    }
  } catch {
    // Invalid JSON is an invalid PID record.
  }
  return { kind: 'invalid' };
}

export function readProcessState(pidFile: string): ProcessState {
  let snapshot: string;
  try {
    snapshot = fs.readFileSync(pidFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing', snapshot: null };
    return { kind: 'invalid', snapshot: '' };
  }

  const parsed = parsePidRecord(snapshot);
  if (parsed.kind === 'invalid') return { kind: 'invalid', snapshot };
  if (parsed.kind === 'legacy') return { kind: 'legacy', snapshot, pid: parsed.pid };

  const currentStartTime = getProcessStartTime(parsed.record.pid);
  if (currentStartTime === null || currentStartTime !== parsed.record.startTime) {
    return { kind: 'stale', snapshot, record: parsed.record };
  }
  return { kind: 'running', snapshot, record: parsed.record };
}

export function writePidRecord(pidFile: string, record: PidRecord): void {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  const temporary = `${pidFile}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`);
    fs.renameSync(temporary, pidFile);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temporary file was never created or was already renamed.
    }
    throw error;
  }
}

export function removePidFileIfMatches(pidFile: string, expectedSnapshot: string | null): boolean {
  if (expectedSnapshot === null) return false;
  try {
    if (fs.readFileSync(pidFile, 'utf8') !== expectedSnapshot) return false;
    fs.unlinkSync(pidFile);
    return true;
  } catch {
    return false;
  }
}

export function removePidRecordIfMatches(pidFile: string, expected: PidRecord): boolean {
  const state = readProcessState(pidFile);
  if (state.kind !== 'running') return false;
  if (state.record.pid !== expected.pid || state.record.startTime !== expected.startTime) return false;
  return removePidFileIfMatches(pidFile, state.snapshot);
}

export function processIdentityMatches(record: PidRecord): boolean {
  return getProcessStartTime(record.pid) === record.startTime;
}
