import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scriptPath = path.resolve(".agents/skills/code-task/scripts/detect-mode.js");

function runDetect(files: Record<string, string>) {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-detect-mode-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(taskDir, name), content);
  }

  const result = spawnSync(process.execPath, [scriptPath, taskDir], { encoding: "utf8" });
  return {
    status: result.status,
    output: JSON.parse(result.stdout)
  };
}

function zhReview(verdict: string, findings = "0 阻塞项，0 主要，0 次要 / **env-blocked**：0") {
  return `## 审查摘要

- **总体结论**：${verdict}
- **发现（AI 可处理）**：${findings}
`;
}

function enReview(verdict: string, findings = "0 blockers, 0 majors, 0 minors / **env-blocked**: 0") {
  return `## Review Summary

- **Overall Verdict**: ${verdict}
- **Findings (AI-actionable)**: ${findings}
`;
}

test("code-task dual-mode: branch 1 - no code starts init mode", () => {
  const result = runDetect({});

  assert.equal(result.status, 0);
  assert.equal(result.output.mode, "init");
  assert.equal(result.output.next_artifact, "code.md");
});

test("code-task dual-mode: branch 2 - unreviewed code returns error", () => {
  const result = runDetect({ "code.md": "# code" });

  assert.equal(result.status, 2);
  assert.equal(result.output.mode, "error");
  assert.equal(result.output.review_artifact, "review-code.md");
});

test("code-task dual-mode: branch 3 - review ahead of code returns error", () => {
  const result = runDetect({
    "code.md": "# code",
    "review-code.md": zhReview("通过"),
    "review-code-r2.md": zhReview("通过")
  });

  assert.equal(result.status, 2);
  assert.equal(result.output.mode, "error");
});

test("code-task dual-mode: branch 4 - Approved with no findings refuses rerun", () => {
  const result = runDetect({
    "code.md": "# code",
    "review-code.md": zhReview("通过")
  });

  assert.equal(result.status, 1);
  assert.equal(result.output.mode, "refused");
  assert.equal(result.output.verdict, "Approved");
});

test("code-task dual-mode: branch 5 - Approved with findings enters optional fix mode (zh-CN review fixture)", () => {
  const result = runDetect({
    "code.md": "# code",
    "review-code.md": zhReview("通过", "0 阻塞项，1 主要，2 次要 / **env-blocked**：0")
  });

  assert.equal(result.status, 0);
  assert.equal(result.output.mode, "fix");
  assert.equal(result.output.verdict, "Approved-with-issues");
  assert.equal(result.output.review_artifact, "review-code.md");
  assert.equal(result.output.next_artifact, "code-r2.md");
});

test("code-task dual-mode: branch 5 - Approved with findings enters optional fix mode (en review fixture)", () => {
  const result = runDetect({
    "code.md": "# code",
    "review-code.md": enReview("Approved", "0 blockers, 1 major, 2 minors / **env-blocked**: 0")
  });

  assert.equal(result.status, 0);
  assert.equal(result.output.mode, "fix");
  assert.equal(result.output.verdict, "Approved-with-issues");
  assert.equal(result.output.review_artifact, "review-code.md");
});

test("code-task dual-mode: branch 6 - Changes Requested triggers fix mode (zh-CN review fixture)", () => {
  const result = runDetect({
    "code.md": "# code",
    "review-code.md": zhReview("需要修改", "2 阻塞项，1 主要，0 次要 / **env-blocked**：0")
  });

  assert.equal(result.status, 0);
  assert.equal(result.output.mode, "fix");
  assert.equal(result.output.verdict, "Changes Requested");
});

test("code-task dual-mode: branch 6 - Changes Requested triggers fix mode (en review fixture)", () => {
  const result = runDetect({
    "code.md": "# code",
    "review-code.md": enReview("Changes Requested", "2 blockers, 1 major, 0 minors / **env-blocked**: 0")
  });

  assert.equal(result.status, 0);
  assert.equal(result.output.mode, "fix");
  assert.equal(result.output.verdict, "Changes Requested");
});

test("code-task dual-mode: branch 7 - Rejected refuses local fix mode", () => {
  const result = runDetect({
    "code.md": "# code",
    "review-code.md": zhReview("拒绝")
  });

  assert.equal(result.status, 1);
  assert.equal(result.output.mode, "refused");
  assert.equal(result.output.verdict, "Rejected");
});

test("code-task dual-mode: parsing failure returns error", () => {
  const result = runDetect({
    "code.md": "# code",
    "review-code.md": "## 审查摘要\n\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要\n"
  });

  assert.equal(result.status, 2);
  assert.equal(result.output.mode, "error");
  assert.match(result.output.message, /cannot parse|unrecognized/);
});
