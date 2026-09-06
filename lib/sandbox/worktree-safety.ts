import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProbe } from './shell.ts';
import { resolveSandboxTarget } from './workspace-identity.ts';

type WorktreeChange = {
  indexStatus: string;
  worktreeStatus: string;
  path: string;
  originalPath?: string;
};

type WorktreeSnapshot = {
  worktree: string;
  branch: string;
  head: string;
  changes: readonly WorktreeChange[];
  identity: string;
  source?: 'registered' | 'recovered';
  recovery?: WorktreeRecoveryContext;
};

type WorktreeInspection =
  | { status: 'clean'; snapshot: WorktreeSnapshot }
  | { status: 'dirty'; snapshot: WorktreeSnapshot }
  | { status: 'failed'; worktree: string; message: string };

type WorktreeRemovalPermit = {
  mode: 'clean' | 'discard';
  snapshot: WorktreeSnapshot;
};

type WorktreeRecoveryContext = Readonly<{
  repoRoot: string;
  worktreeBase: string;
  branch: string;
  identitySource: 'branch-only' | 'task-bound';
  taskId: string | null;
}>;

type Probe = typeof runProbe;

function probeText(probe: Probe, cwd: string, args: string[]): string {
  const result = probe('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : result.stderr.toString('utf8').trim();
    throw new Error(stderr || `git ${args[0] ?? 'command'} failed with exit code ${result.status ?? 'unknown'}`);
  }
  return typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8');
}

