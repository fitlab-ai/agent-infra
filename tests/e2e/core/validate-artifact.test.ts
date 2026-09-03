import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  exists,
  read
} from "../../helpers.ts";
import {
  assertHasCanonicalPrSyncStructure,
  assertPayloadStatus,
  assertPointsToPrSyncRule,
  buildCompletedTaskContent,
  buildTaskContent,
  boundFactValue,
  buildTaskFrontmatter,
  formatTimestamp,
  formatTimestampInTimeZone,
  loadFixture,
  parseValidatorPayload,
  runValidator,
  withTempRoot,
  write
} from "./validate-artifact-helpers.ts";

const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

type TaskMetaCase = {
  name: string;
  skill: string;
  content(): string;
  assertResult(result: ReturnType<typeof runValidator>): void;
};

type ActivityLogCase = {
  name: string;
  issueNumber: number | string;
  activityLines(now: string): string[];
  assertResult(result: ReturnType<typeof runValidator>): void;
};

function writeCodeFixture(taskDir: string, fixture = "valid-code.md") {
  write(path.join(taskDir, "code.md"), loadFixture(fixture));
}

function writeCreateTaskDocument(
  taskDir: string,
  frontmatterOverrides: Record<string, string | number>,
  activityLines: string[] = []
) {
  write(path.join(taskDir, "task.md"), [
    buildTaskFrontmatter(frontmatterOverrides),
    "",
    "# 任务：创建任务",
    ...(activityLines.length > 0 ? ["", "## 活动日志", "", ...activityLines] : [])
  ].join("\n"));
}

const gateCases = [
  {
    name: "validate-artifact gate passes for code-task with fresh task and artifact",
    prefix: "agent-infra-gate-pass-",
    args(taskDir: string) {
      return ["gate", "code-task", taskDir, "code.md"];
    },
    prepare(taskDir: string) {
      write(path.join(taskDir, "task.md"), buildTaskContent());
      writeCodeFixture(taskDir);
    },
    assertResult(result: ReturnType<typeof runValidator>) {
      assert.equal(result.status, 0, result.stderr);
      const payload = parseValidatorPayload(result.stdout);
      assert.equal(payload.gate, "pass");
      assert.equal(payload.checks.length, 6);
      assert.deepEqual(
        payload.checks.map((check) => check.type),
        ["task-meta", "artifact", "implementation-input", "activity-log", "review-ledger", "platform-sync"]
      );
      assert.deepEqual(
        payload.checks.map((check) => check.status),
        ["pass", "pass", "pass", "pass", "pass", "pass"]
      );
    }
  },
  {
    name: "validate-artifact gate passes for complete-task when completion checklist is fully checked",
    prefix: "agent-infra-complete-task-pass-",
    args(taskDir: string) {
      return ["gate", "complete-task", taskDir];
    },
    prepare(taskDir: string) {
      write(path.join(taskDir, "task.md"), buildCompletedTaskContent([
        "- [x] 所有需求已满足",
        "- [x] 测试已编写并通过",
        "- [x] 代码已审查",
        "- [x] 文档已更新（如适用）",
        "- [x] PR 已创建"
      ], { pr_delivery_fact: boundFactValue(1) }));
    },
    assertResult(result: ReturnType<typeof runValidator>) {
      assert.equal(result.status, 0, result.stderr);
      const payload = parseValidatorPayload(result.stdout);
      assert.equal(payload.gate, "pass");
      assert.deepEqual(
        payload.checks.map((check) => check.type),
        ["task-meta", "activity-log", "completion-checklist", "review-ledger", "manual-validation", "post-review-commit", "platform-sync-preflight", "required-pr-delivery", "platform-sync", "artifact"]
      );
      assert.deepEqual(
        payload.checks.map((check) => check.status),
        ["pass", "pass", "pass", "pass", "pass", "pass", "pass", "pass", "pass", "pass"]
      );
    }
  }
];

