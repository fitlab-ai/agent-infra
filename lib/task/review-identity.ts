import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { resolveBranchWorktree } from '../git/branch-worktree.ts';
import { snapshotReview } from '../git/review-snapshot.ts';
import { resolveDeliveryTarget } from './delivery-target.ts';
import { parseTypedTaskFrontmatter } from './frontmatter.ts';
import {
  extractReviewDiffBase,
  extractReviewDiffFingerprint,
  extractReviewedHead,
  extractReviewTargetHead,
  extractReviewedSnapshotTree,
  loadPostReviewConfig,
  resolvePostReviewGlobs
} from './review-fingerprint.ts';

export type ReviewIdentityResult = Readonly<{
  status: 'matched' | 'different' | 'indeterminate';
  message: string;
  reviewedHead: string | null;
  currentHead: string | null;
}>;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function result(
  status: ReviewIdentityResult['status'], message: string,
  reviewedHead: string | null = null, currentHead: string | null = null
): ReviewIdentityResult {
  return { status, message, reviewedHead, currentHead };
}

export function inspectReviewIdentity(taskDir: string, reportContent: string, repositoryRoot?: string): ReviewIdentityResult {
  const reviewedHead = extractReviewedHead(reportContent);
  const targetHead = extractReviewTargetHead(reportContent);
  const diffBase = extractReviewDiffBase(reportContent);
  const fingerprint = extractReviewDiffFingerprint(reportContent);
  const reviewedTree = extractReviewedSnapshotTree(reportContent);
  if (!reviewedHead || !targetHead || !diffBase || !fingerprint || !reviewedTree) {
    return result('indeterminate', 'Review report is missing commit or snapshot identity', reviewedHead || null);
  }
  try {
    const metadata = parseTypedTaskFrontmatter(fs.readFileSync(path.join(taskDir, 'task.md'), 'utf8'));
    const taskRepositoryRoot = git(taskDir, ['rev-parse', '--show-toplevel']);
    const branch = String(metadata.branch ?? '').trim();
    const gitRoot = branch ? resolveBranchWorktree(taskRepositoryRoot, branch) : taskRepositoryRoot;
    if (!gitRoot) return result('indeterminate', `Task branch '${branch}' is not checked out in a registered worktree`, reviewedHead);
    const currentHead = git(gitRoot, ['rev-parse', 'HEAD']);
    const baseline = git(gitRoot, ['rev-parse', `${reviewedHead}^{commit}`]);
    if (baseline !== currentHead) return result('different', 'Reviewed commit differs from current HEAD', baseline, currentHead);

    const remote = String(metadata.delivery_remote ?? '').trim();
    const baseRef = String(metadata.delivery_base_ref ?? '').trim();
    if (!remote || !baseRef) return result('indeterminate', 'Task delivery target is not bound', baseline, currentHead);
    const target = resolveDeliveryTarget(gitRoot, { remote, baseRef });
    if (!target.ok) return result('indeterminate', target.message, baseline, currentHead);
    const currentTarget = git(gitRoot, ['rev-parse', `${targetHead}^{commit}`]);
    const computedDiffBase = git(gitRoot, ['merge-base', baseline, currentTarget]);
    if (git(gitRoot, ['rev-parse', `${diffBase}^{commit}`]) !== computedDiffBase) {
      return result('different', 'Saved review diff base no longer matches the current target', baseline, currentHead);
    }

    const globs = resolvePostReviewGlobs({}, loadPostReviewConfig(repositoryRoot ?? taskRepositoryRoot));
    const trackedChanges = git(gitRoot, ['diff', '--name-only', '-z', baseline, '--', ...globs]);
    const untrackedChanges = git(gitRoot, ['ls-files', '-o', '--exclude-standard', '-z', '--', ...globs]);
    if (trackedChanges || untrackedChanges) return result('different', 'Reviewed worktree contains uncommitted changes', baseline, currentHead);

    const snapshot = snapshotReview({
      cwd: gitRoot,
      mode: 'worktree',
      baseline,
      diffBase: computedDiffBase,
      globs
    });
    if (snapshot.fingerprint !== fingerprint) return result('different', 'Reviewed diff fingerprint differs from the current worktree', baseline, currentHead);
    if (snapshot.tree !== reviewedTree) return result('different', 'Reviewed snapshot tree differs from the current worktree', baseline, currentHead);
    return result('matched', 'Review report matches the current commit and clean worktree', baseline, currentHead);
  } catch (error) {
    return result('indeterminate', error instanceof Error ? error.message : String(error), reviewedHead);
  }
}
