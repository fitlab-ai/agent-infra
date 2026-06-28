import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { filePath, gitSafeEnv, initIsolatedGitRepo, onPlatforms } from "../../helpers.ts";
import { withTempRoot, write } from "./validate-artifact-helpers.ts";

const fingerprintScript = filePath(".agents/scripts/review-diff-fingerprint.js");

function git(repoRoot: string, args: string[]) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", env: gitSafeEnv() });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function fingerprint(repoRoot: string, mode: "worktree" | "staged", baseline: string) {
  const result = spawnSync(process.execPath, [fingerprintScript, mode, baseline], {
    cwd: repoRoot,
    encoding: "utf8",
    env: gitSafeEnv()
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const value = result.stdout.trim();
  assert.match(value, /^sha256:[0-9a-f]{64}$/);
  return value;
}

function setupRepo(tempRoot: string) {
  initIsolatedGitRepo(tempRoot);
  git(tempRoot, ["config", "user.email", "codex@example.com"]);
  git(tempRoot, ["config", "user.name", "Codex"]);
  write(path.join(tempRoot, ".agents/skills/existing.md"), "base\n");
  write(path.join(tempRoot, ".agents/skills/delete-me.md"), "delete\n");
  git(tempRoot, ["add", ".agents/skills/existing.md", ".agents/skills/delete-me.md"]);
  git(tempRoot, ["commit", "-qm", "base"]);
  return git(tempRoot, ["rev-parse", "HEAD"]);
}

test("review diff fingerprint includes tracked changes, deletions, and untracked files without mutating index", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-fingerprint-mixed-", (tempRoot) => {
    const baseline = setupRepo(tempRoot);
    write(path.join(tempRoot, ".agents/skills/existing.md"), "base\nchanged\n");
    fs.rmSync(path.join(tempRoot, ".agents/skills/delete-me.md"));
    write(path.join(tempRoot, ".agents/skills/new file.md"), "new\n");

    const statusBefore = git(tempRoot, ["status", "--short"]);
    const worktree = fingerprint(tempRoot, "worktree", baseline);
    const statusAfter = git(tempRoot, ["status", "--short"]);
    assert.equal(statusAfter, statusBefore);

    git(tempRoot, ["add", ".agents/skills/existing.md", ".agents/skills/delete-me.md", ".agents/skills/new file.md"]);
    const staged = fingerprint(tempRoot, "staged", baseline);
    assert.equal(staged, worktree);
  });
});

test("review diff fingerprint includes changes that were already staged during review", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-fingerprint-prestaged-", (tempRoot) => {
    const baseline = setupRepo(tempRoot);
    write(path.join(tempRoot, ".agents/skills/existing.md"), "base\nstaged\n");
    git(tempRoot, ["add", ".agents/skills/existing.md"]);

    const worktree = fingerprint(tempRoot, "worktree", baseline);
    const staged = fingerprint(tempRoot, "staged", baseline);
    assert.equal(staged, worktree);
  });
});

test("review diff fingerprint changes when worktree changes after review", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-fingerprint-extra-change-", (tempRoot) => {
    const baseline = setupRepo(tempRoot);
    write(path.join(tempRoot, ".agents/skills/existing.md"), "base\nreviewed\n");
    const reviewed = fingerprint(tempRoot, "worktree", baseline);

    write(path.join(tempRoot, ".agents/skills/existing.md"), "base\nreviewed\nextra\n");
    git(tempRoot, ["add", ".agents/skills/existing.md"]);
    const staged = fingerprint(tempRoot, "staged", baseline);
    assert.notEqual(staged, reviewed);
  });
});

test("post-review globs are shared by the validator and fingerprint helper", () => {
  const validator = fs.readFileSync(filePath(".agents/scripts/validate-artifact.js"), "utf8");
  assert.match(validator, /from "\.\/lib\/post-review-commit\.js"/);
  assert.match(validator, /resolvePostReviewGlobs\(config, loadReviewConfig\(\)\)/);
});

test("review diff fingerprint covers paths outside the legacy allowlist (fail-closed)", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-fingerprint-failclosed-", (tempRoot) => {
    const baseline = setupRepo(tempRoot);
    const clean = fingerprint(tempRoot, "worktree", baseline);

    write(path.join(tempRoot, "scripts/x.js"), "// new generator change\n");
    const changed = fingerprint(tempRoot, "worktree", baseline);
    assert.notEqual(changed, clean);
  });
});

test("review diff fingerprint covers package-lock.json by default", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-fingerprint-lockfile-", (tempRoot) => {
    const baseline = setupRepo(tempRoot);
    const clean = fingerprint(tempRoot, "worktree", baseline);

    write(path.join(tempRoot, "package-lock.json"), "{}\n");
    const changed = fingerprint(tempRoot, "worktree", baseline);
    assert.notEqual(changed, clean);
  });
});

test("review diff fingerprint honors project post_review_exclude_globs", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-fingerprint-exclude-", (tempRoot) => {
    setupRepo(tempRoot);
    write(
      path.join(tempRoot, ".agents/.airc.json"),
      JSON.stringify({ review: { post_review_exclude_globs: ["package-lock.json"] } }, null, 2) + "\n"
    );
    git(tempRoot, ["add", ".agents/.airc.json"]);
    git(tempRoot, ["commit", "-qm", "add exclude config"]);
    const baseline = git(tempRoot, ["rev-parse", "HEAD"]);
    const clean = fingerprint(tempRoot, "worktree", baseline);

    write(path.join(tempRoot, "package-lock.json"), "{}\n");
    const excluded = fingerprint(tempRoot, "worktree", baseline);
    assert.equal(excluded, clean);

    write(path.join(tempRoot, "scripts/included.js"), "// not excluded\n");
    const included = fingerprint(tempRoot, "worktree", baseline);
    assert.notEqual(included, clean);
  });
});
