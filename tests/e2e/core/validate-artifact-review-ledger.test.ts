import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { CLI_PATH, INTERNAL_CLI_PATH } from "../../helpers.ts";

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

function runLedger(skill: string, taskDir: string, repositoryRoot?: string) {
  const result = runValidator(["check", "review-ledger", taskDir, "--skill", skill], { repositoryRoot });
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

test("review-ledger honors the project maxHandshakeRounds override", async () => {
  await withTempRoot("agent-infra-ledger-configured-limit-", (tempRoot) => {
    write(path.join(tempRoot, ".agents", ".airc.json"), JSON.stringify({
      review: { maxHandshakeRounds: 2 }
    }));
    write(
      path.join(tempRoot, ".agents", "skills", "complete-task", "config", "verify.json"),
      JSON.stringify({ skill: "complete-task", checks: { "review-ledger": {} } })
    );
    const taskDir = path.join(tempRoot, TASK_ID);
    write(path.join(taskDir, "task.md"), buildLedgerTask([
      "| CD-1 | code | 2 | blocker | refuted | still disputed |"
    ]));

    const { payload } = runLedger("complete-task", taskDir, tempRoot);
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /reached limit 2/);
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

test("review-ledger keeps HD decision rows blocking until human-decided", async () => {
  await withTempRoot("agent-infra-ledger-hd-", (tempRoot) => {
    const taskDir = path.join(tempRoot, TASK_ID);
    write(path.join(taskDir, "task.md"), buildLedgerTask([
      "| HD-1 | plan | - | decision | needs-human-decision | plan.md#HD-1 |"
    ]));

    const blocked = runLedger("code-task", taskDir);
    assert.equal(blocked.payload.status, "fail");
    assert.match(blocked.payload.message, /HD-1/);

    write(path.join(taskDir, "task.md"), buildLedgerTask([
      "| HD-1 | plan | - | decision | human-decided | 人工裁决#HD-1 |"
    ]));
    const ruled = runLedger("code-task", taskDir);
    assert.equal(ruled.payload.status, "pass", ruled.result.stdout);
  });
});

test("review-ledger recognizes the evidence written by the real decide command", async () => {
  await withTempRoot("agent-infra-ledger-decide-", (tempRoot) => {
    spawnSync("git", ["init", "--quiet"], { cwd: tempRoot });
    write(path.join(tempRoot, ".agents", ".airc.json"), JSON.stringify({ project: "demo" }));
    const taskDir = path.join(tempRoot, ".agents", "workspace", "active", TASK_ID);
    const pending = [
      buildTaskFrontmatter({ id: TASK_ID, current_step: "code-review" }),
      "",
      "# 任务：真实裁决门禁",
      "",
      ...LEDGER_HEADER,
      "| CD-1 | code | 1 | blocker | needs-human-decision | review-code.md#CD-1 |",
      "",
      "## 人工裁决",
      "",
      "## 活动日志",
      "",
      "- 2026-03-28 00:00:00+00:00 — **Review Code** by codex — pending"
    ].join("\n");
    write(path.join(taskDir, "task.md"), pending);

    assert.equal(runLedger("complete-task", taskDir).payload.status, "fail");
    const decided = spawnSync("node", [CLI_PATH, "decide", TASK_ID, "CD-1", "--needs-implementation", "false", "accept reviewer guidance"], {
      cwd: tempRoot,
      encoding: "utf8"
    });
    assert.equal(decided.status, 0, decided.stderr);
    const content = fs.readFileSync(path.join(taskDir, "task.md"), "utf8");
    assert.match(content, /\| CD-1 \| code \| 1 \| blocker \| human-decided \| task\.md#HDR-1 \|/);
    assert.match(content, /^### HDR-1$/m);
    assert.equal(runLedger("complete-task", taskDir).payload.status, "pass");
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

test("review-ledger and stage-status agree for open minor, terminal, and advisory-only stages", async () => {
  await withTempRoot("agent-infra-ledger-parity-", (tempRoot) => {
    spawnSync("git", ["init", "--quiet"], { cwd: tempRoot });
    write(path.join(tempRoot, ".agents", ".airc.json"), JSON.stringify({ project: "demo" }));
    const taskDir = path.join(tempRoot, ".agents", "workspace", "active", TASK_ID);
    const cases = [
      { stage: "analysis", id: "AN-1", skill: "plan-task" },
      { stage: "plan", id: "PL-1", skill: "code-task" },
      { stage: "code", id: "CD-1", skill: "complete-task" }
    ];

    for (const item of cases) {
      write(path.join(taskDir, "task.md"), buildLedgerTask([
        `| ${item.id} | ${item.stage} | 1 | minor | open | review.md#${item.id} |`
      ]));
      const openStatus = spawnSync(process.execPath, [INTERNAL_CLI_PATH, "task-ledger", TASK_ID, "stage-status", "--stage", item.stage], {
        cwd: tempRoot, encoding: "utf8"
      });
      assert.equal(openStatus.status, 0, openStatus.stderr);
      assert.equal(JSON.parse(openStatus.stdout).stageStatus.canAdvance, false);
      assert.equal(runLedger(item.skill, taskDir).payload.status, "fail");

      write(path.join(taskDir, "task.md"), buildLedgerTask([
        `| ${item.id} | ${item.stage} | 1 | minor | closed | implementation evidence |`
      ]));
      const terminalStatus = spawnSync(process.execPath, [INTERNAL_CLI_PATH, "task-ledger", TASK_ID, "stage-status", "--stage", item.stage], {
        cwd: tempRoot, encoding: "utf8"
      });
      assert.equal(JSON.parse(terminalStatus.stdout).stageStatus.canAdvance, true);
      assert.equal(runLedger(item.skill, taskDir).payload.status, "pass");
    }

    write(path.join(taskDir, "task.md"), buildLedgerTask([]));
    const advisoryOnly = spawnSync(process.execPath, [INTERNAL_CLI_PATH, "task-ledger", TASK_ID, "stage-status", "--stage", "code"], {
      cwd: tempRoot, encoding: "utf8"
    });
    assert.equal(JSON.parse(advisoryOnly.stdout).stageStatus.canAdvance, true);
    assert.equal(runLedger("complete-task", taskDir).payload.status, "pass");
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
    assert.equal(payload.type, "review-ledger");
  });
});
