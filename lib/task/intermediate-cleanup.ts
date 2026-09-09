import { inspectOwnedPath } from '../owned-path.ts';
import { taskFinalizationReceiptState } from './finalization-state.ts';
import { withTaskExecutionLock } from './task-execution-lock.ts';
import fs from 'node:fs';
import path from 'node:path';

import { checkpointCommitMatches } from './commit-identity.ts';
import {
  readCheckpointIntent,
  type CheckpointIntent
} from './commit-intent.ts';
import { parseTaskFrontmatter } from './frontmatter.ts';
import {
  readTaskFinalizationReceipt,
  type TaskFinalizationReceipt
} from './finalization.ts';
import {
  readLocalArtifactFinalizationIntent,
  semanticDigest,
  sha256Content,
  type LocalArtifactFinalizationIntent
} from './local-artifact-finalization.ts';
import { parseArtifactName } from './artifact-name.ts';
import { enumerateAllTaskDirs, type TaskWorkspaceState } from './resolve-ref.ts';
import type { TaskControlBindingEvidence } from './finalization-state.ts';

const TASK_ID_RE = /^TASK-\d{8}-\d{6}$/;
const LOCAL_INTENT_RE = /^(TASK-\d{8}-\d{6})-(analysis|plan|code)-(.+\.md)\.json$/;
const COMMIT_INTENT_RE = /^(TASK-\d{8}-\d{6})\.json$/;
const AUXILIARY_ROOTS = [
  '.local-artifact-finalization-intents',
  '.task-commit-intents'
] as const;

type CleanupKind = 'LFAI-CONSUMED' | 'COMMIT-SYNCED' | 'EMPTY-AUX-PARENT';
type CleanupDisposition = 'planned' | 'protected' | 'skipped' | 'deleted' | 'failed';
type FileIdentity = Readonly<{ dev: string; ino: string; size: number; mtimeMs: number }>;

type IntermediateCleanupItem = Readonly<{
  kind: CleanupKind | 'AUXILIARY-UNKNOWN';
  taskId: string | null;
  path: string;
  disposition: CleanupDisposition;
  reason: string;
  identity: FileIdentity | null;
}>;

type IntermediateCleanupReport = Readonly<{
  status: 'dry-run' | 'completed' | 'partial';
  items: readonly IntermediateCleanupItem[];
  remaining: readonly IntermediateCleanupItem[];
}>;

type IntermediateCleanupOptions = Readonly<{
  taskIds?: readonly string[];
  controlBindingEvidence?: TaskControlBindingEvidence;
}>;

type ScanOptions = IntermediateCleanupOptions & Readonly<{ preflight?: boolean }>;

type TaskRecord = Readonly<{
  taskId: string;
  taskDir: string;
  state: TaskWorkspaceState;
  frontmatter: Record<string, string>;
}>;

function auxiliaryRoot(repoRoot: string, name: typeof AUXILIARY_ROOTS[number]): string {
  return path.join(repoRoot, '.agents', 'workspace', name);
}

function taskRoot(repoRoot: string): string {
  return path.join(repoRoot, '.agents', 'workspace');
}

