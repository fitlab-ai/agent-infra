import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { appendActivityEntry, locateActivityLog } from './activity-log.ts';
import { artifactFamilyCatalog, inspectArtifactDirectory } from './artifact-lifecycle.ts';
import { parseArtifactName } from './artifact-name.ts';
import { parseTypedTaskFrontmatter, updateTaskFrontmatter } from './frontmatter.ts';
import { upsertSection } from './sections.ts';
import { locateHotTaskDirs, resolveTaskRef, TASK_ID_RE } from './resolve-ref.ts';
import {
  configuredShortIdLength, executeShortIdCommand, loadShortIdByTaskId,
  mutateShortIdRegistry
} from './short-id.ts';
import { captureTaskWriteMetadata, writeTask } from './write.ts';
import type { TaskFileSystem, TaskMutation, TaskOperationSummary, TaskWriteMetadata } from './write.ts';
import { validateCurrentTaskContract } from './current-contract.ts';
import { isValidAgentInfraVersion } from '../version.ts';
import { taskIssueIdentity } from '../platform/task-identities.ts';
import { resourceIdentityEquals } from '../platform/resource-identity.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from './task-execution-lock.ts';

const lifecycleIntentCatalog = [
  'block', 'activate', 'cancel', 'complete', 'close-codescan', 'close-dependabot', 'restore', 'recover-started'
] as const;
const lifecycleFailureCatalog = [
  'LIFECYCLE_DIRECTORY_TRANSFER_FAILED',
  'LIFECYCLE_DIRECTORY_RENAME_FAILED',
  'LIFECYCLE_DOCUMENT_INVALID',
  'LIFECYCLE_FINAL_STATE_INVALID',
  'LIFECYCLE_IDENTITY_CONFLICT',
  'LIFECYCLE_IDENTITY_INVALID',
  'LIFECYCLE_INTENT_CONFLICT',
  'LIFECYCLE_JOURNAL_CLEANUP_FAILED',
  'LIFECYCLE_JOURNAL_INVALID',
  'LIFECYCLE_JOURNAL_WRITE_FAILED',
  'LIFECYCLE_LOG_MISSING',
  'LIFECYCLE_METADATA_FAILED',
  'LIFECYCLE_PAYLOAD_INVALID',
  'LIFECYCLE_SHORT_ID_FAILED',
  'LIFECYCLE_SHORT_ID_PRECONDITION',
  'LIFECYCLE_RUNTIME_MOVE_UNSAFE',
  'LIFECYCLE_SOURCE_INVALID',
  'LIFECYCLE_STAGING_IDENTITY_INVALID',
  'LIFECYCLE_STAGING_INVALID',
  'LIFECYCLE_TARGET_CONFLICT',
  'LIFECYCLE_TASK_NOT_FOUND',
  'SHORT_ID_CAPACITY_EXCEEDED'
] as const;
const lifecycleProducerCatalog = lifecycleFailureCatalog.map((code) => ({
  producerId: 'lifecycle.apply' as const,
  guardId: 'G-03' as const,
  code
}));
type TaskLifecycleIntent = (typeof lifecycleIntentCatalog)[number];
type TaskLifecycleRequest =
  | { taskRef: string; intent: 'block'; agent: string; reason: string; unblockCondition: string; dryRun?: boolean }
  | { taskRef: string; intent: 'activate'; agent: string; note: string; dryRun?: boolean }
  | { taskRef: string; intent: 'cancel'; agent: string; reason: string; dryRun?: boolean }
  | { taskRef: string; intent: 'complete'; agent: string; dryRun?: boolean }
  | { taskRef: string; intent: 'close-codescan'; agent: string; alertNumber: number; reason: string; dryRun?: boolean }
  | { taskRef: string; intent: 'close-dependabot'; agent: string; alertNumber: number; reason: string; dryRun?: boolean }
  | { taskRef: string; intent: 'restore'; agent: string; stagingDir: string; issueNumber: number; dryRun?: boolean }
  | { taskRef: string; intent: 'recover-started'; agent: string; auto: true; dryRun?: boolean };

type HotState = 'active' | 'blocked' | 'completed';
type SourceState = HotState | 'staging';
type LifecycleStep = 'task-written' | 'directory-moved' | 'registry-committed';
type LifecycleError = { code: string; message: string };
type LifecycleJournal = {
  version: 1;
  taskId: string;
  intent: TaskLifecycleIntent;
  intentDigest: string;
  sourceState: SourceState;
  targetState: HotState;
  metadata: TaskWriteMetadata;
  completedSteps: LifecycleStep[];
  failure?: LifecycleError;
};
type TaskLifecycleResult = {
  status: 'planned' | 'applied' | 'no-op' | 'failed';
  changed: boolean;
  requestRef: string;
  taskId: string | null;
  intent: TaskLifecycleIntent | string;
  sourceState: SourceState | null;
  targetState: HotState | null;
  sourcePath: string | null;
  targetPath: string | null;
  task: { operations: readonly TaskOperationSummary[] };
  directory: { effect: 'move' | 'unchanged'; changed: boolean };
  shortId: { effect: 'allocated' | 'released' | 'unchanged'; shortId: string | null; changed: boolean };
  timestamp: string | null;
  agentInfraVersion: string | null;
  journalPath: string | null;
  completedSteps: readonly LifecycleStep[];
  pendingSteps: readonly LifecycleStep[];
  error: LifecycleError | null;
};
type LifecycleFileSystem = {
  renameSync: (source: string, target: string) => void;
  readFileSync: (file: string) => string;
  writeFileSync: (file: string, content: string, flag?: string) => void;
  unlinkSync: (file: string) => void;
};
type TaskLifecycleOptions = {
  repoRoot?: string;
  metadataProvider?: () => TaskWriteMetadata;
  fileSystem?: Partial<LifecycleFileSystem>;
  taskFileSystem?: Partial<TaskFileSystem>;
  directoryRenameSync?: (source: string, target: string) => void;
  /** Write the terminal task document and durable journal, but leave the move
   * and short-id mutation for a separately authorized commit. */
  prepareOnly?: boolean;
};

type TaskCompletionProjection = Readonly<{ taskId: string; content: string; timestamp: string; agentInfraVersion: string }>;

const STEPS: readonly LifecycleStep[] = ['task-written', 'directory-moved', 'registry-committed'];
function stepsForIntent(intent: TaskLifecycleIntent): readonly LifecycleStep[] {
  return intent === 'complete' ? ['task-written', 'directory-moved'] : STEPS;
}
const DEFAULT_IO: LifecycleFileSystem = {
  renameSync: (source, target) => fs.renameSync(source, target),
  readFileSync: (file) => fs.readFileSync(file, 'utf8'),
  writeFileSync: (file, content, flag) => fs.writeFileSync(file, content, { encoding: 'utf8', flag: flag ?? 'w' }),
  unlinkSync: (file) => fs.unlinkSync(file)
};

