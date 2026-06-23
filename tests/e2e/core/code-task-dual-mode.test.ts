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

// review-plan fixtures must include the "审查输入" / "Review Input" line that names the
// reviewed plan file; checkPlanAheadOfCode uses it to link a review-plan back to its plan
// regardless of round-number mismatch.
function zhReviewPlan(reviewedPlanFile: string, verdict: string, findings = "0 阻塞项，0 主要，0 次要 / **env-blocked**：0") {
  return `# 技术方案审查报告

- **审查输入**：
  - \`${reviewedPlanFile}\`

${zhReview(verdict, findings)}`;
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

// A maintainer may append a review-code-r{N} round against the existing latest code
// (rev_max > code_max) after a PR is opened. This is not corruption — detect-mode defers to
// the latest review's verdict instead of erroring. The branch is decided by verdict, so the
// same five cases that apply to rev_max == code_max apply here.
test("code-task dual-mode: human-supplemented review (Approved 0/0/0) refuses rerun", () => {
  const result = runDetect({
    "code.md": "# code",
    "review-code.md": zhReview("通过"),
    "review-code-r2.md": zhReview("通过")
  });

  assert.equal(result.status, 1);
  assert.equal(result.output.mode, "refused");
  assert.equal(result.output.verdict, "Approved");
});

test("code-task dual-mode: human-supplemented review (Changes Requested) enters fix mode", () => {
  const result = runDetect({
    "code.md": "# code",
    "review-code.md": zhReview("通过"),
    "review-code-r2.md": zhReview("需要修改", "2 阻塞项，1 主要，0 次要 / **env-blocked**：0")
  });

  assert.equal(result.status, 0);
  assert.equal(result.output.mode, "fix");
  assert.equal(result.output.verdict, "Changes Requested");
  assert.equal(result.output.next_artifact, "code-r2.md");
  assert.equal(result.output.review_artifact, "review-code-r2.md");
});

test("code-task dual-mode: human-supplemented review (Approved-with-issues) enters optional fix mode", () => {
  const result = runDetect({
    "code.md": "# code",
    "review-code.md": zhReview("通过"),
    "review-code-r2.md": zhReview("通过", "0 阻塞项，1 主要，2 次要 / **env-blocked**：0")
  });

  assert.equal(result.status, 0);
  assert.equal(result.output.mode, "fix");
  assert.equal(result.output.verdict, "Approved-with-issues");
  assert.equal(result.output.next_artifact, "code-r2.md");
  assert.equal(result.output.review_artifact, "review-code-r2.md");
});

test("code-task dual-mode: human-supplemented review (Rejected) refuses local fix mode", () => {
  const result = runDetect({
    "code.md": "# code",
    "review-code.md": zhReview("通过"),
    "review-code-r2.md": zhReview("拒绝")
  });

  assert.equal(result.status, 1);
  assert.equal(result.output.mode, "refused");
  assert.equal(result.output.verdict, "Rejected");
});

test("code-task dual-mode: human-supplemented review with unparsable verdict still errors", () => {
  const result = runDetect({
    "code.md": "# code",
    "review-code.md": zhReview("通过"),
    "review-code-r2.md": "## 审查摘要\n\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要\n"
  });

  assert.equal(result.status, 2);
  assert.equal(result.output.mode, "error");
  assert.match(result.output.message, /cannot parse|unrecognized/);
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

// branch 4 (Approved 0/0/0 with no plan iteration → `refused`) remains the regression baseline for
// the new replan branch; we don't duplicate it here.

function runDetectWithMtimes(
  files: Record<string, string>,
  mtimes: Record<string, number> = {}
) {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-detect-mode-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(taskDir, name), content);
  }
  for (const [name, mtimeSeconds] of Object.entries(mtimes)) {
    fs.utimesSync(path.join(taskDir, name), mtimeSeconds, mtimeSeconds);
  }

  const result = spawnSync(process.execPath, [scriptPath, taskDir], { encoding: "utf8" });
  return {
    status: result.status,
    output: JSON.parse(result.stdout)
  };
}

test("code-task dual-mode: branch 2 (replan) - new plan-r2 after code triggers init", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const result = runDetectWithMtimes(
    {
      "code.md": "# code",
      "review-code.md": zhReview("通过"),
      "plan.md": "# plan",
      "review-plan.md": zhReviewPlan("plan.md", "通过"),
      "plan-r2.md": "# plan-r2",
      "review-plan-r2.md": zhReviewPlan("plan-r2.md", "通过")
    },
    {
      "code.md": nowSec - 5,
      "review-code.md": nowSec - 5,
      "plan.md": nowSec - 5,
      "review-plan.md": nowSec - 5,
      "plan-r2.md": nowSec,
      "review-plan-r2.md": nowSec
    }
  );

  assert.equal(result.status, 0);
  assert.equal(result.output.mode, "init");
  assert.equal(result.output.next_round, 2);
  assert.equal(result.output.next_artifact, "code-r2.md");
  assert.equal(result.output.review_artifact, "review-plan-r2.md");
});

