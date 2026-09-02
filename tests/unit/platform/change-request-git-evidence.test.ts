import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { resolveMaterializedReviewedHeadRelation } from "../../../lib/platform/change-request-git-evidence.ts";
import type { PullRequestSnapshot } from "../../../lib/platform/pull-requests.ts";
import { gitSafeEnv } from "../../helpers.ts";

const providerSource = path.resolve("tests/fixtures/platform-providers/git-evidence-provider.mjs");

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitSafeEnv()
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function writeCommit(root: string, content: string, message: string): string {
  fs.writeFileSync(path.join(root, "file.txt"), content);
  git(root, ["add", "file.txt"]);
  git(root, ["commit", "-qm", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

function repositorySnapshot(root: string) {
  return {
    head: git(root, ["rev-parse", "HEAD"]),
    branch: git(root, ["symbolic-ref", "-q", "HEAD"]),
    index: git(root, ["write-tree"]),
    status: git(root, ["status", "--porcelain=v1"]),
    refs: git(root, ["show-ref"])
  };
}

function fixture(advanceTarget = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "change-request-evidence-"));
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const caller = path.join(root, "caller");

  fs.mkdirSync(seed);
  git(seed, ["init", "-q", "-b", "main"]);
  git(seed, ["config", "user.name", "Test"]);
  git(seed, ["config", "user.email", "test@example.com"]);
  git(root, ["init", "-q", "--bare", remote]);

  const base = writeCommit(seed, "base\n", "base");
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-q", "origin", "main"]);
  git(root, ["clone", "-q", "--branch", "main", remote, caller]);

  git(seed, ["switch", "-qc", "feature"]);
  const head = writeCommit(seed, "base\nreviewed\n", "reviewed");
  git(seed, ["push", "-q", "origin", `${head}:refs/pull/1/head`]);
  git(seed, ["switch", "-q", "main"]);
  const snapshotBase = advanceTarget
    ? writeCommit(seed, "advanced\nbase\n", "advance target")
    : base;
  git(seed, ["merge", "--squash", "feature"]);
  git(seed, ["commit", "-qm", "squash"]);
  const merge = git(seed, ["rev-parse", "HEAD"]);
  git(seed, ["push", "-q", "origin", "main"]);

  const pullRequest: PullRequestSnapshot = {
    repository: "o/r",
    number: 1,
    nodeId: "PR_1",
    url: "https://example.test/1",
    state: "closed",
    title: "",
    body: "",
    draft: false,
    head: { repository: "o/r", ref: "feature", sha: head },
    base: { repository: "o/r", ref: "main", sha: snapshotBase },
    mergedAt: "2026-07-25T00:00:00Z",
    mergeCommitSha: merge,
    labels: [],
    assignees: [],
    milestone: null
  };

  return { root, remote, caller, base, head, merge, pullRequest };
}

function configureEvidenceProvider(caller: string, type: string, remote: string, reviewedHeadRef = "refs/pull/1/head") {
  fs.mkdirSync(path.join(caller, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(caller, ".agents", ".airc.json"), JSON.stringify({
    platform: {
      type,
      providers: {
        [type]: { source: providerSource, config: { remoteUrl: remote, reviewedHeadRef } }
      }
    }
  }));
}

test("materializes merged PR evidence without changing the caller repository", async () => {
  const f = fixture();
  try {
    configureEvidenceProvider(f.caller, "isolated-evidence-test", f.remote);
    assert.notEqual(spawnSync("git", ["cat-file", "-e", `${f.head}^{commit}`], {
      cwd: f.caller,
      env: gitSafeEnv()
    }).status, 0);
    assert.notEqual(spawnSync("git", ["cat-file", "-e", `${f.merge}^{commit}`], {
      cwd: f.caller,
      env: gitSafeEnv()
    }).status, 0);
    const before = repositorySnapshot(f.caller);

    assert.deepEqual(await resolveMaterializedReviewedHeadRelation({
      cwd: f.caller,
      platformType: "isolated-evidence-test",
      lastReviewedCommit: f.head,
      pullRequest: f.pullRequest
    }), {
      status: "merged-equivalent",
      reviewedHead: f.head,
      mergeCommit: f.merge,
      comparisonHead: f.merge
    });

    assert.deepEqual(repositorySnapshot(f.caller), before);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("materializes an equivalent squash after the target advances in the same file", async () => {
  const f = fixture(true);
  try {
    configureEvidenceProvider(f.caller, "advanced-isolated-evidence-test", f.remote);
    const before = repositorySnapshot(f.caller);
    assert.deepEqual(await resolveMaterializedReviewedHeadRelation({
      cwd: f.caller,
      platformType: "advanced-isolated-evidence-test",
      lastReviewedCommit: f.head,
      pullRequest: f.pullRequest
    }), {
      status: "merged-equivalent",
      reviewedHead: f.head,
      mergeCommit: f.merge,
      comparisonHead: f.merge
    });
    assert.deepEqual(repositorySnapshot(f.caller), before);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("blocks with a stable code when platform refs cannot be fetched", async () => {
  const f = fixture();
  try {
    configureEvidenceProvider(f.caller, "missing-evidence-ref-test", f.remote, "refs/pull/999/head");
    const result = await resolveMaterializedReviewedHeadRelation({
      cwd: f.caller,
      platformType: "missing-evidence-ref-test",
      lastReviewedCommit: f.head,
      pullRequest: f.pullRequest
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.code, "PR_MERGE_EVIDENCE_FETCH_FAILED");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("fails closed when fetched refs do not match the platform snapshot", async () => {
  const f = fixture();
  try {
    configureEvidenceProvider(f.caller, "mismatched-evidence-head-test", f.remote, "refs/heads/main");
    const result = await resolveMaterializedReviewedHeadRelation({
      cwd: f.caller,
      platformType: "mismatched-evidence-head-test",
      lastReviewedCommit: f.head,
      pullRequest: f.pullRequest
    });
    assert.equal(result.status, "failed");
    assert.equal(result.code, "PR_MERGE_FETCHED_HEAD_MISMATCH");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("rejects an inconsistent reviewed identity before fetching", async () => {
  const f = fixture();
  try {
    configureEvidenceProvider(f.caller, "invalid-evidence-identity-test", f.remote);
    const result = await resolveMaterializedReviewedHeadRelation({
      cwd: f.caller,
      platformType: "invalid-evidence-identity-test",
      lastReviewedCommit: "f".repeat(40),
      pullRequest: f.pullRequest
    });
    assert.equal(result.status, "failed");
    assert.equal(result.code, "PR_MERGE_IDENTITY_INVALID");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
