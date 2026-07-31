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

test("accepts an authoritative content-equivalent squash merge", () => {
  const f = fixture();
  try {
    assert.deepEqual(resolveReviewedHeadRelation({
      gitRoot: f.root, comparisonHead: f.merge, lastReviewedCommit: f.head,
      pullRequest: f.pullRequest, pathspecs: [":/"]
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
      pullRequest: inspected.value!,
      pathspecs: [":/"]
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

test("fails closed for changed squash content and protected post-merge commits", () => {
  const changed = fixture();
  try {
    git(changed.root, ["reset", "--hard", `${changed.merge}^`]);
    writeCommit(changed.root, "base\ndifferent\n", "different squash");
    changed.pullRequest.mergeCommitSha = git(changed.root, ["rev-parse", "HEAD"]);
    const mismatch = resolveReviewedHeadRelation({
      gitRoot: changed.root, comparisonHead: changed.pullRequest.mergeCommitSha,
      lastReviewedCommit: changed.head, pullRequest: changed.pullRequest, pathspecs: [":/"]
    });
    assert.equal(mismatch.status, "failed");
    assert.equal(mismatch.code, "PR_MERGE_CONTENT_MISMATCH");
  } finally {
    fs.rmSync(changed.root, { recursive: true, force: true });
  }

  const later = fixture();
  try {
    const localHead = writeCommit(later.root, "base\nreviewed\nlater\n", "later");
    const result = resolveReviewedHeadRelation({
      gitRoot: later.root, comparisonHead: localHead, lastReviewedCommit: later.head,
      pullRequest: later.pullRequest, pathspecs: [":/"]
    });
    assert.equal(result.status, "failed");
    assert.equal(result.code, "POST_MERGE_CHANGES");
  } finally {
    fs.rmSync(later.root, { recursive: true, force: true });
  }
});

test("blocks when authoritative merge objects are missing", () => {
  const f = fixture();
  try {
    f.pullRequest.base.sha = "f".repeat(40);
    const result = resolveReviewedHeadRelation({
      gitRoot: f.root, comparisonHead: f.merge, lastReviewedCommit: f.head,
      pullRequest: f.pullRequest, pathspecs: [":/"]
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
      pullRequest: f.pullRequest,
      pathspecs: [":/"]
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
      pullRequest: f.pullRequest,
      pathspecs: [":/"]
    });
    assert.equal(result.status, "failed");
    assert.equal(result.code, "PR_MERGE_TOPOLOGY_INVALID");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