function fileIdentity(stat: fs.Stats): FileIdentity {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function errorCode(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : null;
}

function safeLstat(root: string, target: string, expect: 'file' | 'directory'): FileIdentity | null {
  const stat = inspectOwnedPath(root, target, expect);
  return stat ? fileIdentity(stat) : null;
}

function inspectTaskRecords(repoRoot: string, taskIds?: ReadonlySet<string>): Map<string, TaskRecord> {
  const records = new Map<string, TaskRecord>();
  for (const entry of enumerateAllTaskDirs(repoRoot)) {
    if (taskIds && !taskIds.has(entry.taskId)) continue;
    const taskMdPath = path.join(entry.taskDir, 'task.md');
    if (safeLstat(taskRoot(repoRoot), taskMdPath, 'file') === null) continue;
    const content = fs.readFileSync(taskMdPath, 'utf8');
    records.set(entry.taskId, {
      taskId: entry.taskId,
      taskDir: entry.taskDir,
      state: entry.state,
      frontmatter: parseTaskFrontmatter(content)
    });
  }
  return records;
}

function item(
  kind: CleanupKind | 'AUXILIARY-UNKNOWN',
  taskId: string | null,
  filePath: string,
  disposition: CleanupDisposition,
  reason: string,
  identity: FileIdentity | null = null
): IntermediateCleanupItem {
  return { kind, taskId, path: path.resolve(filePath), disposition, reason, identity };
}

function taskGate(task: TaskRecord | undefined): string | null {
  if (!task) return 'TASK_NOT_FOUND';
  if (task.state !== 'completed' && task.state !== 'archive') return 'TASK_STATE_PROTECTED';
  if (task.frontmatter.id !== task.taskId || task.frontmatter.status !== 'completed') return 'TASK_STATE_PROTECTED';
  if (!task.frontmatter.branch) return 'TASK_IDENTITY_INVALID';
  return null;
}

function receiptGate(
  repoRoot: string,
  task: TaskRecord,
  options: ScanOptions
): string | null {
  let receipt: TaskFinalizationReceipt | null;
  try { receipt = readTaskFinalizationReceipt(repoRoot, task.taskId); }
  catch { return 'FINALIZATION_RECEIPT_INVALID'; }
  if (!receipt) return 'FINALIZATION_RECEIPT_MISSING';
  const state = taskFinalizationReceiptState(receipt);
  if (state === 'pending') return 'FINALIZATION_RECEIPT_PENDING';
  if (state === 'unresolved') return 'LFAI_RETRY_OR_WARNING_OPEN';
  if (receipt.controlBinding) {
    const evidence = options.controlBindingEvidence?.(task.taskId, receipt.controlBinding);
    if (evidence !== 'terminal' && !(options.preflight && evidence === 'pending')) return 'CONTROL_BINDING_MISMATCH';
  }
  return null;
}

function canonicalLocalIntentPath(taskId: string, family: string, artifact: string): string {
  return `${taskId}-${family}-${artifact}.json`;
}

function localIntentCandidate(
  repoRoot: string,
  task: TaskRecord | undefined,
  filePath: string,
  taskId: string,
  family: 'analysis' | 'plan' | 'code',
  artifact: string,
  identity: FileIdentity,
  options: ScanOptions
): IntermediateCleanupItem {
  const protectedReason = taskGate(task);
  if (protectedReason) return item('LFAI-CONSUMED', taskId, filePath, 'protected', protectedReason, identity);
  if (path.basename(filePath) !== canonicalLocalIntentPath(taskId, family, artifact)
    || !parseArtifactName(artifact)?.family || parseArtifactName(artifact)!.family !== family) {
    return item('LFAI-CONSUMED', taskId, filePath, 'protected', 'PATH_IDENTITY_MISMATCH', identity);
  }
  let intent: LocalArtifactFinalizationIntent | null;
  try { intent = readLocalArtifactFinalizationIntent(repoRoot, taskId, family, artifact); }
  catch { return item('LFAI-CONSUMED', taskId, filePath, 'protected', 'LFAI_SCHEMA_INVALID', identity); }
  if (!intent || intent.state !== 'consumed') {
    return item('LFAI-CONSUMED', taskId, filePath, 'protected', 'LFAI_STATE_PROTECTED', identity);
  }
  const artifactPath = path.join(task!.taskDir, artifact);
  if (safeLstat(task!.taskDir, artifactPath, 'file') === null) {
    return item('LFAI-CONSUMED', taskId, filePath, 'protected', 'ARTIFACT_IDENTITY_MISMATCH', identity);
  }
  let content: string;
  try { content = fs.readFileSync(artifactPath, 'utf8'); }
  catch { return item('LFAI-CONSUMED', taskId, filePath, 'protected', 'ARTIFACT_UNREADABLE', identity); }
  if (intent.artifactSha256 !== sha256Content(content) || intent.semanticDigest !== semanticDigest(content)) {
    return item('LFAI-CONSUMED', taskId, filePath, 'protected', 'ARTIFACT_DIGEST_MISMATCH', identity);
  }
  const receiptReason = receiptGate(repoRoot, task!, options);
  if (receiptReason) return item('LFAI-CONSUMED', taskId, filePath, 'protected', receiptReason, identity);
  return item('LFAI-CONSUMED', taskId, filePath, 'planned', 'LFAI_CONSUMED_AND_VERIFIED', identity);
}

function commitIntentCandidate(
  repoRoot: string,
  task: TaskRecord | undefined,
  filePath: string,
  taskId: string,
  identity: FileIdentity,
  options: ScanOptions
): IntermediateCleanupItem {
  const protectedReason = taskGate(task);
  if (protectedReason) return item('COMMIT-SYNCED', taskId, filePath, 'protected', protectedReason, identity);
  let intent: CheckpointIntent | null;
  try { intent = readCheckpointIntent(repoRoot, taskId); }
  catch { return item('COMMIT-SYNCED', taskId, filePath, 'protected', 'COMMIT_INTENT_INVALID', identity); }
  if (!intent || intent.state !== 'synced' || intent.taskId !== taskId
    || intent.branch !== task!.frontmatter.branch || !intent.committedHead
    || task!.frontmatter.checkpoint_commit !== intent.committedHead
    || !checkpointCommitMatches(repoRoot, intent, intent.committedHead)) {
    return item('COMMIT-SYNCED', taskId, filePath, 'protected', 'COMMIT_EVIDENCE_MISMATCH', identity);
  }
  const receiptReason = receiptGate(repoRoot, task!, options);
  if (receiptReason) return item('COMMIT-SYNCED', taskId, filePath, 'protected', receiptReason, identity);
  return item('COMMIT-SYNCED', taskId, filePath, 'planned', 'COMMIT_SYNCED_AND_VERIFIED', identity);
}

function readAuxiliaryCandidates(
  repoRoot: string,
  tasks: Map<string, TaskRecord>,
  options: ScanOptions
): IntermediateCleanupItem[] {
  const candidates: IntermediateCleanupItem[] = [];
  const selected = options.taskIds ? new Set(options.taskIds) : null;
  for (const rootName of AUXILIARY_ROOTS) {
    const root = auxiliaryRoot(repoRoot, rootName);
    let rootIdentity: FileIdentity | null;
    try { rootIdentity = safeLstat(taskRoot(repoRoot), root, 'directory'); }
    catch { rootIdentity = null; }
    if (rootIdentity === null) {
      let stat: fs.Stats | null = null;
      try { stat = fs.lstatSync(root); } catch { stat = null; }
      if (stat?.isSymbolicLink()) candidates.push(item('AUXILIARY-UNKNOWN', null, root, 'protected', 'PATH_SYMLINK'));
      else if (stat) candidates.push(item('AUXILIARY-UNKNOWN', null, root, 'protected', 'PATH_IDENTITY_MISMATCH'));
      continue;
    }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); }
    catch {
      candidates.push(item('AUXILIARY-UNKNOWN', null, root, 'protected', 'AUXILIARY_ROOT_UNREADABLE', rootIdentity));
      continue;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const filePath = path.join(root, entry.name);
      if (entry.isSymbolicLink()) {
        candidates.push(item('AUXILIARY-UNKNOWN', null, filePath, 'protected', 'PATH_SYMLINK'));
        continue;
      }
      if (!entry.isFile()) {
        candidates.push(item('AUXILIARY-UNKNOWN', null, filePath, 'protected', 'PATH_IDENTITY_MISMATCH'));
        continue;
      }
      const identity = safeLstat(root, filePath, 'file');
      if (!identity) {
        candidates.push(item('AUXILIARY-UNKNOWN', null, filePath, 'protected', 'PATH_IDENTITY_MISMATCH'));
        continue;
      }
      if (rootName === '.local-artifact-finalization-intents') {
        const match = LOCAL_INTENT_RE.exec(entry.name);
        if (!match || (selected && !selected.has(match[1]!))) {
          if (!selected || !match) candidates.push(item('AUXILIARY-UNKNOWN', null, filePath, 'protected', 'PATH_IDENTITY_MISMATCH', identity));
          continue;
        }
        candidates.push(localIntentCandidate(
          repoRoot, tasks.get(match[1]!), filePath, match[1]!, match[2] as 'analysis' | 'plan' | 'code', match[3]!, identity, options
        ));
      } else {
        const match = COMMIT_INTENT_RE.exec(entry.name);
        if (!match || (selected && !selected.has(match[1]!))) {
          if (!selected || !match) candidates.push(item('AUXILIARY-UNKNOWN', null, filePath, 'protected', 'PATH_IDENTITY_MISMATCH', identity));
          continue;
        }
        candidates.push(commitIntentCandidate(repoRoot, tasks.get(match[1]!), filePath, match[1]!, identity, options));
      }
    }
    if (entries.length === 0) {
      candidates.push(item('EMPTY-AUX-PARENT', null, root, 'planned', 'EMPTY_CANONICAL_AUXILIARY_ROOT', rootIdentity));
    }
  }
  return candidates;
}

