import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  readStableFile,
  readStableFileSync,
  writeAtomicFile
} from '../host-control/secure-fs.ts';

export type ProjectionAncestorIdentity = Readonly<{
  path: string;
  realpath: string;
  dev: number;
  ino: number;
  mountIdentity: string;
}>;

export type SandboxTaskTreeEntry = Readonly<{
  relativePath: string;
  type: 'directory' | 'file';
  mode: number;
  sha256?: string;
}>;

export type SandboxTaskTreeSnapshot = Readonly<{
  root: string;
  treeSha256: string;
  entries: readonly SandboxTaskTreeEntry[];
}>;

export type SandboxTaskCutoverJournal = Readonly<{
  version: 1;
  state: 'prepared' | 'verified-equal' | 'preserved' | 'committed' | 'cleaned';
  taskId: string;
  generation: string;
  hostTaskDir: string;
  projectionDir: string;
  manifestPath: string;
  hostTreeSha256: string;
  projectionTreeSha256: string;
  manifestSha256: string;
  payloadRoot: string;
  error?: string;
}>;

export type SandboxTaskCutoverReconciliation = Readonly<{
  version: 1;
  action: 'reconcile-host';
  operator: string;
  confirmedAt: string;
  journalSha256: string;
  taskId: string;
  generation: string;
  hostTaskDir: string;
  projectionDir: string;
  manifestPath: string;
  payloadRoot: string;
  payloadTreeSha256: string;
  projectionTreeSha256: string;
  payloadProjectionTreeSha256: string;
  manifestSha256: string;
  hostTreeSha256: string;
}>;

const CUTOVER_COMPATIBILITY_TODO =
  'TODO(compat): Remove legacy projection manifest fields, parser branch, cutover payload handling, and related fixtures once the managed-root inventory reports zero legacy projection manifests and all pre-direct-mount containers have been recreated or removed.';

export function hasLegacySandboxProjection(manifest: Readonly<{
  taskProjectionDir?: string;
  taskProjectionTopology?: readonly ProjectionAncestorIdentity[];
}>): boolean {
  return manifest.taskProjectionDir !== undefined || manifest.taskProjectionTopology !== undefined;
}

export function sandboxTaskCutoverRoot(params: Readonly<{
  base: string;
  project: string;
  container: string;
  taskId: string;
}>): string {
  if (!/^TASK-\d{8}-\d{6}$/u.test(params.taskId)
    || !/^[A-Za-z0-9._-]+$/u.test(params.project)
    || !/^[A-Za-z0-9._-]+$/u.test(params.container)) {
    throw new Error('SANDBOX_TASK_CUTOVER_ID_INVALID');
  }
  const root = canonicalPathWithMissing(path.join(params.base, params.project, params.container, params.taskId));
  const base = canonicalPathWithMissing(params.base);
  const relative = path.relative(base, root);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('SANDBOX_TASK_CUTOVER_PATH_INVALID');
  return root;
}

