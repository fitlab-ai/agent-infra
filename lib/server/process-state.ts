import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export type ProcessStartTime = number;

export type ProcessIdentity = Readonly<{
  pid: number;
  startTime: ProcessStartTime;
}>;

export type ProcessIdentityState = 'alive' | 'dead' | 'unknown';
export type ProcessIdentityProbe = (identity: ProcessIdentity) => ProcessIdentityState;

export type PidRecord = ProcessIdentity & {
  version: 2;
};

export type ProcessStartTimeQuery = { command: string; args: string[] };

export type ProcessState =
  | { kind: 'missing'; snapshot: null }
  | { kind: 'legacy-json'; snapshot: string; legacy: LegacyProcessSnapshot }
  | { kind: 'legacy-pid-only'; snapshot: string; legacy: LegacyProcessSnapshot }
  | { kind: 'legacy-unknown'; snapshot: string; legacy: LegacyProcessSnapshot; reason: string }
  | { kind: 'stale'; snapshot: string; record: PidRecord }
  | { kind: 'running'; snapshot: string; record: PidRecord };

export type LegacyProcessSnapshot = Readonly<{
  pid?: number;
  raw: string;
  format: 'json-v1' | 'pid-only' | 'malformed';
}>;

export type LinuxProcessStat = { state: string; startTime: number };

export function parseLinuxProcessStat(raw: string): LinuxProcessStat | null {
  const closeParen = raw.lastIndexOf(')');
  if (closeParen < 0) return null;
  const fields = raw.slice(closeParen + 1).trim().split(/\s+/);
  const state = fields[0];
  const startTime = fields[19];
  if (typeof state !== 'string' || state.length !== 1 || !/^\d+$/.test(startTime ?? '')) {
    return null;
  }
  const numericStartTime = Number(startTime);
  if (!Number.isSafeInteger(numericStartTime)) return null;
  return { state, startTime: numericStartTime };
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

export function parseDarwinStartTime(output: string): number | null {
  const match = output.trim().match(/^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) ([A-Z][a-z]{2})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/);
  if (!match) return null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months.indexOf(match[1]!);
  if (month < 0) return null;
  const timestamp = Date.UTC(
    Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])
  );
  return Number.isNaN(timestamp) ? null : timestamp;
}

export function getProcessStartTime(
  pid: number,
  platform: NodeJS.Platform = process.platform
): ProcessStartTime | null {
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
    const output = execFileSync(query.command, query.args, {
      encoding: 'utf8',
      env: platform === 'darwin' ? { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' } : process.env
    }).trim();
    if (output.length === 0) return null;
    if (platform === 'win32') {
      const timestamp = new Date(output);
      return Number.isNaN(timestamp.getTime()) ? null : timestamp.getTime();
    }
    if (platform === 'darwin') return parseDarwinStartTime(output);
    return null;
  } catch {
    return null;
  }
}

export function getProcessIdentityState(
  identity: ProcessIdentity,
  platform: NodeJS.Platform = process.platform
): ProcessIdentityState {
  if (!Number.isInteger(identity.pid) || identity.pid <= 0 || !Number.isSafeInteger(identity.startTime)) {
    return 'dead';
  }
  if (platform === 'linux') {
    try {
      const stat = parseLinuxProcessStat(fs.readFileSync(`/proc/${identity.pid}/stat`, 'utf8'));
      if (stat === null) return 'unknown';
      if (stat.state === 'Z') return 'dead';
      return stat.startTime === identity.startTime ? 'alive' : 'dead';
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'dead' : 'unknown';
    }
  }
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code !== 'EPERM') return 'unknown';
  }
  const query = buildProcessStartTimeQuery(identity.pid, platform);
  if (query === null) return 'unknown';
  try {
    const output = execFileSync(query.command, query.args, {
      encoding: 'utf8',
      env: platform === 'darwin' ? { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' } : process.env
    }).trim();
    if (output.length === 0) return 'unknown';
    const startTime = platform === 'win32'
      ? new Date(output).getTime()
      : platform === 'darwin'
        ? parseDarwinStartTime(output)
        : null;
    if (startTime === null || Number.isNaN(startTime)) return 'unknown';
    return startTime === identity.startTime ? 'alive' : 'dead';
  } catch {
    return 'unknown';
  }
}

function parsePidRecord(
  raw: string
):
  | { kind: 'legacy-json'; legacy: LegacyProcessSnapshot }
  | { kind: 'legacy-pid-only'; legacy: LegacyProcessSnapshot }
  | { kind: 'legacy-unknown'; legacy: LegacyProcessSnapshot; reason: string }
  | { kind: 'record'; record: PidRecord } {
  const trimmed = raw.trim();
  if (/^[1-9]\d*$/.test(trimmed)) {
    const pid = Number(trimmed);
    return Number.isSafeInteger(pid)
      ? { kind: 'legacy-pid-only', legacy: { pid, raw, format: 'pid-only' } }
      : { kind: 'legacy-unknown', legacy: { raw, format: 'malformed' }, reason: 'pid is not a safe integer' };
  }
  try {
    const value = JSON.parse(trimmed) as { version?: unknown; pid?: unknown; startTime?: unknown } | null;
    const pidValue: unknown = value?.pid;
    const startTimeValue: unknown = value?.startTime;
    if (
      value !== null &&
      value.version === 2 &&
      typeof pidValue === 'number' &&
      Number.isSafeInteger(pidValue) &&
      pidValue > 0 &&
      typeof startTimeValue === 'number' &&
      Number.isSafeInteger(startTimeValue) &&
      startTimeValue >= 0
    ) {
      const startTime = startTimeValue as number;
      return {
        kind: 'record',
        record: { version: 2, pid: pidValue, startTime }
      };
    }
    if (
      value !== null &&
      value.version === 1 &&
      typeof pidValue === 'number' &&
      Number.isSafeInteger(pidValue) &&
      pidValue > 0 &&
      typeof value.startTime === 'string' &&
      value.startTime.length > 0
    ) {
      return { kind: 'legacy-json', legacy: { pid: pidValue, raw, format: 'json-v1' } };
    }
    return { kind: 'legacy-unknown', legacy: { raw, format: 'malformed' }, reason: 'unsupported PID record schema' };
  } catch {
    return { kind: 'legacy-unknown', legacy: { raw, format: 'malformed' }, reason: 'invalid PID record JSON' };
  }
}

export function readProcessState(pidFile: string): ProcessState {
  let snapshot: string;
  try {
    snapshot = fs.readFileSync(pidFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing', snapshot: null };
    return { kind: 'legacy-unknown', snapshot: '', legacy: { raw: '', format: 'malformed' }, reason: 'PID record cannot be read' };
  }

  const parsed = parsePidRecord(snapshot);
  if (parsed.kind === 'legacy-json') return { kind: parsed.kind, snapshot, legacy: parsed.legacy };
  if (parsed.kind === 'legacy-pid-only') return { kind: parsed.kind, snapshot, legacy: parsed.legacy };
  if (parsed.kind === 'legacy-unknown') return { kind: parsed.kind, snapshot, legacy: parsed.legacy, reason: parsed.reason };

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

export function processIdentityMatches(identity: ProcessIdentity): boolean {
  return getProcessIdentityState(identity) === 'alive';
}
