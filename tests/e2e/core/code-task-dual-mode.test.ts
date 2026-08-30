import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { INTERNAL_CLI_PATH } from "../../helpers.ts";
import { sha256File, upsertArtifactReceipt } from "../../../lib/task/artifact-receipts.ts";
import { upsertSection } from "../../../lib/task/sections.ts";

const TASK_ID = "TASK-20260101-000001";

function makeFixture(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-detect-mode-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  const taskDir = path.join(root, ".agents", "workspace", "active", TASK_ID);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "task.md"), `---\nid: ${TASK_ID}\nstatus: active\ncurrent_step: technical-design-review\nagent_infra_version: v0.9.11-alpha.0\n---\n\n# Task\n\n## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n`);
  const withPlan = files["plan.md"] ? files : { "plan.md": "# plan", ...files };
  for (const [name, content] of Object.entries(withPlan)) fs.writeFileSync(path.join(taskDir, name), content);
  seedLifecycleReceipts(taskDir);
  return { root, taskDir };
}

function addReceipt(taskDir: string, receipt: Parameters<typeof upsertArtifactReceipt>[1]) {
  const taskPath = path.join(taskDir, "task.md");
  const content = fs.readFileSync(taskPath, "utf8");
  const mutation = upsertArtifactReceipt(content, receipt);
  fs.writeFileSync(taskPath, upsertSection(content, mutation).content);
}

function seedLifecycleReceipts(taskDir: string) {
  const completedAt = "2026-01-01 00:00:00+00:00";
  const entries = fs.readdirSync(taskDir).filter((name) => /^review-plan(?:-r[2-9]\d*)?\.md$/.test(name));
  for (const output of entries) {
    const content = fs.readFileSync(path.join(taskDir, output), "utf8");
    const input = content.match(/`((?:plan|plan-r[2-9]\d*)\.md)`/)?.[1];
    if (!input || !fs.existsSync(path.join(taskDir, input))) continue;
    addReceipt(taskDir, {
      event: "review-plan.completed", output, input,
      inputSha256: sha256File(path.join(taskDir, input)), completedAt
    });
  }
  const codeOutputs = fs.readdirSync(taskDir).filter((name) => /^code(?:-r[2-9]\d*)?\.md$/.test(name));
  for (const output of codeOutputs) {
    if (!fs.existsSync(path.join(taskDir, "plan.md"))) continue;
    addReceipt(taskDir, {
      event: "code.completed", output, input: "plan.md",
      inputSha256: sha256File(path.join(taskDir, "plan.md")), completedAt
    });
  }
}

function runDetect(files: Record<string, string>) {
  const fixture = makeFixture(files);
  const result = spawnSync(process.execPath, [INTERNAL_CLI_PATH, "task-artifact", TASK_ID, "inspect", "--family", "code"], { cwd: fixture.root, encoding: "utf8" });
  return {
    status: result.status,
    output: JSON.parse(result.stdout)
  };
}

function zhReview(verdict: string, findings = "0 阻塞项，0 主要，0 次要 / **人工校验**：0") {
  return `## 审查摘要

- **总体结论**：${verdict}
- **发现（AI 可处理）**：${findings}
`;
}

function enReview(verdict: string, findings = "0 blockers, 0 majors, 0 minors / **Manual validation**: 0") {
  return `## Review Summary

- **Overall Verdict**: ${verdict}
- **Findings (AI-actionable)**: ${findings}
`;
}

function decisionTask(rows: string[], reviewTime = "2026-07-18 10:00:00+08:00", reviewCompleted = true) {
  const reviewEntry = reviewCompleted
    ? `- ${reviewTime} — **Review Code (Round 1)** by claude — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 0 → review-code.md`
    : `- ${reviewTime} — **Review Code (Round 1) [started]** by claude — started`;
  return `---
id: ${TASK_ID}
status: active
current_step: code-review
agent_infra_version: v0.9.11-alpha.0
---

# Task

## Review Disagreement Ledger

| id | stage | round | severity | status | evidence |
|----|-------|-------|----------|--------|----------|

## 实现输入

| id | ledger_id | decision_evidence | stage | needs_implementation | decided_at | status | consumed_by |
|----|-----------|-------------------|-------|----------------------|------------|--------|-------------|
${rows.join("\n")}

## Activity Log

${reviewEntry}
`;
}

// review-plan fixtures must include the "审查输入" / "Review Input" line that names the
// reviewed plan file; checkPlanAheadOfCode uses it to link a review-plan back to its plan
// regardless of round-number mismatch.
function zhReviewPlan(reviewedPlanFile: string, verdict: string, findings = "0 阻塞项，0 主要，0 次要 / **人工校验**：0") {
  return `# 技术方案审查报告

- **审查输入**：
  - \`${reviewedPlanFile}\`

${zhReview(verdict, findings)}`;
}

