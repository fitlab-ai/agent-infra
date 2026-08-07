import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { registerPlatformAdapter } from "../../../lib/platform/adapters.ts";
import type { PlatformChangeRequestSnapshot } from "../../../lib/platform/adapters.ts";
import { platformResult } from "../../../lib/platform/types.ts";
import { verifyInProcess } from "../../../lib/task/verification-engine.ts";
import { gitSafeEnv } from "../../helpers.ts";

const TASK_A_ID = "TASK-20260731-000001";
const TASK_B_ID = "TASK-20260731-000002";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: gitSafeEnv() });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commit(root: string, content: string, message: string): string {
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

function writeTask(caller: string, taskId: string, prNumber: number, reviewedHead: string): string {
  const taskDir = path.join(caller, ".agents", "workspace", "active", taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "task.md"), [
    "---",
    `id: ${taskId}`,
    "status: active",
    "current_step: code-review",
    `pr_number: ${prNumber}`,
    `last_reviewed_commit: ${reviewedHead}`,
    "---",
    "",
    "# Task"
  ].join("\n"));
  fs.writeFileSync(path.join(taskDir, "review-code.md"), "# Review\n");
  return taskDir;
}

test("complete-task gate verifies target advancement and consecutive squash merges from isolated remote evidence", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "complete-task-remote-evidence-"));
  const remote = path.join(fixtureRoot, "remote.git");
  const seed = path.join(fixtureRoot, "seed");
  const caller = path.join(fixtureRoot, "caller");
  try {
    fs.mkdirSync(seed);
    git(seed, ["init", "-q", "-b", "main"]);
    git(seed, ["config", "user.name", "Test"]);
    git(seed, ["config", "user.email", "test@example.com"]);
    git(fixtureRoot, ["init", "-q", "--bare", remote]);

    commit(seed, "base\n", "base");
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "-q", "origin", "main"]);
    git(fixtureRoot, ["clone", "-q", "--branch", "main", remote, caller]);

    git(seed, ["switch", "-qc", "feature-a"]);
    const reviewedHeadA = commit(seed, "base\nreviewed-a\n", "reviewed A");
    git(seed, ["push", "-q", "origin", `${reviewedHeadA}:refs/pull/1/head`]);
    git(seed, ["switch", "-q", "main"]);
    const advancedBase = commit(seed, "advanced\nbase\n", "advance target");
    git(seed, ["merge", "--squash", "feature-a"]);
    git(seed, ["commit", "-qm", "squash A"]);
    const mergeCommitA = git(seed, ["rev-parse", "HEAD"]);

    git(seed, ["switch", "-qc", "feature-b"]);
    const reviewedHeadB = commit(seed, "base\nreviewed-a\nreviewed-b\n", "reviewed B");
    git(seed, ["push", "-q", "origin", `${reviewedHeadB}:refs/pull/2/head`]);
    git(seed, ["switch", "-q", "main"]);
    git(seed, ["merge", "--squash", "feature-b"]);
    git(seed, ["commit", "-qm", "squash B"]);
    const mergeCommitB = git(seed, ["rev-parse", "HEAD"]);
    git(seed, ["push", "-q", "origin", "main"]);

    const platformType = "complete-task-remote-evidence-test";
    const pullRequests = new Map<number, PlatformChangeRequestSnapshot>([
      [1, {
        repository: "o/r",
        number: 1,
        nodeId: "PR_1",
        url: "https://example.test/o/r/pull/1",
        state: "closed",
        title: "",
        body: "",
        draft: false,
        head: { repository: "o/r", ref: "feature-a", sha: reviewedHeadA },
        base: { repository: "o/r", ref: "main", sha: advancedBase },
        mergedAt: "2026-07-31T00:00:00Z",
        mergeCommitSha: mergeCommitA,
        labels: [],
        assignees: [],
        milestone: null
      }],
      [2, {
        repository: "o/r",
        number: 2,
        nodeId: "PR_2",
        url: "https://example.test/o/r/pull/2",
        state: "closed",
        title: "",
        body: "",
        draft: false,
        head: { repository: "o/r", ref: "feature-b", sha: reviewedHeadB },
        base: { repository: "o/r", ref: "main", sha: mergeCommitA },
        mergedAt: "2026-07-31T00:01:00Z",
        mergeCommitSha: mergeCommitB,
        labels: [],
        assignees: [],
        milestone: null
      }]
    ]);
    registerPlatformAdapter({
      type: platformType,
      resolveContext() {
        return platformResult("no-op", {
          platform: { type: platformType, repository: "o/r", currentUser: "reviewer" }
        });
      },
      inspectChangeRequest({ number }) {
        return { ok: true, value: pullRequests.get(number)! };
      },
      resolveChangeRequestGitEvidence({ number }) {
        return {
          ok: true,
          value: {
            remoteUrl: remote,
            reviewedHeadRef: `refs/pull/${number}/head`,
            targetHeadRef: "refs/heads/main"
          }
        };
      }
    });

    fs.mkdirSync(path.join(caller, ".agents", "skills", "complete-task", "config"), { recursive: true });
    fs.writeFileSync(path.join(caller, ".agents", ".airc.json"), JSON.stringify({
      platform: { type: platformType }
    }));
    fs.writeFileSync(
      path.join(caller, ".agents", "skills", "complete-task", "config", "verify.json"),
      JSON.stringify({ skill: "complete-task", checks: { "post-review-commit": {} } })
    );
    const taskA = writeTask(caller, TASK_A_ID, 1, reviewedHeadA);
    const taskB = writeTask(caller, TASK_B_ID, 2, reviewedHeadB);

    for (const sha of [reviewedHeadA, mergeCommitA, reviewedHeadB, mergeCommitB]) {
      assert.notEqual(spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
        cwd: caller, env: gitSafeEnv()
      }).status, 0);
    }
    const before = repositorySnapshot(caller);

    for (const taskDir of [taskA, taskB]) {
      const result = verifyInProcess({
        mode: "gate",
        skillName: "complete-task",
        taskDir,
        checks: [],
        repositoryRoot: caller
      });
      assert.equal(result.gate, "pass");
      assert.equal(result.checks[0].status, "pass");
      assert.match(result.checks[0].message, /content-equivalent to squash merge/);
    }
    assert.deepEqual(repositorySnapshot(caller), before);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
