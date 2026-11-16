import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PullRequestSnapshot } from "./pull-requests.ts";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

type ReviewedHeadRelation =
  | { status: "strict"; reviewedHead: string }
  | { status: "merged-equivalent"; reviewedHead: string; mergeCommit: string; comparisonHead: string }
  | { status: "failed" | "blocked"; code: string; message: string };

type CommitPullRequestIdentity = { repository: string; pullRequestNumbers: number[] };
type MergeDomain = { status: "ok"; commits: string[]; mergeBase: string } | { status: "failed" | "blocked"; relation: ReviewedHeadRelation };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitExists(gitRoot: string, sha: string): boolean {
  try { git(gitRoot, ["cat-file", "-e", `${sha}^{commit}`]); return true; } catch { return false; }
}

function isAncestor(gitRoot: string, ancestor: string, descendant: string): "yes" | "no" | "error" {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: gitRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status === 0) return "yes";
  if (result.status === 1) return "no";
  return "error";
}

function failed(code: string, message: string): ReviewedHeadRelation { return { status: "failed", code, message }; }
function blocked(message: string, code = "PR_MERGE_GIT_EVIDENCE_UNAVAILABLE"): ReviewedHeadRelation { return { status: "blocked", code, message }; }

function resolveMergeDomain(gitRoot: string, reviewedHead: string, mergeEnd: string): MergeDomain {
  try {
    const parents = git(gitRoot, ["rev-list", "--parents", "-n", "1", mergeEnd]).split(/\s+/);
    if (parents.length < 2 || !parents[1]) return { status: "failed", relation: failed("PR_MERGE_TOPOLOGY_INVALID", "PR merge end has no first parent") };
    const firstParent = parents[1];
    const result = spawnSync("git", ["merge-base", "--all", reviewedHead, firstParent], { cwd: gitRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (result.error || result.status === null || result.status > 1) return { status: "blocked", relation: blocked("Unable to compute the reviewed PR merge base") };
    const bases = result.stdout.trim() ? result.stdout.trim().split(/\s+/) : [];
    if (result.status === 1 || bases.length !== 1 || !SHA_PATTERN.test(bases[0] || "")) return { status: "failed", relation: failed("PR_MERGE_TOPOLOGY_INVALID", "Reviewed head and PR merge end first parent do not have a unique merge base") };
    const mergeBase = bases[0]!;
    const onFirstParent = isAncestor(gitRoot, mergeBase, mergeEnd);
    if (onFirstParent === "error") return { status: "blocked", relation: blocked("Unable to verify the reviewed PR merge base ancestry") };
    if (onFirstParent === "no") return { status: "failed", relation: failed("PR_MERGE_TOPOLOGY_INVALID", "Reviewed PR merge base is not on the merge end first-parent chain") };
    const commits = git(gitRoot, ["rev-list", "--first-parent", "--reverse", `${mergeBase}..${mergeEnd}`]).split(/\r?\n/).filter(Boolean);
    if (commits.length === 0 || commits.at(-1) !== mergeEnd) return { status: "failed", relation: failed("PR_MERGE_TOPOLOGY_INVALID", "PR merge end is not the end of the enumerated first-parent range") };
    let previous = mergeBase;
    for (const sha of commits) {
      const item = git(gitRoot, ["rev-list", "--parents", "-n", "1", sha]).split(/\s+/);
      if (item[1] !== previous) return { status: "failed", relation: failed("PR_MERGE_TOPOLOGY_INVALID", "First-parent range is not a continuous commit sequence") };
      previous = sha;
    }
    return { status: "ok", commits, mergeBase };
  } catch { return { status: "blocked", relation: blocked("Unable to enumerate the reviewed PR merge domain") }; }
}

function compareReplayedTree(input: { gitRoot: string; mergeBase: string; reviewedHead: string; candidateBase: string; mergeEnd: string }): ReviewedHeadRelation | null {
  const { gitRoot, mergeBase, reviewedHead, candidateBase, mergeEnd } = input;
  let tempDir: string | undefined;
  let relation: ReviewedHeadRelation | null = null;
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-merge-equivalence-"));
    const env = { ...process.env, GIT_INDEX_FILE: path.join(tempDir, "index") };
    const readTree = spawnSync("git", ["read-tree", candidateBase], { cwd: gitRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (readTree.error || readTree.status !== 0) relation = blocked("Unable to initialize isolated PR merge evidence");
    else {
      const patch = spawnSync("git", ["diff", "--no-renames", "--binary", "--full-index", mergeBase, reviewedHead], { cwd: gitRoot, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
      if (patch.error || patch.status !== 0) relation = blocked("Unable to generate the reviewed PR patch");
      else {
        const diffBlocks = patch.stdout.split(/^diff --git .*$/m).slice(1);
        const requiredBlobs = diffBlocks.flatMap((block) => {
          const index = block.match(/^index ([0-9a-f]{40})\.\.([0-9a-f]{40})(?: (\d{6}))?$/m);
          const oldMode = block.match(/^(?:old mode|deleted file mode) (\d{6})$/m)?.[1];
          const preimageMode = oldMode ?? index?.[3];
          return index && preimageMode !== "160000" && !/^0+$/.test(index[1]!) ? [index[1]!] : [];
        });
        for (const oid of requiredBlobs) {
          const blob = spawnSync("git", ["cat-file", "-e", `${oid}^{blob}`], { cwd: gitRoot, env, stdio: ["ignore", "ignore", "ignore"] });
          if (blob.error || blob.status !== 0) { relation = blocked("A reviewed patch preimage object is unavailable", "PR_MERGE_OBJECT_MISSING"); break; }
        }
        if (relation === null && patch.stdout.length > 0) {
          const apply = spawnSync("git", ["apply", "--cached", "--3way", "--binary", "-q"], { cwd: gitRoot, env, encoding: "utf8", input: patch.stdout, maxBuffer: 32 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
          const unmerged = spawnSync("git", ["ls-files", "--unmerged", "-z"], { cwd: gitRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
          if (unmerged.error || unmerged.status !== 0) relation = blocked("Unable to inspect the isolated PR merge index");
          else if (apply.status === 1 && unmerged.stdout.length > 0) relation = failed("PR_MERGE_CONTENT_MISMATCH", "Reviewed PR patch cannot be replayed without conflicts, so content equivalence cannot be established");
          else if (apply.error || apply.status !== 0 || unmerged.stdout.length > 0) relation = blocked("Unable to replay the reviewed PR patch without an unresolved index state");
        }
        if (relation === null) {
          const written = spawnSync("git", ["write-tree"], { cwd: gitRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
          const target = spawnSync("git", ["rev-parse", `${mergeEnd}^{tree}`], { cwd: gitRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
          if (written.error || written.status !== 0 || target.error || target.status !== 0) relation = blocked("Unable to compare complete PR merge trees");
          else if (written.stdout.trim() !== target.stdout.trim()) relation = failed("PR_MERGE_CONTENT_MISMATCH", "Replayed reviewed PR content differs from the authoritative merge tree");
        }
      }
    }
  } catch { relation = blocked("Unable to create isolated PR merge evidence"); }
  finally {
    if (tempDir) try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { relation = blocked("Unable to clean up isolated PR merge evidence"); }
  }
  return relation;
}

function resolveMergedGitEvidence(input: {
  gitRoot: string; comparisonHead: string; mergeEnd: string; pullRequest: PullRequestSnapshot;
  defaultBranch: string; associations: ReadonlyMap<string, CommitPullRequestIdentity>;
}): ReviewedHeadRelation | null {
  const { gitRoot, comparisonHead, mergeEnd, pullRequest, defaultBranch, associations } = input;
  const shas = [pullRequest.base.sha, pullRequest.head.sha, mergeEnd, comparisonHead];
  if (shas.some((sha) => !SHA_PATTERN.test(sha) || !commitExists(gitRoot, sha))) return blocked("Required PR merge Git objects are unavailable", "PR_MERGE_OBJECT_MISSING");
  if (pullRequest.base.ref !== defaultBranch) return failed("PR_MERGE_IDENTITY_INVALID", "Pull request target is not the repository default branch");
  const ancestry = isAncestor(gitRoot, mergeEnd, comparisonHead);
  if (ancestry === "error") return blocked("Unable to verify PR merge ancestry");
  if (ancestry === "no") return failed("PR_MERGE_TARGET_MISMATCH", "PR merge end is not in the authoritative target history");
  const domain = resolveMergeDomain(gitRoot, pullRequest.head.sha, mergeEnd);
  if (domain.status !== "ok") return domain.relation;
  const identities: number[][] = [];
  for (const sha of domain.commits) {
    const identity = associations.get(sha);
    if (!identity) return blocked("Commit pull request association evidence is incomplete");
    if (identity.repository !== pullRequest.repository || identity.pullRequestNumbers.length > 1 || new Set(identity.pullRequestNumbers).size !== identity.pullRequestNumbers.length) return failed("PR_MERGE_IDENTITY_INVALID", "Commit pull request association identity is ambiguous or inconsistent");
    identities.push(identity.pullRequestNumbers);
  }
  const targetNumber = pullRequest.number;
  if (identities.at(-1)?.filter((number) => number === targetNumber).length !== 1) return failed("PR_MERGE_IDENTITY_INVALID", "PR merge end is not uniquely associated with the target pull request");
  const targetIndexes = identities.flatMap((numbers, index) => numbers.includes(targetNumber) ? [index] : []);
  const start = targetIndexes[0];
  if (start === undefined || targetIndexes.length !== domain.commits.length - start || targetIndexes.some((index, offset) => index !== start + offset)) return failed("PR_MERGE_IDENTITY_INVALID", "Target pull request identity is not one terminal continuous commit range");
  const candidateBase = start === 0 ? domain.mergeBase : domain.commits[start - 1]!;
  const verifyBase = spawnSync("git", ["merge-base", "--all", pullRequest.head.sha, candidateBase], { cwd: gitRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (verifyBase.error || verifyBase.status === null || verifyBase.status > 1) return blocked("Unable to verify the candidate PR range base");
  const bases = verifyBase.stdout.trim() ? verifyBase.stdout.trim().split(/\s+/) : [];
  if (bases.length !== 1 || bases[0] !== domain.mergeBase) return failed("PR_MERGE_TOPOLOGY_INVALID", "Candidate PR range base does not preserve the unique reviewed merge base");
  return compareReplayedTree({ gitRoot, mergeBase: domain.mergeBase, reviewedHead: pullRequest.head.sha, candidateBase, mergeEnd });
}

export function resolveReviewedHeadRelation(input: {
  gitRoot: string; comparisonHead: string; lastReviewedCommit: string; pullRequest: PullRequestSnapshot;
  defaultBranch: string; associations: ReadonlyMap<string, CommitPullRequestIdentity>;
}): ReviewedHeadRelation {
  const { comparisonHead, lastReviewedCommit, pullRequest } = input;
  if (comparisonHead === lastReviewedCommit && lastReviewedCommit === pullRequest.head.sha && !(pullRequest.state === "closed" && pullRequest.mergedAt && pullRequest.mergeCommitSha)) return { status: "strict", reviewedHead: lastReviewedCommit };
  if (pullRequest.state !== "closed" || !pullRequest.mergedAt || !pullRequest.mergeCommitSha || lastReviewedCommit !== pullRequest.head.sha) return failed("PR_MERGE_IDENTITY_INVALID", "PR merge identity does not match the reviewed head");
  const evidenceFailure = resolveMergedGitEvidence({ ...input, mergeEnd: pullRequest.mergeCommitSha });
  if (evidenceFailure) return evidenceFailure;
  return { status: "merged-equivalent", reviewedHead: lastReviewedCommit, mergeCommit: pullRequest.mergeCommitSha, comparisonHead };
}

export { resolveMergeDomain };
export type { CommitPullRequestIdentity, MergeDomain, ReviewedHeadRelation };