for (const c of gateCases) {
  test(c.name, () => withTempRoot(c.prefix, (tempRoot) => {
    const taskDir = path.join(tempRoot, "TASK-20260328-000001");
    c.prepare(taskDir);
    c.assertResult(runValidator(c.args(taskDir)));
  }));
}

const taskMetaCases: TaskMetaCase[] = [
  {
    name: "validate-artifact create-task task-meta accepts a generated branch",
    skill: "create-task",
    content() {
      const now = formatTimestamp(new Date());
      return [
        buildTaskFrontmatter({
          type: "feature",
          workflow: "feature-development",
          branch: "agent-infra-feature-cli-generic-sandbox",
          current_step: "requirement-analysis"
        }),
        "",
        "# 任务：创建任务",
        "",
        "## 活动日志",
        "",
        `- ${now} — **Task Created** by codex — Task created from description`
      ].join("\n");
    },
    assertResult(result) {
      assert.equal(result.status, 0, result.stderr);
    }
  },
  {
    name: "validate-artifact create-task task-meta rejects invalid branch naming",
    skill: "create-task",
    content() {
      return [
        buildTaskFrontmatter({
          branch: "wrong-prefix-feature-cli-generic-sandbox",
          current_step: "requirement-analysis"
        }),
        "",
        "# 任务：创建任务"
      ].join("\n");
    },
    assertResult(result) {
      assert.equal(result.status, 1);
      assert.match(result.stdout, /Invalid branch/);
    }
  },
  {
    name: "validate-artifact task-meta rejects a current task when agent_infra_version is missing",
    skill: "code-task",
    content() {
      return buildTaskContent().replace(/^agent_infra_version: .*$/m, "agent_infra_version:");
    },
    assertResult(result) {
      assert.equal(result.status, 1);
      assert.match(result.stdout, /Missing required fields: agent_infra_version/);
    }
  },
  {
    name: "validate-artifact task-meta rejects malformed agent_infra_version",
    skill: "code-task",
    content() {
      return buildTaskContent({ agent_infra_version: "0.6.1" });
    },
    assertResult(result) {
      assert.equal(result.status, 1);
      assert.match(result.stdout, /Invalid agent_infra_version/);
    }
  },
  {
    name: "validate-artifact task-meta rejects unknown agent_infra_version",
    skill: "code-task",
    content() {
      return buildTaskContent({ agent_infra_version: "unknown" });
    },
    assertResult(result) {
      assert.equal(result.status, 1);
      assert.match(result.stdout, /Invalid agent_infra_version/);
    }
  },
  {
    name: "validate-artifact task-meta accepts SemVer build metadata in agent_infra_version",
    skill: "code-task",
    content() {
      return buildTaskContent({ agent_infra_version: "v0.6.1-alpha.0+build.7" });
    },
    assertResult(result) {
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /Invalid agent_infra_version/);
    }
  },
  {
    name: "validate-artifact task-meta accepts stamped agent_infra_version",
    skill: "code-task",
    content() {
      return buildTaskContent({ agent_infra_version: "v0.6.1-alpha.0" });
    },
    assertResult(result) {
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /agent_infra_version.*missing/);
    }
  },
  {
    name: "validate-artifact task-meta supports cancel-task cancelled_at requirements",
    skill: "cancel-task",
    content() {
      const cancelledAt = formatTimestamp(new Date());
      return buildTaskContent({
        status: "completed",
        cancelled_at: cancelledAt,
        cancel_reason: "No longer needed after investigation"
      }, {
        NOW: cancelledAt
      });
    },
    assertResult(result) {
      assert.equal(result.status, 0, result.stderr);
      assertPayloadStatus(result, { type: "task-meta", status: "pass" });
    }
  },
  {
    name: "validate-artifact task-meta passes for analyze-task when start_date is present",
    skill: "analyze-task",
    content() {
      return buildTaskContent({
        current_step: "requirement-analysis",
        start_date: "2026-06-25"
      });
    },
    assertResult(result) {
      assert.equal(result.status, 0, result.stderr);
      assertPayloadStatus(result, { type: "task-meta", status: "pass" });
    }
  },
  {
    name: "validate-artifact task-meta fails for analyze-task when start_date is missing",
    skill: "analyze-task",
    content() {
      return buildTaskContent({
        current_step: "requirement-analysis"
      });
    },
    assertResult(result) {
      assert.equal(result.status, 1, result.stderr);
      assertPayloadStatus(result, { type: "task-meta", status: "fail" });
      assert.match(result.stdout, /Expected start_date to be present/);
    }
  },
  {
    name: "validate-artifact task-meta passes for complete-task when target_date is present",
    skill: "complete-task",
    content() {
      const now = formatTimestamp(new Date());
      return buildTaskContent({
        status: "completed",
        completed_at: now,
        target_date: "2026-06-25"
      }, {
        NOW: now
      });
    },
    assertResult(result) {
      assert.equal(result.status, 0, result.stderr);
      assertPayloadStatus(result, { type: "task-meta", status: "pass" });
    }
  },
  {
    name: "validate-artifact task-meta fails for complete-task when target_date is missing",
    skill: "complete-task",
    content() {
      const now = formatTimestamp(new Date());
      return buildTaskContent({
        status: "completed",
        completed_at: now
      }, {
        NOW: now
      });
    },
    assertResult(result) {
      assert.equal(result.status, 1, result.stderr);
      assertPayloadStatus(result, { type: "task-meta", status: "fail" });
      assert.match(result.stdout, /Expected target_date to be present/);
    }
  }
];

