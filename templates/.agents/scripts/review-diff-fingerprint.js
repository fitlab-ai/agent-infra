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
  console.error("Usage: node .agents/scripts/review-diff-fingerprint.js <worktree|staged> <baseline> [--format json]");
  console.error("   or: node .agents/scripts/review-diff-fingerprint.js compare <expected-tree> <actual-tree> [--format json]");
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

function pathExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function hashDiff(args, env = process.env) {
  const diff = execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "buffer",
    env
  });
  return `sha256:${crypto.createHash("sha256").update(diff).digest("hex")}`;
}

function withTemporaryIndex(baseline, callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-review-index-"));
  const tempIndex = path.join(tempDir, "index");
  const env = { ...process.env, GIT_INDEX_FILE: tempIndex };

  try {
    execFileSync("git", ["read-tree", baseline], { cwd: repoRoot, env });
    return callback(env);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function projectWorktree(baseline, globs, env) {
  const tracked = splitNull(git(["diff", "--name-only", "-z", baseline, "--", ...globs]));
  const untracked = splitNull(git(["ls-files", "-o", "--exclude-standard", "-z", "--", ...globs]));
  const paths = [...new Set([...tracked, ...untracked])];

  for (const filePath of paths) {
    const absolutePath = path.join(repoRoot, filePath);
    if (pathExists(absolutePath)) {
      execFileSync("git", ["update-index", "--add", "--", filePath], { cwd: repoRoot, env });
    } else {
      execFileSync("git", ["update-index", "--remove", "--", filePath], { cwd: repoRoot, env });
    }
  }
}

function projectStaged(baseline, globs, env) {
  const paths = splitNull(git(["diff", "--cached", "--name-only", "-z", baseline, "--", ...globs]));
  for (const filePath of paths) {
    const entry = execFileSync(
      "git",
      ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", filePath],
      { cwd: repoRoot, encoding: "buffer" }
    );
    const indexInfo = entry.length > 0
      ? entry
      : Buffer.from(`0 ${"0".repeat(40)}\t${filePath}\0`);
    execFileSync("git", ["update-index", "-z", "--index-info"], {
      cwd: repoRoot,
      env,
      input: indexInfo
    });
  }
}

function snapshot(mode, baseline, globs) {
  return withTemporaryIndex(baseline, (env) => {
    if (mode === "worktree") {
      projectWorktree(baseline, globs, env);
    } else {
      projectStaged(baseline, globs, env);
    }
    return {
      baseline,
      fingerprint: hashDiff(["diff", "--cached", "--binary", baseline, "--", ...globs], env),
      tree: git(["write-tree"], { env }).trim()
    };
  });
}

function compareTrees(expected, actual) {
  git(["rev-parse", "--verify", `${expected}^{tree}`]);
  git(["rev-parse", "--verify", `${actual}^{tree}`]);
  const fields = splitNull(git(["diff", "--name-status", "-z", "--no-renames", expected, actual]));
  const result = { equal: fields.length === 0, added: [], missing: [], different: [] };
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index];
    const filePath = fields[index + 1];
    if (status === "A") {
      result.added.push(filePath);
    } else if (status === "D") {
      result.missing.push(filePath);
    } else {
      result.different.push(filePath);
    }
  }
  return result;
}

function main(argv) {
  const [mode, first, second] = argv;
  const json = argv.includes("--format") && argv[argv.indexOf("--format") + 1] === "json";

  if (mode === "compare") {
    if (!first || !second) {
      usage();
    }
    const result = compareTrees(first, second);
    process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${result.equal ? "equal" : "different"}\n`);
    process.exitCode = result.equal ? 0 : 1;
    return;
  }

  const baseline = first;
  if (!["worktree", "staged"].includes(mode) || !baseline) {
    usage();
  }

  const resolvedBaseline = git(["rev-parse", "--verify", `${baseline}^{commit}`]).trim();
  const globs = resolvePostReviewGlobs({}, loadReviewConfig());
  const result = snapshot(mode, resolvedBaseline, globs);
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${result.fingerprint}\n`);
}

main(process.argv.slice(2));
