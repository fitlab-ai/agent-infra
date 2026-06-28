import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { gitSafeEnv, initIsolatedGitRepo, onPlatforms } from "../../helpers.ts";
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

function commitCodePath(repoRoot: string, relPath: string, content: string, message: string): string {
  write(path.join(repoRoot, relPath), content);
  git(repoRoot, ["add", "-A"]);
  git(repoRoot, ["commit", "-qm", message]);
  return git(repoRoot, ["rev-parse", "HEAD"]);
}

function buildTask(rows: string[] = [], frontmatterOverrides: Record<string, string> = {}) {
  const ledger = [
    "## 审查分歧账本",
    "",
    "| id | stage | round | severity | status | evidence |",
    "|----|-------|-------|----------|--------|----------|",
    ...rows,
    ""
  ];
  return [
    buildTaskFrontmatter({ id: TASK_ID, current_step: "completed", ...frontmatterOverrides }),
    "",
    "# 任务：post-review commit 门禁",
    "",
    ...ledger,
    "## 活动日志",
    "",
    "- 2026-03-28 00:00:00+00:00 — **Completed** by codex — archived"
  ].join("\n");
}

function buildReviewCode(baselineLine: string | null, verdict = "通过") {
  return [
    "# 代码审查报告",
    "",
    ...(baselineLine === null ? [] : [`- **审查基线提交**：${baselineLine}`]),
    "## 审查摘要",
    "",
    `- **总体结论**：${verdict}`
  ].join("\n");
}

function runCheck(taskDir: string) {
  const result = runValidator(["check", "post-review-commit", taskDir, "--skill", "complete-task"]);
  return { result, payload: parseValidatorPayload(result.stdout) };
}

function setupRepo(tempRoot: string) {
  initIsolatedGitRepo(tempRoot);
  git(tempRoot, ["config", "user.email", "codex@example.com"]);
  git(tempRoot, ["config", "user.name", "Codex"]);
  const taskDir = path.join(tempRoot, "task");
  return { taskDir };
}

test("post-review-commit passes when there is no review-code artifact", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-prc-none-", (tempRoot) => {
    const { taskDir } = setupRepo(tempRoot);
    commitCodePath(tempRoot, ".agents/skills/x.md", "base\n", "base");
    write(path.join(taskDir, "task.md"), buildTask());

    const { payload } = runCheck(taskDir);
    assert.equal(payload.status, "pass");
    assert.match(payload.message, /check inactive/);
  });
});

test("post-review-commit passes when no commits land after the baseline", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-prc-clean-", (tempRoot) => {
    const { taskDir } = setupRepo(tempRoot);
    const baseline = commitCodePath(tempRoot, ".agents/skills/x.md", "base\n", "base");
    write(path.join(taskDir, "task.md"), buildTask());
    write(path.join(taskDir, "review-code.md"), buildReviewCode(baseline));

    const { payload } = runCheck(taskDir);
    assert.equal(payload.status, "pass");
  });
});

test("post-review-commit prefers last_reviewed_commit over the review baseline", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-prc-last-reviewed-", (tempRoot) => {
    const { taskDir } = setupRepo(tempRoot);
    const reviewBaseline = commitCodePath(tempRoot, ".agents/skills/x.md", "base\n", "base");
    const reviewedCommit = commitCodePath(tempRoot, ".agents/skills/x.md", "base\nreviewed\n", "reviewed change");
    write(path.join(taskDir, "task.md"), buildTask([], { last_reviewed_commit: reviewedCommit }));
    write(path.join(taskDir, "review-code.md"), buildReviewCode(reviewBaseline));

    const { payload } = runCheck(taskDir);
    assert.equal(payload.status, "pass");
  });
});

test("post-review-commit fails when a code-path commit lands after last_reviewed_commit", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-prc-after-last-reviewed-", (tempRoot) => {
    const { taskDir } = setupRepo(tempRoot);
    const reviewBaseline = commitCodePath(tempRoot, ".agents/skills/x.md", "base\n", "base");
    const reviewedCommit = commitCodePath(tempRoot, ".agents/skills/x.md", "base\nreviewed\n", "reviewed change");
    write(path.join(taskDir, "task.md"), buildTask([], { last_reviewed_commit: reviewedCommit }));
    write(path.join(taskDir, "review-code.md"), buildReviewCode(reviewBaseline));
    commitCodePath(tempRoot, ".agents/skills/x.md", "base\nreviewed\nextra\n", "unreviewed change");

    const { payload } = runCheck(taskDir);
    assert.equal(payload.status, "fail");
  });
});

test("post-review-commit falls back to the review baseline when last_reviewed_commit is invalid", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-prc-invalid-last-reviewed-", (tempRoot) => {
    const { taskDir } = setupRepo(tempRoot);
    commitCodePath(tempRoot, ".agents/skills/x.md", "base\n", "base");
    const fallbackBaseline = commitCodePath(tempRoot, ".agents/skills/x.md", "base\nreviewed\n", "reviewed change");
    write(path.join(taskDir, "task.md"), buildTask([], { last_reviewed_commit: "not-a-sha" }));
    write(path.join(taskDir, "review-code.md"), buildReviewCode(fallbackBaseline));

    const { payload } = runCheck(taskDir);
    assert.equal(payload.status, "pass");
  });
});