for (const c of taskMetaCases) {
  test(c.name, () => withTempRoot("agent-infra-task-meta-", (tempRoot) => {
    const taskDir = path.join(tempRoot, "TASK-20260328-000001");
    write(path.join(taskDir, "task.md"), c.content());
    c.assertResult(runValidator(["check", "task-meta", taskDir, "--skill", c.skill]));
  }));
}

const activityLogCases: ActivityLogCase[] = [
  {
    name: "validate-artifact activity-log passes for create-task happy path with Issue created",
    issueNumber: 296,
    activityLines(now) {
      return [`- ${now} — **Create Task** by codex — Task created from description`];
    },
    assertResult(result) {
      assert.equal(result.status, 0, result.stderr);
    }
  },
  {
    name: "validate-artifact activity-log accepts legacy create-task step name during transition",
    issueNumber: 296,
    activityLines(now) {
      return [`- ${now} — **Task Created** by codex — Task created from description`];
    },
    assertResult(result) {
      assert.equal(result.status, 0, result.stderr);
    }
  },
  {
    name: "validate-artifact activity-log fails for create-task when Create Issue entry is appended",
    issueNumber: 296,
    activityLines(now) {
      return [
        `- ${now} — **Task Created** by codex — Task created from description`,
        `- ${now} — **Create Issue** by codex — Created GitHub Issue #296`
      ];
    },
    assertResult(result) {
      assert.equal(result.status, 1);
      assert.match(result.stdout, /Latest action 'Create Issue' does not match/);
    }
  },
  {
    name: "validate-artifact activity-log fails for create-task when Issue Creation Skipped entry is appended",
    issueNumber: "N/A",
    activityLines(now) {
      return [
        `- ${now} — **Task Created** by codex — Task created from description`,
        `- ${now} — **Issue Creation Skipped** by codex — GitHub Issue creation failed`
      ];
    },
    assertResult(result) {
      assert.equal(result.status, 1);
      assert.match(result.stdout, /Latest action 'Issue Creation Skipped' does not match/);
    }
  }
];

