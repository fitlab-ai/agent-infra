import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SANDBOX_CONTROL_IDENTITY_FILE = 'identity.json';

export type SandboxControlIdentitySentinel = Readonly<{
  version: 1;
  mode: 'task-bound' | 'branch-only';
  taskId: string | null;
  generation: string;
  controlRootId: string;
}>;

export type SandboxControlIdentityValidation = Readonly<{
  state: 'valid' | 'missing' | 'malformed' | 'generation-mismatch' | 'root-id-mismatch' | 'topology-mismatch';
  sentinel: SandboxControlIdentitySentinel | null;
}>;

function identityError(code: SandboxControlIdentityValidation['state']): Error {
  return new Error(`SANDBOX_CONTROL_IDENTITY_${code.replaceAll('-', '_').toUpperCase()}`);
}

function canonicalIdentity(value: SandboxControlIdentitySentinel): string {
  return JSON.stringify({
    version: value.version,
    mode: value.mode,
    taskId: value.taskId,
    generation: value.generation,
    controlRootId: value.controlRootId
  });
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function identitySentinelPath(publicStatusDir: string): string {
  return path.join(publicStatusDir, SANDBOX_CONTROL_IDENTITY_FILE);
}

export function createSandboxControlRootId(): string {
  return `${randomBytes(32).toString('hex')}${randomUUID().replaceAll('-', '')}`;
}

export function createSandboxControlIdentitySentinel(params: Readonly<{
  mode: 'task-bound' | 'branch-only';
  taskId: string | null;
  generation: string;
  controlRootId?: string;
}>): SandboxControlIdentitySentinel {
  const sentinel: SandboxControlIdentitySentinel = {
    version: 1,
    mode: params.mode,
    taskId: params.mode === 'task-bound' ? params.taskId : null,
    generation: params.generation,
    controlRootId: params.controlRootId ?? createSandboxControlRootId()
  };
  parseSandboxControlIdentitySentinel(sentinel);
  return sentinel;
}

export function identityDigest(value: SandboxControlIdentitySentinel): string {
  const normalized = parseSandboxControlIdentitySentinel(value);
  return createHash('sha256').update(canonicalIdentity(normalized), 'utf8').digest('hex');
}

export function parseSandboxControlIdentitySentinel(value: unknown): SandboxControlIdentitySentinel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw identityError('malformed');
  const candidate = value as Partial<SandboxControlIdentitySentinel>;
  if (Object.keys(candidate).sort().join(',') !== 'controlRootId,generation,mode,taskId,version'
    || candidate.version !== 1
    || (candidate.mode !== 'task-bound' && candidate.mode !== 'branch-only')
    || (candidate.taskId !== null && typeof candidate.taskId !== 'string')
    || (candidate.mode === 'task-bound' && !candidate.taskId)
    || (candidate.mode === 'branch-only' && candidate.taskId !== null)
    || typeof candidate.generation !== 'string' || candidate.generation.length === 0
    || typeof candidate.controlRootId !== 'string' || !/^[a-f0-9]{64,128}$/u.test(candidate.controlRootId)) {
    throw identityError('malformed');
  }
  return candidate as SandboxControlIdentitySentinel;
}

export function writeSandboxControlIdentitySentinel(
  publicStatusDir: string,
  value: SandboxControlIdentitySentinel
): SandboxControlIdentitySentinel {
  const sentinel = parseSandboxControlIdentitySentinel(value);
  fs.mkdirSync(publicStatusDir, { recursive: true, mode: 0o700 });
  const target = identitySentinelPath(publicStatusDir);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const encoded = `${canonicalIdentity(sentinel)}\n`;
  const descriptor = fs.openSync(temporary, 'wx', 0o400);
  try {
    fs.writeFileSync(descriptor, encoded, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o400);
    fsyncDirectory(publicStatusDir);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return sentinel;
}

export function readSandboxControlIdentitySentinel(publicStatusDir: string): SandboxControlIdentitySentinel {
  const filePath = identitySentinelPath(publicStatusDir);
  if (!fs.existsSync(filePath)) throw identityError('missing');
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw identityError('malformed');
    return parseSandboxControlIdentitySentinel(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('SANDBOX_CONTROL_IDENTITY_')) throw error;
    throw identityError('malformed');
  }
}

export function validateSandboxControlIdentity(params: Readonly<{
  publicStatusDir: string;
  root: string;
  manifestRoot?: string;
  mode: 'task-bound' | 'branch-only';
  taskId: string | null;
  generation: string;
  controlRootId: string;
}>): SandboxControlIdentityValidation {
  let sentinel: SandboxControlIdentitySentinel;
  try {
    sentinel = readSandboxControlIdentitySentinel(params.publicStatusDir);
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code.endsWith('MISSING')) return { state: 'missing', sentinel: null };
    return { state: 'malformed', sentinel: null };
  }
  if (sentinel.generation !== params.generation) return { state: 'generation-mismatch', sentinel };
  if (sentinel.controlRootId !== params.controlRootId) return { state: 'root-id-mismatch', sentinel };
  if (sentinel.mode !== params.mode || sentinel.taskId !== params.taskId) return { state: 'topology-mismatch', sentinel };
  if (params.manifestRoot && path.resolve(params.manifestRoot) !== path.resolve(params.root)) {
    return { state: 'topology-mismatch', sentinel };
  }
  return { state: 'valid', sentinel };
}

export function assertSandboxControlIdentity(params: Parameters<typeof validateSandboxControlIdentity>[0]): SandboxControlIdentitySentinel {
  const result = validateSandboxControlIdentity(params);
  if (result.state !== 'valid' || !result.sentinel) {
    throw new Error(`SANDBOX_CONTROL_IDENTITY_${result.state.replaceAll('-', '_').toUpperCase()}`);
  }
  return result.sentinel;
}
