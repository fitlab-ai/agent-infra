import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SandboxControlManifest, SandboxControlFamily, SandboxControlRequest } from './protocol.ts';
import { identityDigest as digestIdentity } from './identity-sentinel.ts';
import { acquireSandboxResourceLock } from './native-file-lock.ts';

export const SANDBOX_CONTROL_AUDIT_PHASES = Object.freeze([
  'validated', 'gated', 'reserved', 'prepared', 'accepted-authorized', 'accepted-committed',
  'start-authorized', 'started-committed', 'completed', 'evidence-written',
  'publish-authorized', 'published-committed', 'rejected', 'recovered'
] as const);
export type SandboxControlAuditPhase = typeof SANDBOX_CONTROL_AUDIT_PHASES[number];
export type SandboxControlAuditOutcome = 'not-executed' | 'in-progress' | 'success' | 'failure' | 'unknown' | 'rejected';

export type SandboxControlAuditContext = Readonly<{
  requestId: string;
  taskId: string | null;
  family: SandboxControlFamily | null;
  operation: string | null;
  phase: SandboxControlAuditPhase;
  outcome: SandboxControlAuditOutcome;
  generation: string;
  identityDigest: string;
}>;

export type SandboxControlTransition = Readonly<{
  version: 1;
  requestId: string;
  generation: string;
  phase: SandboxControlAuditPhase;
  at: number;
  identityDigest: string;
  reference: string | null;
}>;

const REQUEST_ID = /^[a-f0-9-]{16,64}$/u;
const SAFE_OPERATION = /^[a-z][a-z0-9.-]{0,96}$/u;
const AUDIT_MAX_BYTES = 1024 * 1024;

export function requestAuditFields(manifest: SandboxControlManifest, request: SandboxControlRequest) {
  return {
    requestId: request.id, requestFamily: request.family, sandboxTaskId: manifest.taskId,
    requestGeneration: request.generation, requestIssuedAt: request.issuedAt, requestExpiresAt: request.expiresAt
  };
}

export function resultAuditFields(result: Readonly<{ exitCode: number; stdout: string; stderr: string }>) {
  return {
    exitCode: result.exitCode,
    outputBytes: Buffer.byteLength(result.stdout, 'utf8'), errorBytes: Buffer.byteLength(result.stderr, 'utf8'),
    outputDigest: createHash('sha256').update(result.stdout, 'utf8').digest('hex'),
    errorDigest: createHash('sha256').update(result.stderr, 'utf8').digest('hex')
  };
}

function auditRoot(manifest: SandboxControlManifest): string {
  return path.dirname(path.resolve(manifest.publicStatusDir));
}

function auditPath(manifest: SandboxControlManifest): string {
  return path.join(auditRoot(manifest), 'audit.ndjson');
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function manifestIdentityDigest(manifest: SandboxControlManifest): string {
  return digestIdentity({
    version: 1,
    mode: manifest.mode,
    taskId: manifest.taskId,
    generation: manifest.generation,
    controlRootId: manifest.controlRootId
  });
}

export function createSandboxControlAuditContext(
  manifest: SandboxControlManifest,
  params: Readonly<{
    requestId: string;
    family: SandboxControlFamily | null;
    operation?: string | null;
    phase: SandboxControlAuditPhase;
    outcome: SandboxControlAuditOutcome;
  }>
): SandboxControlAuditContext {
  if (!REQUEST_ID.test(params.requestId)) throw new Error('SANDBOX_CONTROL_AUDIT_REQUEST_INVALID');
  if (params.operation !== null && params.operation !== undefined && !SAFE_OPERATION.test(params.operation)) {
    throw new Error('SANDBOX_CONTROL_AUDIT_OPERATION_INVALID');
  }
  if (!SANDBOX_CONTROL_AUDIT_PHASES.includes(params.phase)) throw new Error('SANDBOX_CONTROL_AUDIT_PHASE_INVALID');
  return {
    requestId: params.requestId,
    taskId: manifest.taskId,
    family: params.family,
    operation: params.operation ?? null,
    phase: params.phase,
    outcome: params.outcome,
    generation: manifest.generation,
    identityDigest: manifestIdentityDigest(manifest)
  };
}

function safeFields(fields: Readonly<Record<string, string | number | boolean | null>>): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!/^[a-z][a-zA-Z0-9]{0,63}$/u.test(key)) continue;
    if (/(token|secret|credential|proof|password|path|root|cwd|stdout|stderr|args|command|taskref)/iu.test(key)) continue;
    if (typeof value === 'string' && value.length > 256) continue;
    result[key] = value;
  }
  return result;
}

function requestHasTerminalTransition(directory: string): boolean {
  const transitions = path.join(directory, 'transitions');
  if (!fs.existsSync(transitions)) return false;
  return ['published-committed', 'recovered'].some((phase) => fs.existsSync(path.join(transitions, `${phase}.json`)));
}

