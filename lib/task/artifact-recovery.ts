import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { writeDurableFile } from '../fs/durable-write.ts';
import { readStableFileSync } from '../host-control/secure-fs.ts';
import { parseArtifactName } from './artifact-name.ts';
import { canonicalSemanticDigest, sha256Content } from './artifact-operations.ts';
import {
  artifactRecoveryRoot,
  readArtifactRecoveryIntent,
  writeArtifactRecoveryIntent
} from './artifact-repair-intent.ts';
import type {
  ArtifactRecoveryIntent,
  ArtifactRecoveryPhase,
  ArtifactRecoveryState
} from './artifact-repair-intent.ts';
import type { ArtifactSchemaFamily } from './artifact-schema.ts';
import { withTaskExecutionLock } from './task-execution-lock.ts';

const MAX_ARTIFACT_BYTES = 1024 * 1024;

export type ArtifactRecoveryTuple = Readonly<{
  taskId: string;
  family: ArtifactSchemaFamily;
  artifact: string;
  round: number;
  requestId: string;
  phase?: ArtifactRecoveryPhase | null;
  authorityDigest?: string | null;
}>;

export type ArtifactRecoveryContext = Readonly<ArtifactRecoveryTuple & {
  repoRoot: string;
  taskDir: string;
  recoveryId: string;
  stagingId: string;
  formalPath: string;
  stagingPath: string;
  baselinePath: string;
  generationsPath: string;
  baselineSha256: string;
  baselineSemanticDigest: string;
}>;

export type ArtifactRecoveryOptions = Readonly<{
  repoRoot: string;
  taskDir: string;
  recoveryId?: string;
  lockAlreadyHeld?: boolean;
  expectedFinalSha256?: string;
  expectedFinalSemanticDigest?: string;
}>;

export type StagedArtifactCandidate = Readonly<{
  recoveryId: string;
  candidateSha256: string;
  semanticDigest: string;
  path: string;
}>;

export type ArtifactRecoveryReconcileResult = Readonly<{
  status: ArtifactRecoveryState | 'indeterminate';
  intent: ArtifactRecoveryIntent;
}>;

export class ArtifactRecoveryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ArtifactRecoveryError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ArtifactRecoveryError(code, message);
}

function runLocked<T>(
  context: Pick<ArtifactRecoveryContext, 'repoRoot' | 'taskId'>,
  owner: string,
  callback: () => T,
  lockAlreadyHeld = false
): T {
  return lockAlreadyHeld ? callback() : withTaskExecutionLock(context.repoRoot, context.taskId, owner, callback);
}

function assertTaskId(taskId: string): void {
  if (!/^TASK-\d{8}-\d{6}$/u.test(taskId)) fail('ARTIFACT_RECOVERY_IDENTITY_INVALID', 'task id is invalid');
}

function assertDigest(value: string, name: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) fail('ARTIFACT_RECOVERY_DIGEST_INVALID', `${name} must be a lowercase SHA-256 digest`);
}

function assertRecoveryId(value: string): void {
  if (!/^[a-f0-9-]{16,64}$/u.test(value)) fail('ARTIFACT_RECOVERY_IDENTITY_INVALID', 'recovery id is invalid');
}

function assertTuple(tuple: ArtifactRecoveryTuple): void {
  assertTaskId(tuple.taskId);
  if (path.basename(tuple.artifact) !== tuple.artifact || !tuple.artifact.endsWith('.md')) {
    fail('ARTIFACT_RECOVERY_TARGET_INVALID', 'artifact must be a canonical top-level Markdown file');
  }
  const parsed = parseArtifactName(tuple.artifact);
  if (!parsed || parsed.family !== tuple.family || parsed.round !== tuple.round) {
    fail('ARTIFACT_RECOVERY_IDENTITY_INVALID', 'artifact tuple does not match its canonical family and round');
  }
  if (!tuple.requestId || /[\r\n]/u.test(tuple.requestId)) fail('ARTIFACT_RECOVERY_IDENTITY_INVALID', 'request id is invalid');
  if (!Number.isSafeInteger(tuple.round) || tuple.round < 1) fail('ARTIFACT_RECOVERY_IDENTITY_INVALID', 'round is invalid');
}

