import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  locateActivityLog,
  appendActivityEntry,
  pairEntries,
  parseCommitAttemptStarted
} from './activity-log.ts';
import type { CommitAttempt } from './activity-log.ts';
import { commitIntentPath, digest, readCommitIntent } from './commit-intent.ts';
import type { CommitIntent } from './commit-intent.ts';
import { parseTypedTaskFrontmatter } from './frontmatter.ts';
import { artifactName, maxRound, parseReviewSummary } from './review-artifacts.ts';
import {
  extractReviewBaseline,
  extractReviewedSnapshotTree,
  findAuthoritativeReviewCodeArtifact,
  parseReviewedGitTree
} from './review-fingerprint.ts';
import type { TaskMutation } from './write.ts';

type CommitFinalizationDisposition =
  | 'idle'
  | 'prepared'
  | 'recoverable'
  | 'invalid'
  | 'conflict'
  | 'retryable-start'
  | 'orphaned-start';

type CommitFinalizationCode =
  | 'COMMIT_FINALIZATION_PENDING'
  | 'COMMIT_FINALIZATION_EVIDENCE_MISSING'
  | 'COMMIT_FINALIZATION_EVIDENCE_INVALID'
  | 'COMMIT_FINALIZATION_CONFLICT';

type CommitFinalizationInspection = Readonly<{
  disposition: CommitFinalizationDisposition;
  code: CommitFinalizationCode | null;
  message: string;
  currentHead: string;
  committedHead: string | null;
  commitNote: string | null;
  activityNote: string | null;
  needsAnchor: boolean;
  needsLog: boolean;
  intent: CommitIntent | null;
  intentDigest: string | null;
  attempt: CommitAttempt | null;
}>;

type CreatePrCommitGate = Readonly<{
  allowed: boolean;
  code: CommitFinalizationCode | null;
  message: string;
  disposition: CommitFinalizationDisposition;
  action: 'continue' | 'rerun-commit' | 'rerun-review-code';
}>;

type CommitTaskFinalizationPlan = Readonly<{
  mutations: readonly TaskMutation[];
  commitNote: string;
}>;

const SHA_RE = /^[a-f0-9]{40,64}$/;

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function commitExists(repoRoot: string, value: string): boolean {
  return SHA_RE.test(value) && spawnSync('git', ['cat-file', '-e', `${value}^{commit}`], {
    cwd: repoRoot,
    stdio: 'ignore'
  }).status === 0;
}

function isAncestor(repoRoot: string, ancestor: string, descendant: string): boolean {
  return spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: repoRoot,
    stdio: 'ignore'
  }).status === 0;
}

function hasMatchingApprovedReview(
  taskDir: string,
  beforeRound: number,
  baseline: string,
  tree: string
): boolean {
  const entries = fs.readdirSync(taskDir);
  for (let round = Math.min(beforeRound - 1, maxRound(entries, 'review-code')); round >= 1; round -= 1) {
    const file = path.join(taskDir, artifactName('review-code', round));
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, 'utf8');
    const summary = parseReviewSummary(content);
    if (
      summary.ok
      && summary.summary.verdict === 'Approved'
      && extractReviewBaseline(content) === baseline
      && extractReviewedSnapshotTree(content) === tree
    ) return true;
  }
  return false;
}

function outcome(
  disposition: CommitFinalizationDisposition,
  overrides: Partial<CommitFinalizationInspection> = {}
): CommitFinalizationInspection {
  return {
    disposition,
    code: null,
    message: disposition,
    currentHead: '',
    committedHead: null,
    commitNote: null,
    activityNote: null,
    needsAnchor: false,
    needsLog: false,
    intent: null,
    intentDigest: null,
    attempt: null,
    ...overrides
  };
}

function invalid(
  message: string,
  currentHead = '',
  code: CommitFinalizationCode = 'COMMIT_FINALIZATION_EVIDENCE_INVALID',
  overrides: Partial<CommitFinalizationInspection> = {}
): CommitFinalizationInspection {
  return outcome('invalid', { code, message, currentHead, ...overrides });
}