function buildIntermediateCleanupReport(items: readonly IntermediateCleanupItem[], dryRun = false, partial = false): IntermediateCleanupReport {
  const remaining = items.filter((candidate) => candidate.disposition !== 'deleted' && candidate.disposition !== 'skipped');
  return {
    status: dryRun ? 'dry-run' : partial || remaining.some((candidate) => candidate.disposition === 'failed') ? 'partial' : 'completed',
    items,
    remaining
  };
}

function scanInternal(repoRootInput: string, options: ScanOptions): IntermediateCleanupItem[] {
  const repoRoot = path.resolve(repoRootInput);
  if (safeLstat(path.dirname(repoRoot), repoRoot, 'directory') === null) {
    throw new Error('INTERMEDIATE_CLEANUP_REPOSITORY_INVALID');
  }
  const selected = options.taskIds ? new Set(options.taskIds.filter((taskId) => TASK_ID_RE.test(taskId))) : undefined;
  const tasks = inspectTaskRecords(repoRoot, selected);
  return readAuxiliaryCandidates(repoRoot, tasks, options);
}

function scanIntermediateCleanup(repoRoot: string, options: ScanOptions = {}): IntermediateCleanupReport {
  const candidates = scanInternal(repoRoot, options);
  return buildIntermediateCleanupReport(candidates, true);
}