function assertDirectory(directory: string, label: string): void {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(directory); }
  catch (error) { fail('ARTIFACT_RECOVERY_PATH_INVALID', `${label} is unavailable: ${String(error)}`); }
  if (!stat!.isDirectory() || stat!.isSymbolicLink()) fail('ARTIFACT_RECOVERY_PATH_INVALID', `${label} must be a real directory`);
}

function assertRegular(file: string, label: string): fs.Stats {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) { fail('ARTIFACT_RECOVERY_PATH_INVALID', `${label} is unavailable: ${String(error)}`); }
  if (stat!.isSymbolicLink() || !stat!.isFile()) fail('ARTIFACT_RECOVERY_PATH_INVALID', `${label} must be a regular file`);
  return stat!;
}

function ensureOwnedDirectoryTree(rootInput: string, targetInput: string): void {
  const root = path.resolve(rootInput);
  const target = path.resolve(targetInput);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('ARTIFACT_RECOVERY_PATH_INVALID', 'recovery staging must remain inside the repository');
  }
  assertDirectory(root, 'repository root');
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        fail('ARTIFACT_RECOVERY_PATH_INVALID', `recovery directory is unavailable: ${String(error)}`);
      }
      try { fs.mkdirSync(current, { mode: 0o700 }); }
      catch (mkdirError) { fail('ARTIFACT_RECOVERY_PATH_INVALID', `recovery directory could not be created: ${String(mkdirError)}`); }
      try { stat = fs.lstatSync(current); }
      catch (lstatError) { fail('ARTIFACT_RECOVERY_PATH_INVALID', `recovery directory could not be verified: ${String(lstatError)}`); }
    }
    if (stat!.isSymbolicLink() || !stat!.isDirectory()) fail('ARTIFACT_RECOVERY_PATH_INVALID', 'recovery directory must be a real directory');
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && stat!.uid !== process.getuid()) {
      fail('ARTIFACT_RECOVERY_PATH_INVALID', 'recovery directory is not owned by the current user');
    }
  }
}

function assertRecoveryRoot(context: ArtifactRecoveryContext): void {
  ensureOwnedDirectoryTree(context.repoRoot, path.dirname(context.stagingPath));
}

