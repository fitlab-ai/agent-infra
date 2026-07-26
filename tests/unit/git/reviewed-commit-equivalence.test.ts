import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { resolveLocalReviewedCommitRelation } from "../../../lib/git/reviewed-commit-equivalence.ts";
import { gitSafeEnv } from "../../helpers.ts";

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: gitSafeEnv() });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function writeCommit(root: string, files: Record<string, string>, message: string): string {
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-commit-equivalence-"));
  git(root, ["init", "-q", "-b", "master"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "user.email", "test@example.com"]);
  const parent = writeCommit(root, { "protected.txt": "base\n" }, "base");
  const reviewed = writeCommit(root, { "protected.txt": "base\nreviewed\n" }, "reviewed");
  git(root, ["reset", "--hard", parent]);
  return { root, parent, reviewed };
}

function resolve(root: string, reviewed: string, rewritten: string, localHead = rewritten, pathspecs = [":/"]) {
  return resolveLocalReviewedCommitRelation({
    gitRoot: root,
    localHead,
    lastReviewedCommit: reviewed,
    rewrittenCommit: rewritten,
    pathspecs
  });
}

test("accepts a single-parent local recommit with the reviewed tree", () => {
  const f = fixture();
  try {
    const rewritten = writeCommit(f.root, { "protected.txt": "base\nreviewed\n" }, "rewritten");
    assert.deepEqual(resolve(f.root, f.reviewed, rewritten), {
      status: "local-equivalent",
      reviewedHead: f.reviewed,
      rewrittenCommit: rewritten
    });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("accepts equal protected content when only an excluded path differs", () => {
  const f = fixture();
  try {
    const rewritten = writeCommit(f.root, {
      "protected.txt": "base\nreviewed\n",
      "generated.txt": "local-only\n"
    }, "rewritten with excluded output");
    assert.notEqual(git(f.root, ["rev-parse", `${f.reviewed}^{tree}`]), git(f.root, ["rev-parse", `${rewritten}^{tree}`]));

    assert.equal(resolve(
      f.root,
      f.reviewed,
      rewritten,
      rewritten,
      [":/", ":(top,exclude)generated.txt"]
    ).status, "local-equivalent");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("fails closed for changed protected content", () => {
  const f = fixture();
  try {
    const rewritten = writeCommit(f.root, { "protected.txt": "base\ndifferent\n" }, "different rewrite");
    const result = resolve(f.root, f.reviewed, rewritten);
    assert.equal(result.status, "failed");
    assert.equal(result.code, "LOCAL_REWRITE_CONTENT_MISMATCH");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("fails closed for a merge candidate", () => {
  const merged = fixture();
  try {
    writeCommit(merged.root, { "protected.txt": "base\nreviewed\n" }, "rewritten");
    git(merged.root, ["switch", "-qc", "side", merged.parent]);
    writeCommit(merged.root, { "side.txt": "side\n" }, "side");
    git(merged.root, ["switch", "-q", "master"]);
    git(merged.root, ["merge", "--no-ff", "-qm", "merge side", "side"]);
    const mergeCommit = git(merged.root, ["rev-parse", "HEAD"]);
    const mergeResult = resolve(merged.root, merged.reviewed, mergeCommit);
    assert.equal(mergeResult.status, "failed");
    assert.equal(mergeResult.code, "LOCAL_REWRITE_TOPOLOGY_INVALID");
  } finally {
    fs.rmSync(merged.root, { recursive: true, force: true });
  }
});

test("fails closed when the rewrite candidate is outside HEAD history", () => {
  const f = fixture();
  try {
    const rewritten = writeCommit(f.root, { "protected.txt": "base\nreviewed\n" }, "rewritten");
    git(f.root, ["switch", "-qc", "other", f.parent]);
    const localHead = writeCommit(f.root, { "other.txt": "other\n" }, "other history");
    const result = resolve(f.root, f.reviewed, rewritten, localHead);
    assert.equal(result.status, "failed");
    assert.equal(result.code, "LOCAL_REWRITE_TOPOLOGY_INVALID");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("fails when protected paths change after the equivalent rewrite", () => {
  const f = fixture();
  try {
    const rewritten = writeCommit(f.root, { "protected.txt": "base\nreviewed\n" }, "rewritten");
    const localHead = writeCommit(f.root, { "protected.txt": "base\nreviewed\nlater\n" }, "later protected change");
    const result = resolve(f.root, f.reviewed, rewritten, localHead);
    assert.equal(result.status, "failed");
    assert.equal(result.code, "POST_LOCAL_REWRITE_CHANGES");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("blocks when a required commit object is missing", () => {
  const f = fixture();
  try {
    const result = resolve(f.root, f.reviewed, "f".repeat(40));
    assert.equal(result.status, "blocked");
    assert.equal(result.code, "LOCAL_REWRITE_OBJECT_MISSING");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