function inspectCommitFinalization(
  taskDir: string,
  repoRoot: string,
  taskId: string
): CommitFinalizationInspection {
  let currentHead: string;
  let taskContent: string;
  let metadata: ReturnType<typeof parseTypedTaskFrontmatter>;
  try {
    currentHead = git(repoRoot, ['rev-parse', 'HEAD']);
    taskContent = fs.readFileSync(path.join(taskDir, 'task.md'), 'utf8');
    metadata = parseTypedTaskFrontmatter(taskContent);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }

  const activity = locateActivityLog(taskContent);
  if (!activity) return invalid('task activity log is missing or ambiguous', currentHead);
  const commitRows = pairEntries(activity.entries).filter((row) => row.step === 'Commit');
  const openRows = commitRows.filter((row) => row.started !== '' && row.done === '');
  const file = commitIntentPath(taskDir);
  if (!fs.existsSync(file)) {
    if (openRows.length === 1) {
      const attempt = parseCommitAttemptStarted(openRows[0]!.note);
      if (attempt && attempt.baseline === currentHead) {
        return outcome('retryable-start', {
          message: 'a structured Commit attempt can be safely reused',
          currentHead,
          attempt
        });
      }
    }
    if (openRows.length > 0) {
      return outcome('orphaned-start', {
        code: 'COMMIT_FINALIZATION_EVIDENCE_MISSING',
        message: 'an open Commit activity entry exists without a commit intent',
        currentHead
      });
    }
    return outcome('idle', { message: 'no active commit finalization exists', currentHead });
  }

  let raw: string;
  let intent: CommitIntent;
  try {
    raw = fs.readFileSync(file, 'utf8');
    intent = readCommitIntent(taskDir, taskId);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error), currentHead);
  }
  const intentDigest = digest(raw);
  const shared = { currentHead, intent, intentDigest, committedHead: intent.committedHead };

  if (!commitExists(repoRoot, intent.baselineHead)) {
    return invalid('commit intent baseline is not a valid Git commit', currentHead, 'COMMIT_FINALIZATION_EVIDENCE_INVALID', shared);
  }

  if (intent.phase === 'prepared') {
    if (intent.committedHead !== null || intent.pushEvidence !== null) {
      return invalid('prepared commit intent contains commit or push evidence', currentHead, 'COMMIT_FINALIZATION_EVIDENCE_INVALID', shared);
    }
    if (currentHead !== intent.baselineHead || openRows.length !== 1) {
      return outcome('conflict', {
        ...shared,
        code: 'COMMIT_FINALIZATION_CONFLICT',
        message: 'prepared commit intent does not match HEAD and exactly one open Commit entry'
      });
    }
    return outcome('prepared', { ...shared, message: 'prepared commit intent can be safely retried' });
  }

  if (!intent.committedHead || !commitExists(repoRoot, intent.committedHead)) {
    return invalid('committed intent head is missing or invalid', currentHead, 'COMMIT_FINALIZATION_EVIDENCE_INVALID', shared);
  }
  if (intent.phase === 'committed' && intent.pushEvidence !== null) {
    return invalid('committed intent contains premature push evidence', currentHead, 'COMMIT_FINALIZATION_EVIDENCE_INVALID', shared);
  }
  if (
    intent.phase === 'pushed'
    && (
      intent.pushEvidence === null
      || intent.pushEvidence.head !== intent.committedHead
      || !intent.pushEvidence.remote
      || !intent.pushEvidence.ref
    )
  ) {
    return invalid('pushed intent evidence is missing or inconsistent', currentHead, 'COMMIT_FINALIZATION_EVIDENCE_INVALID', shared);
  }
  if (currentHead !== intent.committedHead || !isAncestor(repoRoot, intent.baselineHead, intent.committedHead)) {
    return outcome('conflict', {
      ...shared,
      code: 'COMMIT_FINALIZATION_CONFLICT',
      message: 'repository HEAD or ancestry conflicts with the commit intent'
    });
  }

  const commitNote = git(repoRoot, ['show', '-s', '--format=%h%x20%s', intent.committedHead]);
  const matchingDone = commitRows.filter((row) => row.done !== '' && row.note === commitNote);
  const pushOnlyRetry = (intent.phase === 'committed' || intent.phase === 'pushed')
    && intent.baselineHead === intent.committedHead
    && matchingDone.length === 1
    && openRows.length === 1;
  const noOpCommitRetry = intent.phase === 'committed'
    && intent.baselineHead === intent.committedHead
    && matchingDone.length === 1
    && openRows.length === 1
    && openRows[0]?.attempt !== undefined;
  const review = findAuthoritativeReviewCodeArtifact(taskDir);
  let needsAnchor = false;
  if (review.ok && review.path) {
    let reviewContent: string;
    try {
      reviewContent = fs.readFileSync(review.path, 'utf8');
    } catch (error) {
      return invalid(error instanceof Error ? error.message : String(error), currentHead, 'COMMIT_FINALIZATION_EVIDENCE_MISSING', shared);
    }
    const summary = parseReviewSummary(reviewContent);
    const reviewBaseline = extractReviewBaseline(reviewContent);
    const reviewTree = extractReviewedSnapshotTree(reviewContent);
    if (!summary.ok || summary.summary.verdict !== 'Approved' || !commitExists(repoRoot, reviewBaseline) || !parseReviewedGitTree(reviewTree)) {
      return invalid('authoritative review-code evidence is not a valid approved snapshot', currentHead, 'COMMIT_FINALIZATION_EVIDENCE_INVALID', shared);
    }
    const committedTree = git(repoRoot, ['rev-parse', `${intent.committedHead}^{tree}`]);
    const matchingCurrentReview = reviewBaseline === intent.baselineHead && reviewTree === committedTree;
    if (
      !matchingCurrentReview
      && !hasMatchingApprovedReview(
        taskDir,
        review.round,
        intent.baselineHead,
        committedTree
      )
    ) {
      return outcome('conflict', {
        ...shared,
        code: 'COMMIT_FINALIZATION_CONFLICT',
        message: 'review baseline or snapshot tree conflicts with the committed intent'
      });
    }

    const anchor = String(metadata.last_reviewed_commit ?? '').trim();
    if (anchor && anchor !== intent.committedHead && anchor !== intent.baselineHead) {
      return outcome('conflict', {
        ...shared,
        code: 'COMMIT_FINALIZATION_CONFLICT',
        message: 'task review anchor conflicts with the committed intent'
      });
    }
    needsAnchor = anchor !== intent.committedHead;
  }
  const needsLog = (matchingDone.length === 0 && openRows.length === 1) || pushOnlyRetry || noOpCommitRetry;
  if (!(needsLog || (matchingDone.length === 1 && openRows.length === 0))) {
    return outcome('conflict', {
      ...shared,
      code: 'COMMIT_FINALIZATION_CONFLICT',
      message: 'Commit activity identity is missing, duplicated, or ambiguous',
      commitNote
    });
  }
  return outcome('recoverable', {
    ...shared,
    message: 'commit finalization can be recovered',
    commitNote,
    activityNote: pushOnlyRetry ? `Pushed ${commitNote}` : commitNote,
    needsAnchor,
    needsLog
  });
}

