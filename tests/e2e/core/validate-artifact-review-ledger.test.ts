import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  buildTaskFrontmatter,
  parseValidatorPayload,
  runValidator,
  withTempRoot,
  write
} from "./validate-artifact-helpers.ts";

const TASK_ID = "TASK-20260328-000001";

const LEDGER_HEADER = [
  "## 审查分歧账本",
  "",
  "| id | stage | round | severity | status | evidence |",
  "|----|-------|-------|----------|--------|----------|"
];

function buildLedgerTask(rows: string[], { withSection = true } = {}) {
  const ledger = withSection ? [...LEDGER_HEADER, ...rows, ""] : [];
  return [
    buildTaskFrontmatter({ id: TASK_ID, current_step: "completed" }),
    "",
    "# 任务：账本门禁",
    "",
    ...ledger,
    "## 活动日志",
    "",
    "- 2026-03-28 00:00:00+00:00 — **Completed** by codex — archived"
  ].join("\n");
}

function runLedger(skill: string, taskDir: string) {
  const result = runValidator(["check", "review-ledger", taskDir, "--skill", skill]);
  return { result, payload: parseValidatorPayload(result.stdout) };
}

test("review-ledger passes when no ledger section exists (backward compatible)", async () => {
  await withTempRoot("agent-infra-ledger-none-", (tempRoot) => {
    const taskDir = path.join(tempRoot, TASK_ID);
    write(path.join(taskDir, "task.md"), buildLedgerTask([], { withSection: false }));

    const { result, payload } = runLedger("complete-task", taskDir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(payload.status, "pass");
  });
});

test("review-ledger passes when every in-scope row is terminal", async () => {
  await withTempRoot("agent-infra-ledger-clean-", (tempRoot) => {
    const taskDir = path.join(tempRoot, TASK_ID);
    write(path.join(taskDir, "task.md"), buildLedgerTask([
      "| CD-1 | code | 2 | blocker | closed | fixed in code-r2, approved by review-code-r2 |",
      "| PL-1 | plan | 1 | major | confirmed | reviewer accepted refutation |"
    ]));

    const { result } = runLedger("complete-task", taskDir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
});

test("review-ledger fails on an open (unresolved) row", async () => {
  await withTempRoot("agent-infra-ledger-open-", (tempRoot) => {
    const taskDir = path.join(tempRoot, TASK_ID);
    write(path.join(taskDir, "task.md"), buildLedgerTask([
      "| CD-1 | code | 1 | blocker | open | review-code.md#1 |"
    ]));

    const { result, payload } = runLedger("complete-task", taskDir);
    assert.notEqual(result.status, 0, result.stdout);
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /CD-1/);
  });
});

test("review-ledger fails when a non-open status carries no evidence", async () => {
  await withTempRoot("agent-infra-ledger-evidence-", (tempRoot) => {
    const taskDir = path.join(tempRoot, TASK_ID);
    write(path.join(taskDir, "task.md"), buildLedgerTask([
      "| CD-1 | code | 1 | blocker | confirmed |  |"
    ]));

    const { payload } = runLedger("complete-task", taskDir);
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /requires evidence/);
  });
});

test("review-ledger fails on an illegal status value", async () => {
  await withTempRoot("agent-infra-ledger-illegal-", (tempRoot) => {
    const taskDir = path.join(tempRoot, TASK_ID);
    write(path.join(taskDir, "task.md"), buildLedgerTask([
      "| CD-1 | code | 1 | blocker | bogus | x |"
    ]));

    const { payload } = runLedger("complete-task", taskDir);
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /illegal status/);
  });
});

test("review-ledger forces escalation once a finding reaches the round limit", async () => {
  await withTempRoot("agent-infra-ledger-converge-", (tempRoot) => {
    const taskDir = path.join(tempRoot, TASK_ID);
    write(path.join(taskDir, "task.md"), buildLedgerTask([
      "| CD-1 | code | 3 | blocker | refuted | still disputed |"
    ]));

    const { payload } = runLedger("complete-task", taskDir);
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /without convergence|needs-human-decision/);
  });
});

test("review-ledger keeps needs-human-decision blocking until ruled", async () => {
  await withTempRoot("agent-infra-ledger-human-", (tempRoot) => {
    const taskDir = path.join(tempRoot, TASK_ID);
    write(path.join(taskDir, "task.md"), buildLedgerTask([
      "| CD-1 | code | 3 | blocker | needs-human-decision | escalated |"
    ]));

    const blocked = runLedger("complete-task", taskDir);
    assert.equal(blocked.payload.status, "fail");

    write(path.join(taskDir, "task.md"), buildLedgerTask([
      "| CD-1 | code | 3 | blocker | human-decided | maintainer ruled in favor of executor |"
    ]));
    const ruled = runLedger("complete-task", taskDir);
    assert.equal(ruled.payload.status, "pass");
  });
});

test("review-ledger stage_scope only enforces stages before the caller", async () => {
  await withTempRoot("agent-infra-ledger-scope-", (tempRoot) => {
    const taskDir = path.join(tempRoot, TASK_ID);
    // An open code-stage row is out of scope for plan-task (which only guards analysis).
    write(path.join(taskDir, "task.md"), buildLedgerTask([
      "| AN-1 | analysis | 1 | major | closed | resolved |",
      "| CD-1 | code | 1 | blocker | open | not yet handled |"
    ]));

    const planScoped = runLedger("plan-task", taskDir);
    assert.equal(planScoped.payload.status, "pass", planScoped.result.stdout);

    // complete-task guards all stages, so the same open code row must fail.
    const allScoped = runLedger("complete-task", taskDir);
    assert.equal(allScoped.payload.status, "fail");
    assert.match(allScoped.payload.message, /CD-1/);
  });
});

test("review-ledger fails on a malformed (wrong column count) row", async () => {
  await withTempRoot("agent-infra-ledger-malformed-", (tempRoot) => {
    const taskDir = path.join(tempRoot, TASK_ID);
    write(path.join(taskDir, "task.md"), buildLedgerTask([
      "| CD-1 | code | 1 | blocker |"
    ]));

    const { payload } = runLedger("complete-task", taskDir);
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /malformed/);
  });
});
