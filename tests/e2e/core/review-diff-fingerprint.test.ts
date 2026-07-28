import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { gitSafeEnv, initIsolatedGitRepo, onPlatforms } from "../../helpers.ts";
import { resolvePostReviewGlobs } from "../../../lib/task/review-fingerprint.ts";
import { compareReviewTrees, snapshotReview } from "../../../lib/git/review-snapshot.ts";
import { withTempRoot, write } from "./validate-artifact-helpers.ts";

function git(repoRoot: string, args: string[]) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", env: gitSafeEnv() });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function fingerprint(repoRoot: string, mode: "worktree" | "staged", baseline: string) {
  const value = snapshotReview({ cwd: repoRoot, mode, baseline, globs: resolvePostReviewGlobs({}, {}) }).fingerprint;
  assert.match(value, /^sha256:[0-9a-f]{64}$/);
  return value;
}

type Snapshot = { baseline: string; diffBase: string; fingerprint: string; tree: string };

function snapshot(repoRoot: string, mode: "worktree" | "staged", baseline: string, diffBase?: string): Snapshot {
  return snapshotReview({ cwd: repoRoot, mode, baseline, diffBase, globs: resolvePostReviewGlobs({}, {}) }) as Snapshot;
}

function compare(repoRoot: string, expected: string, actual: string) {
  const payload = compareReviewTrees({ cwd: repoRoot, expected, actual });
  return {
    status: payload.equal ? 0 : 1,
    payload
  };
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

test("review snapshots produce comparable worktree and staged trees without mutating the real index", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-snapshot-equal-", (tempRoot) => {
    const baseline = setupRepo(tempRoot);
    const newFile = process.platform === "win32" ? ".agents/skills/new file.md" : ".agents/skills/new\nfile.md";
    write(path.join(tempRoot, ".agents/skills/existing.md"), "base\nchanged\n");
    fs.rmSync(path.join(tempRoot, ".agents/skills/delete-me.md"));
    write(path.join(tempRoot, newFile), "new\n");

    const worktree = snapshot(tempRoot, "worktree", baseline);
    git(tempRoot, ["add", ".agents/skills/existing.md", ".agents/skills/delete-me.md", newFile]);
    const statusBefore = git(tempRoot, ["status", "--short"]);
    const staged = snapshot(tempRoot, "staged", baseline);
    const statusAfter = git(tempRoot, ["status", "--short"]);

    assert.equal(worktree.baseline, baseline);
    assert.match(worktree.fingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.match(worktree.tree, /^[0-9a-f]{40,64}$/);
    assert.equal(staged.tree, worktree.tree);
    assert.equal(statusAfter, statusBefore);
    assert.deepEqual(compare(tempRoot, worktree.tree, staged.tree), {
      status: 0,
      payload: { equal: true, added: [], missing: [], different: [] }
    });
  });
});

test("review snapshot fingerprints a clean committed range from an independent diff base", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-snapshot-committed-range-", (tempRoot) => {
    const diffBase = setupRepo(tempRoot);
    write(path.join(tempRoot, ".agents/skills/existing.md"), "base\ncommitted\n");
    git(tempRoot, ["add", ".agents/skills/existing.md"]);
    git(tempRoot, ["commit", "-qm", "committed review target"]);
    const reviewedCommit = git(tempRoot, ["rev-parse", "HEAD"]);

    const emptyAtHead = snapshot(tempRoot, "worktree", reviewedCommit);
    const committedRange = snapshot(tempRoot, "worktree", reviewedCommit, diffBase);

    assert.equal(committedRange.baseline, reviewedCommit);
    assert.equal(committedRange.diffBase, diffBase);
    assert.equal(committedRange.tree, git(tempRoot, ["rev-parse", `${reviewedCommit}^{tree}`]));
    assert.notEqual(committedRange.fingerprint, emptyAtHead.fingerprint);
  });
});

test("review snapshot comparison classifies added, missing, and different paths", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-snapshot-compare-", (tempRoot) => {
    const baseline = setupRepo(tempRoot);
    write(path.join(tempRoot, ".agents/skills/existing.md"), "base\nreviewed\n");
    fs.rmSync(path.join(tempRoot, ".agents/skills/delete-me.md"));
    write(path.join(tempRoot, ".agents/skills/reviewed-only.md"), "reviewed\n");
    const reviewed = snapshot(tempRoot, "worktree", baseline);

    git(tempRoot, ["add", ".agents/skills/existing.md", ".agents/skills/delete-me.md"]);
    write(path.join(tempRoot, ".agents/skills/existing.md"), "base\nstaged-different\n");
    git(tempRoot, ["add", ".agents/skills/existing.md"]);
    write(path.join(tempRoot, ".agents/skills/staged-only.md"), "staged\n");
    git(tempRoot, ["add", ".agents/skills/staged-only.md"]);
    const staged = snapshot(tempRoot, "staged", baseline);
    const result = compare(tempRoot, reviewed.tree, staged.tree);

    assert.equal(result.status, 1);
    assert.deepEqual(result.payload, {
      equal: false,
      added: [".agents/skills/staged-only.md"],
      missing: [".agents/skills/reviewed-only.md"],
      different: [".agents/skills/existing.md"]
    });
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

test("post-review globs use the shared typed helper", () => {
  assert.deepEqual(resolvePostReviewGlobs({}, { post_review_exclude_globs: ["dist/**"] }), [":/", ":(top,exclude)dist/**"]);
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
    const globs = resolvePostReviewGlobs({}, { post_review_exclude_globs: ["package-lock.json"] });
    const clean = snapshotReview({ cwd: tempRoot, mode: "worktree", baseline, globs }).fingerprint;

    write(path.join(tempRoot, "package-lock.json"), "{}\n");
    const excluded = snapshotReview({ cwd: tempRoot, mode: "worktree", baseline, globs }).fingerprint;
    assert.equal(excluded, clean);

    write(path.join(tempRoot, "scripts/included.js"), "// not excluded\n");
    const included = snapshotReview({ cwd: tempRoot, mode: "worktree", baseline, globs }).fingerprint;
    assert.notEqual(included, clean);
  });
});