function failed(request: Pick<TaskLifecycleRequest, 'taskRef' | 'intent'>, error: LifecycleError, extra: Partial<TaskLifecycleResult> = {}): TaskLifecycleResult {
  return {
    status: 'failed', changed: false, requestRef: request.taskRef, taskId: null,
    intent: request.intent, sourceState: null, targetState: null, sourcePath: null,
    targetPath: null, task: { operations: [] }, directory: { effect: 'unchanged', changed: false },
    shortId: { effect: 'unchanged', shortId: null, changed: false }, timestamp: null,
    agentInfraVersion: null, journalPath: null, completedSteps: [], pendingSteps: stepsForIntent(request.intent),
    error, ...extra
  };
}

export function taskLifecycleFailure(
  request: Pick<TaskLifecycleRequest, 'taskRef' | 'intent'>,
  error: LifecycleError,
  taskId: string | null = null
): TaskLifecycleResult {
  return failed(request, error, { taskId });
}

function normalizedRequest(request: TaskLifecycleRequest): TaskLifecycleRequest | LifecycleError {
  if (!request || typeof request !== 'object' || !lifecycleIntentCatalog.includes(request.intent as TaskLifecycleIntent)) {
    return { code: 'LIFECYCLE_PAYLOAD_INVALID', message: 'intent is not in the lifecycle catalog' };
  }
  if (typeof request.taskRef !== 'string' || !request.taskRef || typeof request.agent !== 'string' || !request.agent.trim()) {
    return { code: 'LIFECYCLE_PAYLOAD_INVALID', message: 'taskRef and agent are required' };
  }
  const singleLine = (name: string, value: unknown): string | LifecycleError => {
    if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) {
      return { code: 'LIFECYCLE_PAYLOAD_INVALID', message: `${name} must be a non-empty single line` };
    }
    return value.trim();
  };
  const agent = singleLine('agent', request.agent);
  if (typeof agent !== 'string') return agent;
  if (request.intent === 'block') {
    const reason = singleLine('reason', request.reason);
    const unblockCondition = singleLine('unblockCondition', request.unblockCondition);
    if (typeof reason !== 'string') return reason;
    if (typeof unblockCondition !== 'string') return unblockCondition;
    return { ...request, agent, reason, unblockCondition };
  }
  if (request.intent === 'activate') {
    const note = singleLine('note', request.note);
    return typeof note === 'string' ? { ...request, agent, note } : note;
  }
  if (request.intent === 'cancel' || request.intent === 'close-codescan' || request.intent === 'close-dependabot') {
    const reason = singleLine('reason', request.reason);
    if (typeof reason !== 'string') return reason;
    if (request.intent !== 'cancel' && (!Number.isSafeInteger(request.alertNumber) || request.alertNumber < 1)) {
      return { code: 'LIFECYCLE_PAYLOAD_INVALID', message: 'alertNumber must be a positive integer' };
    }
    return { ...request, agent, reason };
  }
  if (request.intent === 'restore') {
    if (typeof request.stagingDir !== 'string' || !request.stagingDir || !Number.isSafeInteger(request.issueNumber) || request.issueNumber < 1) {
      return { code: 'LIFECYCLE_PAYLOAD_INVALID', message: 'restore requires stagingDir and a positive issueNumber' };
    }
    return { ...request, agent };
  }
  return { ...request, agent };
}

