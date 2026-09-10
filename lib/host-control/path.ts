import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const HOST_CONTROL_DIRECTORY_MODE = 0o700;
export const HOST_CONTROL_SOCKET_MODE = 0o600;
export const HOST_CONTROL_WORKER_TOKEN_MODE = 0o600;

export type HostControlPlatform = 'linux' | 'darwin' | 'unsupported';

export type HostControlEndpointOptions = Readonly<{
  platform?: HostControlPlatform;
  uid?: number;
  username?: string;
}>;

function currentPlatform(): HostControlPlatform {
  if (process.platform === 'linux' || process.platform === 'darwin') return process.platform;
  return 'unsupported';
}

function validUid(uid: number | undefined): number {
  const resolved = uid ?? process.getuid?.();
  if (!Number.isInteger(resolved) || resolved === undefined || resolved < 0) {
    throw new Error('HOST_CONTROL_ENDPOINT_INVALID: uid is unavailable');
  }
  return resolved;
}

function validUsername(username: string | undefined): string {
  const resolved = username ?? os.userInfo({ encoding: 'utf8' }).username;
  if (!/^[A-Za-z0-9._-]+$/u.test(resolved)) {
    throw new Error('HOST_CONTROL_ENDPOINT_INVALID: username is invalid');
  }
  return resolved;
}

export function resolveHostControlEndpoint(options: HostControlEndpointOptions = {}): string {
  const platform = options.platform ?? currentPlatform();
  if (platform === 'linux') return `/run/user/${validUid(options.uid)}/agent-infra/host-control.sock`;
  if (platform === 'darwin') return path.posix.join(
    '/Users',
    validUsername(options.username),
    'Library',
    'Application Support',
    'agent-infra',
    'run',
    'host-control.sock'
  );
  throw new Error('HOST_CONTROL_UNSUPPORTED_PLATFORM');
}

export function hostControlWorkerTokenPath(endpoint: string): string {
  return `${endpoint}.worker-token`;
}

function assertWorkerTokenFile(tokenPath: string, uid = process.getuid?.()): string {
  const stat = fs.lstatSync(tokenPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('HOST_CONTROL_WORKER_TOKEN_INVALID');
  if ((stat.mode & 0o777) !== HOST_CONTROL_WORKER_TOKEN_MODE) throw new Error('HOST_CONTROL_WORKER_TOKEN_MODE_INVALID');
  if (uid !== undefined && stat.uid !== uid) throw new Error('HOST_CONTROL_WORKER_TOKEN_OWNER_INVALID');
  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/u.test(token)) throw new Error('HOST_CONTROL_WORKER_TOKEN_INVALID');
  return token;
}

export function ensureHostControlWorkerToken(endpoint: string, uid = process.getuid?.()): string {
  const tokenPath = hostControlWorkerTokenPath(endpoint);
  try {
    return assertWorkerTokenFile(tokenPath, uid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const token = randomBytes(32).toString('hex');
  try {
    const fd = fs.openSync(tokenPath, 'wx', HOST_CONTROL_WORKER_TOKEN_MODE);
    try {
      fs.writeFileSync(fd, `${token}\n`, 'utf8');
      fs.fchmodSync(fd, HOST_CONTROL_WORKER_TOKEN_MODE);
      if (uid !== undefined && process.getuid?.() === uid) fs.fchownSync(fd, uid, process.getgid?.() ?? -1);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return assertWorkerTokenFile(tokenPath, uid);
}

export function readHostControlWorkerToken(endpoint: string, uid = process.getuid?.()): string {
  return assertWorkerTokenFile(hostControlWorkerTokenPath(endpoint), uid);
}

export function removeHostControlWorkerToken(endpoint: string): void {
  try {
    fs.unlinkSync(hostControlWorkerTokenPath(endpoint));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export type HostControlEndpointInspection = Readonly<{
  ok: boolean;
  code: string | null;
  ownerUid?: number;
  mode?: number;
  parentMode?: number;
}>;

export function inspectHostControlEndpoint(
  endpoint: string,
  expected: Readonly<{ uid?: number }> = {}
): HostControlEndpointInspection {
  let endpointStat: fs.Stats;
  let parentStat: fs.Stats;
  try {
    endpointStat = fs.lstatSync(endpoint);
    parentStat = fs.lstatSync(path.dirname(endpoint));
  } catch {
    return { ok: false, code: 'HOST_CONTROL_ENDPOINT_MISSING' };
  }
  if (endpointStat.isSymbolicLink()) return { ok: false, code: 'HOST_CONTROL_ENDPOINT_SYMLINK' };
  if (!endpointStat.isSocket()) return { ok: false, code: 'HOST_CONTROL_ENDPOINT_NOT_SOCKET' };
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    return { ok: false, code: 'HOST_CONTROL_PARENT_INVALID' };
  }
  let ancestor = path.dirname(endpoint);
  while (true) {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(ancestor); } catch { return { ok: false, code: 'HOST_CONTROL_PARENT_INVALID' }; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { ok: false, code: 'HOST_CONTROL_PARENT_INVALID' };
    const next = path.dirname(ancestor);
    if (next === ancestor) break;
    ancestor = next;
  }
  const mode = endpointStat.mode & 0o777;
  const parentMode = parentStat.mode & 0o777;
  if (mode !== HOST_CONTROL_SOCKET_MODE) return { ok: false, code: 'HOST_CONTROL_ENDPOINT_MODE_INVALID', ownerUid: endpointStat.uid, mode, parentMode };
  if (parentMode !== HOST_CONTROL_DIRECTORY_MODE) return { ok: false, code: 'HOST_CONTROL_PARENT_MODE_INVALID', ownerUid: endpointStat.uid, mode, parentMode };
  if (expected.uid !== undefined && endpointStat.uid !== expected.uid) {
    return { ok: false, code: 'HOST_CONTROL_ENDPOINT_OWNER_INVALID', ownerUid: endpointStat.uid, mode, parentMode };
  }
  if (expected.uid !== undefined && parentStat.uid !== expected.uid) {
    return { ok: false, code: 'HOST_CONTROL_PARENT_OWNER_INVALID', ownerUid: parentStat.uid, mode, parentMode };
  }
  return { ok: true, code: null, ownerUid: endpointStat.uid, mode, parentMode };
}

export function prepareHostControlDirectory(endpoint: string, uid = process.getuid?.()): string {
  const directory = path.dirname(endpoint);
  const segments = path.resolve(directory).split(path.sep);
  let current = path.isAbsolute(directory) ? path.sep : '';
  for (const segment of segments.filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('HOST_CONTROL_PARENT_INVALID');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  fs.mkdirSync(directory, { recursive: true, mode: HOST_CONTROL_DIRECTORY_MODE });
  fs.chmodSync(directory, HOST_CONTROL_DIRECTORY_MODE);
  if (uid !== undefined && process.getuid?.() === uid) fs.chownSync(directory, uid, process.getgid?.() ?? -1);
  return directory;
}
