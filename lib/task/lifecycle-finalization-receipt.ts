import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { parseArtifactName } from './artifact-name.ts';
import type { ArtifactSchemaFamily } from './artifact-schema.ts';
import { readControllerAuthorityState } from '../sandbox/control/controller-authority-state.ts';

export type LifecycleFinalizationReceipt = Readonly<{
  version: 1;
  taskId: string;
  family: ArtifactSchemaFamily;
  artifact: string;
  round: number;
  artifactSha256: string;
  semanticDigest: string;
  operationId: string;
  finalizer: 'artifact' | 'review';
  authorityMode: 'direct-host' | 'sandbox-inactive' | 'sandbox-active';
  authorityDigest: string | null;
  state: 'pending' | 'consumed';
  createdAt: number;
  updatedAt: number;
}>;

type ReceiptInput = Pick<LifecycleFinalizationReceipt,
  'taskId' | 'family' | 'artifact' | 'round' | 'artifactSha256' | 'semanticDigest' | 'finalizer' | 'authorityMode' | 'authorityDigest'>;

const HEX = /^[a-f0-9]{64}$/u;

function fail(code: string): never { throw new Error(code); }

function root(repoRoot: string): string {
  return path.join(repoRoot, '.agents', 'workspace', '.local-lifecycle-finalization-receipts');
}

function receiptPath(repoRoot: string, taskId: string, family: ArtifactSchemaFamily, artifact: string): string {
  return path.join(root(repoRoot), `${taskId}-${family}-${artifact}.json`);
}

function validReceipt(value: unknown): value is LifecycleFinalizationReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as LifecycleFinalizationReceipt;
  const parsed = parseArtifactName(receipt.artifact);
  return receipt.version === 1
    && /^TASK-\d{8}-\d{6}$/u.test(receipt.taskId)
    && parsed?.family === receipt.family && parsed.round === receipt.round
    && HEX.test(receipt.artifactSha256) && HEX.test(receipt.semanticDigest)
    && /^[a-f0-9-]{16,64}$/u.test(receipt.operationId)
    && ['artifact', 'review'].includes(receipt.finalizer)
    && ['direct-host', 'sandbox-inactive', 'sandbox-active'].includes(receipt.authorityMode)
    && (receipt.authorityDigest === null || HEX.test(receipt.authorityDigest))
    && ['pending', 'consumed'].includes(receipt.state)
    && Number.isSafeInteger(receipt.createdAt) && Number.isSafeInteger(receipt.updatedAt);
}

export function readLifecycleFinalizationReceipt(
  repoRoot: string,
  taskId: string,
  family: ArtifactSchemaFamily,
  artifact: string
): LifecycleFinalizationReceipt | null {
  const file = receiptPath(repoRoot, taskId, family, artifact);
  if (!fs.existsSync(file)) return null;
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fail('LIFECYCLE_FINALIZATION_RECEIPT_INVALID'); }
  if (!validReceipt(value) || value.taskId !== taskId || value.family !== family || value.artifact !== artifact) {
    return fail('LIFECYCLE_FINALIZATION_RECEIPT_INVALID');
  }
  return value;
}

function writeReceipt(
  repoRoot: string,
  receipt: LifecycleFinalizationReceipt,
  expected: LifecycleFinalizationReceipt | null
): LifecycleFinalizationReceipt {
  if (!validReceipt(receipt)) return fail('LIFECYCLE_FINALIZATION_RECEIPT_INVALID');
  const directory = root(repoRoot);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = receiptPath(repoRoot, receipt.taskId, receipt.family, receipt.artifact);
  const lock = `${file}.lock`;
  let descriptor: number;
  try { descriptor = fs.openSync(lock, 'wx', 0o600); }
  catch { return fail('LIFECYCLE_FINALIZATION_RECEIPT_CONFLICT'); }
  try {
    const current = fs.existsSync(file)
      ? readLifecycleFinalizationReceipt(repoRoot, receipt.taskId, receipt.family, receipt.artifact)
      : null;
    if (!isDeepStrictEqual(current, expected)) return fail('LIFECYCLE_FINALIZATION_RECEIPT_CONFLICT');
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
    return receipt;
  } finally {
    fs.closeSync(descriptor!);
    fs.rmSync(lock, { force: true });
  }
}

