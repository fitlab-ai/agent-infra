import { execFileSync } from "node:child_process";

import type { PullRequestSnapshot } from "./pull-requests.ts";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

type ReviewedHeadRelation =
  | { status: "strict"; reviewedHead: string }
  | { status: "merged-equivalent"; reviewedHead: string; mergeCommit: string }
  | { status: "failed" | "blocked"; code: string; message: string };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function commitExists(gitRoot: string, sha: string): boolean {
  try {
    git(gitRoot, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export function resolveReviewedHeadRelation(input: {
  gitRoot: string;
  localHead: string;
  lastReviewedCommit: string;
  pullRequest: PullRequestSnapshot;
  pathspecs: string[];
}): ReviewedHeadRelation {
  const { gitRoot, localHead, lastReviewedCommit, pullRequest, pathspecs } = input;
  if (localHead === lastReviewedCommit && lastReviewedCommit === pullRequest.head.sha) {
    return { status: "strict", reviewedHead: lastReviewedCommit };
  }
  if (pullRequest.state !== "closed" || !pullRequest.mergedAt || !pullRequest.mergeCommitSha ||
      lastReviewedCommit !== pullRequest.head.sha) {
    return { status: "failed", code: "PR_MERGE_IDENTITY_INVALID", message: "PR merge identity does not match the reviewed head" };
  }
  const shas = [pullRequest.base.sha, pullRequest.head.sha, pullRequest.mergeCommitSha, localHead];
  if (shas.some((sha) => !SHA_PATTERN.test(sha) || !commitExists(gitRoot, sha))) {
    return { status: "blocked", code: "PR_MERGE_OBJECT_MISSING", message: "Required PR merge Git objects are unavailable" };
  }
  try {
    git(gitRoot, ["merge-base", "--is-ancestor", pullRequest.mergeCommitSha, localHead]);
    const parents = git(gitRoot, ["rev-list", "--parents", "-n", "1", pullRequest.mergeCommitSha]).trim().split(/\s+/);
    if (parents.length !== 2) {
      return { status: "failed", code: "PR_MERGE_TOPOLOGY_INVALID", message: "PR merge commit is not a single-parent squash commit" };
    }
    const diffArgs = ["diff", "--no-renames", "--binary", "--full-index"];
    const reviewedDiff = git(gitRoot, [...diffArgs, pullRequest.base.sha, pullRequest.head.sha]);
    const mergedDiff = git(gitRoot, [...diffArgs, `${pullRequest.mergeCommitSha}^`, pullRequest.mergeCommitSha]);
    if (reviewedDiff !== mergedDiff) {
      return { status: "failed", code: "PR_MERGE_CONTENT_MISMATCH", message: "Squash merge content differs from the reviewed PR changes" };
    }
    const postMerge = git(gitRoot, ["rev-list", `${pullRequest.mergeCommitSha}..${localHead}`, "--", ...pathspecs]).trim();
    if (postMerge) {
      return { status: "failed", code: "POST_MERGE_CHANGES", message: "Protected paths changed after the squash merge" };
    }
  } catch {
    return { status: "blocked", code: "PR_MERGE_GIT_EVIDENCE_UNAVAILABLE", message: "Unable to verify PR merge topology or content" };
  }
  return {
    status: "merged-equivalent",
    reviewedHead: lastReviewedCommit,
    mergeCommit: pullRequest.mergeCommitSha
  };
}

export type { ReviewedHeadRelation };