function hasActiveRequest(manifest: SandboxControlManifest): boolean {
  if (!fs.existsSync(manifest.processingDir)) return false;
  return fs.readdirSync(manifest.processingDir, { withFileTypes: true })
    .some((entry) => entry.isDirectory() && REQUEST_ID.test(entry.name)
      && !requestHasTerminalTransition(path.join(manifest.processingDir, entry.name)));
}

function rotateAuditUnderLock(manifest: SandboxControlManifest, filePath: string): void {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size < AUDIT_MAX_BYTES) return;
  if (hasActiveRequest(manifest)) return;
  fs.rmSync(`${filePath}.1`, { force: true });
  fs.renameSync(filePath, `${filePath}.1`);
  fsyncDirectory(auditRoot(manifest));
  const descriptor = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function appendAuditRecord(
  manifest: SandboxControlManifest,
  record: Readonly<Record<string, unknown>>,
  critical: boolean
): void {
  const root = auditRoot(manifest);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = acquireSandboxResourceLock(`sandbox-control-audit:${root}`);
  try {
    const filePath = auditPath(manifest);
    rotateAuditUnderLock(manifest, filePath);
    const descriptor = fs.openSync(filePath, 'a', 0o600);
    try {
      fs.writeSync(descriptor, `${JSON.stringify(record)}\n`, undefined, 'utf8');
      if (critical) fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    if (critical) throw new Error(`SANDBOX_CONTROL_AUDIT_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    lock.release();
  }
}

export function appendCriticalAudit(
  manifest: SandboxControlManifest,
  context: SandboxControlAuditContext,
  fields: Readonly<Record<string, string | number | boolean | null>> = {},
  now = Date.now()
): void {
  appendAuditRecord(manifest, {
    version: 2,
    at: now,
    event: context.phase,
    ...context,
    ...safeFields(fields)
  }, true);
}

export function appendDiagnosticAudit(
  manifest: SandboxControlManifest,
  event: string,
  fields: Readonly<Record<string, string | number | boolean | null>> = {},
  now = Date.now()
): void {
  try {
    appendAuditRecord(manifest, {
      version: 2,
      at: now,
      event,
      generation: manifest.generation,
      identityDigest: manifestIdentityDigest(manifest),
      ...safeFields(fields)
    }, false);
  } catch {
    // Diagnostics are deliberately best effort.
  }
}

function transitionPath(manifest: SandboxControlManifest, requestId: string, phase: SandboxControlAuditPhase): string {
  if (!REQUEST_ID.test(requestId)) throw new Error('SANDBOX_CONTROL_TRANSITION_REQUEST_INVALID');
  return path.join(manifest.processingDir, requestId, 'transitions', `${phase}.json`);
}

export function writeSandboxControlTransition(
  manifest: SandboxControlManifest,
  params: Readonly<{
    requestId: string;
    phase: SandboxControlAuditPhase;
    reference?: string | null;
    now?: number;
  }>
): SandboxControlTransition {
  const transition: SandboxControlTransition = {
    version: 1,
    requestId: params.requestId,
    generation: manifest.generation,
    phase: params.phase,
    at: params.now ?? Date.now(),
    identityDigest: manifestIdentityDigest(manifest),
    reference: params.reference ?? null
  };
  const target = transitionPath(manifest, params.requestId, params.phase);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const encoded = `${JSON.stringify(transition)}\n`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, encoded, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.linkSync(temporary, target);
    fsyncDirectory(path.dirname(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = readSandboxControlTransition(manifest, params.requestId, params.phase);
    if (JSON.stringify(existing) !== JSON.stringify(transition)) throw new Error('SANDBOX_CONTROL_TRANSITION_CONFLICT');
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return transition;
}

export function readSandboxControlTransition(
  manifest: SandboxControlManifest,
  requestId: string,
  phase: SandboxControlAuditPhase
): SandboxControlTransition {
  const filePath = transitionPath(manifest, requestId, phase);
  if (!fs.existsSync(filePath)) throw new Error('SANDBOX_CONTROL_TRANSITION_MISSING');
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { throw new Error('SANDBOX_CONTROL_TRANSITION_INVALID'); }
  const candidate = value as Partial<SandboxControlTransition> | null;
  if (!candidate || candidate.version !== 1 || candidate.requestId !== requestId
    || candidate.generation !== manifest.generation || candidate.phase !== phase
    || !Number.isSafeInteger(candidate.at) || typeof candidate.identityDigest !== 'string'
    || (candidate.reference !== null && typeof candidate.reference !== 'string')) {
    throw new Error('SANDBOX_CONTROL_TRANSITION_INVALID');
  }
  return candidate as SandboxControlTransition;
}

export function listSandboxControlTransitions(manifest: SandboxControlManifest, requestId: string): SandboxControlTransition[] {
  const directory = path.join(manifest.processingDir, requestId, 'transitions');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -5))
    .filter((phase): phase is SandboxControlAuditPhase => SANDBOX_CONTROL_AUDIT_PHASES.includes(phase as SandboxControlAuditPhase))
    .map((phase) => readSandboxControlTransition(manifest, requestId, phase));
}
