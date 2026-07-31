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

const TASK_ID = "TASK-20260731-000001";

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

test("complete-task gate verifies a squash merge from remote evidence when local objects are absent", () => {
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

    const base = commit(seed, "base\n", "base");
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "-q", "origin", "main"]);
    git(fixtureRoot, ["clone", "-q", "--branch", "main", remote, caller]);

    git(seed, ["switch", "-qc", "feature"]);
    const reviewedHead = commit(seed, "base\nreviewed\n", "reviewed");
    git(seed, ["push", "-q", "origin", `${reviewedHead}:refs/pull/1/head`]);
    git(seed, ["switch", "-q", "main"]);
    git(seed, ["merge", "--squash", "feature"]);
    git(seed, ["commit", "-qm", "squash"]);
    const mergeCommit = git(seed, ["rev-parse", "HEAD"]);
    git(seed, ["push", "-q", "origin", "main"]);

    const platformType = "complete-task-remote-evidence-test";
    const pullRequest: PlatformChangeRequestSnapshot = {
      repository: "o/r",
      number: 1,
      nodeId: "PR_1",
      url: "https://example.test/o/r/pull/1",
      state: "closed",
      title: "",
      body: "",
      draft: false,
      head: { repository: "o/r", ref: "feature", sha: reviewedHead },
      base: { repository: "o/r", ref: "main", sha: base },
      mergedAt: "2026-07-31T00:00:00Z",
      mergeCommitSha: mergeCommit,
      labels: [],
      assignees: [],
      milestone: null
    };
    registerPlatformAdapter({
      type: platformType,
      resolveContext() {
        return platformResult("no-op", {
          platform: { type: platformType, repository: "o/r", currentUser: "reviewer" }
        });
      },
      inspectChangeRequest() {
        return { ok: true, value: pullRequest };
      },
      resolveChangeRequestGitEvidence() {
        return {
          ok: true,
          value: {
            remoteUrl: remote,
            reviewedHeadRef: "refs/pull/1/head",
            targetHeadRef: "refs/heads/main"
          }
        };
      }
    });

    const taskDir = path.join(caller, ".agents", "workspace", "active", TASK_ID);
    fs.mkdirSync(path.join(caller, ".agents", "skills", "complete-task", "config"), { recursive: true });
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(caller, ".agents", ".airc.json"), JSON.stringify({
      platform: { type: platformType }
    }));
    fs.writeFileSync(
      path.join(caller, ".agents", "skills", "complete-task", "config", "verify.json"),
      JSON.stringify({ skill: "complete-task", checks: { "post-review-commit": {} } })
    );
    fs.writeFileSync(path.join(taskDir, "task.md"), [
      "---",
      `id: ${TASK_ID}`,
      "status: active",
      "current_step: code-review",
      "pr_number: 1",
      `last_reviewed_commit: ${reviewedHead}`,
      "---",
      "",
      "# Task"
    ].join("\n"));
    fs.writeFileSync(path.join(taskDir, "review-code.md"), "# Review\n");

    assert.notEqual(spawnSync("git", ["cat-file", "-e", `${reviewedHead}^{commit}`], {
      cwd: caller, env: gitSafeEnv()
    }).status, 0);
    assert.notEqual(spawnSync("git", ["cat-file", "-e", `${mergeCommit}^{commit}`], {
      cwd: caller, env: gitSafeEnv()
    }).status, 0);

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
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