function intentIdentity(request: TaskLifecycleRequest, taskId: string): string {
  const payload: Record<string, unknown> = { taskId, intent: request.intent, agent: request.agent };
  if ('reason' in request) payload.reason = request.reason;
  if ('unblockCondition' in request) payload.unblockCondition = request.unblockCondition;
  if ('note' in request) payload.note = request.note;
  if ('alertNumber' in request) payload.alertNumber = request.alertNumber;
  if ('issueNumber' in request) payload.issueNumber = request.issueNumber;
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function transition(request: TaskLifecycleRequest): { sources: readonly SourceState[]; target: HotState; registry: 'alloc' | 'release' | 'none' } {
  if (request.intent === 'block') return { sources: ['active'], target: 'blocked', registry: 'release' };
  if (request.intent === 'activate') return { sources: ['blocked'], target: 'active', registry: 'alloc' };
  if (request.intent === 'cancel') return { sources: ['active', 'blocked'], target: 'completed', registry: 'release' };
  if (request.intent === 'restore') return { sources: ['staging'], target: 'active', registry: 'alloc' };
  if (request.intent === 'complete') return { sources: ['active'], target: 'completed', registry: 'none' };
  return { sources: ['active'], target: 'completed', registry: 'release' };
}

function sameTaskEntry(source: string, target: string): boolean {
  const sourceStat = fs.lstatSync(source);
  let targetStat: fs.Stats;
  try { targetStat = fs.lstatSync(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (sourceStat.isSymbolicLink() || targetStat.isSymbolicLink()) {
    return sourceStat.isSymbolicLink() && targetStat.isSymbolicLink()
      && fs.readlinkSync(source) === fs.readlinkSync(target);
  }
  if (sourceStat.isDirectory() && targetStat.isDirectory()) {
    const sourceNames = fs.readdirSync(source).sort();
    const targetNames = fs.readdirSync(target).sort();
    return sourceNames.join('\0') === targetNames.join('\0')
      && sourceNames.every((name) => sameTaskEntry(path.join(source, name), path.join(target, name)))
      && (sourceStat.mode & 0o777) === (targetStat.mode & 0o777);
  }
  return sourceStat.isFile() && targetStat.isFile()
    && (sourceStat.mode & 0o777) === (targetStat.mode & 0o777)
    && fs.readFileSync(source).equals(fs.readFileSync(target));
}

function copyTaskEntry(source: string, target: string): void {
  const sourceStat = fs.lstatSync(source);
  if (fs.existsSync(target)) {
    const targetStat = fs.lstatSync(target);
    if (sourceStat.isDirectory() && targetStat.isDirectory() && !targetStat.isSymbolicLink()) {
      for (const name of fs.readdirSync(source).sort()) copyTaskEntry(path.join(source, name), path.join(target, name));
      fs.chmodSync(target, sourceStat.mode & 0o777);
      return;
    }
    if (sameTaskEntry(source, target)) return;
    throw new Error(`task content conflict at ${path.relative(path.dirname(source), source)}`);
  }
  if (sourceStat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), target);
    return;
  }
  if (sourceStat.isDirectory()) {
    fs.mkdirSync(target, { mode: sourceStat.mode & 0o777 });
    for (const name of fs.readdirSync(source).sort()) copyTaskEntry(path.join(source, name), path.join(target, name));
    fs.chmodSync(target, sourceStat.mode & 0o777);
    return;
  }
  if (!sourceStat.isFile()) throw new Error(`unsupported task entry: ${source}`);
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(target, sourceStat.mode & 0o777);
}

function transferTaskContents(sourcePath: string, targetPath: string): void {
  const sourceRoot = fs.lstatSync(sourcePath);
  if (!sourceRoot.isDirectory() || sourceRoot.isSymbolicLink()) throw new Error('task source is not a real directory');
  const targetRoot = fs.lstatSync(targetPath);
  if (!targetRoot.isDirectory() || targetRoot.isSymbolicLink()) throw new Error('completed target is not a real directory');
  for (const name of fs.readdirSync(sourcePath).sort()) {
    copyTaskEntry(path.join(sourcePath, name), path.join(targetPath, name));
  }
  const sourceNames = fs.readdirSync(sourcePath).sort();
  const targetNames = fs.readdirSync(targetPath).sort();
  if (sourceNames.join('\0') !== targetNames.join('\0')
    || !sourceNames.every((name) => sameTaskEntry(path.join(sourcePath, name), path.join(targetPath, name)))) {
    throw new Error('completed target does not match task source after copy');
  }
}

function targetContainsTask(targetPath: string, taskId: string, request: TaskLifecycleRequest): boolean {
  try {
    const stat = fs.lstatSync(targetPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const entries = fs.readdirSync(targetPath);
    if (entries.length === 0) return true;
    const taskPath = path.join(targetPath, 'task.md');
    const journalPath = path.join(targetPath, '.task-lifecycle.json');
    if (!fs.existsSync(taskPath) || !fs.existsSync(journalPath)) return false;
    const frontmatter = parseTypedTaskFrontmatter(fs.readFileSync(taskPath, 'utf8'));
    const journal = parseJournal(fs.readFileSync(journalPath, 'utf8'));
    return frontmatter.id === taskId && frontmatter.status === 'completed'
      && journal.taskId === taskId && journal.intent === request.intent
      && journal.intentDigest === intentIdentity(request, taskId);
  } catch {
    return false;
  }
}

function actionAndNote(request: TaskLifecycleRequest, restoredFiles = 0): { action: string; note: string } {
  if (request.intent === 'block') return { action: 'Block Task', note: request.reason };
  if (request.intent === 'activate') return { action: 'Activate Task', note: request.note };
  if (request.intent === 'cancel') return { action: 'Cancel Task', note: request.reason };
  if (request.intent === 'complete') return { action: 'Complete Task', note: 'Task moved to completed/' };
  if (request.intent === 'close-codescan') return { action: 'Close Codescan', note: `Code Scanning alert #${request.alertNumber} dismissed: ${request.reason}` };
  if (request.intent === 'close-dependabot') return { action: 'Close Dependabot', note: `Dependabot alert #${request.alertNumber} dismissed: ${request.reason}` };
  if (request.intent === 'recover-started') return { action: 'Recover Started', note: 'automatic recovery' };
  return { action: 'Restore Task', note: `Restored ${restoredFiles} files from Issue #${request.issueNumber}` };
}

function matchingCompletion(content: string, request: TaskLifecycleRequest, restoredFiles = 0): boolean {
  const section = locateActivityLog(content);
  if (!section) return false;
  const identity = actionAndNote(request, restoredFiles);
  return section.entries.some((entry) => entry.step === identity.action && entry.agent === request.agent && entry.note === identity.note);
}

function validateRestoreStaging(request: Extract<TaskLifecycleRequest, { intent: 'restore' }>, repoRoot: string, taskId: string): LifecycleError | { stagingDir: string; fileCount: number } {
  let workspace: string;
  let stagingDir: string;
  try {
    workspace = fs.realpathSync.native(path.resolve(repoRoot, '.agents', 'workspace'));
    stagingDir = fs.realpathSync.native(path.resolve(request.stagingDir));
  } catch (error) {
    return { code: 'LIFECYCLE_STAGING_INVALID', message: String(error) };
  }
  const relative = path.relative(workspace, stagingDir);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || path.basename(stagingDir) === taskId) {
    return { code: 'LIFECYCLE_STAGING_INVALID', message: 'restore staging must be a non-final directory inside .agents/workspace' };
  }
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(stagingDir, { withFileTypes: true }); }
  catch (error) { return { code: 'LIFECYCLE_STAGING_INVALID', message: String(error) }; }
  for (const entry of entries) {
    const stat = fs.lstatSync(path.join(stagingDir, entry.name));
    if (stat.isSymbolicLink() || !stat.isFile() || (entry.name !== 'task.md' && entry.name !== '.task-lifecycle.json' && !parseArtifactName(entry.name))) {
      return { code: 'LIFECYCLE_STAGING_INVALID', message: `unsupported restore entry '${entry.name}'` };
    }
  }
  try {
    if (fs.statSync(workspace).dev !== fs.statSync(stagingDir).dev) {
      return { code: 'LIFECYCLE_STAGING_INVALID', message: 'restore staging and active workspace must share a filesystem' };
    }
  } catch (error) {
    return { code: 'LIFECYCLE_STAGING_INVALID', message: String(error) };
  }
  const taskFile = path.join(stagingDir, 'task.md');
  if (!fs.existsSync(taskFile)) return { code: 'LIFECYCLE_STAGING_INVALID', message: 'restore staging has no task.md' };
  try {
    const frontmatter = parseTypedTaskFrontmatter(fs.readFileSync(taskFile, 'utf8'));
    const issueIdentity = taskIssueIdentity(frontmatter);
    const requestedIssueIdentity = { kind: 'number' as const, value: request.issueNumber };
    if (frontmatter.id !== taskId || !issueIdentity || !resourceIdentityEquals(issueIdentity, requestedIssueIdentity) || frontmatter.current_step === 'completed') {
      return { code: 'LIFECYCLE_STAGING_IDENTITY_INVALID', message: 'restore task identity, platform issue identity, or current_step is invalid' };
    }
  } catch (error) {
    return { code: 'LIFECYCLE_STAGING_INVALID', message: error instanceof Error ? error.message : String(error) };
  }
  for (const family of artifactFamilyCatalog) {
    const inventory = inspectArtifactDirectory(stagingDir, family.family);
    if (inventory.diagnostics.some((item) => item.code !== 'BROKEN_REFERENCE')) {
      return { code: 'LIFECYCLE_STAGING_INVALID', message: `restore artifact topology is invalid for ${family.family}` };
    }
  }
  return { stagingDir, fileCount: entries.filter((entry) => !entry.name.startsWith('.')).length };
}