function removeCandidate(candidate: IntermediateCleanupItem): IntermediateCleanupItem {
  if (candidate.disposition !== 'planned') return candidate;
  const root = candidate.kind === 'EMPTY-AUX-PARENT'
    ? path.dirname(path.dirname(candidate.path))
    : path.dirname(candidate.path);
  const expected = candidate.identity;
  if (!expected) return { ...candidate, disposition: 'protected', reason: 'PATH_IDENTITY_MISSING' };
  let raw: fs.Stats;
  try { raw = fs.lstatSync(candidate.path); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return { ...candidate, disposition: 'skipped', reason: 'ALREADY_GONE' };
    return { ...candidate, disposition: 'failed', reason: 'CLEANUP_RECHECK_FAILED' };
  }
  if (raw.isSymbolicLink()) return { ...candidate, disposition: 'protected', reason: 'PATH_IDENTITY_CHANGED' };
  const actual = safeLstat(root, candidate.path, candidate.kind === 'EMPTY-AUX-PARENT' ? 'directory' : 'file');
  if (!actual) return { ...candidate, disposition: 'protected', reason: 'PATH_IDENTITY_CHANGED' };
  if (!sameFileIdentity(expected, actual)) return { ...candidate, disposition: 'protected', reason: 'PATH_IDENTITY_CHANGED' };
  try {
    if (candidate.kind === 'EMPTY-AUX-PARENT') {
      if (fs.readdirSync(candidate.path).length !== 0) return { ...candidate, disposition: 'protected', reason: 'AUXILIARY_ROOT_NOT_EMPTY' };
      fs.rmdirSync(candidate.path);
    } else {
      fs.unlinkSync(candidate.path);
    }
    return { ...candidate, disposition: 'deleted', reason: 'DELETED_AFTER_LOCKED_RECHECK' };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { ...candidate, disposition: 'skipped', reason: 'ALREADY_GONE' };
    return { ...candidate, disposition: 'failed', reason: 'CLEANUP_DELETE_FAILED' };
  }
}


type IntermediateCleanupCoordinatorOptions = IntermediateCleanupOptions & Readonly<{
  dryRun?: boolean;
  lockedTaskIds?: ReadonlySet<string>;
}>;

function intermediateCleanupKey(item: IntermediateCleanupItem): string {
  return `${item.kind}\0${item.path}`;
}