function canonicalPathWithMissing(value: string): string {
  let current = path.resolve(value);
  const missing: string[] = [];
  while (!fs.existsSync(current)) {
    missing.push(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  current = fs.realpathSync.native(current);
  for (const segment of missing.reverse()) current = path.join(current, segment);
  return current;
}

function canonicalTerminalPath(value: string): string {
  return path.join(fs.realpathSync.native(path.dirname(path.resolve(value))), path.basename(value));
}

function assertRealDirectory(directory: string, code = 'SANDBOX_TASK_CUTOVER_SOURCE_INVALID'): string {
  const resolved = path.resolve(directory);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(resolved); } catch { throw new Error(`${code}: ${directory}`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${code}: ${directory}`);
  return fs.realpathSync.native(resolved);
}

function treeEntries(root: string, current: string, entries: SandboxTaskTreeEntry[]): void {
  for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(current, entry.name);
    const relativePath = path.relative(root, absolute).split(path.sep).join('/');
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`SANDBOX_TASK_CUTOVER_SOURCE_INVALID: ${absolute}`);
    if (stat.isDirectory()) {
      entries.push({ relativePath, type: 'directory', mode: stat.mode & 0o777 });
      treeEntries(root, absolute, entries);
      continue;
    }
    if (!stat.isFile()) throw new Error(`SANDBOX_TASK_CUTOVER_SOURCE_INVALID: ${absolute}`);
    const stable = readStableFileSync(absolute, { maxBytes: 64 * 1024 * 1024 });
    entries.push({
      relativePath,
      type: 'file',
      mode: stat.mode & 0o777,
      sha256: stable.sha256
    });
  }
}

export function snapshotSandboxTaskTree(directory: string): SandboxTaskTreeSnapshot {
  const root = assertRealDirectory(path.resolve(directory));
  const entries: SandboxTaskTreeEntry[] = [];
  treeEntries(root, root, entries);
  const treeSha256 = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return { root, treeSha256, entries };
}

async function writeJournal(root: string, journal: SandboxTaskCutoverJournal): Promise<void> {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  await writeAtomicFile(path.join(root, 'journal.json'), Buffer.from(`${JSON.stringify(journal)}\n`, 'utf8'), 0o600);
}

function readJournal(root: string): SandboxTaskCutoverJournal | null {
  const journalPath = path.join(root, 'journal.json');
  if (!fs.existsSync(journalPath)) return null;
  try {
    const value = JSON.parse(readStableFileSync(journalPath, { maxBytes: 1024 * 1024 }).bytes.toString('utf8')) as SandboxTaskCutoverJournal;
    if (value.version !== 1 || typeof value.state !== 'string' || typeof value.taskId !== 'string') throw new Error('invalid journal');
    return value;
  } catch {
    throw new Error(`SANDBOX_TASK_CUTOVER_JOURNAL_INVALID: ${journalPath}`);
  }
}

function journalSha256(journal: SandboxTaskCutoverJournal): string {
  return createHash('sha256').update(`${JSON.stringify(journal)}\n`, 'utf8').digest('hex');
}

function reconciliationPath(root: string): string {
  return path.join(root, 'reconciliation.json');
}

function readReconciliation(root: string): SandboxTaskCutoverReconciliation | null {
  const file = reconciliationPath(root);
  if (!fs.existsSync(file)) return null;
  try {
    const value = JSON.parse(readStableFileSync(file, { maxBytes: 1024 * 1024 }).bytes.toString('utf8')) as SandboxTaskCutoverReconciliation;
    if (value.version !== 1 || value.action !== 'reconcile-host' || typeof value.operator !== 'string'
      || typeof value.confirmedAt !== 'string' || typeof value.journalSha256 !== 'string') {
      throw new Error('invalid reconciliation');
    }
    return value;
  } catch {
    throw new Error(`SANDBOX_TASK_CUTOVER_RECONCILIATION_INVALID: ${file}`);
  }
}

export function readSandboxTaskCutoverJournal(params: Readonly<{
  base: string;
  project: string;
  container: string;
  taskId: string;
}>): SandboxTaskCutoverJournal | null {
  const root = sandboxTaskCutoverRoot(params);
  const journal = readJournal(root);
  if (!journal) return null;
  if (journal.taskId !== params.taskId) throw new Error('SANDBOX_TASK_CUTOVER_JOURNAL_INVALID');
  return journal;
}

function copyTree(source: SandboxTaskTreeSnapshot, target: string): void {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of source.entries) {
    const destination = path.join(target, entry.relativePath);
    if (entry.type === 'directory') {
      fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
      fs.chmodSync(destination, entry.mode);
      continue;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const stable = readStableFileSync(path.join(source.root, entry.relativePath), {
      maxBytes: 64 * 1024 * 1024,
      expectedSha256: entry.sha256
    });
    fs.writeFileSync(destination, stable.bytes, { mode: entry.mode, flag: 'wx' });
    fs.chmodSync(destination, entry.mode);
  }
}

type PreservedSandboxTaskCutoverState = Readonly<{
  hostTaskDir: string;
  projectionDir: string;
  manifestPath: string;
  payloadRoot: string;
  host: SandboxTaskTreeSnapshot;
  projection: SandboxTaskTreeSnapshot;
  payload: SandboxTaskTreeSnapshot;
  payloadProjection: SandboxTaskTreeSnapshot;
}>;

async function readPreservedSandboxTaskCutoverState(params: Readonly<{
  root: string;
  journal: SandboxTaskCutoverJournal;
  hostTaskDir: string;
  projectionDir: string;
  manifestPath: string;
}>): Promise<PreservedSandboxTaskCutoverState> {
  const hostTaskDir = assertRealDirectory(params.hostTaskDir, 'SANDBOX_TASK_CUTOVER_IDENTITY_INVALID');
  const projectionDir = assertRealDirectory(params.projectionDir, 'SANDBOX_TASK_CUTOVER_IDENTITY_INVALID');
  const manifestPath = canonicalTerminalPath(params.manifestPath);
  const payloadRoot = path.join(params.root, 'payload');
  if (hostTaskDir !== params.journal.hostTaskDir
    || projectionDir !== params.journal.projectionDir
    || manifestPath !== params.journal.manifestPath
    || params.journal.payloadRoot !== payloadRoot) {
    throw new Error('SANDBOX_TASK_CUTOVER_IDENTITY_INVALID');
  }

  let host: SandboxTaskTreeSnapshot;
  let projection: SandboxTaskTreeSnapshot;
  let payload: SandboxTaskTreeSnapshot;
  let payloadProjection: SandboxTaskTreeSnapshot;
  try {
    host = snapshotSandboxTaskTree(hostTaskDir);
    projection = snapshotSandboxTaskTree(projectionDir);
    payload = snapshotSandboxTaskTree(payloadRoot);
    payloadProjection = snapshotSandboxTaskTree(path.join(payloadRoot, 'projection'));
    await readStableFile(manifestPath, {
      maxBytes: 1024 * 1024,
      expectedSha256: params.journal.manifestSha256
    });
    await readStableFile(path.join(payloadRoot, 'manifest.json'), {
      maxBytes: 1024 * 1024,
      expectedSha256: params.journal.manifestSha256
    });
  } catch (error) {
    throw new Error(`SANDBOX_TASK_CUTOVER_RECONCILIATION_REQUIRED: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (projection.treeSha256 !== params.journal.projectionTreeSha256
    || payloadProjection.treeSha256 !== params.journal.projectionTreeSha256) {
    throw new Error('SANDBOX_TASK_CUTOVER_RECONCILIATION_REQUIRED: preserved projection changed');
  }
  return { hostTaskDir, projectionDir, manifestPath, payloadRoot, host, projection, payload, payloadProjection };
}

/**
 * Records the explicit host-side action after a maintainer has reconciled
 * selected projection content into the host task directory.
 */
export async function recordSandboxTaskCutoverReconciliation(params: Readonly<{
  base: string;
  project: string;
  container: string;
  taskId: string;
  generation: string;
  hostTaskDir: string;
  projectionDir: string;
  manifestPath: string;
  operator: string;
}>): Promise<SandboxTaskCutoverReconciliation> {
  const operator = params.operator.trim();
  if (!operator) throw new Error('SANDBOX_TASK_CUTOVER_RECONCILIATION_OPERATOR_REQUIRED');
  const root = sandboxTaskCutoverRoot(params);
  const journal = readJournal(root);
  if (!journal || journal.taskId !== params.taskId || journal.generation !== params.generation || journal.state !== 'preserved') {
    throw new Error('SANDBOX_TASK_CUTOVER_RECONCILIATION_REQUIRED');
  }
  const state = await readPreservedSandboxTaskCutoverState({
    root,
    journal,
    hostTaskDir: params.hostTaskDir,
    projectionDir: params.projectionDir,
    manifestPath: params.manifestPath
  });
  const reconciliation: SandboxTaskCutoverReconciliation = {
    version: 1,
    action: 'reconcile-host',
    operator,
    confirmedAt: new Date().toISOString(),
    journalSha256: journalSha256(journal),
    taskId: journal.taskId,
    generation: journal.generation,
    hostTaskDir: state.hostTaskDir,
    projectionDir: state.projectionDir,
    manifestPath: state.manifestPath,
    payloadRoot: state.payloadRoot,
    payloadTreeSha256: state.payload.treeSha256,
    projectionTreeSha256: state.projection.treeSha256,
    payloadProjectionTreeSha256: state.payloadProjection.treeSha256,
    manifestSha256: journal.manifestSha256,
    hostTreeSha256: state.host.treeSha256
  };
  await writeAtomicFile(
    reconciliationPath(root),
    Buffer.from(`${JSON.stringify(reconciliation)}\n`, 'utf8'),
    0o600
  );
  return reconciliation;
}

async function replayPreservedSandboxTaskCutover(
  params: Readonly<{
    root: string;
    journal: SandboxTaskCutoverJournal;
    hostTaskDir: string;
    projectionDir: string;
    manifestPath: string;
  }>
): Promise<SandboxTaskCutoverJournal> {
  const state = await readPreservedSandboxTaskCutoverState(params);
  const reconciliation = readReconciliation(params.root);
  if (!reconciliation) {
    throw new Error(`SANDBOX_TASK_CUTOVER_RECONCILIATION_REQUIRED: run 'ai sandbox reconcile --operator <name> ${params.journal.taskId}' after reviewing payload`);
  }
  const matches = reconciliation.journalSha256 === journalSha256(params.journal)
    && reconciliation.taskId === params.journal.taskId
    && reconciliation.generation === params.journal.generation
    && reconciliation.hostTaskDir === state.hostTaskDir
    && reconciliation.projectionDir === state.projectionDir
    && reconciliation.manifestPath === state.manifestPath
    && reconciliation.payloadRoot === state.payloadRoot
    && reconciliation.payloadTreeSha256 === state.payload.treeSha256
    && reconciliation.projectionTreeSha256 === state.projection.treeSha256
    && reconciliation.payloadProjectionTreeSha256 === state.payloadProjection.treeSha256
    && reconciliation.manifestSha256 === params.journal.manifestSha256
    && reconciliation.hostTreeSha256 === state.host.treeSha256
    && reconciliation.operator.trim().length > 0
    && reconciliation.confirmedAt.trim().length > 0;
  if (!matches) {
    throw new Error(`SANDBOX_TASK_CUTOVER_RECONCILIATION_REQUIRED: stale host reconciliation; rerun 'ai sandbox reconcile --operator <name> ${params.journal.taskId}'`);
  }
  const verifiedEqual = {
    ...params.journal,
    state: 'verified-equal' as const,
    hostTreeSha256: state.host.treeSha256,
    projectionTreeSha256: state.payloadProjection.treeSha256
  };
  await writeJournal(params.root, verifiedEqual);
  return verifiedEqual;
}

/**
 * The only compatibility boundary for manifests written before direct mounts.
 * It never reconciles projection bytes into the task directory.
 */
export async function prepareSandboxTaskCutover(params: Readonly<{
  base: string;
  project: string;
  container: string;
  taskId: string;
  generation: string;
  hostTaskDir: string;
  projectionDir: string;
  manifestPath: string;
}>): Promise<SandboxTaskCutoverJournal> {
  void CUTOVER_COMPATIBILITY_TODO;
  const root = sandboxTaskCutoverRoot(params);
  const existing = readJournal(root);
  if (existing) {
    if (existing.taskId !== params.taskId || existing.generation !== params.generation) {
      throw new Error('SANDBOX_TASK_CUTOVER_JOURNAL_INVALID');
    }
    if (existing.state === 'preserved') {
      return replayPreservedSandboxTaskCutover({
        root,
        journal: existing,
        hostTaskDir: params.hostTaskDir,
        projectionDir: params.projectionDir,
        manifestPath: params.manifestPath
      });
    }
    if (existing.state === 'verified-equal') return existing;
  }

  let host: SandboxTaskTreeSnapshot;
  let projection: SandboxTaskTreeSnapshot;
  let manifest: Awaited<ReturnType<typeof readStableFile>>;
  try {
    host = snapshotSandboxTaskTree(params.hostTaskDir);
    projection = snapshotSandboxTaskTree(params.projectionDir);
    manifest = await readStableFile(canonicalTerminalPath(params.manifestPath), { maxBytes: 1024 * 1024 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed: SandboxTaskCutoverJournal = {
      version: 1,
      state: 'prepared',
      taskId: params.taskId,
      generation: params.generation,
      hostTaskDir: path.resolve(params.hostTaskDir),
      projectionDir: path.resolve(params.projectionDir),
      manifestPath: canonicalTerminalPath(params.manifestPath),
      hostTreeSha256: '',
      projectionTreeSha256: '',
      manifestSha256: '',
      payloadRoot: path.join(root, 'payload'),
      error: message
    };
    await writeJournal(root, failed);
    throw new Error(`SANDBOX_TASK_CUTOVER_INVALID: ${message}`);
  }

  const prepared: SandboxTaskCutoverJournal = {
    version: 1,
    state: 'prepared',
    taskId: params.taskId,
    generation: params.generation,
    hostTaskDir: host.root,
    projectionDir: projection.root,
    manifestPath: canonicalTerminalPath(params.manifestPath),
    hostTreeSha256: host.treeSha256,
    projectionTreeSha256: projection.treeSha256,
    manifestSha256: manifest.sha256,
    payloadRoot: path.join(root, 'payload')
  };
  await writeJournal(root, prepared);
  if (host.treeSha256 === projection.treeSha256) {
    const verifiedEqual = { ...prepared, state: 'verified-equal' as const };
    await writeJournal(root, verifiedEqual);
    return verifiedEqual;
  }

  const payload = path.join(root, 'payload');
  const staging = path.join(root, `.staging-${process.pid}-${Date.now()}`);
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    copyTree(projection, path.join(staging, 'projection'));
    const copiedProjection = snapshotSandboxTaskTree(path.join(staging, 'projection'));
    if (copiedProjection.treeSha256 !== projection.treeSha256) throw new Error('projection digest changed while copying');
    fs.mkdirSync(path.join(staging, 'payload'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(staging, 'payload', 'manifest.json'), manifest.bytes, { flag: 'wx', mode: 0o600 });
    fs.rmSync(payload, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(payload), { recursive: true, mode: 0o700 });
    fs.renameSync(path.join(staging, 'payload'), payload);
    fs.renameSync(path.join(staging, 'projection'), path.join(payload, 'projection'));
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`SANDBOX_TASK_CUTOVER_COPY_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
  fs.rmSync(staging, { recursive: true, force: true });
  const preserved = { ...prepared, state: 'preserved' as const };
  await writeJournal(root, preserved);
  throw new Error(`SANDBOX_TASK_CUTOVER_CONFLICT: host=${host.treeSha256} projection=${projection.treeSha256} journal=${path.join(root, 'journal.json')}`);
}

export async function completeSandboxTaskCutover(params: Readonly<{
  base: string;
  project: string;
  container: string;
  taskId: string;
  generation: string;
}>): Promise<void> {
  const root = sandboxTaskCutoverRoot(params);
  const journal = readJournal(root);
  if (!journal || journal.taskId !== params.taskId || journal.generation !== params.generation) {
    throw new Error('SANDBOX_TASK_CUTOVER_JOURNAL_INVALID');
  }
  if (journal.state !== 'verified-equal') throw new Error('SANDBOX_TASK_CUTOVER_RECONCILIATION_REQUIRED');
  await writeJournal(root, { ...journal, state: 'committed' });
  await writeJournal(root, { ...journal, state: 'cleaned' });
  fs.rmSync(root, { recursive: true, force: true });
}

export function stageLegacySandboxWorkspaceView(viewRoot: string, cutoverRoot: string): string | null {
  if (!fs.existsSync(viewRoot)) return null;
  assertRealDirectory(viewRoot, 'SANDBOX_TASK_CUTOVER_VIEW_INVALID');
  const backup = path.join(cutoverRoot, 'legacy-view');
  fs.mkdirSync(cutoverRoot, { recursive: true, mode: 0o700 });
  if (fs.existsSync(backup)) throw new Error('SANDBOX_TASK_CUTOVER_VIEW_BACKUP_CONFLICT');
  fs.renameSync(viewRoot, backup);
  return backup;
}

export function restoreLegacySandboxWorkspaceView(viewRoot: string, backup: string | null): void {
  if (!backup || !fs.existsSync(backup)) return;
  if (fs.existsSync(viewRoot)) throw new Error('SANDBOX_TASK_CUTOVER_VIEW_RESTORE_CONFLICT');
  fs.mkdirSync(path.dirname(viewRoot), { recursive: true, mode: 0o700 });
  fs.renameSync(backup, viewRoot);
}
