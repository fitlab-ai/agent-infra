import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function git(repoRoot: string, args: string[], options: { env?: NodeJS.ProcessEnv; encoding?: BufferEncoding | 'buffer' } = {}) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: options.encoding ?? 'utf8', env: options.env ?? process.env });
}

function splitNull(output: string): string[] { return output.split('\0').filter(Boolean); }
function exists(filePath: string): boolean { try { fs.lstatSync(filePath); return true; } catch { return false; } }

function withTemporaryIndex<T>(repoRoot: string, baseline: string, callback: (env: NodeJS.ProcessEnv) => T): T {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-review-index-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(tempDir, 'index') };
  try {
    execFileSync('git', ['read-tree', baseline], { cwd: repoRoot, env });
    return callback(env);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function projectWorktree(repoRoot: string, baseline: string, globs: string[], env: NodeJS.ProcessEnv) {
  const tracked = splitNull(String(git(repoRoot, ['diff', '--name-only', '-z', baseline, '--', ...globs])));
  const untracked = splitNull(String(git(repoRoot, ['ls-files', '-o', '--exclude-standard', '-z', '--', ...globs])));
  for (const filePath of new Set([...tracked, ...untracked])) {
    const args = exists(path.join(repoRoot, filePath)) ? ['update-index', '--add', '--', filePath] : ['update-index', '--remove', '--', filePath];
    execFileSync('git', args, { cwd: repoRoot, env });
  }
}

function projectStaged(repoRoot: string, baseline: string, globs: string[], env: NodeJS.ProcessEnv) {
  for (const filePath of splitNull(String(git(repoRoot, ['diff', '--cached', '--name-only', '-z', baseline, '--', ...globs])))) {
    const entry = execFileSync('git', ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', filePath], { cwd: repoRoot, encoding: 'buffer' });
    execFileSync('git', ['update-index', '-z', '--index-info'], {
      cwd: repoRoot, env, input: entry.length > 0 ? entry : Buffer.from(`0 ${'0'.repeat(40)}\t${filePath}\0`)
    });
  }
}

function projectSnapshot(
  repoRoot: string,
  mode: 'worktree' | 'staged',
  baseline: string,
  globs: string[]
) {
  return withTemporaryIndex(repoRoot, baseline, (env) => {
    if (mode === 'worktree') projectWorktree(repoRoot, baseline, globs, env);
    else projectStaged(repoRoot, baseline, globs, env);
    return {
      diff: execFileSync('git', ['diff', '--cached', '--binary', baseline, '--', ...globs], {
        cwd: repoRoot,
        encoding: 'buffer',
        env
      }),
      tree: String(git(repoRoot, ['write-tree'], { env })).trim()
    };
  });
}

function snapshotReview(input: {
  cwd: string;
  mode: 'worktree' | 'staged';
  baseline: string;
  diffBase?: string;
  globs: string[];
}) {
  const repoRoot = String(git(input.cwd, ['rev-parse', '--show-toplevel'])).trim();
  const resolvedBaseline = String(git(repoRoot, ['rev-parse', '--verify', `${input.baseline}^{commit}`])).trim();
  const resolvedDiffBase = String(git(
    repoRoot,
    ['rev-parse', '--verify', `${input.diffBase || resolvedBaseline}^{commit}`]
  )).trim();
  const reviewed = projectSnapshot(repoRoot, input.mode, resolvedBaseline, input.globs);
  const fingerprintSource = resolvedDiffBase === resolvedBaseline
    ? reviewed.diff
    : projectSnapshot(repoRoot, input.mode, resolvedDiffBase, input.globs).diff;
  return {
    baseline: resolvedBaseline,
    diffBase: resolvedDiffBase,
    fingerprint: `sha256:${crypto.createHash('sha256').update(fingerprintSource).digest('hex')}`,
    tree: reviewed.tree
  };
}

function compareReviewTrees(input: { cwd: string; expected: string; actual: string }) {
  const repoRoot = String(git(input.cwd, ['rev-parse', '--show-toplevel'])).trim();
  git(repoRoot, ['rev-parse', '--verify', `${input.expected}^{tree}`]);
  git(repoRoot, ['rev-parse', '--verify', `${input.actual}^{tree}`]);
  const fields = splitNull(String(git(repoRoot, ['diff', '--name-status', '-z', '--no-renames', input.expected, input.actual])));
  const result = { equal: fields.length === 0, added: [] as string[], missing: [] as string[], different: [] as string[] };
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index]; const filePath = fields[index + 1]!;
    if (status === 'A') result.added.push(filePath);
    else if (status === 'D') result.missing.push(filePath);
    else result.different.push(filePath);
  }
  return result;
}

export { compareReviewTrees, snapshotReview };