for (const c of activityLogCases) {
  test(c.name, () => withTempRoot("agent-infra-create-task-activity-", (tempRoot) => {
    const now = formatTimestamp(new Date());
    const taskDir = path.join(tempRoot, "TASK-20260328-000001");
    writeCreateTaskDocument(taskDir, {
      branch: "agent-infra-refactor-create-task-gate",
      current_step: "requirement-analysis",
      issue_number: c.issueNumber,
      updated_at: now
    }, c.activityLines(now));
    c.assertResult(runValidator(["check", "activity-log", taskDir, "--skill", "create-task"]));
  }));
}

test("validate-artifact artifact check fails when a required section is missing", () => (
  withTempRoot("agent-infra-gate-fail-", (tempRoot) => {
    const taskDir = path.join(tempRoot, "TASK-20260328-000001");
    write(path.join(taskDir, "task.md"), buildTaskContent());
    writeCodeFixture(taskDir, "missing-section-code.md");

    const result = runValidator(["check", "artifact", taskDir, "code.md", "--skill", "code-task"]);
    assert.equal(result.status, 1);
    assertPayloadStatus(result, { type: "artifact", status: "fail", message: /LOCAL_ARTIFACT_MISSING_SECTION/ });
  })
));

test("validate-artifact artifact check accepts an old valid artifact", () => (
  withTempRoot("agent-infra-gate-old-artifact-", (tempRoot) => {
    const taskDir = path.join(tempRoot, "TASK-20260328-000001");
    write(path.join(taskDir, "task.md"), buildTaskContent());
    writeCodeFixture(taskDir);
    const old = new Date(Date.now() - 45 * 60_000);
    fs.utimesSync(path.join(taskDir, "code.md"), old, old);

    const result = runValidator(["check", "artifact", taskDir, "code.md", "--skill", "code-task"]);
    assert.equal(result.status, 0, result.stderr);
    assertPayloadStatus(result, { type: "artifact", status: "pass" });
  })
));

test("validate-artifact activity-log accepts an old valid local timestamp", () => (
  withTempRoot("agent-infra-gate-stale-", (tempRoot) => {
    const taskDir = path.join(tempRoot, "TASK-20260328-000001");
    const staleTimestamp = formatTimestampInTimeZone(new Date(Date.now() - 45 * 60_000), localTimeZone);
    write(path.join(taskDir, "task.md"), buildTaskContent(
      { updated_at: staleTimestamp },
      { NOW: staleTimestamp }
    ));
    writeCodeFixture(taskDir);

    const result = runValidator(["check", "activity-log", taskDir, "--skill", "code-task"], {
      env: { TZ: localTimeZone }
    });
    assert.equal(result.status, 0, result.stderr);
    assertPayloadStatus(result, { type: "activity-log", status: "pass" });
  })
));

test("validate-artifact completion-checklist fails when a complete-task item is unchecked", () => (
  withTempRoot("agent-infra-complete-task-checklist-fail-", (tempRoot) => {
    const taskDir = path.join(tempRoot, "TASK-20260328-000001");
    write(path.join(taskDir, "task.md"), buildCompletedTaskContent([
      "- [x] 所有需求已满足",
      "- [ ] 测试已编写并通过",
      "- [x] 代码已审查"
    ]));

    const result = runValidator(["check", "completion-checklist", taskDir, "--skill", "complete-task"]);
    assert.equal(result.status, 1, result.stderr);
    assertPayloadStatus(result, {
      type: "completion-checklist",
      status: "fail",
      message: /Completion Checklist has unchecked items: 测试已编写并通过/
    });
  })
));

