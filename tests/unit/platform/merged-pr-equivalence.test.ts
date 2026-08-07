import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  inspectPlatformChangeRequest,
  registerPlatformAdapter
} from "../../../lib/platform/adapters.ts";
import { resolveReviewedHeadRelation } from "../../../lib/platform/merged-pr-equivalence.ts";
import type { PullRequestSnapshot } from "../../../lib/platform/pull-requests.ts";
import { platformResult } from "../../../lib/platform/types.ts";
import { gitSafeEnv } from "../../helpers.ts";

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: gitSafeEnv() });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function writeCommit(root: string, content: string, message: string): string {
  fs.writeFileSync(path.join(root, "file.txt"), content);
  git(root, ["add", "file.txt"]);
  git(root, ["commit", "-qm", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

function commitTree(root: string, tree: string, parents: string[], message: string): string {
  return git(root, ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", message]);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "merged-pr-equivalence-"));
  git(root, ["init", "-q", "-b", "master"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "user.email", "test@example.com"]);
  const base = writeCommit(root, "base\n", "base");
  git(root, ["switch", "-qc", "feature"]);
  const head = writeCommit(root, "base\nreviewed\n", "reviewed");
  git(root, ["switch", "-q", "master"]);
  git(root, ["merge", "--squash", "feature"]);
  git(root, ["commit", "-qm", "squash"]);
  const merge = git(root, ["rev-parse", "HEAD"]);
  const pullRequest: PullRequestSnapshot = {
    repository: "o/r", number: 1, nodeId: "PR_1", url: "https://example.test/1",
    state: "closed", title: "", body: "", draft: false,
    head: { repository: "o/r", ref: "feature", sha: head },
    base: { repository: "o/r", ref: "master", sha: base },
    mergedAt: "2026-07-25T00:00:00Z", mergeCommitSha: merge,
    labels: [], assignees: [], milestone: null
  };
  return { root, base, head, merge, pullRequest };
}

function advancedTargetFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "merged-pr-equivalence-advanced-"));
  git(root, ["init", "-q", "-b", "master"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "user.email", "test@example.com"]);
  const mergeBase = writeCommit(root, "base\nanchor\n", "base");
  git(root, ["switch", "-qc", "feature"]);
  const head = writeCommit(root, "base\nanchor\nreviewed\n", "reviewed");
  git(root, ["switch", "-q", "master"]);
  const advancedBase = writeCommit(root, "advanced\nbase\nanchor\n", "advance target");
  git(root, ["merge", "--squash", "feature"]);
  git(root, ["commit", "-qm", "squash"]);
  const merge = git(root, ["rev-parse", "HEAD"]);
  const pullRequest: PullRequestSnapshot = {
    repository: "o/r", number: 1, nodeId: "PR_1", url: "https://example.test/1",
    state: "closed", title: "", body: "", draft: false,
    head: { repository: "o/r", ref: "feature", sha: head },
    base: { repository: "o/r", ref: "master", sha: advancedBase },
    mergedAt: "2026-07-25T00:00:00Z", mergeCommitSha: merge,
    labels: [], assignees: [], milestone: null
  };
  return { root, mergeBase, advancedBase, head, merge, pullRequest };
}

test("accepts an authoritative content-equivalent squash merge", () => {
  const f = fixture();
  try {
    assert.deepEqual(resolveReviewedHeadRelation({
      gitRoot: f.root, comparisonHead: f.merge, lastReviewedCommit: f.head,
      pullRequest: f.pullRequest
    }), {
      status: "merged-equivalent",
      reviewedHead: f.head,
      mergeCommit: f.merge,
      comparisonHead: f.merge
    });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("accepts an equivalent squash after the target advances in the same file", () => {
  const f = advancedTargetFixture();
  try {
    assert.notEqual(f.pullRequest.base.sha, f.mergeBase);
    assert.deepEqual(resolveReviewedHeadRelation({
      gitRoot: f.root, comparisonHead: f.merge, lastReviewedCommit: f.head,
      pullRequest: f.pullRequest
    }), {
      status: "merged-equivalent",
      reviewedHead: f.head,
      mergeCommit: f.merge,
      comparisonHead: f.merge
    });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("accepts a normalized squash snapshot supplied by a custom platform adapter", () => {
  const f = fixture();
  try {
    registerPlatformAdapter({
      type: "custom-merge-test",
      resolveContext() {
        return platformResult("no-op", {
          platform: { type: "custom-merge-test", repository: "o/r", currentUser: "reviewer" }
        });
      },
      inspectChangeRequest() {
        return { ok: true, value: f.pullRequest };
      }
    });
    const inspected = inspectPlatformChangeRequest("custom-merge-test", {
      cwd: f.root,
      repository: "o/r",
      number: 1
    });
    assert.equal(inspected.ok, true);
    assert.deepEqual(resolveReviewedHeadRelation({
      gitRoot: f.root,
      comparisonHead: f.merge,
      lastReviewedCommit: f.head,
      pullRequest: inspected.value!
    }), {
      status: "merged-equivalent",
      reviewedHead: f.head,
      mergeCommit: f.merge,
      comparisonHead: f.merge
    });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("fails closed for changed squash content and accepts later target changes", () => {
  const changed = fixture();
  try {
    git(changed.root, ["reset", "--hard", `${changed.merge}^`]);
    writeCommit(changed.root, "base\ndifferent\n", "different squash");
    changed.pullRequest.mergeCommitSha = git(changed.root, ["rev-parse", "HEAD"]);
    const mismatch = resolveReviewedHeadRelation({
      gitRoot: changed.root, comparisonHead: changed.pullRequest.mergeCommitSha,
      lastReviewedCommit: changed.head, pullRequest: changed.pullRequest
    });
    assert.equal(mismatch.status, "failed");
    assert.equal(mismatch.code, "PR_MERGE_CONTENT_MISMATCH");
    assert.equal(mismatch.message, "Replayed reviewed PR content differs from the squash merge tree");
  } finally {
    fs.rmSync(changed.root, { recursive: true, force: true });
  }

  const later = fixture();
  try {
    const localHead = writeCommit(later.root, "base\nreviewed\nlater\n", "later");
    const result = resolveReviewedHeadRelation({
      gitRoot: later.root, comparisonHead: localHead, lastReviewedCommit: later.head,
      pullRequest: later.pullRequest
    });
    assert.deepEqual(result, {
      status: "merged-equivalent",
      reviewedHead: later.head,
      mergeCommit: later.merge,
      comparisonHead: localHead
    });
  } finally {
    fs.rmSync(later.root, { recursive: true, force: true });
  }
});

test("fails closed for whitespace-only squash content drift", () => {
  const f = fixture();
  try {
    git(f.root, ["reset", "--hard", `${f.merge}^`]);
    const merge = writeCommit(f.root, "base\nreviewed \n", "whitespace drift");
    f.pullRequest.mergeCommitSha = merge;
    const result = resolveReviewedHeadRelation({
      gitRoot: f.root, comparisonHead: merge, lastReviewedCommit: f.head,
      pullRequest: f.pullRequest
    });
    assert.equal(result.status, "failed");
    assert.equal(result.code, "PR_MERGE_CONTENT_MISMATCH");
    assert.equal(result.message, "Replayed reviewed PR content differs from the squash merge tree");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("fails closed when the reviewed patch conflicts with the squash parent", () => {
  const f = fixture();
  try {
    git(f.root, ["reset", "--hard", f.base]);
    writeCommit(f.root, "target change\n", "advance target");
    const squashParent = git(f.root, ["rev-parse", "HEAD"]);
    const merge = writeCommit(f.root, "reviewed change\n", "manual squash");
    f.pullRequest.base.sha = squashParent;
    f.pullRequest.mergeCommitSha = merge;
    const result = resolveReviewedHeadRelation({
      gitRoot: f.root, comparisonHead: merge, lastReviewedCommit: f.head,
      pullRequest: f.pullRequest
    });
    assert.equal(result.status, "failed");
    assert.equal(result.code, "PR_MERGE_CONTENT_MISMATCH");
    assert.equal(
      result.message,
      "Reviewed PR patch cannot be replayed without conflicts, so content equivalence cannot be established"
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("rejects squash histories without a unique merge base", () => {
  const f = fixture();
  try {
    git(f.root, ["switch", "--orphan", "unrelated"]);
    const squashParent = writeCommit(f.root, "unrelated\n", "unrelated root");
    const merge = writeCommit(f.root, "unrelated\nreviewed\n", "unrelated squash");
    f.pullRequest.base.sha = squashParent;
    f.pullRequest.mergeCommitSha = merge;
    const result = resolveReviewedHeadRelation({
      gitRoot: f.root, comparisonHead: merge, lastReviewedCommit: f.head,
      pullRequest: f.pullRequest
    });
    assert.equal(result.status, "failed");
    assert.equal(result.code, "PR_MERGE_TOPOLOGY_INVALID");
    assert.equal(result.message, "Reviewed head and squash parent do not have a unique merge base");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("rejects squash histories with multiple best merge bases", () => {
  const f = fixture();
  try {
    const tree = git(f.root, ["rev-parse", `${f.base}^{tree}`]);
    const firstSide = commitTree(f.root, tree, [f.base], "first side");
    const secondSide = commitTree(f.root, tree, [f.base], "second side");
    const reviewedHead = commitTree(f.root, tree, [firstSide, secondSide], "reviewed head");
    const squashParent = commitTree(f.root, tree, [secondSide, firstSide], "squash parent");
    const merge = commitTree(f.root, tree, [squashParent], "squash");
    f.pullRequest.head.sha = reviewedHead;
    f.pullRequest.base.sha = squashParent;
    f.pullRequest.mergeCommitSha = merge;
    const result = resolveReviewedHeadRelation({
      gitRoot: f.root, comparisonHead: merge, lastReviewedCommit: reviewedHead,
      pullRequest: f.pullRequest
    });
    assert.equal(result.status, "failed");
    assert.equal(result.code, "PR_MERGE_TOPOLOGY_INVALID");
    assert.equal(result.message, "Reviewed head and squash parent do not have a unique merge base");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("blocks when authoritative merge objects are missing", () => {
  const f = fixture();
  try {
    f.pullRequest.base.sha = "f".repeat(40);
    const result = resolveReviewedHeadRelation({
      gitRoot: f.root, comparisonHead: f.merge, lastReviewedCommit: f.head,
      pullRequest: f.pullRequest
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.code, "PR_MERGE_OBJECT_MISSING");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("rejects a merge commit outside authoritative target history", () => {
  const f = fixture();
  try {
    const result = resolveReviewedHeadRelation({
      gitRoot: f.root,
      comparisonHead: f.base,
      lastReviewedCommit: f.head,
      pullRequest: f.pullRequest
    });
    assert.equal(result.status, "failed");
    assert.equal(result.code, "PR_MERGE_TARGET_MISMATCH");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("rejects a two-parent merge topology", () => {
  const f = fixture();
  try {
    git(f.root, ["reset", "--hard", f.base]);
    git(f.root, ["merge", "--no-ff", "-qm", "merge", "feature"]);
    const mergeCommit = git(f.root, ["rev-parse", "HEAD"]);
    f.pullRequest.mergeCommitSha = mergeCommit;
    const result = resolveReviewedHeadRelation({
      gitRoot: f.root,
      comparisonHead: mergeCommit,
      lastReviewedCommit: f.head,
      pullRequest: f.pullRequest
    });
    assert.equal(result.status, "failed");
    assert.equal(result.code, "PR_MERGE_TOPOLOGY_INVALID");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
