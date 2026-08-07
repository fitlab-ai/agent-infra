import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PullRequestSnapshot } from "./pull-requests.ts";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

type ReviewedHeadRelation =
  | { status: "strict"; reviewedHead: string }
  | {
      status: "merged-equivalent";
      reviewedHead: string;
      mergeCommit: string;
      comparisonHead: string;
    }
  | { status: "failed" | "blocked"; code: string; message: string };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function commitExists(gitRoot: string, sha: string): boolean {
  try {
    git(gitRoot, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function isAncestor(gitRoot: string, ancestor: string, descendant: string):
  | { status: "yes" | "no" }
  | { status: "error" } {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: gitRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status === 0) return { status: "yes" };
  if (result.status === 1) return { status: "no" };
  return { status: "error" };
}

function blocked(message: string): ReviewedHeadRelation {
  return { status: "blocked", code: "PR_MERGE_GIT_EVIDENCE_UNAVAILABLE", message };
}

function resolveUniqueMergeBase(
  gitRoot: string,
  reviewedHead: string,
  squashParent: string
): { status: "ok"; mergeBase: string } | { status: "failed" | "blocked"; relation: ReviewedHeadRelation } {
  const result = spawnSync("git", ["merge-base", "--all", reviewedHead, squashParent], {
    cwd: gitRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error || result.status === null || result.status > 1) {
    return { status: "blocked", relation: blocked("Unable to compute the reviewed PR merge base") };
  }
  const candidates = result.stdout.trim() === "" ? [] : result.stdout.trim().split(/\s+/);
  if (result.status === 1 || candidates.length !== 1) {
    return {
      status: "failed",
      relation: {
        status: "failed",
        code: "PR_MERGE_TOPOLOGY_INVALID",
        message: "Reviewed head and squash parent do not have a unique merge base"
      }
    };
  }
  const [candidate] = candidates;
  if (!candidate || !SHA_PATTERN.test(candidate)) {
    return { status: "blocked", relation: blocked("Git returned an invalid reviewed PR merge base") };
  }
  return { status: "ok", mergeBase: candidate };
}

function compareReplayedTree(input: {
  gitRoot: string;
  mergeBase: string;
  reviewedHead: string;
  squashParent: string;
  squashCommit: string;
}): ReviewedHeadRelation | null {
  const { gitRoot, mergeBase, reviewedHead, squashParent, squashCommit } = input;
  let tempDir: string | undefined;
  let relation: ReviewedHeadRelation | null = null;
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-merge-equivalence-"));
    const env = { ...process.env, GIT_INDEX_FILE: path.join(tempDir, "index") };
    const readTree = spawnSync("git", ["read-tree", squashParent], {
      cwd: gitRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
    });
    if (readTree.error || readTree.status !== 0) {
      relation = blocked("Unable to initialize isolated squash merge evidence");
    } else {
      const patchResult = spawnSync(
        "git",
        ["diff", "--no-renames", "--binary", "--full-index", mergeBase, reviewedHead],
        { cwd: gitRoot, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }
      );
      if (patchResult.error || patchResult.status !== 0) {
        relation = blocked("Unable to generate the reviewed PR patch");
      } else if (patchResult.stdout !== "") {
        const applyResult = spawnSync("git", ["apply", "--cached", "--3way", "--binary", "-q"], {
          cwd: gitRoot,
          env,
          encoding: "utf8",
          input: patchResult.stdout,
          maxBuffer: 32 * 1024 * 1024,
          stdio: ["pipe", "pipe", "pipe"]
        });
        if (applyResult.status === 1) {
          relation = {
            status: "failed",
            code: "PR_MERGE_CONTENT_MISMATCH",
            message: "Reviewed PR patch cannot be replayed without conflicts, so content equivalence cannot be established"
          };
        } else if (applyResult.error || applyResult.status !== 0) {
          relation = blocked("Unable to replay the reviewed PR patch");
        }
      }
      if (relation === null) {
        const compareResult = spawnSync(
          "git",
          ["diff", "--cached", "--quiet", "--no-ext-diff", squashCommit, "--"],
          { cwd: gitRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
        );
        if (compareResult.status === 1) {
          relation = {
            status: "failed",
            code: "PR_MERGE_CONTENT_MISMATCH",
            message: "Replayed reviewed PR content differs from the squash merge tree"
          };
        } else if (compareResult.error || compareResult.status !== 0) {
          relation = blocked("Unable to compare replayed PR content with the squash merge tree");
        }
      }
    }
  } catch {
    relation = blocked("Unable to create isolated squash merge evidence");
  } finally {
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        relation = blocked("Unable to clean up isolated squash merge evidence");
      }
    }
  }
  return relation;
}

export function resolveReviewedHeadRelation(input: {
  gitRoot: string;
  comparisonHead: string;
  lastReviewedCommit: string;
  pullRequest: PullRequestSnapshot;
}): ReviewedHeadRelation {
  const { gitRoot, comparisonHead, lastReviewedCommit, pullRequest } = input;
  if (
    comparisonHead === lastReviewedCommit &&
    lastReviewedCommit === pullRequest.head.sha &&
    !(pullRequest.state === "closed" && pullRequest.mergedAt && pullRequest.mergeCommitSha)
  ) {
    return { status: "strict", reviewedHead: lastReviewedCommit };
  }
  if (pullRequest.state !== "closed" || !pullRequest.mergedAt || !pullRequest.mergeCommitSha ||
      lastReviewedCommit !== pullRequest.head.sha) {
    return { status: "failed", code: "PR_MERGE_IDENTITY_INVALID", message: "PR merge identity does not match the reviewed head" };
  }
  const shas = [pullRequest.base.sha, pullRequest.head.sha, pullRequest.mergeCommitSha, comparisonHead];
  if (shas.some((sha) => !SHA_PATTERN.test(sha) || !commitExists(gitRoot, sha))) {
    return { status: "blocked", code: "PR_MERGE_OBJECT_MISSING", message: "Required PR merge Git objects are unavailable" };
  }
  const ancestry = isAncestor(gitRoot, pullRequest.mergeCommitSha, comparisonHead);
  if (ancestry.status === "no") {
    return {
      status: "failed",
      code: "PR_MERGE_TARGET_MISMATCH",
      message: "PR merge commit is not in the authoritative target history"
    };
  }
  if (ancestry.status === "error") {
    return {
      status: "blocked",
      code: "PR_MERGE_GIT_EVIDENCE_UNAVAILABLE",
      message: "Unable to verify PR merge ancestry"
    };
  }
  try {
    const parents = git(gitRoot, ["rev-list", "--parents", "-n", "1", pullRequest.mergeCommitSha]).trim().split(/\s+/);
    if (parents.length !== 2) {
      return { status: "failed", code: "PR_MERGE_TOPOLOGY_INVALID", message: "PR merge commit is not a single-parent squash commit" };
    }
    const squashParent = parents[1];
    if (!squashParent) {
      return { status: "failed", code: "PR_MERGE_TOPOLOGY_INVALID", message: "PR merge commit is not a single-parent squash commit" };
    }
    const mergeBase = resolveUniqueMergeBase(gitRoot, pullRequest.head.sha, squashParent);
    if (mergeBase.status !== "ok") return mergeBase.relation;
    const replayFailure = compareReplayedTree({
      gitRoot,
      mergeBase: mergeBase.mergeBase,
      reviewedHead: pullRequest.head.sha,
      squashParent,
      squashCommit: pullRequest.mergeCommitSha
    });
    if (replayFailure) return replayFailure;
  } catch {
    return { status: "blocked", code: "PR_MERGE_GIT_EVIDENCE_UNAVAILABLE", message: "Unable to verify PR merge topology or content" };
  }
  return {
    status: "merged-equivalent",
    reviewedHead: lastReviewedCommit,
    mergeCommit: pullRequest.mergeCommitSha,
    comparisonHead
  };
}

export type { ReviewedHeadRelation };