test("validate-artifact completion-checklist ignores fenced historical checklists", () => (
  withTempRoot("agent-infra-complete-task-fenced-checklist-", (tempRoot) => {
    const taskDir = path.join(tempRoot, "TASK-20260328-000001");
    const fencedHistory = [
      "```text",
      "## 完成检查清单",
      "- [ ] 历史未完成项",
      "```",
      ""
    ].join("\n");
    const content = buildCompletedTaskContent([
      "- [x] 所有需求已满足",
      "- [x] 测试已编写并通过",
      "- [x] 代码已审查"
    ]);
    write(path.join(taskDir, "task.md"), content.replace("## 完成检查清单", `${fencedHistory}## 完成检查清单`));

    const result = runValidator(["check", "completion-checklist", taskDir, "--skill", "complete-task"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assertPayloadStatus(result, { type: "completion-checklist", status: "pass" });
  })
));

test("validate-artifact section parsing honors tilde, longer, and mismatched fence closers", () => (
  withTempRoot("agent-infra-complete-task-fence-variants-", (tempRoot) => {
    const taskDir = path.join(tempRoot, "TASK-20260328-000001");
    const checklist = [
      "- [x] 所有需求已满足",
      "- [x] 测试已编写并通过",
      "- [x] 代码已审查"
    ];
    const fencedHistories = [
      "~~~text\n## 完成检查清单\n- [ ] 历史未完成项\n~~~~",
      "````text\n## 完成检查清单\n- [ ] 历史未完成项\n```\n## Completion Checklist\n- [ ] 仍在 fence 内\n`````",
      "~~~text\n## 完成检查清单\n- [ ] 历史未完成项\n```\n## Completion Checklist\n- [ ] 仍在 fence 内\n~~~"
    ];

    for (const [index, history] of fencedHistories.entries()) {
      const content = buildCompletedTaskContent(checklist);
      write(path.join(taskDir, "task.md"), content.replace("## 完成检查清单", `${history}\n\n## 完成检查清单`));
      const result = runValidator(["check", "completion-checklist", taskDir, "--skill", "complete-task"]);
      assert.equal(result.status, 0, `case ${index}: ${result.stderr || result.stdout}`);
    }
  })
));

test("validate-artifact task-meta accepts a valid workflow warning with escaped pipes", () => (
  withTempRoot("agent-infra-workflow-warning-pass-", (tempRoot) => {
    const taskDir = path.join(tempRoot, "TASK-20260328-000001");
    write(path.join(taskDir, "task.md"), [
      buildTaskContent(),
      "",
      "## 工作流告警",
      "",
      "| id | time | step | severity | code | status | target | message | action | resolved_at | resolution |",
      "|----|------|------|----------|------|--------|--------|---------|--------|-------------|------------|",
      String.raw`| WW-1 | 2026-07-09 12:00:00+08:00 | issue-sync | ACTION_REQUIRED | COMMENT_SYNC_FAILED | open | task-comment | failed a\\\|b | retry a\\\|b |  |  |`
    ].join("\n"));

    const result = runValidator(["check", "task-meta", taskDir, "--skill", "code-task"]);
    assert.equal(result.status, 0, result.stderr);
    assertPayloadStatus(result, { type: "task-meta", status: "pass" });
  })
));

test("validate-artifact task-meta rejects invalid workflow warning lifecycle fields", () => (
  withTempRoot("agent-infra-workflow-warning-fail-", (tempRoot) => {
    const taskDir = path.join(tempRoot, "TASK-20260328-000001");
    write(path.join(taskDir, "task.md"), [
      buildTaskContent(),
      "",
      "## Workflow Warnings",
      "",
      "| id | time | step | severity | code | status | target | message | action | resolved_at | resolution |",
      "|----|------|------|----------|------|--------|--------|---------|--------|-------------|------------|",
      "| WW-1 | 2026-07-09 12:00:00+08:00 | issue-sync | ACTION_REQUIRED | COMMENT_SYNC_FAILED | open | task-comment | failed |  |  |  |",
      "| WW-2 | 2026-07-09 12:01:00+08:00 | issue-sync | INFO | METADATA_SYNC_SKIPPED | resolved | label | skipped | none |  |  |"
    ].join("\n"));

    const result = runValidator(["check", "task-meta", taskDir, "--skill", "code-task"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /open warning requires action/);
    assert.match(result.stdout, /illegal severity 'INFO'/);
    assert.match(result.stdout, /resolved warning requires resolved_at and resolution/);
  })
));

test("PR summary callers reference the shared pr-sync rule", () => {
  assertPointsToPrSyncRule(".agents/skills/commit/reference/pr-summary-sync.md");
  assertPointsToPrSyncRule(".agents/skills/create-pr/reference/comment-publish.md");
  assertPointsToPrSyncRule(".agents/skills/complete-manual-validation/reference/summary-update.md");
});

test("template references point to the shared pr-sync rule", () => {
  assertPointsToPrSyncRule("templates/.agents/skills/commit/reference/pr-summary-sync.en.md");
  assertPointsToPrSyncRule("templates/.agents/skills/commit/reference/pr-summary-sync.zh-CN.md");
  assertPointsToPrSyncRule("templates/.agents/skills/create-pr/reference/comment-publish.en.md");
  assertPointsToPrSyncRule("templates/.agents/skills/create-pr/reference/comment-publish.zh-CN.md");
  assertPointsToPrSyncRule("templates/.agents/skills/complete-manual-validation/reference/summary-update.en.md");
  assertPointsToPrSyncRule("templates/.agents/skills/complete-manual-validation/reference/summary-update.zh-CN.md");
});

test("local and zh-CN rule files contain the canonical PR summary structure", () => {
  // The comment-body template carries the manual-validation section as a placeholder,
  // not a hard-coded ⚠️ heading; the two render branches are documented in prose.
  const zhHeadings = [/## 审查摘要/, /\{manual-validation-section\}/, /### 关键技术决策/, /### 审查历程/, /### 测试结果/];
  for (const file of [".agents/rules/pr-sync.md", "templates/.agents/rules/pr-sync.zh-CN.md"]) {
    assertHasCanonicalPrSyncStructure(file, zhHeadings);
    const content = read(file);
    assert.match(content, /complete-manual-validation/, `${file} should document the manual-validation completion caller`);
    assert.match(content, /manual-validation\.md/, `${file} should include manual-validation artifacts as aggregation input`);
    assert.match(content, /### ✅ 人工验证已通过/, `${file} should document the passed manual-validation branch`);
    assert.match(content, /### ⚠️ 需人工校验/, `${file} should document the retained-items branch`);
    assert.match(content, /### ✅ 无需人工校验/, `${file} should document the empty branch without the warning style`);
  }
});

test("template English rule contains the canonical PR summary structure", () => {
  const file = "templates/.agents/rules/pr-sync.en.md";
  const enHeadings = [/## Review Summary/, /\{manual-validation-section\}/, /### Key Technical Decisions/, /### Review History/, /### Test Results/];
  assertHasCanonicalPrSyncStructure(file, enHeadings);
  const content = read(file);
  assert.match(content, /complete-manual-validation/, "should document the manual-validation completion caller");
  assert.match(content, /manual-validation\.md/, "should include manual-validation artifacts as aggregation input");
  assert.match(content, /### ✅ Manual Validation Passed/, "should document the passed manual-validation branch");
  assert.match(content, /### ⚠️ Manual Verification Required/, "should document the retained-items branch");
  assert.match(content, /### ✅ No Manual Verification Needed/, "should document the empty branch without the warning style");
});

test("typed verification core and skill configs are present", () => {
  [
    "lib/task/verification.ts",
    "lib/task/verification-engine.ts",
    "lib/platform/verification-sync.ts",
    "lib/platform/verification-required.ts",
    ".agents/skills/code-task/config/verify.json",
    "templates/.agents/skills/code-task/config/verify.en.json",
    "templates/.agents/skills/code-task/config/verify.zh-CN.json"
  ].forEach((relativePath) => {
    assert.ok(exists(relativePath), `${relativePath} should exist`);
  });

});