function planCommitTaskFinalization(
  taskDir: string,
  inspection: CommitFinalizationInspection,
  agent: string,
  timestamp: string
): CommitTaskFinalizationPlan {
  if (
    inspection.disposition !== 'recoverable'
    || !inspection.committedHead
    || !inspection.commitNote
    || !inspection.activityNote
  ) {
    throw new Error('commit finalization task mutations require a recoverable inspection');
  }
  const taskContent = fs.readFileSync(path.join(taskDir, 'task.md'), 'utf8');
  const frontmatter: Record<string, string> = { assigned_to: agent };
  if (inspection.needsAnchor) frontmatter.last_reviewed_commit = inspection.committedHead;
  const mutations: TaskMutation[] = [{
    kind: 'frontmatter',
    set: frontmatter
  }];
  if (inspection.needsLog) {
    const activity = locateActivityLog(taskContent);
    if (!activity) throw new Error('task activity log is missing or ambiguous');
    mutations.push({
      kind: 'section',
      aliases: ['活动日志', 'Activity Log'],
      heading: activity.heading,
      body: appendActivityEntry(activity, {
        time: timestamp,
        step: 'Commit',
        agent,
        note: inspection.activityNote
      })
    });
  }
  return { mutations, commitNote: inspection.commitNote };
}