function parseStatus(raw: string): WorktreeChange[] {
  const records = raw.split('\0');
  const changes: WorktreeChange[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? '';
    if (!record || record.startsWith('# ')) continue;
    if (record.startsWith('? ')) {
      changes.push({ indexStatus: '?', worktreeStatus: '?', path: record.slice(2) });
      continue;
    }
    if (record.startsWith('1 ')) {
      const match = /^1 (..) \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s.exec(record);
      if (!match) throw new Error('Unable to parse git porcelain v2 ordinary record');
      changes.push({ indexStatus: match[1]![0]!, worktreeStatus: match[1]![1]!, path: match[2]! });
      continue;
    }
    if (record.startsWith('2 ')) {
      const match = /^2 (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s.exec(record);
      const originalPath = records[++index];
      if (!match || originalPath === undefined || originalPath === '') {
        throw new Error('Unable to parse git porcelain v2 rename record');
      }
      changes.push({
        indexStatus: match[1]![0]!,
        worktreeStatus: match[1]![1]!,
        path: match[2]!,
        originalPath
      });
      continue;
    }
    if (record.startsWith('u ')) {
      const match = /^u (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s.exec(record);
      if (!match) throw new Error('Unable to parse git porcelain v2 unmerged record');
      changes.push({ indexStatus: match[1]![0]!, worktreeStatus: match[1]![1]!, path: match[2]! });
      continue;
    }
    throw new Error(`Unsupported git porcelain v2 record '${record[0] ?? ''}'`);
  }
  return changes;
}

function updatePart(hash: ReturnType<typeof createHash>, label: string, value: string | Buffer): void {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  hash.update(`${label.length}:${label}:${data.length}:`, 'utf8');
  hash.update(data);
}

function resolveSnapshotPath(worktree: string, relativePath: string): string {
  const resolved = path.resolve(worktree, relativePath);
  const relative = path.relative(worktree, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Git reported a path outside the worktree: ${JSON.stringify(relativePath)}`);
  }
  return resolved;
}

function hashPath(hash: ReturnType<typeof createHash>, worktree: string, relativePath: string, probe: Probe): void {
  updatePart(hash, 'path', relativePath);
  const target = resolveSnapshotPath(worktree, relativePath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      updatePart(hash, 'kind', 'absent');
      return;
    }
    throw error;
  }

  updatePart(hash, 'mode', String(stat.mode & 0o7777));
  if (stat.isFile()) {
    updatePart(hash, 'kind', 'file');
    updatePart(hash, 'content', fs.readFileSync(target));
    return;
  }
  if (stat.isSymbolicLink()) {
    updatePart(hash, 'kind', 'symlink');
    updatePart(hash, 'target', fs.readlinkSync(target));
    return;
  }
  if (stat.isDirectory()) {
    updatePart(hash, 'kind', 'git-directory');
    const nestedHead = probeText(probe, target, ['rev-parse', '--verify', 'HEAD']).trim();
    const nestedStatus = probeText(probe, target, [
      'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=none'
    ]);
    const nestedIndex = probeText(probe, target, ['ls-files', '--stage', '-z']);
    updatePart(hash, 'nested-head', nestedHead);
    updatePart(hash, 'nested-status', nestedStatus);
    updatePart(hash, 'nested-index', nestedIndex);
    for (const change of parseStatus(nestedStatus)) {
      hashPath(hash, target, change.path, probe);
      if (change.originalPath) hashPath(hash, target, change.originalPath, probe);
    }
    return;
  }
  throw new Error(`Unsupported file type in dirty snapshot: ${JSON.stringify(relativePath)}`);
}

function captureOnce(worktree: string, probe: Probe): WorktreeSnapshot {
  const resolvedWorktree = path.resolve(worktree);
  const branch = probeText(probe, resolvedWorktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const head = probeText(probe, resolvedWorktree, ['rev-parse', '--verify', 'HEAD']).trim();
  const status = probeText(probe, resolvedWorktree, [
    'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=none'
  ]);
  const index = probeText(probe, resolvedWorktree, ['ls-files', '--stage', '-z']);
  if (!branch) throw new Error('Unable to determine worktree branch');
  if (!head) throw new Error('Unable to determine worktree HEAD');
  const changes = parseStatus(status);
  const hash = createHash('sha256');
  updatePart(hash, 'worktree', resolvedWorktree);
  updatePart(hash, 'branch', branch);
  updatePart(hash, 'head', head);
  updatePart(hash, 'status', status);
  updatePart(hash, 'index', index);
  for (const change of changes) {
    hashPath(hash, resolvedWorktree, change.path, probe);
    if (change.originalPath) hashPath(hash, resolvedWorktree, change.originalPath, probe);
  }
  return { worktree: resolvedWorktree, branch, head, changes, identity: hash.digest('hex') };
}

function probeTextWithEnv(
  probe: Probe,
  repoRoot: string,
  args: string[],
  env: NodeJS.ProcessEnv
): string {
  const result = probe('git', args, { cwd: repoRoot, encoding: 'utf8', env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : result.stderr.toString('utf8').trim();
    throw new Error(stderr || `git ${args[0] ?? 'command'} failed with exit code ${result.status ?? 'unknown'}`);
  }
  return typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8');
}

function probeMetadataCommand(
  probe: Probe,
  repoRoot: string,
  args: string[],
  env: NodeJS.ProcessEnv
): boolean {
  const result = probe('git', args, { cwd: repoRoot, encoding: 'utf8', env });
  if (result.error) throw result.error;
  return result.status === 0;
}

function hasValidHeadContent(content: string): boolean {
  return /^(?:ref:\s+refs\/\S+|[0-9a-f]{40}|[0-9a-f]{64})$/i.test(content.trim());
}

function assertRecoverableMetadata(worktree: string, repoRoot: string, probe: Probe): void {
  const dotGit = path.join(worktree, '.git');
  let dotGitStat: fs.Stats;
  try {
    dotGitStat = fs.lstatSync(dotGit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (dotGitStat.isSymbolicLink() || dotGitStat.isDirectory()) {
    throw new Error('WORKTREE_RECOVERY_METADATA_NOT_ELIGIBLE');
  }
  if (!dotGitStat.isFile()) throw new Error('WORKTREE_RECOVERY_METADATA_INVALID');

  const content = fs.readFileSync(dotGit, 'utf8').trim();
  const match = /^gitdir:\s*(.+)$/i.exec(content);
  if (!match) throw new Error('WORKTREE_RECOVERY_METADATA_INVALID');

  const commonDir = fs.realpathSync.native(path.resolve(repoRoot, probeText(probe, repoRoot, [
    'rev-parse', '--git-common-dir'
  ]).trim()));
  const adminRoot = path.join(commonDir, 'worktrees');
  const adminPath = path.resolve(path.dirname(dotGit), match[1]!);
  const relative = path.relative(adminRoot, adminPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new Error('WORKTREE_RECOVERY_METADATA_INVALID');
  }

  if (!fs.existsSync(adminPath)) return;
  const adminStat = fs.lstatSync(adminPath);
  if (adminStat.isSymbolicLink()) throw new Error('WORKTREE_RECOVERY_METADATA_INVALID');
  if (!adminStat.isDirectory()) return;

  const requiredFiles = ['HEAD', 'gitdir', 'commondir', 'index'];
  if (requiredFiles.some((name) => !fs.existsSync(path.join(adminPath, name)))) return;
  for (const name of requiredFiles) {
    const filePath = path.join(adminPath, name);
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('WORKTREE_RECOVERY_METADATA_INVALID');
  }

  const adminGitdir = fs.readFileSync(path.join(adminPath, 'gitdir'), 'utf8').trim();
  const adminCommonDir = fs.readFileSync(path.join(adminPath, 'commondir'), 'utf8').trim();
  const adminGitdirPath = adminGitdir
    ? fs.realpathSync.native(path.resolve(adminPath, adminGitdir))
    : '';
  const canonicalDotGit = fs.realpathSync.native(dotGit);
  const adminCommonDirPath = adminCommonDir
    ? fs.realpathSync.native(path.resolve(adminPath, adminCommonDir))
    : '';
  if (!adminGitdir || adminGitdirPath !== canonicalDotGit
    || !adminCommonDir || adminCommonDirPath !== commonDir) {
    throw new Error('WORKTREE_RECOVERY_METADATA_INVALID');
  }

  const headContent = fs.readFileSync(path.join(adminPath, 'HEAD'), 'utf8');
  const indexContent = fs.readFileSync(path.join(adminPath, 'index'));
  if (!hasValidHeadContent(headContent) || indexContent.subarray(0, 4).toString('ascii') !== 'DIRC') return;

  const validationEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_PREFIX']) {
    delete validationEnv[key];
  }
  validationEnv.GIT_DIR = adminPath;
  validationEnv.GIT_WORK_TREE = path.resolve(worktree);
  if (!probeMetadataCommand(probe, repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}'], validationEnv)) return;
  if (!probeMetadataCommand(probe, repoRoot, ['ls-files', '--stage', '-z'], validationEnv)) return;
  throw new Error('WORKTREE_RECOVERY_METADATA_REGISTERED');
}

function parseRecoveredStatus(raw: string): WorktreeChange[] {
  const records = raw.split('\0');
  const changes: WorktreeChange[] = [];
  for (let index = 0; index < records.length;) {
    const status = records[index++] ?? '';
    if (!status) continue;
    const code = status[0] ?? '';
    if (code === 'R' || code === 'C') {
      const originalPath = records[index++];
      const nextPath = records[index++];
      if (!originalPath || !nextPath) throw new Error('Unable to parse recovered Git rename record');
      changes.push({ indexStatus: code, worktreeStatus: ' ', path: nextPath, originalPath });
      continue;
    }
    const filePath = records[index++];
    if (!filePath) throw new Error('Unable to parse recovered Git status record');
    changes.push({
      indexStatus: code === 'D' ? ' ' : code,
      worktreeStatus: code === 'D' ? 'D' : ' ',
      path: filePath
    });
  }
  return changes;
}

function captureRecoveredOnce(
  worktree: string,
  recovery: WorktreeRecoveryContext,
  probe: Probe
): WorktreeSnapshot {
  const resolvedWorktree = path.resolve(worktree);
  const resolvedBase = path.resolve(recovery.worktreeBase);
  const relative = path.relative(resolvedBase, resolvedWorktree);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`WORKTREE_RECOVERY_PATH_INVALID: ${resolvedWorktree}`);
  }
  const stat = fs.lstatSync(resolvedWorktree);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('WORKTREE_RECOVERY_PATH_INVALID');
  const canonicalBase = fs.realpathSync.native(resolvedBase);
  const canonicalWorktree = fs.realpathSync.native(resolvedWorktree);
  const canonicalRelative = path.relative(canonicalBase, canonicalWorktree);
  if (!canonicalRelative || canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) {
    throw new Error('WORKTREE_RECOVERY_PATH_INVALID');
  }
  const resolvedWorkspace = resolveSandboxTarget(recovery.branch, recovery.repoRoot).workspace;
  if (recovery.identitySource === 'branch-only' && resolvedWorkspace.mode !== 'branch-only') {
    throw new Error('WORKTREE_RECOVERY_IDENTITY_CHANGED');
  }
  if (recovery.identitySource === 'task-bound'
    && (resolvedWorkspace.mode !== 'task-bound' || resolvedWorkspace.taskId !== recovery.taskId)) {
    throw new Error('WORKTREE_RECOVERY_IDENTITY_CHANGED');
  }
  assertRecoverableMetadata(resolvedWorktree, recovery.repoRoot, probe);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-recovered-index-'));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  env.GIT_INDEX_FILE = path.join(tempDir, 'index');
  env.GIT_WORK_TREE = resolvedWorktree;
  try {
    const baseline = probeTextWithEnv(probe, recovery.repoRoot, [
      'rev-parse', '--verify', `refs/heads/${recovery.branch}^{commit}`
    ], env).trim();
    if (!baseline) throw new Error(`WORKTREE_RECOVERY_BRANCH_INVALID: ${recovery.branch}`);
    probeTextWithEnv(probe, recovery.repoRoot, ['read-tree', baseline], env);
    probeTextWithEnv(probe, recovery.repoRoot, ['add', '-A', '--', '.'], env);
    const status = probeTextWithEnv(probe, recovery.repoRoot, [
      'diff', '--cached', '--name-status', '--find-renames', '-z', '--', '.'
    ], env);
    const changes = parseRecoveredStatus(status);
    const hash = createHash('sha256');
    updatePart(hash, 'source', 'recovered');
    updatePart(hash, 'worktree', resolvedWorktree);
    updatePart(hash, 'repo-root', path.resolve(recovery.repoRoot));
    updatePart(hash, 'branch', recovery.branch);
    updatePart(hash, 'baseline', baseline);
    updatePart(hash, 'identity-source', recovery.identitySource);
    updatePart(hash, 'task-id', recovery.taskId ?? '');
    updatePart(hash, 'status', status);
    for (const change of changes) {
      hashPath(hash, resolvedWorktree, change.path, probe);
      if (change.originalPath) hashPath(hash, resolvedWorktree, change.originalPath, probe);
    }
    return {
      worktree: resolvedWorktree,
      branch: recovery.branch,
      head: baseline,
      changes,
      identity: hash.digest('hex'),
      source: 'recovered',
      recovery: { ...recovery }
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function inspectWorktree(worktree: string, { probe = runProbe }: { probe?: Probe } = {}): WorktreeInspection {
  const resolvedWorktree = path.resolve(worktree);
  try {
    const first = captureOnce(resolvedWorktree, probe);
    const second = captureOnce(resolvedWorktree, probe);
    if (first.identity !== second.identity) {
      return { status: 'failed', worktree: resolvedWorktree, message: 'Snapshot changed while inspecting worktree' };
    }
    return { status: second.changes.length === 0 ? 'clean' : 'dirty', snapshot: second };
  } catch (error) {
    return {
      status: 'failed',
      worktree: resolvedWorktree,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function inspectRecoveredWorktree(
  worktree: string,
  recovery: WorktreeRecoveryContext,
  { probe = runProbe }: { probe?: Probe } = {}
): WorktreeInspection {
  const resolvedWorktree = path.resolve(worktree);
  try {
    const first = captureRecoveredOnce(resolvedWorktree, recovery, probe);
    const second = captureRecoveredOnce(resolvedWorktree, recovery, probe);
    if (first.identity !== second.identity) {
      return { status: 'failed', worktree: resolvedWorktree, message: 'Snapshot changed while recovering worktree' };
    }
    return { status: second.changes.length === 0 ? 'clean' : 'dirty', snapshot: second };
  } catch (error) {
    return {
      status: 'failed',
      worktree: resolvedWorktree,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function inspectWorktrees(worktrees: readonly string[]): WorktreeInspection[] {
  return [...new Set(worktrees.map((worktree) => path.resolve(worktree)))].sort()
    .map((worktree) => inspectWorktree(worktree));
}

function createCleanPermit(snapshot: WorktreeSnapshot): WorktreeRemovalPermit {
  if (snapshot.changes.length > 0) throw new Error('Cannot create a clean permit for a dirty worktree');
  return { mode: 'clean', snapshot };
}

function createDiscardPermit(snapshot: WorktreeSnapshot): WorktreeRemovalPermit {
  if (snapshot.changes.length === 0) throw new Error('Cannot create a discard permit for a clean worktree');
  return { mode: 'discard', snapshot };
}

function verifyWorktreePermit(
  permit: WorktreeRemovalPermit,
  options: { probe?: Probe } = {}
): WorktreeSnapshot {
  const current = permit.snapshot.source === 'recovered' && permit.snapshot.recovery
    ? inspectRecoveredWorktree(permit.snapshot.worktree, permit.snapshot.recovery, options)
    : inspectWorktree(permit.snapshot.worktree, options);
  if (current.status === 'failed') throw new Error(`Unable to verify worktree permit: ${current.message}`);
  const sameTarget = current.snapshot.worktree === permit.snapshot.worktree
    && current.snapshot.branch === permit.snapshot.branch;
  if (!sameTarget || (permit.mode === 'clean'
    && (current.snapshot.identity !== permit.snapshot.identity || current.status !== 'clean'))) {
    throw new Error(`Worktree changed after authorization: ${permit.snapshot.worktree}`);
  }
  return current.snapshot;
}

function formatWorktreeSnapshot(snapshot: WorktreeSnapshot): string {
  const lines = snapshot.changes.map((change) => {
    const rename = change.originalPath ? ` <- ${JSON.stringify(change.originalPath)}` : '';
    return `  ${change.indexStatus}${change.worktreeStatus} ${JSON.stringify(change.path)}${rename}`;
  });
  return [
    `Worktree: ${JSON.stringify(snapshot.worktree)}`,
    `Branch: ${snapshot.branch}`,
    `HEAD: ${snapshot.head}`,
    ...lines,
    `Snapshot identity: ${snapshot.identity}`
  ].join('\n');
}

export {
  createCleanPermit,
  createDiscardPermit,
  formatWorktreeSnapshot,
  inspectRecoveredWorktree,
  inspectWorktree,
  inspectWorktrees,
  verifyWorktreePermit
};
export type { WorktreeChange, WorktreeInspection, WorktreeRecoveryContext, WorktreeRemovalPermit, WorktreeSnapshot };