function cleanupIntermediateUnderRemovalCoordinator(
  repoRoot: string,
  options: IntermediateCleanupCoordinatorOptions = {}
): IntermediateCleanupReport {
  const scanOptions: IntermediateCleanupOptions = {
    ...(options.taskIds === undefined ? {} : { taskIds: options.taskIds }),
    ...(options.controlBindingEvidence === undefined ? {} : { controlBindingEvidence: options.controlBindingEvidence })
  };
  const initial = scanIntermediateCleanup(repoRoot, scanOptions);
  if (options.dryRun) return initial;

  const items = [...initial.items];
  const lockedTaskIds = options.lockedTaskIds ?? new Set<string>();
  const byTask = new Map<string, number[]>();
  for (const [index, candidate] of items.entries()) {
    if (!candidate.taskId || candidate.disposition !== 'planned') continue;
    const indexes = byTask.get(candidate.taskId) ?? [];
    indexes.push(index);
    byTask.set(candidate.taskId, indexes);
  }

  for (const taskId of [...byTask.keys()].sort()) {
    const execute = (): void => {
      const refreshed = scanIntermediateCleanup(repoRoot, {
        ...scanOptions,
        taskIds: [taskId]
      });
      const refreshedByKey = new Map(refreshed.items.map((candidate) => [intermediateCleanupKey(candidate), candidate]));
      for (const index of byTask.get(taskId) ?? []) {
        const initialCandidate = items[index]!;
        if (initialCandidate.disposition !== 'planned') continue;
        const current = refreshedByKey.get(intermediateCleanupKey(initialCandidate));
        items[index] = current
          ? removeCandidate(current)
          : { ...initialCandidate, disposition: 'protected', reason: 'CANDIDATE_NO_LONGER_ELIGIBLE' };
      }
    };
    try {
      if (lockedTaskIds.has(taskId)) execute();
      else withTaskExecutionLock(repoRoot, taskId, 'sandbox-removal', execute);
    } catch {
      for (const index of byTask.get(taskId) ?? []) {
        const candidate = items[index]!;
        if (candidate.disposition === 'planned') items[index] = { ...candidate, disposition: 'protected', reason: 'TASK_LOCK_BUSY' };
      }
    }
  }

  for (const [index, candidate] of items.entries()) {
    if (candidate.taskId || candidate.disposition !== 'planned') continue;
    items[index] = removeCandidate(candidate);
  }

  const knownPaths = new Set(items.map((candidate) => intermediateCleanupKey(candidate)));
  for (const candidate of scanIntermediateCleanup(repoRoot, scanOptions).items) {
    if (candidate.kind !== 'EMPTY-AUX-PARENT' || candidate.disposition !== 'planned'
      || knownPaths.has(intermediateCleanupKey(candidate))) continue;
    items.push(removeCandidate(candidate));
  }

  return buildIntermediateCleanupReport(items);
}

function protectIntermediateCleanupReport(
  report: IntermediateCleanupReport,
  reason: string
): IntermediateCleanupReport {
  const items = report.items.map((item) => item.disposition === 'planned'
    ? { ...item, disposition: 'protected' as const, reason }
    : item
  );
  return buildIntermediateCleanupReport(items, false, true);
}

function mergeIntermediateCleanupReports(
  reports: readonly IntermediateCleanupReport[]
): IntermediateCleanupReport {
  const items = reports.flatMap((report) => report.items);
  return buildIntermediateCleanupReport(items, false, reports.some((report) => report.status === 'partial'));
}

function formatIntermediateCleanupReport(report: IntermediateCleanupReport): string[] {
  return [
    `remaining ${report.remaining.length} item(s)`,
    ...report.items.map((candidate) => (
    `${candidate.disposition} ${candidate.kind} ${candidate.path}`
    + ` (${candidate.taskId ?? 'unbound'}; ${candidate.reason})`
    ))
  ];
}

export {
  formatIntermediateCleanupReport,
  cleanupIntermediateUnderRemovalCoordinator,
  protectIntermediateCleanupReport,
  mergeIntermediateCleanupReports,
  scanIntermediateCleanup
};
export type {
  CleanupDisposition,
  CleanupKind,
  FileIdentity,
  IntermediateCleanupItem,
  IntermediateCleanupOptions,
  IntermediateCleanupReport
};