test("code-task dual-mode: branch 2 (replan) - unreviewed latest plan does not fire", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  // plan iterated to r2 but the only review-plan (review-plan.md) still references plan.md;
  // checkPlanAheadOfCode sees the latest plan (plan-r2.md) is unreviewed and skips replan,
  // falling through to the existing Approved 0/0/0 → refused branch.
  const result = runDetectWithMtimes(
    {
      "code.md": "# code",
      "review-code.md": zhReview("通过"),
      "plan.md": "# plan",
      "review-plan.md": zhReviewPlan("plan.md", "通过"),
      "plan-r2.md": "# plan-r2"
    },
    {
      "code.md": nowSec - 5,
      "review-code.md": nowSec - 5,
      "plan.md": nowSec - 5,
      "review-plan.md": nowSec - 5,
      "plan-r2.md": nowSec
    }
  );

  assert.equal(result.status, 1);
  assert.equal(result.output.mode, "refused");
});

test("code-task dual-mode: branch 2 (replan) - precedes unreviewed-code error", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  // code-r2 has no matching review-code-r2 (would normally hit branch 3: error).
  // But review-plan-r2 (mtime > code-r2) should win and force a new init round.
  const result = runDetectWithMtimes(
    {
      "code.md": "# code",
      "review-code.md": zhReview("通过"),
      "code-r2.md": "# code-r2",
      "plan.md": "# plan",
      "review-plan.md": zhReviewPlan("plan.md", "通过"),
      "plan-r2.md": "# plan-r2",
      "review-plan-r2.md": zhReviewPlan("plan-r2.md", "通过")
    },
    {
      "code.md": nowSec - 5,
      "review-code.md": nowSec - 5,
      "code-r2.md": nowSec - 5,
      "plan.md": nowSec - 5,
      "review-plan.md": nowSec - 5,
      "plan-r2.md": nowSec,
      "review-plan-r2.md": nowSec
    }
  );

  assert.equal(result.status, 0);
  assert.equal(result.output.mode, "init");
  assert.equal(result.output.next_round, 3);
  assert.equal(result.output.next_artifact, "code-r3.md");
  assert.equal(result.output.review_artifact, "review-plan-r2.md");
});

test("code-task dual-mode: branch 2 (replan) - review-plan Approved-with-issues still triggers init", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  // review-plan-r2 has Approved + 1 major → normalizes to Approved-with-issues.
  // For review-plan that still means "plan approved with non-blocking suggestions";
  // replan must fire.
  const result = runDetectWithMtimes(
    {
      "code.md": "# code",
      "review-code.md": zhReview("通过"),
      "plan.md": "# plan",
      "review-plan.md": zhReviewPlan("plan.md", "通过"),
      "plan-r2.md": "# plan-r2",
      "review-plan-r2.md": zhReviewPlan("plan-r2.md", "通过", "0 阻塞项，1 主要，0 次要 / **env-blocked**：0")
    },
    {
      "code.md": nowSec - 5,
      "review-code.md": nowSec - 5,
      "plan.md": nowSec - 5,
      "review-plan.md": nowSec - 5,
      "plan-r2.md": nowSec,
      "review-plan-r2.md": nowSec
    }
  );

  assert.equal(result.status, 0);
  assert.equal(result.output.mode, "init");
  assert.equal(result.output.next_round, 2);
  assert.equal(result.output.next_artifact, "code-r2.md");
  assert.equal(result.output.review_artifact, "review-plan-r2.md");
});

test("code-task dual-mode: branch 2 (replan) - off-number plan/review-plan linked via 审查输入", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  // Real workflow shape from TASK-20260608-230434: plan-r5 was approved by review-plan-r4.
  // Round numbers are independent counters; checkPlanAheadOfCode must read the
  // "审查输入" of the latest review-plan to verify it actually reviewed the latest plan.
  const result = runDetectWithMtimes(
    {
      "code.md": "# code",
      "review-code.md": zhReview("通过"),
      "plan.md": "# plan",
      "review-plan.md": zhReviewPlan("plan.md", "通过"),
      "plan-r2.md": "# plan-r2",
      "plan-r3.md": "# plan-r3",
      "plan-r4.md": "# plan-r4",
      "plan-r5.md": "# plan-r5",
      "review-plan-r2.md": zhReviewPlan("plan-r2.md", "通过"),
      "review-plan-r3.md": zhReviewPlan("plan-r3.md", "通过"),
      "review-plan-r4.md": zhReviewPlan("plan-r5.md", "通过")
    },
    {
      "code.md": nowSec - 10,
      "review-code.md": nowSec - 10,
      "plan-r5.md": nowSec - 1,
      "review-plan-r4.md": nowSec
    }
  );

  assert.equal(result.status, 0);
  assert.equal(result.output.mode, "init");
  assert.equal(result.output.next_round, 2);
  assert.equal(result.output.next_artifact, "code-r2.md");
  assert.equal(result.output.review_artifact, "review-plan-r4.md");
});

test("code-task dual-mode: branch 2 (replan) - latest plan unreviewed (review-plan points to older plan)", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  // review-plan-r2 explicitly references plan-r2.md, but plan-r3.md exists (unreviewed).
  // checkPlanAheadOfCode must NOT replan because the maintainer hasn't approved plan-r3 yet.
  const result = runDetectWithMtimes(
    {
      "code.md": "# code",
      "review-code.md": zhReview("通过"),
      "plan.md": "# plan",
      "review-plan.md": zhReviewPlan("plan.md", "通过"),
      "plan-r2.md": "# plan-r2",
      "review-plan-r2.md": zhReviewPlan("plan-r2.md", "通过"),
      "plan-r3.md": "# plan-r3"
    },
    {
      "code.md": nowSec - 5,
      "review-code.md": nowSec - 5,
      "plan-r3.md": nowSec,
      "review-plan-r2.md": nowSec
    }
  );

  assert.equal(result.status, 1);
  assert.equal(result.output.mode, "refused");
});
