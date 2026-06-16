import test from "node:test";
import assert from "node:assert/strict";
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
      assert.equal(payload.checks.length, 4);
      assert.deepEqual(
        payload.checks.map((check) => check.status),
        ["pass", "pass", "pass", "pass"]
      );
    }
  },
  {
    name: "validate-artifact gate supports human-readable text output",
    prefix: "agent-infra-gate-text-",
    args(taskDir: string) {
      return ["gate", "code-task", taskDir, "code.md", "--format", "text"];
    },
    prepare(taskDir: string) {
      write(path.join(taskDir, "task.md"), buildTaskContent());
      writeCodeFixture(taskDir);
    },
    assertResult(result: ReturnType<typeof runValidator>) {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^Verification: pass \| Skill: code-task$/m);
      assert.match(result.stdout, /^\s+\[pass\] task-meta - /m);
      assert.match(result.stdout, /^\s+\[pass\] artifact - /m);
      assert.match(result.stdout, /^Result: 4 passed, 0 failed - All declared checks passed$/m);
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
      ]));
    },
    assertResult(result: ReturnType<typeof runValidator>) {
      assert.equal(result.status, 0, result.stderr);
      const payload = parseValidatorPayload(result.stdout);
      assert.equal(payload.gate, "pass");
      assert.deepEqual(
        payload.checks.map((check) => check.type),
        ["task-meta", "activity-log", "completion-checklist", "platform-sync", "artifact"]
      );
      assert.deepEqual(
        payload.checks.map((check) => check.status),
        ["pass", "pass", "pass", "pass", "pass"]
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
    name: "validate-artifact task-meta warns without blocking when agent_infra_version is missing",
    skill: "code-task",
    content() {
      return buildTaskContent();
    },
    assertResult(result) {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /agent_infra_version.*missing/);
      const payload = parseValidatorPayload(result.stdout);
      assert.deepEqual(payload.warnings, [
        "field 'agent_infra_version' missing — historical task or skipped version stamp"
      ]);
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
    name: "validate-artifact task-meta accepts unknown agent_infra_version fallback",
    skill: "code-task",
    content() {
      return buildTaskContent({ agent_infra_version: "unknown" });
    },
    assertResult(result) {
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /agent_infra_version.*missing/);
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
    assertPayloadStatus(result, { type: "artifact", status: "fail", message: /missing sections/i });
  })
));

test("validate-artifact activity-log freshness uses local timestamps", () => (
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
    assert.equal(result.status, 1);
    assertPayloadStatus(result, { type: "activity-log", status: "fail", message: /stale/i });
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

test("commit and create-pr references point to the shared pr-sync rule", () => {
  assertPointsToPrSyncRule(".agents/skills/commit/reference/pr-summary-sync.md");
  assertPointsToPrSyncRule(".agents/skills/create-pr/reference/comment-publish.md");
});

test("template references point to the shared pr-sync rule", () => {
  assertPointsToPrSyncRule("templates/.agents/skills/commit/reference/pr-summary-sync.en.md");
  assertPointsToPrSyncRule("templates/.agents/skills/commit/reference/pr-summary-sync.zh-CN.md");
  assertPointsToPrSyncRule("templates/.agents/skills/create-pr/reference/comment-publish.en.md");
  assertPointsToPrSyncRule("templates/.agents/skills/create-pr/reference/comment-publish.zh-CN.md");
});

test("local and zh-CN rule files contain the canonical PR summary structure", () => {
  const zhHeadings = [/## 审查摘要/, /### ⚠️ 需人工校验/, /### 关键技术决策/, /### 审查历程/, /### 测试结果/];
  assertHasCanonicalPrSyncStructure(".agents/rules/pr-sync.md", zhHeadings);
  assertHasCanonicalPrSyncStructure("templates/.agents/rules/pr-sync.github.zh-CN.md", zhHeadings);
});

test("template English rule contains the canonical PR summary structure", () => {
  const enHeadings = [/## Review Summary/, /### ⚠️ Manual Verification Required/, /### Key Technical Decisions/, /### Review History/, /### Test Results/];
  assertHasCanonicalPrSyncStructure("templates/.agents/rules/pr-sync.github.en.md", enHeadings);
});

test("verification assets are present in local and template trees", () => {
  [
    ".agents/scripts/validate-artifact.js",
    ".agents/scripts/platform-adapters/platform-sync.js",
    "templates/.agents/scripts/validate-artifact.js",
    "templates/.agents/scripts/platform-adapters/platform-sync.github.js",
    ".agents/skills/code-task/config/verify.json",
    "templates/.agents/skills/code-task/config/verify.en.json",
    "templates/.agents/skills/code-task/config/verify.zh-CN.json"
  ].forEach((relativePath) => {
    assert.ok(exists(relativePath), `${relativePath} should exist`);
  });

  assert.equal(
    read(".agents/scripts/validate-artifact.js"),
    read("templates/.agents/scripts/validate-artifact.js"),
    "template validate-artifact.js should stay in sync with the local script"
  );
  assert.equal(
    read(".agents/scripts/platform-adapters/platform-sync.js"),
    read("templates/.agents/scripts/platform-adapters/platform-sync.github.js"),
    "template platform adapter should stay in sync with the local adapter"
  );
});
