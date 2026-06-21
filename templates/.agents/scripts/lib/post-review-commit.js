import fs from "node:fs";
import path from "node:path";

import { artifactName, maxRound } from "./review-artifacts.js";

export const DEFAULT_POST_REVIEW_GLOBS = [
  ".agents/skills",
  ".agents/scripts",
  ".agents/rules",
  ".agents/workflows",
  "bin",
  "lib",
  "src",
  "templates"
];

export function resolvePostReviewGlobs(config = {}, reviewConfig = {}) {
  if (Array.isArray(config.post_review_globs)) {
    return config.post_review_globs;
  }
  if (Array.isArray(reviewConfig.post_review_globs)) {
    return reviewConfig.post_review_globs;
  }
  return DEFAULT_POST_REVIEW_GLOBS;
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
