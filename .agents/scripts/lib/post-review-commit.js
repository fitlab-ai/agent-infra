import fs from "node:fs";
import path from "node:path";

import { artifactName, maxRound } from "./review-artifacts.js";

// Paths excluded from the post-review coverage gate. Fail-closed: the gate
// covers ALL tracked changes by default. This default denylist is EMPTY —
// projects opt into exclusions explicitly via review.post_review_exclude_globs.
export const DEFAULT_POST_REVIEW_EXCLUDES = [];

// Returns git pathspecs selecting "all tracked changes except project excludes".
// The leading ":/" makes coverage fail-closed (everything from the repo root);
// each exclude becomes a top-level negative pathspec. Projects extend the
// denylist via review.post_review_exclude_globs (union, deduped).
export function resolvePostReviewGlobs(config = {}, reviewConfig = {}) {
  const projectExcludes = [
    ...(Array.isArray(reviewConfig.post_review_exclude_globs) ? reviewConfig.post_review_exclude_globs : []),
    ...(Array.isArray(config.post_review_exclude_globs) ? config.post_review_exclude_globs : [])
  ];
  const excludes = [...new Set([...DEFAULT_POST_REVIEW_EXCLUDES, ...projectExcludes])];
  return [":/", ...excludes.map((p) => `:(top,exclude)${p}`)];
}

export function findAuthoritativeReviewCodeArtifact(taskDir) {
  const entries = fs.existsSync(taskDir) ? fs.readdirSync(taskDir) : [];
  const round = maxRound(entries, "review-code");
  if (round === 0) {
    return { ok: false, round: 0, fileName: null, path: null };
  }

  const fileName = artifactName("review-code", round);
  return {
    ok: true,
    round,
    fileName,
    path: path.join(taskDir, fileName)
  };
}

export function extractReviewBaseline(content) {
  const match = String(content).match(/^[-*]?\s*\*\*(?:审查基线提交|Review Baseline Commit)\*\*[:：]\s*(.*?)\s*$/m);
  return match ? match[1].trim().replace(/`/g, "") : "";
}

export function extractReviewDiffFingerprint(content) {
  const match = String(content).match(/^[-*]?\s*\*\*(?:审查差异指纹|Reviewed Diff Fingerprint)\*\*[:：]\s*(.*?)\s*$/m);
  return match ? match[1].trim().replace(/`/g, "") : "";
}

export function parseReviewVerdict(content) {
  const match = String(content).match(/^[-*]?\s*\*\*(?:总体结论|Overall Verdict)\*\*[:：]\s*(.*?)\s*$/m);
  return match ? match[1].trim() : "";
}
