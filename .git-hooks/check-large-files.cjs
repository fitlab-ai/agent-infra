#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MAX_BLOB_BYTES = 1024 * 1024;
const ALLOWLIST_FILE = ".git-large-file-allowlist";

function runGit(args, options = {}) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr || `git ${args[0]} failed.\n`);
    process.exit(result.status || 1);
  }

  return result.stdout;
}

function readAllowlist(repositoryRoot) {
  const allowlistPath = path.join(repositoryRoot, ALLOWLIST_FILE);
  if (!fs.existsSync(allowlistPath)) {
    return new Set();
  }

  return new Set(
    fs.readFileSync(allowlistPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
  );
}

function stagedBlob(repositoryRoot, relativePath) {
  const entry = runGit(["ls-files", "--stage", "-z", "--", relativePath], {
    cwd: repositoryRoot
  }).split("\0").find(Boolean);

  if (!entry) {
    return null;
  }

  const tabIndex = entry.indexOf("\t");
  const [mode, objectId, stage] = entry.slice(0, tabIndex).split(" ");
  if (stage !== "0" || mode === "160000") {
    return null;
  }

  const size = Number(runGit(["cat-file", "-s", objectId], { cwd: repositoryRoot }).trim());
  return Number.isFinite(size) ? { objectId, size } : null;
}

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

const repositoryRoot = runGit(["rev-parse", "--show-toplevel"]).trim();
const allowlist = readAllowlist(repositoryRoot);
const stagedPaths = runGit(
  ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
  { cwd: repositoryRoot }
).split("\0").filter(Boolean);

const oversized = [];
for (const relativePath of stagedPaths) {
  if (allowlist.has(relativePath)) {
    continue;
  }

  const blob = stagedBlob(repositoryRoot, relativePath);
  if (blob && blob.size > MAX_BLOB_BYTES) {
    oversized.push({ relativePath, size: blob.size });
  }
}

if (oversized.length > 0) {
  process.stderr.write(`Large-file check failed: staged Git blobs must not exceed 1 MiB.\n`);
  for (const { relativePath, size } of oversized) {
    process.stderr.write(`  - ${relativePath} (${formatBytes(size)})\n`);
  }
  process.stderr.write(
    `Use Git LFS so Git stores a small pointer, or add an exact repository-relative path to ${ALLOWLIST_FILE}.\n`
  );
  process.exit(1);
}

process.stdout.write("Large-file check passed.\n");