test("post-review-commit fallback reads the highest-round review-code artifact", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-prc-highest-review-", (tempRoot) => {
    const { taskDir } = setupRepo(tempRoot);
    const oldBaseline = commitCodePath(tempRoot, ".agents/skills/x.md", "base\n", "base");
    const highRoundBaseline = commitCodePath(tempRoot, ".agents/skills/x.md", "base\nreviewed\n", "reviewed change");
    write(path.join(taskDir, "task.md"), buildTask());
    write(path.join(taskDir, "review-code.md"), buildReviewCode(oldBaseline, "通过"));
    write(path.join(taskDir, "review-code-r2.md"), buildReviewCode(highRoundBaseline, "需要修改"));

    const { payload } = runCheck(taskDir);
    assert.equal(payload.status, "pass");
  });
});

test("post-review-commit fails when a code-path commit lands after the baseline", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-prc-dirty-", (tempRoot) => {
    const { taskDir } = setupRepo(tempRoot);
    const baseline = commitCodePath(tempRoot, ".agents/skills/x.md", "base\n", "base");
    write(path.join(taskDir, "task.md"), buildTask());
    write(path.join(taskDir, "review-code.md"), buildReviewCode(baseline));
    commitCodePath(tempRoot, ".agents/skills/x.md", "base\nmore\n", "post-review change");

    const { payload } = runCheck(taskDir);
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /re-run review-code|exemption/);
  });
});

test("post-review-commit passes when a human-decided exemption covers the commits", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-prc-exempt-", (tempRoot) => {
    const { taskDir } = setupRepo(tempRoot);
    const baseline = commitCodePath(tempRoot, ".agents/skills/x.md", "base\n", "base");
    write(path.join(taskDir, "task.md"), buildTask([
      "| PRC-1 | post-review-commit | - | - | human-decided | maintainer allowed the follow-up commit |"
    ]));
    write(path.join(taskDir, "review-code.md"), buildReviewCode(baseline));
    commitCodePath(tempRoot, ".agents/skills/x.md", "base\nmore\n", "post-review change");

    const { payload } = runCheck(taskDir);
    assert.equal(payload.status, "pass");
    assert.match(payload.message, /exemption/);
  });
});

test("post-review-commit blocks on an empty or malformed baseline SHA", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-prc-badsha-", (tempRoot) => {
    const { taskDir } = setupRepo(tempRoot);
    commitCodePath(tempRoot, ".agents/skills/x.md", "base\n", "base");
    write(path.join(taskDir, "task.md"), buildTask());
    write(path.join(taskDir, "review-code.md"), buildReviewCode("not-a-sha"));

    const { result, payload } = runCheck(taskDir);
    assert.equal(result.status, 2, result.stdout);
    assert.equal(payload.status, "blocked");
  });
});

test("post-review-commit skips legacy review-code artifacts without a baseline field", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-prc-legacy-", (tempRoot) => {
    const { taskDir } = setupRepo(tempRoot);
    commitCodePath(tempRoot, ".agents/skills/x.md", "base\n", "base");
    write(path.join(taskDir, "task.md"), buildTask());
    write(path.join(taskDir, "review-code.md"), buildReviewCode(null));

    const { payload } = runCheck(taskDir);
    assert.equal(payload.status, "pass");
    assert.match(payload.message, /legacy/);
  });
});

test("post-review-commit blocks when the task is not inside a git repository", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-prc-nogit-", (tempRoot) => {
    const taskDir = path.join(tempRoot, "task");
    write(path.join(taskDir, "task.md"), buildTask());
    write(path.join(taskDir, "review-code.md"), buildReviewCode("0123456789abcdef0123456789abcdef01234567"));

    const { result, payload } = runCheck(taskDir);
    assert.equal(result.status, 2, result.stdout);
    assert.equal(payload.status, "blocked");
  });
});

test("post-review-commit fails for a commit outside the legacy allowlist (fail-closed coverage)", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-prc-failclosed-", (tempRoot) => {
    const { taskDir } = setupRepo(tempRoot);
    const baseline = commitCodePath(tempRoot, ".agents/skills/x.md", "base\n", "base");
    write(path.join(taskDir, "task.md"), buildTask());
    write(path.join(taskDir, "review-code.md"), buildReviewCode(baseline));
    commitCodePath(tempRoot, "scripts/build-inline.js", "// generated\n", "post-review change to a previously-uncovered path");

    const { payload } = runCheck(taskDir);
    assert.equal(payload.status, "fail");
  });
});

test("post-review-commit covers package-lock.json by default (no hardcoded exclusion)", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-prc-lockfile-", (tempRoot) => {
    const { taskDir } = setupRepo(tempRoot);
    const baseline = commitCodePath(tempRoot, ".agents/skills/x.md", "base\n", "base");
    write(path.join(taskDir, "task.md"), buildTask());
    write(path.join(taskDir, "review-code.md"), buildReviewCode(baseline));
    commitCodePath(tempRoot, "package-lock.json", "{}\n", "post-review lockfile bump");

    const { payload } = runCheck(taskDir);
    assert.equal(payload.status, "fail");
  });
});
