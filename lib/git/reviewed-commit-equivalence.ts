import { execFileSync, spawnSync } from "node:child_process";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

type LocalReviewedCommitRelation =
  | {
      status: "local-equivalent";
      reviewedHead: string;
      rewrittenCommit: string;
    }
  | {
      status: "failed" | "blocked";
      code: string;
      message: string;
    };

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

function isAncestor(gitRoot: string, ancestor: string, descendant: string): boolean | null {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: gitRoot,
    encoding: "utf8"
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return null;
}

export function resolveLocalReviewedCommitRelation(input: {
  gitRoot: string;
  localHead: string;
  lastReviewedCommit: string;
  rewrittenCommit: string;
  pathspecs: string[];
}): LocalReviewedCommitRelation {
  const { gitRoot, localHead, lastReviewedCommit, rewrittenCommit, pathspecs } = input;
  const shas = [localHead, lastReviewedCommit, rewrittenCommit];
  if (shas.some((sha) => !SHA_PATTERN.test(sha) || !commitExists(gitRoot, sha))) {
    return {
      status: "blocked",
      code: "LOCAL_REWRITE_OBJECT_MISSING",
      message: "Required local rewrite Git objects are unavailable"
    };
  }

  const ancestor = isAncestor(gitRoot, rewrittenCommit, localHead);
  if (ancestor === false) {
    return {
      status: "failed",
      code: "LOCAL_REWRITE_TOPOLOGY_INVALID",
      message: "Local rewritten commit is not in the current HEAD history"
    };
  }
  if (ancestor === null) {
    return {
      status: "blocked",
      code: "LOCAL_REWRITE_GIT_EVIDENCE_UNAVAILABLE",
      message: "Unable to verify local rewrite ancestry"
    };
  }

  try {
    const parents = git(gitRoot, ["rev-parse", `${rewrittenCommit}^@`])
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "");
    if (parents.length !== 1) {
      return {
        status: "failed",
        code: "LOCAL_REWRITE_TOPOLOGY_INVALID",
        message: "Local rewritten commit is not a single-parent commit"
      };
    }

    const reviewedTree = git(gitRoot, ["rev-parse", `${lastReviewedCommit}^{tree}`]).trim();
    const rewrittenTree = git(gitRoot, ["rev-parse", `${rewrittenCommit}^{tree}`]).trim();
    if (reviewedTree !== rewrittenTree) {
      const protectedDiff = git(gitRoot, [
        "diff",
        "--no-renames",
        "--binary",
        "--full-index",
        lastReviewedCommit,
        rewrittenCommit,
        "--",
        ...pathspecs
      ]);
      if (protectedDiff !== "") {
        return {
          status: "failed",
          code: "LOCAL_REWRITE_CONTENT_MISMATCH",
          message: "Local rewritten commit differs from the reviewed protected content"
        };
      }
    }

    const postRewrite = git(gitRoot, [
      "rev-list",
      `${rewrittenCommit}..${localHead}`,
      "--",
      ...pathspecs
    ]).trim();
    if (postRewrite) {
      return {
        status: "failed",
        code: "POST_LOCAL_REWRITE_CHANGES",
        message: "Protected paths changed after the equivalent local rewrite"
      };
    }
  } catch {
    return {
      status: "blocked",
      code: "LOCAL_REWRITE_GIT_EVIDENCE_UNAVAILABLE",
      message: "Unable to verify local rewrite topology or content"
    };
  }

  return {
    status: "local-equivalent",
    reviewedHead: lastReviewedCommit,
    rewrittenCommit
  };
}

export type { LocalReviewedCommitRelation };