function inspectCreatePrCommitGate(taskDir: string, repoRoot: string, taskId: string): CreatePrCommitGate {
  const lifecycle = inspectCommitFinalization(taskDir, repoRoot, taskId);
  if (lifecycle.disposition !== 'idle') {
    const pending = lifecycle.disposition === 'prepared' || lifecycle.disposition === 'recoverable';
    return {
      allowed: false,
      code: pending ? 'COMMIT_FINALIZATION_PENDING' : lifecycle.code ?? 'COMMIT_FINALIZATION_CONFLICT',
      message: pending ? 'commit finalization must complete before creating a pull request' : lifecycle.message,
      disposition: lifecycle.disposition,
      action: 'rerun-commit'
    };
  }

  const review = findAuthoritativeReviewCodeArtifact(taskDir);
  if (!review.ok || !review.path) {
    return { allowed: true, code: null, message: 'no review-code history requires an anchor', disposition: 'idle', action: 'continue' };
  }
  try {
    const content = fs.readFileSync(review.path, 'utf8');
    const summary = parseReviewSummary(content);
    if (!summary.ok || summary.summary.verdict !== 'Approved') {
      return {
        allowed: false,
        code: 'COMMIT_FINALIZATION_EVIDENCE_INVALID',
        message: 'latest authoritative review-code is not approved',
        disposition: 'idle',
        action: 'rerun-review-code'
      };
    }
    const task = parseTypedTaskFrontmatter(fs.readFileSync(path.join(taskDir, 'task.md'), 'utf8'));
    const currentHead = git(repoRoot, ['rev-parse', 'HEAD']);
    const anchor = String(task.last_reviewed_commit ?? '').trim();
    if (!anchor || !commitExists(repoRoot, anchor)) {
      return {
        allowed: false,
        code: 'COMMIT_FINALIZATION_EVIDENCE_MISSING',
        message: 'approved review snapshot is not anchored to a Git commit',
        disposition: 'idle',
        action: 'rerun-commit'
      };
    }
    if (anchor !== currentHead || extractReviewedSnapshotTree(content) !== git(repoRoot, ['rev-parse', 'HEAD^{tree}'])) {
      return {
        allowed: false,
        code: 'COMMIT_FINALIZATION_CONFLICT',
        message: 'approved review anchor or tree does not match repository HEAD',
        disposition: 'idle',
        action: 'rerun-review-code'
      };
    }
    return { allowed: true, code: null, message: 'commit finalization evidence is complete', disposition: 'idle', action: 'continue' };
  } catch (error) {
    return {
      allowed: false,
      code: 'COMMIT_FINALIZATION_EVIDENCE_INVALID',
      message: error instanceof Error ? error.message : String(error),
      disposition: 'idle',
      action: 'rerun-review-code'
    };
  }
}

export {
  inspectCommitFinalization,
  inspectCreatePrCommitGate,
  planCommitTaskFinalization
};
export type {
  CommitFinalizationCode,
  CommitFinalizationDisposition,
  CommitFinalizationInspection,
  CommitTaskFinalizationPlan,
  CreatePrCommitGate
};