export function recordLifecycleFinalizationReceipt(
  repoRoot: string,
  input: ReceiptInput,
  options: Readonly<{ operationId?: string; now?: number }> = {}
): LifecycleFinalizationReceipt {
  const parsed = parseArtifactName(input.artifact);
  if (!parsed || parsed.family !== input.family || parsed.round !== input.round
    || !HEX.test(input.artifactSha256) || !HEX.test(input.semanticDigest)) {
    return fail('LIFECYCLE_FINALIZATION_RECEIPT_INVALID');
  }
  const existing = readLifecycleFinalizationReceipt(repoRoot, input.taskId, input.family, input.artifact);
  if (existing) {
    const same = existing.artifactSha256 === input.artifactSha256
      && existing.semanticDigest === input.semanticDigest
      && existing.finalizer === input.finalizer
      && existing.authorityMode === input.authorityMode
      && existing.authorityDigest === input.authorityDigest;
    if (same) return existing;
    if (existing.state === 'pending') return fail('LIFECYCLE_FINALIZATION_RECEIPT_CONFLICT');
  }
  const now = options.now ?? Date.now();
  const receipt: LifecycleFinalizationReceipt = {
    version: 1,
    ...input,
    operationId: options.operationId ?? crypto.randomUUID(),
    state: 'pending',
    createdAt: now,
    updatedAt: now
  };
  return writeReceipt(repoRoot, receipt, existing);
}

export function consumeLifecycleFinalizationReceipt(
  repoRoot: string,
  receipt: LifecycleFinalizationReceipt,
  now = Date.now()
): LifecycleFinalizationReceipt {
  const current = readLifecycleFinalizationReceipt(repoRoot, receipt.taskId, receipt.family, receipt.artifact);
  if (!current || !isDeepStrictEqual(current, receipt)) return fail('LIFECYCLE_FINALIZATION_RECEIPT_CONFLICT');
  if (current.state === 'consumed') return current;
  return writeReceipt(repoRoot, { ...current, state: 'consumed', updatedAt: now }, current);
}

export function currentLifecycleAuthorityMode(
  env: NodeJS.ProcessEnv = process.env,
  expectedTaskId?: string
): LifecycleFinalizationReceipt['authorityMode'] {
  return currentLifecycleAuthority(env, expectedTaskId).mode;
}

export function currentLifecycleAuthority(
  env: NodeJS.ProcessEnv = process.env,
  expectedTaskId?: string
): Readonly<{
  mode: LifecycleFinalizationReceipt['authorityMode'];
  digest: string | null;
}> {
  if (!env.AGENT_INFRA_TASK_ID
    || (expectedTaskId !== undefined && env.AGENT_INFRA_TASK_ID !== expectedTaskId)
    || !env.AGENT_INFRA_CONTROL_STATUS_DIR
    || !env.AGENT_INFRA_CONTROL_GENERATION
    || !env.AGENT_INFRA_CONTROL_ROOT_ID) {
    return { mode: 'direct-host', digest: null };
  }
  const statusDir = env.AGENT_INFRA_CONTROL_STATUS_DIR ?? '/run/agent-infra/control-status';
  const state = readControllerAuthorityState(statusDir);
  if (state.state === 'inactive') return { mode: 'sandbox-inactive', digest: null };
  if (state.state === 'active') return {
    mode: 'sandbox-active',
    digest: crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex')
  };
  return fail(`CONTROLLER_AUTHORITY_${state.state.toUpperCase()}`);
}

export { receiptPath as lifecycleFinalizationReceiptPath };
