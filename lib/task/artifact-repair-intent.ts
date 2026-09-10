import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { ArtifactSchemaFamily } from './artifact-schema.ts';

export type ArtifactRepairPhase =
  | 'orchestration.prepare'
  | 'artifact.finalize-local'
  | 'task-event.completed';
export type ArtifactRepairState = 'awaiting-repair' | 'finalize-ready' | 'commit-started' | 'passed' | 'consumed';

export type ArtifactRepairIntent = Readonly<{
  version: 2;
  taskId: string;
  family: ArtifactSchemaFamily;
  artifact: string;
  state: ArtifactRepairState;
  baselineSemanticDigest: string | null;
  artifactSha256: string;
  semanticDigest: string;
  recoveryOperationId: string | null;
  phase: ArtifactRepairPhase | null;
  authorityDigest: string | null;
  requestId: string;
  createdAt: number;
  updatedAt: number;
}>;

function intentRoot(repoRoot: string): string {
  return path.join(repoRoot, '.agents', 'workspace', '.local-artifact-finalization-intents');
}

function intentPath(repoRoot: string, taskId: string, family: ArtifactSchemaFamily, artifact: string): string {
  return path.join(intentRoot(repoRoot), `${taskId}-${family}-${artifact}.json`);
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function validTaskId(value: unknown): value is string {
  return typeof value === 'string' && /^TASK-\d{8}-\d{6}$/u.test(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

export function isArtifactRepairIntent(value: unknown): value is ArtifactRepairIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const intent = value as Record<string, unknown>;
  return exactKeys(intent, [
    'artifact', 'artifactSha256', 'authorityDigest', 'baselineSemanticDigest', 'createdAt',
    'family', 'phase', 'recoveryOperationId', 'requestId', 'semanticDigest', 'state',
    'taskId', 'updatedAt', 'version'
  ])
    && intent.version === 2
    && validTaskId(intent.taskId)
    && typeof intent.family === 'string'
    && ['analysis', 'review-analysis', 'plan', 'review-plan', 'code', 'review-code'].includes(intent.family)
    && typeof intent.artifact === 'string' && intent.artifact.length > 0
    && ['awaiting-repair', 'finalize-ready', 'commit-started', 'passed', 'consumed'].includes(String(intent.state))
    && (intent.baselineSemanticDigest === null || validDigest(intent.baselineSemanticDigest))
    && validDigest(intent.artifactSha256)
    && validDigest(intent.semanticDigest)
    && (intent.recoveryOperationId === null || (typeof intent.recoveryOperationId === 'string' && /^[a-f0-9-]{16,64}$/u.test(intent.recoveryOperationId)))
    && (intent.phase === null || ['orchestration.prepare', 'artifact.finalize-local', 'task-event.completed'].includes(String(intent.phase)))
    && (intent.authorityDigest === null || validDigest(intent.authorityDigest))
    && typeof intent.requestId === 'string' && intent.requestId.length > 0 && !/[\r\n]/u.test(intent.requestId)
    && Number.isSafeInteger(intent.createdAt) && Number.isSafeInteger(intent.updatedAt)
    && (intent.state === 'awaiting-repair' ? intent.baselineSemanticDigest === intent.semanticDigest : true);
}

function readArtifactRepairIntent(
  repoRoot: string,
  taskId: string,
  family: ArtifactSchemaFamily,
  artifact: string
): ArtifactRepairIntent | null {
  const target = intentPath(repoRoot, taskId, family, artifact);
  if (!fs.existsSync(target)) return null;
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(target, 'utf8')) as unknown; }
  catch (error) { throw new Error(`ARTIFACT_REPAIR_INTENT_INVALID: ${String(error)}`); }
  if (!isArtifactRepairIntent(value) || value.taskId !== taskId || value.family !== family || value.artifact !== artifact) {
    throw new Error('ARTIFACT_REPAIR_INTENT_INVALID: repair provenance schema is invalid');
  }
  return value;
}

export function writeArtifactRepairIntent(
  repoRoot: string,
  value: ArtifactRepairIntent,
  options: Readonly<{ expected?: ArtifactRepairIntent | null }> = {}
): void {
  if (!isArtifactRepairIntent(value)) throw new Error('ARTIFACT_REPAIR_INTENT_INVALID: repair provenance schema is invalid');
  const directory = intentRoot(repoRoot);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = intentPath(repoRoot, value.taskId, value.family, value.artifact);
  const lock = `${target}.lock`;
  let descriptor: number;
  try { descriptor = fs.openSync(lock, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('ARTIFACT_REPAIR_INTENT_CONFLICT: another provenance writer owns the intent');
    }
    throw error;
  }
  try {
    const current = fs.existsSync(target)
      ? readArtifactRepairIntent(repoRoot, value.taskId, value.family, value.artifact)
      : null;
    if (!isDeepStrictEqual(current, options.expected ?? null)) {
      throw new Error('ARTIFACT_REPAIR_INTENT_CONFLICT: repair provenance changed during finalization');
    }
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { fs.renameSync(temporary, target); }
    catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* preserve primary error */ }
      throw error;
    }
  } finally {
    fs.closeSync(descriptor);
    try { fs.unlinkSync(lock); } catch { /* preserve the primary result */ }
  }
}

export function findArtifactRepairIntentsByOperation(
  repoRoot: string,
  operationId: string
): readonly ArtifactRepairIntent[] {
  if (!operationId || /[\r\n]/u.test(operationId)) {
    throw new Error('ARTIFACT_REPAIR_OPERATION_INVALID: recovery operation id is invalid');
  }
  const directory = intentRoot(repoRoot);
  if (!fs.existsSync(directory)) return Object.freeze([]);
  return Object.freeze(fs.readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const target = path.join(directory, name);
      let value: unknown;
      try { value = JSON.parse(fs.readFileSync(target, 'utf8')) as unknown; }
      catch (error) { throw new Error(`ARTIFACT_REPAIR_INTENT_INVALID: ${String(error)}`); }
      if (!isArtifactRepairIntent(value)) throw new Error('ARTIFACT_REPAIR_INTENT_INVALID: repair provenance schema is invalid');
      return value;
    })
    .filter((value) => value.recoveryOperationId === operationId));
}

export { readArtifactRepairIntent };