test("code-task dual-mode: branch 1 - no code requires an approved review-plan", () => {
  const result = runDetect({});

  assert.equal(result.status, 2);
  assert.equal(result.output.mode, "error");
});

test("code-task dual-mode: branch 1 - approved plan starts init mode", () => {
  const result = runDetect({
    "review-plan.md": zhReviewPlan("plan.md", "通过")
  });

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
    "review-code-r2.md": zhReview("需要修改", "2 阻塞项，1 主要，0 次要 / **人工校验**：0")
  });

  assert.equal(result.status, 0);
  assert.equal(result.output.mode, "fix");
  assert.equal(result.output.verdict, "Changes Requested");
  assert.equal(result.output.next_artifact, "code-r2.md");
  assert.equal(result.output.review_artifact, "review-code-r2.md");
});

test("code-task dual-mode: human-supplemented review (Approved with findings) fails closed", () => {
  const result = runDetect({
    "code.md": "# code",
    "review-code.md": zhReview("通过"),
    "review-code-r2.md": zhReview("通过", "0 阻塞项，1 主要，2 次要 / **人工校验**：0")
  });

  assert.equal(result.status, 2);
  assert.equal(result.output.mode, "error");
  assert.equal(result.output.verdict, null);
  assert.match(result.output.message, /REVIEW_VERDICT_FINDING_MISMATCH/);
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

test("code-task decision mode selects the earliest pending input", () => {
  const result = runDetect({
    "task.md": decisionTask([
      "| II-2 | HD-2 | task.md#HDR-2 | code | true | 2026-07-18 10:02:00+08:00 | pending | |",
      "| II-1 | CD-1 | task.md#HDR-1 | code | true | 2026-07-18 10:02:00+08:00 | pending | |"
    ]),
    "code.md": "# code",
    "review-code.md": zhReview("通过")
  });
  assert.equal(result.status, 0);
  assert.equal(result.output.mode, "decision");
  assert.equal(result.output.next_artifact, "code-r2.md");
  assert.equal(result.output.implementation_input, "II-1");
  assert.equal(result.output.decision_id, "CD-1");
  assert.equal(result.output.decision_evidence, "task.md#HDR-1");
});

test("code-task decision mode ignores not-required and consumed inputs", () => {
  const result = runDetect({
    "task.md": decisionTask([
      "| II-1 | CD-1 | task.md#HDR-1 | code | false | 2026-07-18 10:01:00+08:00 | not-required | |",
      "| II-2 | CD-2 | task.md#HDR-2 | code | true | 2026-07-18 10:02:00+08:00 | consumed | code.md |"
    ]),
    "code.md": "# code",
    "review-code.md": zhReview("通过")
  });
  assert.equal(result.status, 1);
  assert.equal(result.output.mode, "refused");
});

test("code-task decision mode recovers stale unconsumed input", () => {
  const result = runDetect({
    "task.md": decisionTask([
      "| II-1 | CD-1 | task.md#HDR-1 | code | true | 2026-07-18 09:59:00+08:00 | pending | |"
    ]),
    "code.md": "# code",
    "review-code.md": zhReview("通过")
  });
  assert.equal(result.status, 0, JSON.stringify(result.output));
  assert.equal(result.output.mode, "decision");
  assert.equal(result.output.implementation_input, "II-1");
});

test("code-task decision mode requires a completed approved review identity", () => {
  const result = runDetect({
    "task.md": decisionTask([
      "| II-1 | CD-1 | task.md#HDR-1 | code | true | 2026-07-18 09:59:00+08:00 | pending | |"
    ], "2026-07-18 10:00:00+08:00", false),
    "code.md": "# code",
    "review-code.md": zhReview("通过")
  });
  assert.equal(result.status, 2);
  assert.equal(result.output.mode, "error");
  assert.match(result.output.message, /completed Activity Log identity/i);
});

test("code-task dual-mode: branch 5 - Approved with findings fails closed (zh-CN review fixture)", () => {
  const result = runDetect({
    "code.md": "# code",
    "review-code.md": zhReview("通过", "0 阻塞项，1 主要，2 次要 / **人工校验**：0")
  });

  assert.equal(result.status, 2);
  assert.equal(result.output.mode, "error");
  assert.equal(result.output.verdict, null);
  assert.match(result.output.message, /REVIEW_VERDICT_FINDING_MISMATCH/);
});

test("code-task dual-mode: branch 5 - Approved with findings fails closed (en review fixture)", () => {
  const result = runDetect({
    "code.md": "# code",
    "review-code.md": enReview("Approved", "0 blockers, 1 major, 2 minors / **Manual validation**: 0")
  });

  assert.equal(result.status, 2);
  assert.equal(result.output.mode, "error");
  assert.equal(result.output.verdict, null);
  assert.match(result.output.message, /REVIEW_VERDICT_FINDING_MISMATCH/);
});

test("code-task dual-mode: branch 6 - Changes Requested triggers fix mode (zh-CN review fixture)", () => {
  const result = runDetect({
    "code.md": "# code",
    "review-code.md": zhReview("需要修改", "2 阻塞项，1 主要，0 次要 / **人工校验**：0")
  });

  assert.equal(result.status, 0);
  assert.equal(result.output.mode, "fix");
  assert.equal(result.output.verdict, "Changes Requested");
});

test("code-task dual-mode: branch 6 - Changes Requested triggers fix mode (en review fixture)", () => {
  const result = runDetect({
    "code.md": "# code",
    "review-code.md": enReview("Changes Requested", "2 blockers, 1 major, 0 minors / **Manual validation**: 0")
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

// File times model transport noise only; receipt-backed identity and SHA-256 drive routing.
function runDetectWithTransportTimes(
  files: Record<string, string>,
  mtimes: Record<string, number> = {}
) {
  const fixture = makeFixture(files);
  for (const [name, mtimeSeconds] of Object.entries(mtimes)) {
    fs.utimesSync(path.join(fixture.taskDir, name), mtimeSeconds, mtimeSeconds);
  }

  const result = spawnSync(process.execPath, [INTERNAL_CLI_PATH, "task-artifact", TASK_ID, "inspect", "--family", "code"], { cwd: fixture.root, encoding: "utf8" });
  return {
    status: result.status,
    output: JSON.parse(result.stdout)
  };
}

test("code-task dual-mode: branch 2 (replan) - new plan-r2 after code triggers init", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const result = runDetectWithTransportTimes(
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

test("code-task dual-mode: transport time reordering does not change receipt-backed routing", () => {
  const files = {
    "code.md": "# code",
    "review-code.md": zhReview("通过"),
    "plan.md": "# plan",
    "review-plan.md": zhReviewPlan("plan.md", "通过"),
    "plan-r2.md": "# plan-r2",
    "review-plan-r2.md": zhReviewPlan("plan-r2.md", "通过")
  };
  const first = runDetectWithTransportTimes(files, {
    "plan-r2.md": 2000,
    "review-plan-r2.md": 2030
  });
  const reordered = runDetectWithTransportTimes(files, {
    "plan-r2.md": 2030,
    "review-plan-r2.md": 2000
  });
  const routing = (result: ReturnType<typeof runDetectWithTransportTimes>) => ({
    status: result.status,
    mode: result.output.mode,
    next_round: result.output.next_round,
    next_artifact: result.output.next_artifact,
    review_artifact: result.output.review_artifact
  });
  assert.deepEqual(routing(reordered), routing(first));
});

test("code-task dual-mode: branch 2 (replan) - unreviewed latest plan does not fire", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  // plan iterated to r2 but the only review-plan (review-plan.md) still references plan.md;
  // checkPlanAheadOfCode sees the latest plan (plan-r2.md) is unreviewed and skips replan,
  // falling through to the existing Approved 0/0/0 → refused branch.
  const result = runDetectWithTransportTimes(
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
  // The approved review-plan-r2 receipt and plan identity should win and force a new init round.
  const result = runDetectWithTransportTimes(
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

test("code-task dual-mode: branch 2 (replan) - review-plan Approved with findings fails closed", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  // review-plan-r2 has Approved + 1 major → normalizes to Approved-with-issues.
  const result = runDetectWithTransportTimes(
    {
      "code.md": "# code",
      "review-code.md": zhReview("通过"),
      "plan.md": "# plan",
      "review-plan.md": zhReviewPlan("plan.md", "通过"),
      "plan-r2.md": "# plan-r2",
      "review-plan-r2.md": zhReviewPlan("plan-r2.md", "通过", "0 阻塞项，1 主要，0 次要 / **人工校验**：0")
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

  assert.equal(result.status, 2);
  assert.equal(result.output.mode, "error");
  assert.equal(result.output.verdict, null);
  assert.match(result.output.message, /REVIEW_VERDICT_FINDING_MISMATCH/);
});

test("code-task dual-mode: branch 2 (replan) - off-number plan/review-plan linked via 审查输入", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  // Real workflow shape from TASK-20260608-230434: plan-r5 was approved by review-plan-r4.
  // Round numbers are independent counters; checkPlanAheadOfCode must read the
  // "审查输入" of the latest review-plan to verify it actually reviewed the latest plan.
  const result = runDetectWithTransportTimes(
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
  const result = runDetectWithTransportTimes(
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
