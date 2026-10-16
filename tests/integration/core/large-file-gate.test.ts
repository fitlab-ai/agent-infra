import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { createTempDir, filePath, gitSafeEnv, initIsolatedGitRepo } from "../../helpers.ts";

const checkScript = filePath(".git-hooks/check-large-files.cjs");
const oneMiB = 1024 * 1024;

function git(repositoryRoot: string, ...args: string[]) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: gitSafeEnv()
  });
  assert.equal(result.status, 0, result.stderr);
}

function runCheck(repositoryRoot: string) {
  return spawnSync(process.execPath, [checkScript], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: gitSafeEnv()
  });
}

function withRepository(run: (repositoryRoot: string) => void) {
  const repositoryRoot = createTempDir("agent-infra-large-file-");
  try {
    initIsolatedGitRepo(repositoryRoot);
    run(repositoryRoot);
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
}

test("large-file gate accepts staged blobs up to 1 MiB", () => {
  withRepository((repositoryRoot) => {
    fs.writeFileSync(path.join(repositoryRoot, "boundary.bin"), Buffer.alloc(oneMiB));
    git(repositoryRoot, "add", "boundary.bin");

    assert.equal(runCheck(repositoryRoot).status, 0);
  });
});

test("large-file gate rejects staged blobs larger than 1 MiB", () => {
  withRepository((repositoryRoot) => {
    const relativePath = "large file.bin";
    fs.writeFileSync(path.join(repositoryRoot, relativePath), Buffer.alloc(oneMiB + 1));
    git(repositoryRoot, "add", relativePath);

    const result = runCheck(repositoryRoot);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /large file\.bin/);
    assert.match(result.stderr, /\.git-large-file-allowlist/);
  });
});

test("large-file gate accepts exact allowlist entries", () => {
  withRepository((repositoryRoot) => {
    fs.writeFileSync(path.join(repositoryRoot, "large.bin"), Buffer.alloc(oneMiB + 1));
    fs.writeFileSync(path.join(repositoryRoot, ".git-large-file-allowlist"), "# Reviewed exception\nlarge.bin\n");
    git(repositoryRoot, "add", "large.bin", ".git-large-file-allowlist");

    assert.equal(runCheck(repositoryRoot).status, 0);
  });
});

test("large-file gate measures the staged Git LFS pointer instead of the worktree file", () => {
  withRepository((repositoryRoot) => {
    const targetPath = path.join(repositoryRoot, "large.bin");
    fs.writeFileSync(
      targetPath,
      "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nsize 2097152\n"
    );
    git(repositoryRoot, "add", "large.bin");
    fs.writeFileSync(targetPath, Buffer.alloc(2 * oneMiB));

    assert.equal(runCheck(repositoryRoot).status, 0);
  });
});

test("large-file gate ignores untracked large files", () => {
  withRepository((repositoryRoot) => {
    fs.writeFileSync(path.join(repositoryRoot, "untracked.bin"), Buffer.alloc(oneMiB + 1));

    assert.equal(runCheck(repositoryRoot).status, 0);
  });
});
