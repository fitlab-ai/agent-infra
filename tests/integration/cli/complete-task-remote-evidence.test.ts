import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { PlatformChangeRequestSnapshot } from "../../../lib/platform/adapters.ts";
import { verifyInProcess } from "../../../lib/task/verification-engine.ts";
import { gitSafeEnv } from "../../helpers.ts";
import { buildBoundFact, encodePrDeliveryFact } from "../../../lib/task/pr-delivery-fact.ts";

const TASK_A_ID = "TASK-20260731-000001";
const TASK_B_ID = "TASK-20260731-000002";
const providerSource = path.resolve("tests/fixtures/platform-providers/remote-evidence-provider.mjs");

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

function writeTask(
  caller: string,
  taskId: string,
  prNumber: number,
  reviewedHead: string,
  ledgerRows: string[] = []
): string {
  const taskDir = path.join(caller, ".agents", "workspace", "active", taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "task.md"), [
    "---",
    `id: ${taskId}`,
    "status: active",
    "current_step: code-review",
    `pr_delivery_fact: ${JSON.stringify(encodePrDeliveryFact(buildBoundFact({
      identity: { resource: { kind: "number", value: prNumber }, repository: "fitlab-ai/agent-infra", url: `https://github.com/fitlab-ai/agent-infra/pull/${prNumber}`, head: { repository: "fitlab-ai/agent-infra", ref: "feature", sha: reviewedHead }, base: { repository: "fitlab-ai/agent-infra", ref: "main", sha: "b".repeat(40) } }, source: "reused", verifiedAt: "2026-01-01T00:00:00.000Z", remoteState: "open"
    })))}`,
    `last_reviewed_commit: ${reviewedHead}`,
    "---",
    "",
    "# Task",
    "",
    "## Review Disagreement Ledger",
    "",
    "| id | stage | round | severity | status | evidence |",
    "|----|-------|-------|----------|--------|----------|",
    ...ledgerRows
  ].join("\n"));
  fs.writeFileSync(path.join(taskDir, "review-code.md"), "# Review\n");
  return taskDir;
}

test("complete-task gate verifies target advancement and consecutive squash merges from isolated remote evidence", async () => {
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
    fs.mkdirSync(path.join(caller, ".agents", "skills", "complete-task", "config"), { recursive: true });
    fs.writeFileSync(path.join(caller, ".agents", ".airc.json"), JSON.stringify({
      platform: {
        type: platformType,
        providers: {
          [platformType]: {
            source: providerSource,
            config: { remoteUrl: remote, pullRequests: Object.fromEntries(pullRequests) }
          }
        }
      }
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
      const result = await verifyInProcess({
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

test("complete-task consumes a human exemption for merged identity failures before and after archival", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "complete-task-identity-exemption-"));
  const taskId = "TASK-20260731-000003";
  try {
    git(fixtureRoot, ["init", "-q", "-b", "main"]);
    git(fixtureRoot, ["config", "user.name", "Test"]);
    git(fixtureRoot, ["config", "user.email", "test@example.com"]);
    commit(fixtureRoot, "base\n", "base");

    const platformType = "complete-task-identity-exemption-test";
    const reviewedHead = "a".repeat(40);
    const pullRequest: PlatformChangeRequestSnapshot = {
      repository: "o/r",
      number: 3,
      nodeId: "PR_3",
      url: "https://example.test/o/r/pull/3",
      state: "closed",
      title: "",
      body: "",
      draft: false,
      head: { repository: "o/r", ref: "feature", sha: "b".repeat(40) },
      base: { repository: "o/r", ref: "main", sha: "c".repeat(40) },
      mergedAt: "2026-07-31T00:00:00Z",
      mergeCommitSha: "d".repeat(40),
      labels: [],
      assignees: [],
      milestone: null
    };
    fs.mkdirSync(path.join(fixtureRoot, ".agents", "skills", "complete-task", "config"), { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, ".agents", ".airc.json"), JSON.stringify({
      platform: {
        type: platformType,
        providers: {
          [platformType]: {
            source: providerSource,
            config: { pullRequests: { 3: pullRequest }, evidenceEnabled: false }
          }
        }
      }
    }));
    fs.writeFileSync(
      path.join(fixtureRoot, ".agents", "skills", "complete-task", "config", "verify.json"),
      JSON.stringify({ skill: "complete-task", checks: { "post-review-commit": {} } })
    );
    const activeTask = writeTask(fixtureRoot, taskId, 3, reviewedHead, [
      "| PRC-1 | post-review-commit | - | - | human-decided | maintainer allowed reviewed and merged identities |"
    ]);

    const active = await verifyInProcess({
      mode: "gate",
      skillName: "complete-task",
      taskDir: activeTask,
      checks: [],
      repositoryRoot: fixtureRoot
    });
    assert.equal(active.gate, "pass");
    assert.equal(active.checks[0].status, "pass");
    assert.match(active.checks[0].message, /Human-decided post-review exemption/);
    assert.match(active.checks[0].message, /PR_MERGE_IDENTITY_INVALID/);
    assert.match(active.checks[0].message, /PR merge identity does not match the reviewed head/);
    assert.match(active.checks[0].message, /PRC-1/);
    assert.match(active.checks[0].message, /maintainer allowed reviewed and merged identities/);

    const completedTask = path.join(fixtureRoot, ".agents", "workspace", "completed", taskId);
    fs.mkdirSync(path.dirname(completedTask), { recursive: true });
    fs.renameSync(activeTask, completedTask);
    const completed = await verifyInProcess({
      mode: "gate",
      skillName: "complete-task",
      taskDir: completedTask,
      checks: [],
      repositoryRoot: fixtureRoot
    });
    assert.equal(completed.gate, "pass");
    assert.equal(completed.checks[0].message, active.checks[0].message);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("complete-task keeps merged identity failures closed without a valid exemption", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "complete-task-invalid-identity-exemption-"));
  const reviewedHead = "a".repeat(40);
  try {
    git(fixtureRoot, ["init", "-q", "-b", "main"]);
    git(fixtureRoot, ["config", "user.name", "Test"]);
    git(fixtureRoot, ["config", "user.email", "test@example.com"]);
    commit(fixtureRoot, "base\n", "base");

    const platformType = "complete-task-invalid-identity-exemption-test";
    fs.mkdirSync(path.join(fixtureRoot, ".agents", "skills", "complete-task", "config"), { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, ".agents", ".airc.json"), JSON.stringify({
      platform: {
        type: platformType,
        providers: {
          [platformType]: {
            source: providerSource,
            config: {
              evidenceEnabled: false,
              pullRequests: Object.fromEntries([1, 2, 3, 4, 5, 6].map((number) => [number, {
                repository: "o/r", number, nodeId: `PR_${number}`, url: `https://example.test/o/r/pull/${number}`,
                state: "closed", title: "", body: "", draft: false,
                head: { repository: "o/r", ref: "feature", sha: "b".repeat(40) },
                base: { repository: "o/r", ref: "main", sha: "c".repeat(40) },
                mergedAt: "2026-07-31T00:00:00Z", mergeCommitSha: "d".repeat(40),
                labels: [], assignees: [], milestone: null
              }]))
            }
          }
        }
      }
    }));
    fs.writeFileSync(
      path.join(fixtureRoot, ".agents", "skills", "complete-task", "config", "verify.json"),
      JSON.stringify({ skill: "complete-task", checks: { "post-review-commit": {} } })
    );

    const noExemption = writeTask(fixtureRoot, "TASK-20260731-000004", 4, reviewedHead);
    const missing = await verifyInProcess({
      mode: "gate", skillName: "complete-task", taskDir: noExemption, checks: [], repositoryRoot: fixtureRoot
    });
    assert.equal(missing.gate, "fail");
    assert.equal(missing.checks[0].fail_type, "PR_MERGE_IDENTITY_INVALID");

    const malformed = writeTask(fixtureRoot, "TASK-20260731-000005", 5, reviewedHead, [
      "| PRC-1 | post-review-commit | - | - | open | decision is pending |"
    ]);
    const invalid = await verifyInProcess({
      mode: "gate", skillName: "complete-task", taskDir: malformed, checks: [], repositoryRoot: fixtureRoot
    });
    assert.equal(invalid.gate, "fail");
    assert.equal(invalid.checks[0].fail_type, "POST_REVIEW_EXEMPTION_INVALID");

    const blockedTask = writeTask(fixtureRoot, "TASK-20260731-000006", 6, "b".repeat(40), [
      "| PRC-1 | post-review-commit | - | - | human-decided | maintainer allowed the identity change |"
    ]);
    const blocked = await verifyInProcess({
      mode: "gate", skillName: "complete-task", taskDir: blockedTask, checks: [], repositoryRoot: fixtureRoot
    });
    assert.equal(blocked.gate, "blocked");
    assert.equal(blocked.checks[0].status, "blocked");
    assert.equal(blocked.checks[0].fail_type, "PLATFORM_CAPABILITY_UNSUPPORTED");
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
