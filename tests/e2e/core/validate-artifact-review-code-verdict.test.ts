import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

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

function buildReviewArtifact(verdictLine: string) {
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
    `- ${verdictLine}`,
    "- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **env-blocked**：0",
    "",
    "## 问题清单",
    "",
    "（无）",
    "",
    "## 环境性遗留",
    "",
    "（无）",
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

function buildReviewTask(overrides: Record<string, string | number> = {}) {
  return buildTaskContent(
    {
      id: TASK_ID,
      issue_number: "N/A",
      current_step: "code-review",
      agent_infra_version: "v0.0.0-test",
      ...overrides
    },
    {
      NOW: formatTimestamp(new Date())
    }
  ).replace(
    "**Code (Round 1)** by codex — Code implemented, 2 files modified, 42 tests passed → code.md",
    "**Code Review (Round 1)** by codex — Verdict: Approved, blockers: 0, major: 0, minor: 0 → review-code.md"
  );
}

test("review-code gate rejects combined zh-CN verdict phrase (A-a-zh)", async () => {
  await withTempRoot("agent-infra-rcv-bad-", (tempRoot) => {
    const taskDir = path.join(tempRoot, TASK_ID);
    write(path.join(taskDir, "task.md"), buildReviewTask());
    write(
      path.join(taskDir, "review-code.md"),
      buildReviewArtifact("**总体结论**：通过但有问题")
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
    const taskDir = path.join(tempRoot, TASK_ID);
    write(path.join(taskDir, "task.md"), buildReviewTask());
    write(
      path.join(taskDir, "review-code.md"),
      buildReviewArtifact("**总体结论**：通过")
    );

    const result = runValidator(["gate", "review-code", taskDir, "review-code.md"]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = parseValidatorPayload(result.stdout);
    assert.equal(payload.gate, "pass");
    const artifactCheck = payload.checks.find((c) => c.type === "artifact");
    assert.equal(artifactCheck?.status, "pass");
  });
});