function mutationsFor(request: TaskLifecycleRequest, content: string, metadata: TaskWriteMetadata, restoredFiles: number, allowMissingActivityLog = false): TaskMutation[] | LifecycleError {
  const section = locateActivityLog(content) ?? (allowMissingActivityLog ? { heading: 'Activity Log', body: '', entries: [] } : null);
  if (!section) return { code: 'LIFECYCLE_LOG_MISSING', message: 'task has no unique Activity Log section' };
  const identity = actionAndNote(request, restoredFiles);
  let body = appendActivityEntry(section, { time: metadata.timestamp, step: `${identity.action} [started]`, agent: request.agent, note: 'started' });
  body = appendActivityEntry({ ...section, body }, { time: metadata.timestamp, step: identity.action, agent: request.agent, note: identity.note });
  const set: Record<string, string> = {};
  const remove: string[] = [];
  if (request.intent === 'block') {
    set.status = 'blocked'; set.blocked_at = metadata.timestamp;
    remove.push('completed_at', 'cancelled_at', 'cancel_reason');
  } else if (request.intent === 'activate' || request.intent === 'restore') {
    set.status = 'active'; set.assigned_to = request.agent;
    remove.push('blocked_at', 'completed_at', 'cancelled_at', 'cancel_reason');
  } else if (request.intent === 'cancel') {
    set.status = 'completed'; set.cancelled_at = metadata.timestamp; set.cancel_reason = request.reason;
    remove.push('blocked_at', 'completed_at');
  } else {
    set.status = 'completed'; set.current_step = 'completed'; set.completed_at = metadata.timestamp;
    remove.push('blocked_at', 'cancelled_at', 'cancel_reason');
    const frontmatter = parseTypedTaskFrontmatter(content);
    if (frontmatter.target_date === '') set.target_date = metadata.timestamp.slice(0, 10);
  }
  const mutations: TaskMutation[] = [
    { kind: 'frontmatter', set, remove: [...new Set(remove)] },
    { kind: 'section', aliases: ['活动日志', 'Activity Log'], heading: section.heading, body }
  ];
  if (request.intent === 'block') {
    mutations.splice(1, 0, {
      kind: 'section', aliases: ['阻塞信息', 'Blocking Information'], heading: '阻塞信息',
      body: `- **原因**：${request.reason}\n- **解除条件**：${request.unblockCondition}`
    });
  }
  return mutations;
}

function previewTaskCompletion(taskRef: string, agent: string, options: Pick<TaskLifecycleOptions, 'repoRoot' | 'metadataProvider'> = {}): TaskCompletionProjection {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) throw Object.assign(new Error(resolved.message), { code: resolved.code });
  if (resolved.state !== 'active') throw Object.assign(new Error(`task ${resolved.taskId} is ${resolved.state}, expected active`), { code: 'TASK_STATE_MISMATCH' });
  const original = fs.readFileSync(resolved.taskMdPath, 'utf8');
  const metadata = (options.metadataProvider ?? captureTaskWriteMetadata)();
  if (!isValidAgentInfraVersion(metadata.agentInfraVersion)) throw Object.assign(new Error('metadata agentInfraVersion is invalid'), { code: 'LIFECYCLE_METADATA_FAILED' });
  const mutations = mutationsFor({ taskRef: resolved.taskId, intent: 'complete', agent }, original, metadata, 0);
  if (!Array.isArray(mutations)) throw Object.assign(new Error(mutations.message), { code: mutations.code });
  let content = original;
  for (const mutation of mutations) {
    if (mutation.kind === 'frontmatter') content = updateTaskFrontmatter(content, mutation.set, mutation.remove);
    else if (mutation.kind === 'section') content = upsertSection(content, mutation).content;
    else throw Object.assign(new Error('completion projection contains an unsupported mutation'), { code: 'LIFECYCLE_PROJECTION_INVALID' });
  }
  content = updateTaskFrontmatter(content, { updated_at: metadata.timestamp, agent_infra_version: metadata.agentInfraVersion });
  return { taskId: resolved.taskId, content, timestamp: metadata.timestamp, agentInfraVersion: metadata.agentInfraVersion };
}

function writeJournal(file: string, journal: LifecycleJournal, io: LifecycleFileSystem, create = false): void {
  const temporary = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  io.writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, 'wx');
  try {
    if (create && fs.existsSync(file)) throw Object.assign(new Error('lifecycle journal already exists'), { code: 'LIFECYCLE_INTENT_CONFLICT' });
    io.renameSync(temporary, file);
  } catch (error) {
    try { io.unlinkSync(temporary); } catch { /* preserve primary error */ }
    throw error;
  }
}

function rememberJournalFailure(file: string, journal: LifecycleJournal, io: LifecycleFileSystem, failure: LifecycleError): void {
  try {
    writeJournal(file, { ...journal, failure }, io);
  } catch {
    // Preserve the original lifecycle failure when the diagnostic receipt cannot be updated.
  }
}

function parseJournal(content: string): LifecycleJournal {
  const value = JSON.parse(content) as Partial<LifecycleJournal>;
  if (
    value.version !== 1 || typeof value.taskId !== 'string' ||
    !lifecycleIntentCatalog.includes(value.intent as TaskLifecycleIntent) ||
    typeof value.intentDigest !== 'string' || !value.intentDigest ||
    !['active', 'blocked', 'completed', 'staging'].includes(value.sourceState ?? '') ||
    !['active', 'blocked', 'completed'].includes(value.targetState ?? '') ||
    !value.metadata || typeof value.metadata.timestamp !== 'string' ||
    typeof value.metadata.agentInfraVersion !== 'string' || !Array.isArray(value.completedSteps) ||
    value.completedSteps.some((step) => !STEPS.includes(step)) ||
    new Set(value.completedSteps).size !== value.completedSteps.length
  ) {
    throw new Error('lifecycle journal has invalid schema');
  }
  return value as LifecycleJournal;
}

/** Recovery reads the same journal contract as the lifecycle writer. */
export function readLifecycleJournalEvidence(repoRoot: string, taskId: string): Readonly<{
  exists: boolean; completedSteps: readonly string[]; failure: string | null;
}> {
  const journalPath = locateHotTaskDirs(repoRoot, taskId)
    .map((entry) => path.join(entry.taskDir, '.task-lifecycle.json'))
    .find((candidate) => fs.existsSync(candidate));
  if (!journalPath) return { exists: false, completedSteps: [], failure: null };
  try {
    const journal = parseJournal(fs.readFileSync(journalPath, 'utf8'));
    if (journal.taskId !== taskId) throw new Error('journal task identity mismatch');
    return { exists: true, completedSteps: journal.completedSteps, failure: journal.failure?.code ?? null };
  } catch { return { exists: true, completedSteps: [], failure: 'SANDBOX_CONTROL_LIFECYCLE_JOURNAL_INVALID' }; }
}

