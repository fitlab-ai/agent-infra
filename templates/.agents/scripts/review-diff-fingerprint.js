import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

import { resolvePostReviewGlobs } from "./lib/post-review-commit.js";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: process.cwd(),
  encoding: "utf8"
}).trim();

function usage() {
  console.error("Usage: node .agents/scripts/review-diff-fingerprint.js <worktree|staged> <baseline>");
  process.exit(2);
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: options.encoding || "utf8",
    env: options.env || process.env
  });
}

function loadReviewConfig() {
  const configPath = path.join(repoRoot, ".agents", ".airc.json");
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8")).review || {};
  } catch {
    return {};
  }
}

function splitNull(output) {
  return output.split("\0").filter((value) => value !== "");
}

function hashDiff(args, env = process.env) {
  const diff = execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "buffer",
    env
  });
  return `sha256:${crypto.createHash("sha256").update(diff).digest("hex")}`;
}

function worktreeFingerprint(baseline, globs) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-review-index-"));
  const tempIndex = path.join(tempDir, "index");
  const env = { ...process.env, GIT_INDEX_FILE: tempIndex };

  try {
    execFileSync("git", ["read-tree", baseline], { cwd: repoRoot, env });

    const tracked = splitNull(git(["diff", "--name-only", "-z", baseline, "--", ...globs]));
    const untracked = splitNull(git(["ls-files", "-o", "--exclude-standard", "-z", "--", ...globs]));
    const paths = [...new Set([...tracked, ...untracked])];

    for (const filePath of paths) {
      const absolutePath = path.join(repoRoot, filePath);
      if (fs.existsSync(absolutePath)) {
        execFileSync("git", ["update-index", "--add", "--", filePath], { cwd: repoRoot, env });
      } else {
        execFileSync("git", ["update-index", "--remove", "--", filePath], { cwd: repoRoot, env });
      }
    }

    return hashDiff(["diff", "--cached", "--binary", baseline, "--", ...globs], env);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function stagedFingerprint(baseline, globs) {
  return hashDiff(["diff", "--cached", "--binary", baseline, "--", ...globs]);
}

function main(argv) {
  const [mode, baseline] = argv;
  if (!["worktree", "staged"].includes(mode) || !baseline) {
    usage();
  }

  git(["rev-parse", "--verify", `${baseline}^{commit}`]);
  const globs = resolvePostReviewGlobs({}, loadReviewConfig());
  const fingerprint = mode === "worktree"
    ? worktreeFingerprint(baseline, globs)
    : stagedFingerprint(baseline, globs);
  process.stdout.write(`${fingerprint}\n`);
}

main(process.argv.slice(2));
