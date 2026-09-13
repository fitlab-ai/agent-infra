import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { ArtifactSchemaFamily } from './artifact-schema.ts';
import { parseArtifactName } from './artifact-name.ts';

export type ArtifactRecoveryPhase =
  | 'orchestration.prepare'
  | 'artifact.finalize-local'
  | 'task-event.completed';
export type ArtifactRecoveryState =
  | 'awaiting-recovery'
  | 'finalize-ready'
  | 'commit-started'
  | 'passed'
  | 'consumed'
  | 'aborted';

export type ArtifactRecoveryIntent = Readonly<{
  version: 3;
  taskId: string;
  family: ArtifactSchemaFamily;
  artifact: string;
  round: number;
  state: ArtifactRecoveryState;
  baselineSha256: string;
  baselineSemanticDigest: string;
  stagingId: string;
  candidateSha256: string | null;
  finalArtifactSha256: string | null;
  finalSemanticDigest: string | null;
  recoveryOperationId: string;
  phase: ArtifactRecoveryPhase | null;
  authorityDigest: string | null;
  requestId: string;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}>;

export function artifactRecoveryIntentRoot(repoRoot: string): string {
  return path.join(repoRoot, '.agents', 'workspace', '.local-artifact-finalization-intents');
}

export function artifactRecoveryRoot(repoRoot: string, taskId: string, stagingId: string): string {
  return path.join(repoRoot, '.agents', 'workspace', '.local-artifact-recovery', taskId, stagingId);
}

function intentPath(repoRoot: string, taskId: string, family: ArtifactSchemaFamily, artifact: string): string {
  return path.join(artifactRecoveryIntentRoot(repoRoot), `${taskId}-${family}-${artifact}.json`);
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function validTaskId(value: unknown): value is string {
  return typeof value === 'string' && /^TASK-\d{8}-\d{6}$/u.test(value);
}

function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\r\n]/u.test(value);
}

function validRecoveryId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9-]{16,64}$/u.test(value);
}

function validArtifact(value: unknown, family: unknown, round: unknown): value is string {
  if (typeof value !== 'string' || path.basename(value) !== value || !value.endsWith('.md')) return false;
  const parsed = parseArtifactName(value);
  return Boolean(parsed && parsed.family === family && parsed.round === round);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

export function isArtifactRecoveryIntent(value: unknown): value is ArtifactRecoveryIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const intent = value as Record<string, unknown>;
  return exactKeys(intent, [
    'artifact', 'authorityDigest', 'baselineSemanticDigest', 'baselineSha256', 'candidateSha256',
    'createdAt', 'errorCode', 'errorMessage', 'family', 'finalArtifactSha256', 'finalSemanticDigest',
    'phase', 'recoveryOperationId', 'requestId', 'round', 'stagingId', 'state', 'taskId', 'updatedAt',
    'version'
  ])
    && intent.version === 3
    && validTaskId(intent.taskId)
    && typeof intent.family === 'string'
    && ['analysis', 'review-analysis', 'plan', 'review-plan', 'code', 'review-code'].includes(intent.family)
    && Number.isSafeInteger(intent.round) && (intent.round as number) > 0
    && validArtifact(intent.artifact, intent.family, intent.round)
    && ['awaiting-recovery', 'finalize-ready', 'commit-started', 'passed', 'consumed', 'aborted'].includes(String(intent.state))
    && validDigest(intent.baselineSha256)
    && validDigest(intent.baselineSemanticDigest)
    && validRecoveryId(intent.stagingId)
    && (intent.candidateSha256 === null || validDigest(intent.candidateSha256))
    && (intent.finalArtifactSha256 === null || validDigest(intent.finalArtifactSha256))
    && (intent.finalSemanticDigest === null || validDigest(intent.finalSemanticDigest))
    && validRecoveryId(intent.recoveryOperationId)
    && intent.stagingId === intent.recoveryOperationId
    && (intent.phase === null || ['orchestration.prepare', 'artifact.finalize-local', 'task-event.completed'].includes(String(intent.phase)))
    && (intent.authorityDigest === null || validDigest(intent.authorityDigest))
    && validToken(intent.requestId)
    && (intent.errorCode === null || validToken(intent.errorCode))
    && (intent.errorMessage === null || validToken(intent.errorMessage))
    && Number.isSafeInteger(intent.createdAt)
    && Number.isSafeInteger(intent.updatedAt)
    && (intent.state === 'awaiting-recovery'
      ? intent.finalArtifactSha256 === null && intent.finalSemanticDigest === null
      : true)
    && (intent.state === 'finalize-ready' || intent.state === 'commit-started' || intent.state === 'passed' || intent.state === 'consumed'
      ? validDigest(intent.candidateSha256) && validDigest(intent.finalArtifactSha256) && validDigest(intent.finalSemanticDigest)
      : true)
    && (intent.state === 'aborted' ? intent.errorCode !== null && intent.errorMessage !== null : true);
}