export function inspectTaskLifecycleProgress(
  repoRoot: string, taskId: string, agent: string
): 'not-started' | 'started-recoverable' | 'unknown' {
  try {
    const hot = locateHotTaskDirs(repoRoot, taskId);
    if (hot.length !== 1 || (hot[0]!.state !== 'active' && hot[0]!.state !== 'completed')) return 'unknown';
    const { state, taskDir } = hot[0]!;
    const content = fs.readFileSync(path.join(taskDir, 'task.md'), 'utf8');
    const frontmatter = parseTypedTaskFrontmatter(content);
    if (frontmatter.id !== taskId) return 'unknown';
    const journalPath = path.join(taskDir, '.task-lifecycle.json');
    if (!fs.existsSync(journalPath)) {
      if (state === 'active') return frontmatter.status === 'active' ? 'not-started' : 'unknown';
      return matchingCompletion(content, { taskRef: taskId, intent: 'complete', agent })
        ? 'started-recoverable' : 'unknown';
    }
    const journal = parseJournal(fs.readFileSync(journalPath, 'utf8'));
    const request: TaskLifecycleRequest = { taskRef: taskId, intent: 'complete', agent };
    if (journal.taskId !== taskId || journal.intent !== 'complete'
      || journal.intentDigest !== intentIdentity(request, taskId)
      || journal.sourceState !== 'active' || journal.targetState !== 'completed') return 'unknown';
    if (journal.completedSteps.some((step, index) => stepsForIntent(journal.intent)[index] !== step)) return 'unknown';
    const directoryMoved = journal.completedSteps.includes('directory-moved');
    const registryCommitted = journal.completedSteps.includes('registry-committed');
    const hasShortId = loadShortIdByTaskId(repoRoot).has(taskId);
    if (state === 'active' && (directoryMoved || !hasShortId)) return 'unknown';
    if (state === 'completed' && (!journal.completedSteps.includes('task-written')
      || !matchingCompletion(content, request) || registryCommitted || !hasShortId)) return 'unknown';
    if (frontmatter.status !== state
      && !(state === 'active' && frontmatter.status === 'completed' && matchingCompletion(content, request))) {
      return 'unknown';
    }
    return 'started-recoverable';
  } catch {
    return 'unknown';
  }
}

