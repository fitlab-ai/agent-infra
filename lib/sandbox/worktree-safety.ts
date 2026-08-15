import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runProbe } from './shell.ts';

type WorktreeChange = {
  indexStatus: string;
  worktreeStatus: string;
  path: string;
  originalPath?: string;
};

type WorktreeSnapshot = {
  worktree: string;
  head: string;
  changes: readonly WorktreeChange[];
  identity: string;
};

type WorktreeInspection =
  | { status: 'clean'; snapshot: WorktreeSnapshot }
  | { status: 'dirty'; snapshot: WorktreeSnapshot }
  | { status: 'failed'; worktree: string; message: string };

type WorktreeRemovalPermit = {
  mode: 'clean' | 'discard';
  snapshot: WorktreeSnapshot;
};

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
  const head = probeText(probe, resolvedWorktree, ['rev-parse', '--verify', 'HEAD']).trim();
  const status = probeText(probe, resolvedWorktree, [
    'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=none'
  ]);
  const index = probeText(probe, resolvedWorktree, ['ls-files', '--stage', '-z']);
  if (!head) throw new Error('Unable to determine worktree HEAD');
  const changes = parseStatus(status);
  const hash = createHash('sha256');
  updatePart(hash, 'worktree', resolvedWorktree);
  updatePart(hash, 'head', head);
  updatePart(hash, 'status', status);
  updatePart(hash, 'index', index);
  for (const change of changes) {
    hashPath(hash, resolvedWorktree, change.path, probe);
    if (change.originalPath) hashPath(hash, resolvedWorktree, change.originalPath, probe);
  }
  return { worktree: resolvedWorktree, head, changes, identity: hash.digest('hex') };
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
  const current = inspectWorktree(permit.snapshot.worktree, options);
  if (current.status === 'failed') throw new Error(`Unable to verify worktree permit: ${current.message}`);
  if (current.snapshot.identity !== permit.snapshot.identity || (permit.mode === 'clean' && current.status !== 'clean')) {
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
    `HEAD: ${snapshot.head}`,
    ...lines,
    `Snapshot identity: ${snapshot.identity}`
  ].join('\n');
}

export {
  createCleanPermit,
  createDiscardPermit,
  formatWorktreeSnapshot,
  inspectWorktree,
  inspectWorktrees,
  verifyWorktreePermit
};
export type { WorktreeChange, WorktreeInspection, WorktreeRemovalPermit, WorktreeSnapshot };