export function readArtifactRecoveryIntent(
  repoRoot: string,
  taskId: string,
  family: ArtifactSchemaFamily,
  artifact: string
): ArtifactRecoveryIntent | null {
  if (!validTaskId(taskId) || !validArtifact(artifact, family, parseArtifactName(artifact)?.round)) {
    throw new Error('ARTIFACT_RECOVERY_INTENT_INVALID: recovery journal identity is invalid');
  }
  const target = intentPath(repoRoot, taskId, family, artifact);
  if (!fs.existsSync(target)) return null;
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(target, 'utf8')) as unknown; }
  catch (error) { throw new Error(`ARTIFACT_RECOVERY_INTENT_INVALID: ${String(error)}`); }
  if (!isArtifactRecoveryIntent(value) || value.taskId !== taskId || value.family !== family || value.artifact !== artifact) {
    throw new Error('ARTIFACT_RECOVERY_INTENT_INVALID: recovery journal schema is invalid');
  }
  return value;
}

export function writeArtifactRecoveryIntent(
  repoRoot: string,
  value: unknown,
  options: Readonly<{ expected?: ArtifactRecoveryIntent | null }> = {}
): void {
  if (!isArtifactRecoveryIntent(value)) throw new Error('ARTIFACT_RECOVERY_INTENT_INVALID: recovery journal schema is invalid');
  const intent = value;
  const directory = artifactRecoveryIntentRoot(repoRoot);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = intentPath(repoRoot, intent.taskId, intent.family, intent.artifact);
  const lock = `${target}.lock`;
  let descriptor: number;
  try { descriptor = fs.openSync(lock, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('ARTIFACT_RECOVERY_INTENT_CONFLICT: another journal writer owns the intent');
    }
    throw error;
  }
  try {
    const current = fs.existsSync(target)
      ? readArtifactRecoveryIntent(repoRoot, intent.taskId, intent.family, intent.artifact)
      : null;
    if (!isDeepStrictEqual(current, options.expected ?? null)) {
      throw new Error('ARTIFACT_RECOVERY_INTENT_CONFLICT: recovery journal changed during finalization');
    }
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(intent)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { fs.renameSync(temporary, target); }
    catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* preserve the primary error */ }
      throw error;
    }
  } finally {
    fs.closeSync(descriptor);
    try { fs.unlinkSync(lock); } catch { /* preserve the primary result */ }
  }
}

export function findArtifactRecoveryIntentsByOperation(
  repoRoot: string,
  operationId: string
): readonly ArtifactRecoveryIntent[] {
  if (!validToken(operationId)) throw new Error('ARTIFACT_RECOVERY_OPERATION_INVALID: recovery operation id is invalid');
  const directory = artifactRecoveryIntentRoot(repoRoot);
  if (!fs.existsSync(directory)) return Object.freeze([]);
  return Object.freeze(fs.readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const target = path.join(directory, name);
      let value: unknown;
      try { value = JSON.parse(fs.readFileSync(target, 'utf8')) as unknown; }
      catch (error) { throw new Error(`ARTIFACT_RECOVERY_INTENT_INVALID: ${String(error)}`); }
      if (!isArtifactRecoveryIntent(value)) throw new Error('ARTIFACT_RECOVERY_INTENT_INVALID: recovery journal schema is invalid');
      return value;
    })
    .filter((value) => value.recoveryOperationId === operationId));
}

export { intentPath as artifactRecoveryIntentPath };