function applyTaskLifecycleUnlocked(requestInput: TaskLifecycleRequest, options: TaskLifecycleOptions = {}): TaskLifecycleResult {
  if (requestInput.intent === 'recover-started') {
    return failed(requestInput, { code: 'LIFECYCLE_RECOVERY_REQUIRES_AUTHORITY', message: 'recover-started must be dispatched through task control authority' });
  }
  const normalized = normalizedRequest(requestInput);
  if ('code' in normalized) return failed(requestInput, normalized);
  const request = normalized;
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const io = { ...DEFAULT_IO, ...options.fileSystem };
  let taskId: string;
  if (request.intent === 'restore') {
    if (!TASK_ID_RE.test(request.taskRef)) return failed(request, { code: 'LIFECYCLE_IDENTITY_INVALID', message: 'restore requires a full TASK-id' });
    taskId = request.taskRef;
  } else {
    const resolved = resolveTaskRef(request.taskRef, { repoRoot });
    if (!resolved.ok) return failed(request, { code: resolved.code, message: resolved.message }, { taskId: resolved.taskId });
    taskId = resolved.taskId;
  }
  const spec = transition(request);
  const hot = locateHotTaskDirs(repoRoot, taskId);
  const activeSource = hot.find((candidate) => candidate.state === 'active');
  const completedTarget = hot.find((candidate) => candidate.state === 'completed');
  const transferInProgress = request.intent === 'complete' && Boolean(activeSource && completedTarget)
    && targetContainsTask(completedTarget!.taskDir, taskId, request)
    && fs.existsSync(path.join(activeSource!.taskDir, '.task-lifecycle.json'));
  if (hot.length > 1 && !transferInProgress) return failed(request, { code: 'LIFECYCLE_IDENTITY_CONFLICT', message: `task ${taskId} exists in multiple hot states` }, { taskId });
  let sourceState: SourceState;
  let sourcePath: string;
  let restoredFiles = 0;
  if (request.intent === 'restore' && hot.length === 0) {
    const validation = validateRestoreStaging(request, repoRoot, taskId);
    if ('code' in validation) return failed(request, validation, { taskId });
    sourceState = 'staging'; sourcePath = validation.stagingDir; restoredFiles = validation.fileCount;
  } else if (activeSource && request.intent === 'complete') {
    sourceState = activeSource.state; sourcePath = activeSource.taskDir;
    restoredFiles = fs.readdirSync(sourcePath).filter((name) => !name.startsWith('.')).length;
  } else if (hot[0]) {
    sourceState = hot[0].state; sourcePath = hot[0].taskDir;
    restoredFiles = fs.readdirSync(sourcePath).filter((name) => !name.startsWith('.')).length;
  } else {
    return failed(request, { code: 'LIFECYCLE_TASK_NOT_FOUND', message: `task ${taskId} has no lifecycle source` }, { taskId });
  }
  const targetPath = path.join(repoRoot, '.agents', 'workspace', spec.target, taskId);
  const requiredSteps = stepsForIntent(request.intent);
  const movingTaskDirectory = sourcePath !== targetPath;
  const assertRuntimeMoveSafe = (): LifecycleError | null => {
    if (!movingTaskDirectory) return null;
    const controlManifest = path.join(sourcePath, '.runtime', 'sandbox-control', 'manifest.json');
    const controlLease = path.join(sourcePath, '.runtime', 'sandbox-control', 'lease.json');
    if (request.intent !== 'complete' && (fs.existsSync(controlManifest) || fs.existsSync(controlLease))) {
      return {
        code: 'LIFECYCLE_RUNTIME_MOVE_UNSAFE',
        message: 'task-bound sandbox control state exists; stop and remove the verified sandbox before moving the task directory'
      };
    }
    const orchestrationPath = path.join(sourcePath, '.runtime', 'orchestration.json');
    if (fs.existsSync(orchestrationPath)) {
      try {
        const run = JSON.parse(fs.readFileSync(orchestrationPath, 'utf8')) as { status?: unknown; pendingDelegation?: unknown };
        if (run.status === 'running' || run.pendingDelegation !== null && run.pendingDelegation !== undefined) {
          return {
            code: 'LIFECYCLE_RUNTIME_MOVE_UNSAFE',
            message: 'task orchestration has an active or pending delegation; settle it before moving the task directory'
          };
        }
      } catch {
        return {
          code: 'LIFECYCLE_RUNTIME_MOVE_UNSAFE',
          message: 'task orchestration state is unreadable; refusing to move the task directory'
        };
      }
    }
    return null;
  };
  const currentTaskFile = path.join(sourcePath, 'task.md');
  const existingJournal = fs.existsSync(path.join(sourcePath, '.task-lifecycle.json'));
  if (sourceState === spec.target && !existingJournal) {
    const content = io.readFileSync(currentTaskFile);
    if (matchingCompletion(content, request, restoredFiles)) {
      const frontmatter = parseTypedTaskFrontmatter(content);
      return {
        ...failed(request, { code: '', message: '' }), status: 'no-op', error: null, taskId,
        sourceState, targetState: spec.target, sourcePath, targetPath, pendingSteps: [],
        completedSteps: requiredSteps, timestamp: typeof frontmatter.updated_at === 'string' ? frontmatter.updated_at : null,
        agentInfraVersion: typeof frontmatter.agent_infra_version === 'string' ? frontmatter.agent_infra_version : null
      };
    }
    return failed(request, { code: 'LIFECYCLE_INTENT_CONFLICT', message: `task ${taskId} is already ${spec.target} with a different lifecycle intent` }, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath });
  }
  if (!spec.sources.includes(sourceState) && !existingJournal) {
    return failed(request, { code: 'LIFECYCLE_SOURCE_INVALID', message: `${request.intent} is not allowed from ${sourceState}` }, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath });
  }
  if (sourcePath !== targetPath && fs.existsSync(targetPath) && !existingJournal
    && !(request.intent === 'complete' && targetContainsTask(targetPath, taskId, request))) {
    return failed(request, { code: 'LIFECYCLE_TARGET_CONFLICT', message: `target directory already exists: ${targetPath}` }, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath });
  }
  const moveSafety = assertRuntimeMoveSafe();
  if (moveSafety) return failed(request, moveSafety, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath });
  const content = io.readFileSync(currentTaskFile);
  let frontmatter;
  try { frontmatter = parseTypedTaskFrontmatter(content); }
  catch (error) { return failed(request, { code: 'LIFECYCLE_DOCUMENT_INVALID', message: error instanceof Error ? error.message : String(error) }, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath }); }
  if (frontmatter.id !== taskId) return failed(request, { code: 'LIFECYCLE_IDENTITY_INVALID', message: 'task.md id does not match its lifecycle task id' }, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath });
  if (!locateActivityLog(content)) return failed(request, { code: 'LIFECYCLE_LOG_MISSING', message: 'task has no unique Activity Log section' }, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath });
  if (spec.target === 'active') {
    const contract = validateCurrentTaskContract(content);
    if (!contract.ok) return failed(request, { code: 'LIFECYCLE_DOCUMENT_INVALID', message: contract.message }, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath });
  }
  const registryRequest = executeShortIdCommand({
    operation: 'list', activeDir: path.join(repoRoot, '.agents', 'workspace', 'active'),
    shortIdLength: configuredShortIdLength(repoRoot)
  });
  if (registryRequest.status === 'failed') {
    return failed(request, registryRequest.error!, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath });
  }
  const registry = JSON.parse(registryRequest.output || '{"version":1,"ids":{}}') as { ids: Record<string, string> };
  const registeredKey = Object.entries(registry.ids).find(([, candidate]) => candidate === taskId)?.[0];
  if ((spec.registry === 'release' || request.intent === 'complete') && sourceState === 'active' && !registeredKey) {
    return failed(request, { code: 'LIFECYCLE_SHORT_ID_PRECONDITION', message: 'active source has no short-id registry entry' }, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath });
  }
  if (spec.registry === 'alloc' && !registeredKey && Object.keys(registry.ids).length >= 10 ** configuredShortIdLength(repoRoot) - 1) {
    return failed(request, { code: 'SHORT_ID_CAPACITY_EXCEEDED', message: 'short-id registry has no free slot' }, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath });
  }
  const digest = intentIdentity(request, taskId);
  const initialJournalPath = path.join(sourcePath, '.task-lifecycle.json');
  let journal: LifecycleJournal;
  let journalPath = initialJournalPath;
  if (fs.existsSync(initialJournalPath)) {
    try { journal = parseJournal(io.readFileSync(initialJournalPath)); }
    catch (error) { return failed(request, { code: 'LIFECYCLE_JOURNAL_INVALID', message: String(error) }, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath, journalPath: initialJournalPath }); }
    if (journal.taskId !== taskId || journal.intent !== request.intent) return failed(request, { code: 'LIFECYCLE_INTENT_CONFLICT', message: 'an in-progress lifecycle journal belongs to a different request' }, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath, journalPath: initialJournalPath });
    if (spec.target === 'active' && !isValidAgentInfraVersion(journal.metadata.agentInfraVersion)) {
      return failed(request, { code: 'LIFECYCLE_DOCUMENT_INVALID', message: `journal metadata agentInfraVersion must be a valid v-prefixed semver (received ${journal.metadata.agentInfraVersion})` }, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath, journalPath: initialJournalPath });
    }
    if (request.dryRun) {
      if (!journal.failure) return failed(request, { code: 'LIFECYCLE_JOURNAL_INVALID', message: 'existing lifecycle journal has no durable failure evidence for a read-only probe' }, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath, journalPath: initialJournalPath });
      return failed(request, journal.failure, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath, journalPath: initialJournalPath, completedSteps: journal.completedSteps, pendingSteps: requiredSteps.filter((step) => !journal.completedSteps.includes(step)) });
    }
    if (journal.intentDigest !== digest) return failed(request, { code: 'LIFECYCLE_INTENT_CONFLICT', message: 'an in-progress lifecycle journal belongs to a different request' }, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath, journalPath: initialJournalPath });
  } else {
    let metadata: TaskWriteMetadata;
    try { metadata = (options.metadataProvider ?? captureTaskWriteMetadata)(); }
    catch (error) { return failed(request, { code: 'LIFECYCLE_METADATA_FAILED', message: String(error) }, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath }); }
    if (spec.target === 'active' && !isValidAgentInfraVersion(metadata.agentInfraVersion)) {
      return failed(request, { code: 'LIFECYCLE_DOCUMENT_INVALID', message: `metadata agentInfraVersion must be a valid v-prefixed semver (received ${metadata.agentInfraVersion})` }, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath });
    }
    journal = { version: 1, taskId, intent: request.intent, intentDigest: digest, sourceState, targetState: spec.target, metadata, completedSteps: [] };
    if (request.dryRun) {
      const plannedMutations = mutationsFor(request, content, metadata, restoredFiles, false);
      if ('code' in plannedMutations) return failed(request, plannedMutations, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath });
      const taskPlan = writeTask(
        { taskRef: taskId, expectedState: sourceState === 'blocked' ? 'blocked' : 'active', mutations: plannedMutations, dryRun: true },
        {
          repoRoot, metadataProvider: () => metadata,
          taskLocation: sourceState === 'staging' ? { repoRoot, taskId, taskMdPath: path.join(sourcePath, 'task.md'), state: 'active' } : undefined
        }
      );
      if (taskPlan.status === 'failed') return failed(request, taskPlan.error, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath, task: { operations: taskPlan.operations } });
      return {
        ...failed(request, { code: '', message: '' }), status: 'planned', changed: true, error: null,
        taskId, sourceState, targetState: spec.target, sourcePath, targetPath, task: { operations: taskPlan.operations },
        directory: { effect: 'move', changed: true },
        shortId: {
          effect: spec.registry === 'alloc' ? (registeredKey ? 'unchanged' : 'allocated') : spec.registry === 'release' ? (registeredKey ? 'released' : 'unchanged') : 'unchanged',
          shortId: registeredKey ?? null,
          changed: spec.registry === 'alloc' ? !registeredKey : spec.registry === 'release' ? Boolean(registeredKey) : false
        },
        timestamp: metadata.timestamp, agentInfraVersion: metadata.agentInfraVersion,
        journalPath: initialJournalPath
      };
    }
    try { writeJournal(initialJournalPath, journal, io, true); }
    catch (error) { return failed(request, { code: 'LIFECYCLE_JOURNAL_WRITE_FAILED', message: String(error) }, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath }); }
  }
  const completed = new Set(journal.completedSteps);
  if (sourceState === spec.target && journal.sourceState !== spec.target) completed.add('directory-moved');
  const currentMappings = loadShortIdByTaskId(repoRoot);
  if (requiredSteps.includes('registry-committed')
    && ((spec.target === 'active' && currentMappings.has(taskId)) || (spec.target !== 'active' && !currentMappings.has(taskId)))) {
    if (completed.has('directory-moved')) completed.add('registry-committed');
  }
  let taskOperations: readonly TaskOperationSummary[] = [];
  if (options.prepareOnly && !matchingCompletion(io.readFileSync(path.join(sourcePath, 'task.md')), request, restoredFiles)) {
    return {
      ...failed(request, { code: '', message: '' }), status: 'applied', changed: true, error: null,
      taskId, sourceState, targetState: spec.target, sourcePath, targetPath,
      task: { operations: [] }, directory: { effect: 'unchanged', changed: false },
      shortId: { effect: 'unchanged', shortId: null, changed: false },
      timestamp: journal.metadata.timestamp, agentInfraVersion: journal.metadata.agentInfraVersion,
      journalPath, completedSteps: [...completed], pendingSteps: requiredSteps.filter((step) => !completed.has(step))
    };
  }
  if (matchingCompletion(io.readFileSync(path.join(sourcePath, 'task.md')), request, restoredFiles)) completed.add('task-written');
  if (!completed.has('task-written')) {
    const current = io.readFileSync(path.join(sourcePath, 'task.md'));
    const mutations = mutationsFor(request, current, journal.metadata, restoredFiles, false);
    if ('code' in mutations) return failed(request, mutations, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath, journalPath, completedSteps: [...completed], changed: completed.size > 0 });
    const writeResult = writeTask(
      { taskRef: taskId, expectedState: sourceState === 'blocked' ? 'blocked' : 'active', mutations },
      {
        repoRoot, metadataProvider: () => journal.metadata,
        fileSystem: options.taskFileSystem,
        taskLocation: sourceState === 'staging' ? { repoRoot, taskId, taskMdPath: path.join(sourcePath, 'task.md'), state: 'active' } : undefined
      }
    );
    taskOperations = writeResult.operations;
    if (writeResult.status === 'failed') return failed(request, writeResult.error, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath, journalPath, task: { operations: taskOperations }, completedSteps: [...completed], changed: completed.size > 0, timestamp: journal.metadata.timestamp, agentInfraVersion: journal.metadata.agentInfraVersion });
    completed.add('task-written'); journal.completedSteps = [...completed];
    try { writeJournal(journalPath, journal, io); }
    catch (error) { return failed(request, { code: 'LIFECYCLE_JOURNAL_WRITE_FAILED', message: String(error) }, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath, journalPath, task: { operations: taskOperations }, changed: true, completedSteps: [...completed], timestamp: journal.metadata.timestamp, agentInfraVersion: journal.metadata.agentInfraVersion }); }
  }
  if (options.prepareOnly && !completed.has('directory-moved')) {
    return {
      ...failed(request, { code: '', message: '' }), status: 'applied', changed: true, error: null,
      taskId, sourceState, targetState: spec.target, sourcePath, targetPath,
      task: { operations: taskOperations }, directory: { effect: 'unchanged', changed: false },
      shortId: { effect: 'unchanged', shortId: null, changed: false },
      timestamp: journal.metadata.timestamp, agentInfraVersion: journal.metadata.agentInfraVersion,
      journalPath, completedSteps: [...completed], pendingSteps: requiredSteps.filter((step) => !completed.has(step))
    };
  }
  if (fs.existsSync(targetPath) && !fs.existsSync(path.join(sourcePath, 'task.md'))) completed.add('directory-moved');
  if (!completed.has('directory-moved')) {
    const moveSafety = assertRuntimeMoveSafe();
    if (moveSafety) return failed(request, moveSafety, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath, journalPath, completedSteps: [...completed], changed: completed.size > 0, timestamp: journal.metadata.timestamp, agentInfraVersion: journal.metadata.agentInfraVersion });
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    if (request.intent === 'complete') {
      try {
        if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: false, mode: 0o700 });
        if (!targetContainsTask(targetPath, taskId, request)) {
          throw new Error('completed target has no matching task identity');
        }
        transferTaskContents(sourcePath, targetPath);
        for (const name of fs.readdirSync(sourcePath).filter((entry) => entry !== '.task-lifecycle.json' && entry !== 'task.md').sort()) {
          fs.rmSync(path.join(sourcePath, name), { recursive: true, force: false });
        }
        fs.rmSync(path.join(sourcePath, 'task.md'), { force: false });
        fs.rmSync(path.join(sourcePath, '.task-lifecycle.json'), { force: false });
      } catch (error) {
        const failure = { code: 'LIFECYCLE_DIRECTORY_TRANSFER_FAILED', message: String(error) } as const;
        const sourceJournalPath = path.join(sourcePath, '.task-lifecycle.json');
        rememberJournalFailure(sourceJournalPath, journal, io, failure);
        return failed(request, failure, {
          taskId, sourceState, targetState: spec.target, sourcePath, targetPath,
          journalPath: sourceJournalPath, task: { operations: taskOperations },
          changed: true, completedSteps: [...completed].filter((step) => step !== 'directory-moved'),
          pendingSteps: requiredSteps.filter((step) => !completed.has(step) || step === 'directory-moved'),
          timestamp: journal.metadata.timestamp, agentInfraVersion: journal.metadata.agentInfraVersion
        });
      }
      completed.add('directory-moved');
      journal.completedSteps = [...completed];
      journalPath = path.join(targetPath, '.task-lifecycle.json');
      try { writeJournal(journalPath, journal, io); }
      catch (error) {
        return failed(request, { code: 'LIFECYCLE_JOURNAL_WRITE_FAILED', message: String(error) }, {
          taskId, sourceState, targetState: spec.target, sourcePath, targetPath, journalPath,
          task: { operations: taskOperations }, directory: { effect: 'move', changed: true },
          changed: true, completedSteps: [...completed].filter((step) => step !== 'directory-moved'),
          pendingSteps: requiredSteps.filter((step) => step !== 'task-written'),
          timestamp: journal.metadata.timestamp, agentInfraVersion: journal.metadata.agentInfraVersion
        });
      }
    } else {
      if (fs.existsSync(targetPath)) return failed(request, { code: 'LIFECYCLE_TARGET_CONFLICT', message: `target directory already exists: ${targetPath}` }, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath, journalPath, task: { operations: taskOperations }, changed: true, completedSteps: [...completed], timestamp: journal.metadata.timestamp, agentInfraVersion: journal.metadata.agentInfraVersion });
      try { (options.directoryRenameSync ?? io.renameSync)(sourcePath, targetPath); }
      catch (error) {
        const failure = { code: 'LIFECYCLE_DIRECTORY_RENAME_FAILED', message: String(error) } as const;
        rememberJournalFailure(journalPath, journal, io, failure);
        return failed(request, failure, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath, journalPath, task: { operations: taskOperations }, changed: true, completedSteps: [...completed], timestamp: journal.metadata.timestamp, agentInfraVersion: journal.metadata.agentInfraVersion });
      }
      if (completed.has('directory-moved') && !fs.existsSync(sourcePath)) {
        journalPath = path.join(targetPath, '.task-lifecycle.json');
      } else if (!completed.has('directory-moved')) {
        completed.add('directory-moved'); journal.completedSteps = [...completed]; journalPath = path.join(targetPath, '.task-lifecycle.json');
        try { writeJournal(journalPath, journal, io); }
        catch (error) { return failed(request, { code: 'LIFECYCLE_JOURNAL_WRITE_FAILED', message: String(error) }, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath, journalPath, task: { operations: taskOperations }, directory: { effect: 'move', changed: true }, changed: true, completedSteps: [...completed], timestamp: journal.metadata.timestamp, agentInfraVersion: journal.metadata.agentInfraVersion }); }
      }
    }
  }
  let shortId: TaskLifecycleResult['shortId'] = { effect: 'unchanged', shortId: request.intent === 'complete' ? registeredKey ?? null : null, changed: false };
  if (requiredSteps.includes('registry-committed') && !completed.has('registry-committed')) {
    try { shortId = mutateShortIdRegistry(repoRoot, taskId, spec.registry); }
    catch (error) { return failed(request, { code: (error as { code?: string }).code ?? 'LIFECYCLE_SHORT_ID_FAILED', message: String(error) }, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath, journalPath, task: { operations: taskOperations }, directory: { effect: 'move', changed: true }, changed: true, completedSteps: [...completed], timestamp: journal.metadata.timestamp, agentInfraVersion: journal.metadata.agentInfraVersion }); }
    completed.add('registry-committed'); journal.completedSteps = [...completed];
    try { writeJournal(journalPath, journal, io); }
    catch (error) { return failed(request, { code: 'LIFECYCLE_JOURNAL_WRITE_FAILED', message: String(error) }, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath, journalPath, task: { operations: taskOperations }, directory: { effect: 'move', changed: true }, shortId, changed: true, completedSteps: [...completed], timestamp: journal.metadata.timestamp, agentInfraVersion: journal.metadata.agentInfraVersion }); }
  }
  const mappings = loadShortIdByTaskId(repoRoot);
  if (spec.target === 'active' && !mappings.has(taskId)) return failed(request, { code: 'LIFECYCLE_FINAL_STATE_INVALID', message: 'active lifecycle target has no short id' }, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath, changed: true, completedSteps: [...completed], pendingSteps: [], timestamp: journal.metadata.timestamp, agentInfraVersion: journal.metadata.agentInfraVersion });
  if (request.intent !== 'complete' && spec.target !== 'active' && mappings.has(taskId)) return failed(request, { code: 'LIFECYCLE_FINAL_STATE_INVALID', message: 'non-active lifecycle target retained a short id' }, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath, changed: true, completedSteps: [...completed], pendingSteps: [], timestamp: journal.metadata.timestamp, agentInfraVersion: journal.metadata.agentInfraVersion });
  try { io.unlinkSync(journalPath); }
  catch (error) { return failed(request, { code: 'LIFECYCLE_JOURNAL_CLEANUP_FAILED', message: String(error) }, { taskId, sourceState, targetState: spec.target, sourcePath, targetPath, journalPath, task: { operations: taskOperations }, directory: { effect: 'move', changed: true }, shortId, changed: true, completedSteps: [...completed], pendingSteps: [], timestamp: journal.metadata.timestamp, agentInfraVersion: journal.metadata.agentInfraVersion }); }
  return {
    ...failed(request, { code: '', message: '' }), status: 'applied', changed: true, error: null,
    taskId, sourceState, targetState: spec.target, sourcePath, targetPath,
    task: { operations: taskOperations }, directory: { effect: 'move', changed: true }, shortId,
    timestamp: journal.metadata.timestamp, agentInfraVersion: journal.metadata.agentInfraVersion,
    journalPath, completedSteps: [...completed], pendingSteps: []
  };
}