function unlinkIfPresent(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function writeBytes(target: string, bytes: Buffer): void {
  if (bytes.length > MAX_ARTIFACT_BYTES) fail('ARTIFACT_RECOVERY_SIZE_LIMIT', 'candidate exceeds the bounded artifact size limit');
  writeDurableFile(target, bytes.toString('utf8'), { mode: 0o600, replace: true });
}

function contextPaths(
  tuple: ArtifactRecoveryTuple,
  options: ArtifactRecoveryOptions,
  recoveryId: string
): ArtifactRecoveryContext {
  const taskDir = path.resolve(options.taskDir);
  const root = artifactRecoveryRoot(taskDir, recoveryId);
  return {
    ...tuple,
    repoRoot: options.repoRoot,
    taskDir,
    recoveryId,
    stagingId: recoveryId,
    formalPath: path.join(taskDir, tuple.artifact),
    stagingPath: path.join(root, 'candidate.md'),
    baselinePath: path.join(root, 'baseline.md'),
    generationsPath: path.join(root, 'generations'),
    baselineSha256: '',
    baselineSemanticDigest: ''
  };
}

function readIntentForContext(context: ArtifactRecoveryContext): ArtifactRecoveryIntent {
  const intent = readArtifactRecoveryIntent(context.repoRoot, context.taskId, context.family, context.artifact);
  if (!intent) fail('ARTIFACT_RECOVERY_INTENT_MISSING', 'recovery journal is missing');
  if (intent.recoveryOperationId !== context.recoveryId
    || intent.stagingId !== context.stagingId
    || intent.round !== context.round
    || intent.requestId !== context.requestId) {
    fail('ARTIFACT_RECOVERY_IDENTITY_INVALID', 'recovery context does not match the journal');
  }
  return intent;
}

function contextWithIntent(context: ArtifactRecoveryContext, intent: ArtifactRecoveryIntent): ArtifactRecoveryContext {
  return {
    ...context,
    phase: intent.phase,
    authorityDigest: intent.authorityDigest,
    baselineSha256: intent.baselineSha256,
    baselineSemanticDigest: intent.baselineSemanticDigest
  };
}

function createIntent(context: ArtifactRecoveryContext, now: number): ArtifactRecoveryIntent {
  return {
    version: 4,
    taskId: context.taskId,
    family: context.family,
    artifact: context.artifact,
    round: context.round,
    state: 'awaiting-preflight-recovery',
    baselineSha256: context.baselineSha256,
    baselineSemanticDigest: context.baselineSemanticDigest,
    stagingId: context.stagingId,
    candidateSha256: context.baselineSha256,
    preflightArtifactSha256: null,
    preflightSemanticDigest: null,
    activeGenerationSha256: null,
    activeGenerationSemanticDigest: null,
    pendingGenerationSha256: null,
    pendingGenerationSemanticDigest: null,
    finalArtifactSha256: null,
    finalSemanticDigest: null,
    recoveryOperationId: context.recoveryId,
    phase: context.phase ?? null,
    authorityDigest: context.authorityDigest ?? null,
    requestId: context.requestId,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now
  };
}

export function beginArtifactRecovery(
  tuple: ArtifactRecoveryTuple,
  baselineBytes: Buffer,
  options: ArtifactRecoveryOptions
): ArtifactRecoveryContext {
  assertTuple(tuple);
  assertDirectory(options.taskDir, 'task directory');
  const context = contextPaths(tuple, options, options.recoveryId ?? randomUUID());
  assertRecoveryId(context.recoveryId);
  const targetStat = assertRegular(context.formalPath, 'formal artifact');
  const rootParent = path.dirname(context.stagingPath);
  ensureOwnedDirectoryTree(options.repoRoot, rootParent);
  const stagingStat = fs.lstatSync(rootParent);
  if (stagingStat.dev !== targetStat.dev) fail('ARTIFACT_RECOVERY_PATH_INVALID', 'recovery staging must share the formal artifact file system');
  const baselineSha256 = sha256Content(baselineBytes.toString('utf8'));
  const prepared = { ...context, baselineSha256, baselineSemanticDigest: canonicalSemanticDigest(baselineBytes.toString('utf8')) };
  return runLocked(prepared, 'task-artifact.recovery.begin', () => {
    assertRecoveryRoot(prepared);
    const current = readStableFileSync(prepared.formalPath, { maxBytes: MAX_ARTIFACT_BYTES }).bytes;
    if (sha256Content(current.toString('utf8')) !== baselineSha256 || !current.equals(baselineBytes)) {
      fail('ARTIFACT_RECOVERY_BASELINE_MISMATCH', 'formal artifact does not match the recovery baseline');
    }
    const existing = readArtifactRecoveryIntent(prepared.repoRoot, prepared.taskId, prepared.family, prepared.artifact);
    if (existing && existing.state !== 'aborted' && existing.state !== 'consumed') {
      fail('ARTIFACT_RECOVERY_CONFLICT', 'an active recovery journal already exists for this artifact');
    }
    writeBytes(prepared.baselinePath, baselineBytes);
    writeBytes(prepared.stagingPath, baselineBytes);
    writeArtifactRecoveryIntent(prepared.repoRoot, createIntent(prepared, Date.now()), { expected: existing });
    return prepared;
  }, options.lockAlreadyHeld);
}

export function recordArtifactRecoveryPassed(
  tuple: ArtifactRecoveryTuple,
  options: ArtifactRecoveryOptions
): ArtifactRecoveryContext {
  assertTuple(tuple);
  assertDirectory(options.taskDir, 'task directory');
  const context = contextPaths(tuple, options, options.recoveryId ?? randomUUID());
  assertRecoveryId(context.recoveryId);
  assertRegular(context.formalPath, 'formal artifact');
  return runLocked(context, 'task-artifact.recovery.record-passed', () => {
    assertRecoveryRoot(context);
    const current = readStableFileSync(context.formalPath, { maxBytes: MAX_ARTIFACT_BYTES });
    const prepared = {
      ...context,
      baselineSha256: current.sha256,
      baselineSemanticDigest: canonicalSemanticDigest(current.bytes.toString('utf8'))
    };
    if ((options.expectedFinalSha256 !== undefined) !== (options.expectedFinalSemanticDigest !== undefined)) {
      fail('ARTIFACT_RECOVERY_CANDIDATE_MISMATCH', 'fast-path provenance requires both finalizer digests');
    }
    if (options.expectedFinalSha256 !== undefined && options.expectedFinalSemanticDigest !== undefined
      && (current.sha256 !== options.expectedFinalSha256 || prepared.baselineSemanticDigest !== options.expectedFinalSemanticDigest)) {
      fail('ARTIFACT_RECOVERY_CANDIDATE_MISMATCH', 'formal artifact does not match the finalizer digests');
    }
    const existing = readArtifactRecoveryIntent(prepared.repoRoot, prepared.taskId, prepared.family, prepared.artifact);
    if (existing && (existing.state === 'passed' || existing.state === 'consumed')
      && existing.finalArtifactSha256 === prepared.baselineSha256
      && existing.finalSemanticDigest === prepared.baselineSemanticDigest) {
      return recoveryContextFromIntent(prepared.repoRoot, prepared.taskDir, existing);
    }
    if (existing && existing.state !== 'aborted') {
      fail('ARTIFACT_RECOVERY_CONFLICT', 'an active recovery journal already exists for this artifact');
    }
    const base = createIntent(prepared, Date.now());
    writeBytes(prepared.baselinePath, current.bytes);
    writeBytes(prepared.stagingPath, current.bytes);
    writeArtifactRecoveryIntent(prepared.repoRoot, base, { expected: existing });
    const staged = stageArtifactCandidate(prepared, current.bytes, { lockAlreadyHeld: true });
    prepareArtifactRecoveryCommit(prepared, staged.candidateSha256, staged.semanticDigest, { lockAlreadyHeld: true });
    commitArtifactRecovery(prepared, { lockAlreadyHeld: true });
    prepareArtifactRecoveryFinal(prepared, current.bytes, { lockAlreadyHeld: true });
    commitArtifactRecovery(prepared, { lockAlreadyHeld: true });
    return prepared;
  }, options.lockAlreadyHeld);
}

export function stageArtifactCandidate(
  context: ArtifactRecoveryContext,
  candidateBytes: Buffer,
  options: Readonly<{ lockAlreadyHeld?: boolean }> = {}
): StagedArtifactCandidate {
  return runLocked(context, 'task-artifact.recovery.stage', () => {
    assertRecoveryRoot(context);
    const intent = readIntentForContext(context);
    if (intent.state !== 'awaiting-preflight-recovery') fail('ARTIFACT_RECOVERY_STATE_INVALID', `cannot stage a candidate from '${intent.state}'`);
    const candidateSha256 = sha256Content(candidateBytes.toString('utf8'));
    const semanticDigest = canonicalSemanticDigest(candidateBytes.toString('utf8'));
    writeBytes(context.stagingPath, candidateBytes);
    const next = { ...intent, candidateSha256, updatedAt: Date.now() };
    writeArtifactRecoveryIntent(context.repoRoot, next, { expected: intent });
    return { recoveryId: context.recoveryId, candidateSha256, semanticDigest, path: context.stagingPath };
  }, options.lockAlreadyHeld);
}

function generationPath(context: ArtifactRecoveryContext, sha256: string): string {
  assertDigest(sha256, 'generation digest');
  return path.join(context.generationsPath, `${sha256}.md`);
}

/** Persist and verify an immutable digest-addressed snapshot before it is journaled. */
function writeGeneration(context: ArtifactRecoveryContext, bytes: Buffer, sha256: string, semanticDigest: string): void {
  ensureOwnedDirectoryTree(context.repoRoot, context.generationsPath);
  const target = generationPath(context, sha256);
  if (fs.existsSync(target)) {
    const existing = readStableFileSync(target, { maxBytes: MAX_ARTIFACT_BYTES, expectedSha256: sha256 });
    if (canonicalSemanticDigest(existing.bytes.toString('utf8')) !== semanticDigest) {
      fail('ARTIFACT_RECOVERY_CONFLICT', 'existing generation does not match its semantic digest');
    }
    return;
  }
  writeBytes(target, bytes);
  fs.chmodSync(target, 0o400);
  const sealed = readStableFileSync(target, { maxBytes: MAX_ARTIFACT_BYTES, expectedSha256: sha256 });
  if (canonicalSemanticDigest(sealed.bytes.toString('utf8')) !== semanticDigest) {
    fail('ARTIFACT_RECOVERY_CANDIDATE_MISMATCH', 'generation does not match its validated semantic digest');
  }
}

function publishGeneration(context: ArtifactRecoveryContext, sha256: string, semanticDigest: string, baselineSha256: string): void {
  const target = readStableFileSync(context.formalPath, { maxBytes: MAX_ARTIFACT_BYTES });
  if (target.sha256 === sha256) return;
  if (target.sha256 !== baselineSha256) fail('ARTIFACT_RECOVERY_CONFLICT', 'formal artifact changed outside the expected generation');
  const generation = readStableFileSync(generationPath(context, sha256), { maxBytes: MAX_ARTIFACT_BYTES, expectedSha256: sha256 });
  if (canonicalSemanticDigest(generation.bytes.toString('utf8')) !== semanticDigest) {
    fail('ARTIFACT_RECOVERY_CONFLICT', 'generation semantic digest does not match the journal');
  }
  const publishPath = path.join(path.dirname(context.stagingPath), 'publish.md');
  unlinkIfPresent(publishPath);
  writeBytes(publishPath, generation.bytes);
  fs.chmodSync(publishPath, 0o400);
  fs.renameSync(publishPath, context.formalPath);
  const published = readStableFileSync(context.formalPath, { maxBytes: MAX_ARTIFACT_BYTES, expectedSha256: sha256 });
  if (canonicalSemanticDigest(published.bytes.toString('utf8')) !== semanticDigest) {
    fail('ARTIFACT_RECOVERY_CONFLICT', 'published artifact does not match its generation');
  }
}

export function prepareArtifactRecoveryCommit(
  context: ArtifactRecoveryContext,
  finalSha256: string,
  finalSemanticDigest: string,
  options: Readonly<{ lockAlreadyHeld?: boolean }> = {}
): ArtifactRecoveryIntent {
  assertDigest(finalSha256, 'final artifact digest');
  assertDigest(finalSemanticDigest, 'final semantic digest');
  return runLocked(context, 'task-artifact.recovery.prepare', () => {
    const intent = readIntentForContext(context);
    if (intent.state !== 'awaiting-preflight-recovery') fail('ARTIFACT_RECOVERY_STATE_INVALID', `cannot prepare a preflight from '${intent.state}'`);
    assertRecoveryRoot(context);
    const staged = readStableFileSync(context.stagingPath, { maxBytes: MAX_ARTIFACT_BYTES });
    if (staged.sha256 !== finalSha256 || canonicalSemanticDigest(staged.bytes.toString('utf8')) !== finalSemanticDigest) {
      fail('ARTIFACT_RECOVERY_CANDIDATE_MISMATCH', 'staged candidate does not match the finalizer digest');
    }
    writeGeneration(context, staged.bytes, finalSha256, finalSemanticDigest);
    const next: ArtifactRecoveryIntent = {
      ...intent,
      state: 'preflight-ready',
      candidateSha256: staged.sha256,
      preflightArtifactSha256: finalSha256,
      preflightSemanticDigest: finalSemanticDigest,
      activeGenerationSha256: finalSha256,
      activeGenerationSemanticDigest: finalSemanticDigest,
      errorCode: null,
      errorMessage: null,
      updatedAt: Date.now()
    };
    writeArtifactRecoveryIntent(context.repoRoot, next, { expected: intent });
    return next;
  }, options.lockAlreadyHeld);
}

function markCommitStarted(context: ArtifactRecoveryContext, intent: ArtifactRecoveryIntent): ArtifactRecoveryIntent {
  if (intent.state === 'preflight-commit-started' || intent.state === 'commit-started') return intent;
  if (intent.state !== 'preflight-ready' && intent.state !== 'full-finalizer-ready') fail('ARTIFACT_RECOVERY_STATE_INVALID', `cannot commit from '${intent.state}'`);
  const next: ArtifactRecoveryIntent = { ...intent, state: intent.state === 'preflight-ready' ? 'preflight-commit-started' : 'commit-started', updatedAt: Date.now() };
  writeArtifactRecoveryIntent(context.repoRoot, next, { expected: intent });
  return next;
}

export function commitArtifactRecovery(
  context: ArtifactRecoveryContext,
  options: Readonly<{ lockAlreadyHeld?: boolean }> = {}
): ArtifactRecoveryIntent {
  return runLocked(context, 'task-artifact.recovery.commit', () => {
    let intent = readIntentForContext(context);
    if (intent.state === 'passed' || intent.state === 'consumed') return intent;
    assertRecoveryRoot(context);
    intent = markCommitStarted(context, intent);
    if (intent.state === 'preflight-commit-started') {
      publishGeneration(context, intent.activeGenerationSha256!, intent.activeGenerationSemanticDigest!, intent.baselineSha256);
      const passed = { ...intent, state: 'preflight-passed' as const, updatedAt: Date.now() };
      writeArtifactRecoveryIntent(context.repoRoot, passed, { expected: intent });
      return passed;
    }
    publishGeneration(context, intent.pendingGenerationSha256!, intent.pendingGenerationSemanticDigest!, intent.activeGenerationSha256!);
    const passed: ArtifactRecoveryIntent = {
      ...intent, state: 'passed', activeGenerationSha256: intent.pendingGenerationSha256,
      activeGenerationSemanticDigest: intent.pendingGenerationSemanticDigest,
      pendingGenerationSha256: null, pendingGenerationSemanticDigest: null, updatedAt: Date.now()
    };
    writeArtifactRecoveryIntent(context.repoRoot, passed, { expected: intent });
    return passed;
  }, options.lockAlreadyHeld);
}

export function prepareArtifactRecoveryFinal(
  context: ArtifactRecoveryContext,
  finalBytes: Buffer,
  options: Readonly<{ lockAlreadyHeld?: boolean }> = {}
): ArtifactRecoveryIntent {
  return runLocked(context, 'task-artifact.recovery.finalize', () => {
    const intent = readIntentForContext(context);
    if (intent.state !== 'preflight-passed') fail('ARTIFACT_RECOVERY_STATE_INVALID', `cannot finalize from '${intent.state}'`);
    const finalSha256 = sha256Content(finalBytes.toString('utf8'));
    const finalSemanticDigest = canonicalSemanticDigest(finalBytes.toString('utf8'));
    if (finalSha256 !== intent.activeGenerationSha256) writeGeneration(context, finalBytes, finalSha256, finalSemanticDigest);
    const next: ArtifactRecoveryIntent = {
      ...intent, state: 'full-finalizer-ready', pendingGenerationSha256: finalSha256,
      pendingGenerationSemanticDigest: finalSemanticDigest, finalArtifactSha256: finalSha256,
      finalSemanticDigest, updatedAt: Date.now()
    };
    writeArtifactRecoveryIntent(context.repoRoot, next, { expected: intent });
    return next;
  }, options.lockAlreadyHeld);
}

export function abortArtifactRecovery(
  context: ArtifactRecoveryContext,
  code: string,
  message: string,
  options: Readonly<{ lockAlreadyHeld?: boolean }> = {}
): ArtifactRecoveryIntent {
  return runLocked(context, 'task-artifact.recovery.abort', () => {
    const intent = readIntentForContext(context);
    assertRegular(context.baselinePath, 'baseline backup');
    const target = readStableFileSync(context.formalPath, { maxBytes: MAX_ARTIFACT_BYTES });
    if (target.sha256 !== intent.baselineSha256) fs.renameSync(context.baselinePath, context.formalPath);
    const restored = readStableFileSync(context.formalPath, { maxBytes: MAX_ARTIFACT_BYTES });
    if (restored.sha256 !== intent.baselineSha256) fail('ARTIFACT_RECOVERY_INDETERMINATE', 'baseline restore could not be verified');
    const aborted: ArtifactRecoveryIntent = {
      ...intent,
      state: 'aborted',
      errorCode: code,
      errorMessage: message,
      updatedAt: Date.now()
    };
    writeArtifactRecoveryIntent(context.repoRoot, aborted, { expected: intent });
    return aborted;
  }, options.lockAlreadyHeld);
}

export function reconcileArtifactRecovery(
  context: ArtifactRecoveryContext,
  options: Readonly<{
    lockAlreadyHeld?: boolean;
    validateFinal?: () => boolean;
    restoreBaseline?: boolean;
  }> = {}
): ArtifactRecoveryReconcileResult {
  return runLocked(context, 'task-artifact.recovery.reconcile', () => {
    const intent = readIntentForContext(context);
    if (intent.state !== 'preflight-commit-started' && intent.state !== 'commit-started') return { status: intent.state, intent };
    const target = readStableFileSync(context.formalPath, { maxBytes: MAX_ARTIFACT_BYTES });
    const expected = intent.state === 'preflight-commit-started' ? intent.activeGenerationSha256! : intent.pendingGenerationSha256!;
    if (target.sha256 === expected && (options.validateFinal?.() ?? true)) {
      const next = intent.state === 'preflight-commit-started'
        ? { ...intent, state: 'preflight-passed' as const, updatedAt: Date.now() }
        : { ...intent, state: 'passed' as const, activeGenerationSha256: intent.pendingGenerationSha256, activeGenerationSemanticDigest: intent.pendingGenerationSemanticDigest, pendingGenerationSha256: null, pendingGenerationSemanticDigest: null, updatedAt: Date.now() };
      writeArtifactRecoveryIntent(context.repoRoot, next, { expected: intent });
      return { status: next.state, intent: next };
    }
    if (target.sha256 === (intent.state === 'preflight-commit-started' ? intent.baselineSha256 : intent.activeGenerationSha256)) {
      const retried = commitArtifactRecovery(context, { lockAlreadyHeld: true });
      return { status: retried.state, intent: retried };
    }
    if (options.restoreBaseline) {
      const aborted = abortArtifactRecovery(context, 'ARTIFACT_RECOVERY_CONTEXT_INVALID', 'formal target is not a verifiable baseline or final candidate', { lockAlreadyHeld: true });
      return { status: 'aborted', intent: aborted };
    }
    return { status: 'indeterminate', intent };
  }, options.lockAlreadyHeld);
}

export function consumeArtifactRecovery(
  context: ArtifactRecoveryContext,
  options: Readonly<{ lockAlreadyHeld?: boolean }> = {}
): ArtifactRecoveryIntent {
  return runLocked(context, 'task-artifact.recovery.consume', () => {
    const intent = readIntentForContext(context);
    if (intent.state === 'consumed') return intent;
    if (intent.state !== 'passed') fail('ARTIFACT_RECOVERY_STATE_INVALID', `only passed recovery can be consumed, got '${intent.state}'`);
    const consumed: ArtifactRecoveryIntent = { ...intent, state: 'consumed', updatedAt: Date.now() };
    writeArtifactRecoveryIntent(context.repoRoot, consumed, { expected: intent });
    return consumed;
  }, options.lockAlreadyHeld);
}

export function recoveryContextFromIntent(
  repoRoot: string,
  taskDir: string,
  intent: ArtifactRecoveryIntent
): ArtifactRecoveryContext {
  const context = contextPaths({
    taskId: intent.taskId,
    family: intent.family,
    artifact: intent.artifact,
    round: intent.round,
    requestId: intent.requestId,
    phase: intent.phase,
    authorityDigest: intent.authorityDigest
  }, { repoRoot, taskDir, recoveryId: intent.recoveryOperationId }, intent.recoveryOperationId);
  return contextWithIntent(context, intent);
}

export { canonicalSemanticDigest, readArtifactRecoveryIntent, sha256Content };
