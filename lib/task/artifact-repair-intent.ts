import fs from 'node:fs';
import path from 'node:path';

import type { ArtifactSchemaFamily } from './artifact-schema.ts';

type ArtifactRepairIntent = Readonly<{
  version: 1;
  taskId: string;
  family: ArtifactSchemaFamily;
  artifact: string;
  state: 'awaiting-repair' | 'passed' | 'consumed';
  baselineSemanticDigest: string | null;
  artifactSha256: string;
  semanticDigest: string;
}>;

function intentRoot(repoRoot: string): string {
  return path.join(repoRoot, '.agents', 'workspace', '.local-artifact-finalization-intents');
}

function intentPath(repoRoot: string, taskId: string, family: ArtifactSchemaFamily, artifact: string): string {
  return path.join(intentRoot(repoRoot), `${taskId}-${family}-${artifact}.json`);
}

function isArtifactRepairIntent(value: unknown): value is ArtifactRepairIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const intent = value as Record<string, unknown>;
  return intent.version === 1
    && typeof intent.taskId === 'string' && /^TASK-\d{8}-\d{6}$/.test(intent.taskId)
    && typeof intent.family === 'string' && ['analysis', 'review-analysis', 'plan', 'review-plan', 'code', 'review-code'].includes(intent.family)
    && typeof intent.artifact === 'string' && intent.artifact.length > 0
    && ['awaiting-repair', 'passed', 'consumed'].includes(String(intent.state))
    && (intent.baselineSemanticDigest === null || (typeof intent.baselineSemanticDigest === 'string' && /^[a-f0-9]{64}$/.test(intent.baselineSemanticDigest)))
    && typeof intent.artifactSha256 === 'string' && /^[a-f0-9]{64}$/.test(intent.artifactSha256)
    && typeof intent.semanticDigest === 'string' && /^[a-f0-9]{64}$/.test(intent.semanticDigest)
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

function writeArtifactRepairIntent(repoRoot: string, value: ArtifactRepairIntent): void {
  if (!isArtifactRepairIntent(value)) throw new Error('ARTIFACT_REPAIR_INTENT_INVALID: repair provenance schema is invalid');
  const directory = intentRoot(repoRoot);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = intentPath(repoRoot, value.taskId, value.family, value.artifact);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try { fs.renameSync(temporary, target); }
  catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* preserve primary error */ }
    throw error;
  }
}

export { readArtifactRepairIntent, writeArtifactRepairIntent };
export type { ArtifactRepairIntent };