function applyTaskLifecycle(request: TaskLifecycleRequest, options: TaskLifecycleOptions = {}): TaskLifecycleResult {
  const normalized = normalizedRequest(request);
  if ('code' in normalized) return applyTaskLifecycleUnlocked(request, options);
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const taskId = normalized.intent === 'restore'
    ? normalized.taskRef
    : (() => {
      const resolved = resolveTaskRef(normalized.taskRef, { repoRoot });
      return resolved.ok ? resolved.taskId : null;
    })();
  if (!taskId) return applyTaskLifecycleUnlocked(request, options);
  try {
    return withTaskExecutionLock(repoRoot, taskId, 'task-lifecycle.move', () => applyTaskLifecycleUnlocked(request, options));
  } catch (error) {
    if (error instanceof TaskExecutionLockError) {
      return failed(request, { code: error.code, message: error.message }, { taskId });
    }
    throw error;
  }
}

function applyTaskLifecycleWithinTaskLock(
  request: TaskLifecycleRequest,
  options: TaskLifecycleOptions,
  lockedTaskId: string
): TaskLifecycleResult {
  const normalized = normalizedRequest(request);
  if ('code' in normalized) return failed(request, normalized);
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const resolved = normalized.intent === 'restore'
    ? { ok: true as const, taskId: normalized.taskRef }
    : resolveTaskRef(normalized.taskRef, { repoRoot });
  if (!resolved.ok || resolved.taskId !== lockedTaskId) {
    return failed(request, {
      code: 'LIFECYCLE_LOCK_SCOPE_MISMATCH',
      message: 'task lifecycle request does not match the held task lock'
    }, { taskId: resolved.ok ? resolved.taskId : resolved.taskId });
  }
  return applyTaskLifecycleUnlocked(request, options);
}

export {
  lifecycleIntentCatalog, lifecycleFailureCatalog, lifecycleProducerCatalog,
  applyTaskLifecycle, applyTaskLifecycleWithinTaskLock, previewTaskCompletion
};
export type {
  TaskLifecycleIntent, TaskLifecycleRequest, TaskLifecycleResult, TaskLifecycleOptions,
  LifecycleError, LifecycleJournal, LifecycleStep, TaskCompletionProjection
};
