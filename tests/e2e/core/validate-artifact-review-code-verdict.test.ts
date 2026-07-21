import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { filePath, gitSafeEnv, initIsolatedGitRepo } from "../../helpers.ts";
import {
  buildTaskContent,
  buildTaskFrontmatter,
  formatTimestamp,
  parseValidatorPayload,
  runValidator,
  withTempRoot,
  write
} from "./validate-artifact-helpers.ts";

const TASK_ID = "TASK-20260328-000001";

const fingerprintScript = filePath(".agents/scripts/review-diff-fingerprint.js");

function git(repoRoot: string, args: string[]) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", env: gitSafeEnv() });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function setupReviewRepo(tempRoot: string) {
  initIsolatedGitRepo(tempRoot);
  git(tempRoot, ["config", "user.email", "codex@example.com"]);
  git(tempRoot, ["config", "user.name", "Codex"]);
  write(path.join(tempRoot, ".gitignore"), `${TASK_ID}/\n`);
  write(path.join(tempRoot, ".agents/skills/x.md"), "reviewed\n");
  git(tempRoot, ["add", "-A"]);
  git(tempRoot, ["commit", "-qm", "reviewed"]);
  const baseline = git(tempRoot, ["rev-parse", "HEAD"]);
  const result = spawnSync(process.execPath, [fingerprintScript, "worktree", baseline, "--format", "json"], {
    cwd: tempRoot,
    encoding: "utf8",
    env: gitSafeEnv()
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const snapshot = JSON.parse(result.stdout) as { fingerprint: string; tree: string };
  return {
    taskDir: path.join(tempRoot, TASK_ID),
    baseline,
    reviewedFingerprint: snapshot.fingerprint,
    reviewedTree: snapshot.tree
  };
}

function buildReviewArtifact(verdictLine: string, baseline: string, reviewedFingerprint: string, reviewedTree: string) {
  return [
    "# 代码审查报告",
    "",
    "## 状态核对",
    "",
    "```text",
    "$ git status -s",
    "```",
    "",
    "## 审查摘要",
    "",
    "- **审查者**：codex",
    `- **审查基线提交**：${baseline}`,
    `- **审查差异指纹**：${reviewedFingerprint}`,
    `- **审查快照树**：${reviewedTree}`,
    `- ${verdictLine}`,
    "- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：0",
    "",
    "## 问题清单",
    "",
    "（无）",
    "",
    "## 非阻塞建议",
    "",
    "（无）",
    "",
    "## 人工校验项",
    "",
    "（无）",
    "",
    "## 审查分歧账本回写",
    "",
    "（本轮无新发现）",
    "",
    "## 证据原文",
    "",
    "- 断言：审查通过。",
    "```text",
    "$ true",
    "```",
    "",
    "## 自我质疑",
    "",
    "（无）",
    "",
    "## 结论与建议",
    "",
    "### 审查决定",
    "",
    "- [x] 通过"
  ].join("\n");
}

function buildReviewTask(baseline: string, overrides: Record<string, string | number> = {}) {
  return buildTaskContent(
    {
      id: TASK_ID,
      issue_number: "N/A",
      current_step: "code-review",
      agent_infra_version: "v0.0.0-test",
      last_reviewed_commit: baseline,
      ...overrides
    },
    {
      NOW: formatTimestamp(new Date())
    }
  ).replace(
    "**Code Task (Round 1)** by codex — Code implemented, 2 files modified, 42 tests passed → code.md",
    "**Review Code (Round 1)** by codex — Verdict: Approved, blockers: 0, major: 0, minor: 0 → review-code.md"
  );
}

test("review-code gate rejects combined zh-CN verdict phrase (A-a-zh)", async () => {
  await withTempRoot("agent-infra-rcv-bad-", (tempRoot) => {
    const { taskDir, baseline, reviewedFingerprint, reviewedTree } = setupReviewRepo(tempRoot);
    write(path.join(taskDir, "task.md"), buildReviewTask(baseline));
    write(
      path.join(taskDir, "review-code.md"),
      buildReviewArtifact("**总体结论**：通过但有问题", baseline, reviewedFingerprint, reviewedTree)
    );

    const result = runValidator(["gate", "review-code", taskDir, "review-code.md"]);

    assert.notEqual(result.status, 0, result.stderr || result.stdout);
    const payload = parseValidatorPayload(result.stdout);
    assert.equal(payload.gate, "fail");
    const artifactCheck = payload.checks.find((c) => c.type === "artifact");
    assert.ok(artifactCheck, "expected an artifact check in the payload");
    assert.equal(artifactCheck.status, "fail");
    const message = artifactCheck.message || "";
    // 锚定到 validate-artifact.js 的固定模板字符串 "is missing required pattern: {pattern}"
    // （见 .agents/scripts/validate-artifact.js:367）。如未来要改写错误信息，作者需同时更新此测试。
    assert.match(
      message,
      /missing required pattern/,
      `expected validator's fixed 'missing required pattern' template; got: ${message}`
    );
    // 证明 fail 的是新增的 verdict 正则（含 token alternation），而不是别的 required_pattern。
    assert.match(message, /通过|Approved/, `expected verdict pattern fragment in message; got: ${message}`);
  });
});

test("review-code gate accepts canonical zh-CN verdict (A-b-zh)", async () => {
  await withTempRoot("agent-infra-rcv-good-", (tempRoot) => {
    const { taskDir, baseline, reviewedFingerprint, reviewedTree } = setupReviewRepo(tempRoot);
    write(path.join(taskDir, "task.md"), buildReviewTask(baseline));
    write(
      path.join(taskDir, "review-code.md"),
      buildReviewArtifact("**总体结论**：通过", baseline, reviewedFingerprint, reviewedTree)
    );

    const result = runValidator(["gate", "review-code", taskDir, "review-code.md"]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = parseValidatorPayload(result.stdout);
    assert.equal(payload.gate, "pass");
    const artifactCheck = payload.checks.find((c) => c.type === "artifact");
    assert.equal(artifactCheck?.status, "pass");
  });
});

test("review-code gate fails when the baseline commit field is absent", async () => {
  await withTempRoot("agent-infra-rcv-nobaseline-", (tempRoot) => {
    const { taskDir, baseline, reviewedFingerprint, reviewedTree } = setupReviewRepo(tempRoot);
    write(path.join(taskDir, "task.md"), buildReviewTask(baseline));
    const artifact = buildReviewArtifact("**总体结论**：通过", baseline, reviewedFingerprint, reviewedTree)
      .split("\n")
      .filter((line) => !line.startsWith("- **审查基线提交**"))
      .join("\n");
    write(path.join(taskDir, "review-code.md"), artifact);

    const result = runValidator(["gate", "review-code", taskDir, "review-code.md"]);

    assert.notEqual(result.status, 0, result.stdout);
    const artifactCheck = parseValidatorPayload(result.stdout).checks.find((c) => c.type === "artifact");
    assert.equal(artifactCheck?.status, "fail");
    assert.match(artifactCheck?.message || "", /审查基线提交/);
  });
});

test("review-code gate fails when the ledger writeback section is absent", async () => {
  await withTempRoot("agent-infra-rcv-noledger-", (tempRoot) => {
    const { taskDir, baseline, reviewedFingerprint, reviewedTree } = setupReviewRepo(tempRoot);
    write(path.join(taskDir, "task.md"), buildReviewTask(baseline));
    const lines = buildReviewArtifact("**总体结论**：通过", baseline, reviewedFingerprint, reviewedTree).split("\n");
    const index = lines.indexOf("## 审查分歧账本回写");
    lines.splice(index, 3); // heading, blank line, body line
    write(path.join(taskDir, "review-code.md"), lines.join("\n"));

    const result = runValidator(["gate", "review-code", taskDir, "review-code.md"]);

    assert.notEqual(result.status, 0, result.stdout);
    const artifactCheck = parseValidatorPayload(result.stdout).checks.find((c) => c.type === "artifact");
    assert.equal(artifactCheck?.status, "fail");
    assert.match(artifactCheck?.message || "", /审查分歧账本回写|missing sections/);
  });
});
