import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { gitSafeEnv, initIsolatedGitRepo, onPlatforms } from "../../helpers.ts";
import { snapshotReview } from "../../../lib/git/review-snapshot.ts";
import { resolvePostReviewGlobs } from "../../../lib/task/review-fingerprint.ts";
import {
  buildTaskFrontmatter,
  parseValidatorPayload,
  runValidator,
  withTempRoot,
  write
} from "./validate-artifact-helpers.ts";

const TASK_ID = "TASK-20260328-000001";

function git(repoRoot: string, args: string[]) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", env: gitSafeEnv() });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function snapshot(repoRoot: string, baseline: string) {
  return snapshotReview({ cwd: repoRoot, mode: "worktree", baseline, globs: resolvePostReviewGlobs({}, {}) });
}

function setupRepo(tempRoot: string) {
  initIsolatedGitRepo(tempRoot);
  git(tempRoot, ["config", "user.email", "codex@example.com"]);
  git(tempRoot, ["config", "user.name", "Codex"]);
  write(path.join(tempRoot, ".gitignore"), "task/\n");
  write(path.join(tempRoot, ".agents/skills/x.md"), "base\n");
  git(tempRoot, ["add", "-A"]);
  git(tempRoot, ["commit", "-qm", "base"]);
  const previous = git(tempRoot, ["rev-parse", "HEAD"]);
  write(path.join(tempRoot, ".agents/skills/x.md"), "base\nreviewed\n");
  git(tempRoot, ["add", "-A"]);
  git(tempRoot, ["commit", "-qm", "reviewed"]);
  return {
    taskDir: path.join(tempRoot, "task", TASK_ID),
    previous,
    baseline: git(tempRoot, ["rev-parse", "HEAD"])
  };
}

function taskContent(lastReviewedCommit?: string) {
  return [
    buildTaskFrontmatter({
      id: TASK_ID,
      current_step: "code-review",
      ...(lastReviewedCommit ? { last_reviewed_commit: lastReviewedCommit } : {})
    }),
    "",
    "# 任务：review fact",
    "",
    "## 活动日志",
    "",
    "- 2026-03-28 00:00:00+00:00 — **Review Code (Round 1)** by codex — done"
  ].join("\n");
}

function artifactContent(baseline: string, reviewedSnapshot: { fingerprint: string; tree: string }, verdict = "通过") {
  return [
    "# 代码审查报告",
    "",
    "## 审查摘要",
    "",
    `- **审查基线提交**：${baseline}`,
    `- **审查差异指纹**：${reviewedSnapshot.fingerprint}`,
    `- **审查快照树**：${reviewedSnapshot.tree}`,
    `- **总体结论**：${verdict}`
  ].join("\n");
}

function runCheck(taskDir: string) {
  const result = runValidator(["check", "review-fact", taskDir, "review-code.md", "--skill", "review-code"]);
  return { result, payload: parseValidatorPayload(result.stdout) };
}

test("review-fact accepts an approved report whose HEAD, baseline, fingerprint, and task fact agree", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-review-fact-ok-", (tempRoot) => {
    const { taskDir, baseline } = setupRepo(tempRoot);
    write(path.join(taskDir, "task.md"), taskContent(baseline));
    write(path.join(taskDir, "review-code.md"), artifactContent(baseline, snapshot(tempRoot, baseline)));

    const { result, payload } = runCheck(taskDir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(payload.status, "pass");
  });
});

test("review-fact rejects an approved report when last_reviewed_commit is stale", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-review-fact-stale-", (tempRoot) => {
    const { taskDir, previous, baseline } = setupRepo(tempRoot);
    write(path.join(taskDir, "task.md"), taskContent(previous));
    write(path.join(taskDir, "review-code.md"), artifactContent(baseline, snapshot(tempRoot, baseline)));

    const { result, payload } = runCheck(taskDir);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /last_reviewed_commit/);
  });
});

test("review-fact rejects an approved report when last_reviewed_commit is missing", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-review-fact-missing-", (tempRoot) => {
    const { taskDir, baseline } = setupRepo(tempRoot);
    write(path.join(taskDir, "task.md"), taskContent());
    write(path.join(taskDir, "review-code.md"), artifactContent(baseline, snapshot(tempRoot, baseline)));

    const { result, payload } = runCheck(taskDir);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /last_reviewed_commit/);
  });
});

test("review-fact rejects a report whose baseline does not match HEAD", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-review-fact-head-", (tempRoot) => {
    const { taskDir, previous } = setupRepo(tempRoot);
    write(path.join(taskDir, "task.md"), taskContent(previous));
    write(path.join(taskDir, "review-code.md"), artifactContent(previous, snapshot(tempRoot, previous)));

    const { result, payload } = runCheck(taskDir);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /HEAD|baseline/i);
  });
});

test("review-fact rejects a report whose fingerprint does not match the reviewed worktree", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-review-fact-fingerprint-", (tempRoot) => {
    const { taskDir, baseline } = setupRepo(tempRoot);
    write(path.join(taskDir, "task.md"), taskContent(baseline));
    const reviewed = snapshot(tempRoot, baseline);
    write(path.join(taskDir, "review-code.md"), artifactContent(baseline, { ...reviewed, fingerprint: `sha256:${"0".repeat(64)}` }));

    const { result, payload } = runCheck(taskDir);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /fingerprint/i);
  });
});

test("review-fact rejects a report whose snapshot tree does not match the reviewed worktree", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-review-fact-tree-", (tempRoot) => {
    const { taskDir, baseline } = setupRepo(tempRoot);
    write(path.join(taskDir, "task.md"), taskContent(baseline));
    const reviewed = snapshot(tempRoot, baseline);
    write(path.join(taskDir, "review-code.md"), artifactContent(baseline, { ...reviewed, tree: "0".repeat(40) }));

    const { result, payload } = runCheck(taskDir);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /snapshot tree/i);
  });
});

test("review-fact does not require a task review commit for a non-approved report", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-review-fact-changes-", (tempRoot) => {
    const { taskDir, baseline } = setupRepo(tempRoot);
    write(path.join(taskDir, "task.md"), taskContent());
    write(path.join(taskDir, "review-code.md"), artifactContent(baseline, snapshot(tempRoot, baseline), "需要修改"));

    const { result, payload } = runCheck(taskDir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(payload.status, "pass");
  });
});

test("review-fact accepts an approved uncommitted snapshot without a commit anchor", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-review-fact-uncommitted-", (tempRoot) => {
    const { taskDir, baseline } = setupRepo(tempRoot);
    write(path.join(tempRoot, ".agents/skills/x.md"), "base\nreviewed\nuncommitted\n");
    write(path.join(taskDir, "task.md"), taskContent());
    write(path.join(taskDir, "review-code.md"), artifactContent(baseline, snapshot(tempRoot, baseline)));

    const { result, payload } = runCheck(taskDir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(payload.status, "pass");
  });
});
