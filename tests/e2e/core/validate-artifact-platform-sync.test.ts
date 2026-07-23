import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  filePath,
  gitSafeEnv,
  INTERNAL_CLI_PATH,
  initIsolatedGitRepo,
  onPlatforms,
  pathWithPrependedBin,
  read
} from "../../helpers.ts";
import {
  addWorktree,
  assertPayloadStatus,
  buildArtifactComment,
  buildIssueFieldsPayload,
  buildIssuePayload,
  buildIssueType,
  buildPrPayload,
  buildTaskComment,
  buildTaskContent,
  commitInWorktree,
  createHeadCommit,
  loadFixture,
  parseValidatorPayload,
  runPlatformSyncAdapter,
  runValidator,
  runValidatorWithFakeGh,
  setupPlatformSyncEnv,
  withProjectTempRoot,
  withTempRoot,
  write,
  writeJson
} from "./validate-artifact-helpers.ts";

const taskId = "TASK-20260328-000001";
const summaryComment = "<!-- sync-pr:TASK-20260328-000001:summary -->\n## Review Summary\n\nLooks good.";
const summaryCommentWithSha = (sha: string) => (
  `<!-- sync-pr:TASK-20260328-000001:summary -->\n<!-- last-commit: ${sha} -->\n## Review Summary\n\nLooks good.`
);

test(
  "platform-sync preserves shell metacharacters through Windows .cmd and PATHEXT lookup",
  onPlatforms("win32"),
  async () => withTempRoot("agent-infra-platform-sync-win32-", async (tempRoot) => {
    const ctx = setupPlatformSyncEnv(tempRoot);
    const argsPath = path.join(tempRoot, "gh-args.jsonl");
    write(path.join(ctx.taskDir, "task.md"), buildTaskContent({ issue_number: "65" }));
    writeJson(ctx.issuePath, buildIssuePayload());

    const result = await runPlatformSyncAdapter(ctx.taskDir, {
      when: "issue_number_exists",
      expected_status_label: "status: in-progress"
    }, ctx.env({
      AGENT_INFRA_GH_BIN: "gh",
      AGENT_INFRA_GH_ARGS_JSON: JSON.stringify(["--jq", "value | value"]),
      GH_FAKE_ARGS_PATH: argsPath,
      GH_FAKE_STRIP_PREFIX_COUNT: "2",
      GH_FAKE_ISSUE_PATH: ctx.issuePath
    }));

    assert.equal(result.status, "pass", result.message);
    const calls = fs.readFileSync(argsPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.ok(calls.length > 0);
    assert.equal(calls[0][0], "--jq");
    assert.equal(calls[0][1], "value | value");
  })
);

test("platform-sync reads Issue metadata through the shared REST snapshot adapter", async () => {
  await withTempRoot("agent-infra-platform-sync-shared-", async (tempRoot) => {
    const ctx = setupPlatformSyncEnv(tempRoot);
    const argsPath = path.join(tempRoot, "gh-args.jsonl");
    write(path.join(ctx.taskDir, "task.md"), buildTaskContent({ issue_number: "65" }));
    writeJson(ctx.issuePath, buildIssuePayload());
    const result = await runPlatformSyncAdapter(ctx.taskDir, {
      when: "issue_number_exists",
      expected_status_label: "status: in-progress"
    }, ctx.env({ GH_FAKE_ARGS_PATH: argsPath, GH_FAKE_ISSUE_PATH: ctx.issuePath }));
    assert.equal(result.status, "pass", result.message);
    const calls = fs.readFileSync(argsPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as string[]);
    assert.ok(calls.some((args) => args[0] === "api" && /\/issues\/65$/.test(args[1] || "")));
  });
});

test("requirements sync converges before the complete-task platform gate", async () => {
  await withProjectTempRoot("agent-infra-requirements-convergence-", async (tempRoot) => {
    initIsolatedGitRepo(tempRoot, { remote: "git@github.com:fitlab-ai/agent-infra.git" });
    const taskDir = path.join(tempRoot, ".agents", "workspace", "active", taskId);
    const issuePath = path.join(tempRoot, "issue.json");
    const commentsPath = path.join(tempRoot, "comments.json");
    const fakeGhPath = path.join(tempRoot, "fake-gh.cjs");
    write(path.join(tempRoot, ".agents", ".airc.json"), '{"platform":{"type":"github"}}');
    write(path.join(taskDir, "task.md"), buildTaskContent({ issue_number: "65", type: "bugfix" }));
    write(fakeGhPath, loadFixture("fake-gh.js"));
    writeJson(issuePath, {
      number: 65,
      id: 650,
      node_id: "I_65",
      html_url: "https://github.com/fitlab-ai/agent-infra/issues/65",
      state: "open",
      title: "Issue",
      body: "# Issue\n\n## Requirements\n\nN/A\n",
      labels: [],
      assignees: [],
      milestone: { title: "0.7.1" },
      type: { name: "Bug" }
    });
    writeJson(commentsPath, []);
    const env = gitSafeEnv({
      AGENT_INFRA_GH_BIN: process.execPath,
      AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([fakeGhPath]),
      GH_FAKE_ISSUE_PATH: issuePath,
      GH_FAKE_COMMENTS_PATH: commentsPath,
      GH_FAKE_ISSUE_NUMBER: "65"
    });
    const runInternal = (args: string[]) => spawnSync(process.execPath, [INTERNAL_CLI_PATH, ...args], {
      cwd: tempRoot,
      env,
      encoding: "utf8"
    });

    const synced = runInternal(["platform-issue", "sync", taskId, "--agent", "codex", "--requirements"]);
    assert.equal(synced.status, 0, `${synced.stderr}\n${synced.stdout}`);
    assert.equal(JSON.parse(synced.stdout).status, "applied");

    const taskComment = runInternal(["platform-comment", "sync", taskId, "--kind", "task", "--agent", "codex"]);
    assert.equal(taskComment.status, 0, `${taskComment.stderr}\n${taskComment.stdout}`);
    const comments = JSON.parse(fs.readFileSync(commentsPath, "utf8"));
    comments.push({ id: 999, body: `<!-- sync-issue:${taskId}:summary -->\nSummary` });
    writeJson(commentsPath, comments);

    const validation = runValidator(
      ["check", "platform-sync", taskDir, "--skill", "complete-task"],
      { env }
    );
    assert.equal(validation.status, 0, `${validation.stderr}\n${validation.stdout}`);
    assertPayloadStatus(validation, { type: "platform-sync", status: "pass" });
    assert.match(JSON.parse(fs.readFileSync(issuePath, "utf8")).body, /- \[x\] 保留最新验证输出/);
  });
});

const implementSyncCases = [
  {
    name: "validate-artifact gate passes when synced artifact and task comments match local files",
    gate: true,
    skill: "code-task",
    comments(taskContent: string, artifactContent: string) {
      return [
        { body: buildArtifactComment(taskId, "code.md", "实现报告", artifactContent) },
        { body: buildTaskComment(taskId, taskContent) }
      ];
    },
    assertResult(result: ReturnType<typeof runValidator>) {
      assert.equal(result.status, 0, result.stderr);
      const payload = parseValidatorPayload(result.stdout);
      assert.equal(payload.gate, "pass");
      assert.ok(payload.checks.length > 0);
      assert.ok(payload.checks.every((check) => check.status === "pass"));
    }
  },
  {
    name: "validate-artifact platform-sync fails when artifact comment content differs from the local artifact",
    skill: "code-task",
    comments(taskContent: string) {
      return [
        { body: buildArtifactComment(taskId, "code.md", "实现报告", "# 摘要\n\n这不是原文。") },
        { body: buildTaskComment(taskId, taskContent) }
      ];
    },
    assertResult(result: ReturnType<typeof runValidator>) {
      assert.equal(result.status, 1);
      assertPayloadStatus(result, {
        type: "platform-sync",
        status: "fail",
        message: /Comment content mismatch for 'code'/
      });
      assert.match(parseValidatorPayload(result.stdout).message, /first difference near char \d+/);
    }
  },
  {
    name: "validate-artifact platform-sync fails when the task comment does not use the rendered frontmatter details block",
    skill: "code-task",
    comments(taskContent: string, artifactContent: string) {
      return [
        { body: buildArtifactComment(taskId, "code.md", "实现报告", artifactContent) },
        { body: buildTaskComment(taskId, taskContent, { rawBody: true }) }
      ];
    },
    assertResult(result: ReturnType<typeof runValidator>) {
      assert.equal(result.status, 1);
      assertPayloadStatus(result, {
        type: "platform-sync",
        status: "fail",
        message: /Comment content mismatch for 'task'/
      });
      assert.match(parseValidatorPayload(result.stdout).message, /line \d+, column \d+/);
    }
  },
  {
    name: "validate-artifact platform-sync fails when the Issue Type does not match task type",
    skill: "code-task",
    taskOverrides: { type: "feature" },
    issuePayload: buildIssuePayload({ type: buildIssueType("Task") }),
    comments(taskContent: string, artifactContent: string) {
      return [
        { body: buildArtifactComment(taskId, "code.md", "实现报告", artifactContent) },
        { body: buildTaskComment(taskId, taskContent) }
      ];
    },
    assertResult(result: ReturnType<typeof runValidator>) {
      assert.equal(result.status, 1);
      assertPayloadStatus(result, {
        type: "platform-sync",
        status: "fail",
        message: /has type 'Task', expected 'Feature'/
      });
    }
  },
  {
    name: "validate-artifact platform-sync fails for organization repos when the Issue Type is missing",
    skill: "code-task",
    issuePayload: buildIssuePayload({ type: null }),
    comments(taskContent: string, artifactContent: string) {
      return [
        { body: buildArtifactComment(taskId, "code.md", "实现报告", artifactContent) },
        { body: buildTaskComment(taskId, taskContent) }
      ];
    },
    assertResult(result: ReturnType<typeof runValidator>) {
      assert.equal(result.status, 1);
      assertPayloadStatus(result, {
        type: "platform-sync",
        status: "fail",
        message: /has no Issue Type set/
      });
    }
  },
  {
    name: "validate-artifact platform-sync passes for user repos when the Issue Type is missing",
    skill: "code-task",
    issuePayload: buildIssuePayload({ type: null }),
    extraEnv: { GH_FAKE_REPO_OWNER_TYPE: "User" },
    comments(taskContent: string, artifactContent: string) {
      return [
        { body: buildArtifactComment(taskId, "code.md", "实现报告", artifactContent) },
        { body: buildTaskComment(taskId, taskContent) }
      ];
    },
    assertResult(result: ReturnType<typeof runValidator>) {
      assert.equal(result.status, 0, result.stderr);
      assertPayloadStatus(result, { type: "platform-sync", status: "pass" });
    }
  },
  {
    name: "validate-artifact platform-sync skips Issue Type verification when the REST query is unavailable",
    skill: "code-task",
    extraEnv: {
      GH_FAKE_ISSUE_REST_FAIL: "Issue Types are unavailable",
      AGENT_INFRA_PLATFORM_RETRY_DELAYS_MS: "0,0"
    },
    comments(taskContent: string, artifactContent: string) {
      return [
        { body: buildArtifactComment(taskId, "code.md", "实现报告", artifactContent) },
        { body: buildTaskComment(taskId, taskContent) }
      ];
    },
    assertResult(result: ReturnType<typeof runValidator>) {
      assert.equal(result.status, 0, result.stderr);
      assertPayloadStatus(result, { type: "platform-sync", status: "pass" });
    }
  },
  {
    name: "validate-artifact platform-sync accepts English task frontmatter summary when language override is en",
    skill: "code-task",
    extraEnv: { VALIDATE_ARTIFACT_LANGUAGE: "en" },
    comments(taskContent: string, artifactContent: string) {
      return [
        { body: buildArtifactComment(taskId, "code.md", "Code Report", artifactContent) },
        { body: buildTaskComment(taskId, taskContent, { summaryText: "Metadata (frontmatter)" }) }
      ];
    },
    assertResult(result: ReturnType<typeof runValidator>) {
      assert.equal(result.status, 0, result.stderr);
      assertPayloadStatus(result, { type: "platform-sync", status: "pass" });
    }
  },
  {
    name: "validate-artifact platform-sync fails for create-task when the task comment is missing",
    skill: "create-task",
    issuePayload: buildIssuePayload({
      labels: [{ name: "status: waiting-for-triage" }],
      body: "# Issue\n"
    }),
    comments() {
      return [];
    },
    assertResult(result: ReturnType<typeof runValidator>) {
      assert.equal(result.status, 1);
      assertPayloadStatus(result, {
        type: "platform-sync",
        status: "fail",
        message: /sync-issue:TASK-20260328-000001:task/
      });
    }
  },
  {
    name: "validate-artifact platform-sync passes for create-task when the Issue has a milestone",
    skill: "create-task",
    issuePayload: buildIssuePayload({
      labels: [{ name: "status: waiting-for-triage" }],
      body: "# Issue\n"
    }),
    comments(taskContent: string) {
      return [{ body: buildTaskComment(taskId, taskContent) }];
    },
    assertResult(result: ReturnType<typeof runValidator>) {
      assert.equal(result.status, 0, result.stderr);
      assertPayloadStatus(result, { type: "platform-sync", status: "pass" });
    }
  },
  {
    name: "validate-artifact platform-sync fails for create-task when the Issue has no milestone",
    skill: "create-task",
    issuePayload: buildIssuePayload({
      labels: [{ name: "status: waiting-for-triage" }],
      body: "# Issue\n",
      milestone: null
    }),
    comments(taskContent: string) {
      return [{ body: buildTaskComment(taskId, taskContent) }];
    },
    assertResult(result: ReturnType<typeof runValidator>) {
      assert.equal(result.status, 1);
      assertPayloadStatus(result, {
        type: "platform-sync",
        status: "fail",
        message: /has no milestone set/
      });
    }
  },
  {
    name: "validate-artifact platform-sync fails for code-task when Issue milestone is a release line",
    skill: "code-task",
    issuePayload: buildIssuePayload({
      labels: [{ name: "status: in-progress" }],
      body: "# Issue\n",
      milestone: { title: "0.7.x" }
    }),
    comments(taskContent: string, artifactContent: string) {
      return [
        { body: buildArtifactComment(taskId, "code.md", "实现报告", artifactContent) },
        { body: buildTaskComment(taskId, taskContent) }
      ];
    },
    assertResult(result: ReturnType<typeof runValidator>) {
      assert.equal(result.status, 1);
      assertPayloadStatus(result, {
        type: "platform-sync",
        status: "fail",
        message: /milestone '0\.7\.x' is a release line/
      });
    }
  },
  {
    name: "validate-artifact platform-sync passes for code-task when Issue milestone is a specific version",
    skill: "code-task",
    issuePayload: buildIssuePayload({
      labels: [{ name: "status: in-progress" }],
      body: "# Issue\n",
      milestone: { title: "0.7.1" }
    }),
    comments(taskContent: string, artifactContent: string) {
      return [
        { body: buildArtifactComment(taskId, "code.md", "实现报告", artifactContent) },
        { body: buildTaskComment(taskId, taskContent) }
      ];
    },
    assertResult(result: ReturnType<typeof runValidator>) {
      assert.equal(result.status, 0, result.stderr);
      assertPayloadStatus(result, { type: "platform-sync", status: "pass" });
    }
  },
  {
    name: "validate-artifact platform-sync skips code-task milestone check without triage permission",
    skill: "code-task",
    issuePayload: buildIssuePayload({
      labels: [{ name: "status: in-progress" }],
      body: "# Issue\n",
      milestone: { title: "0.7.x" }
    }),
    comments(taskContent: string, artifactContent: string) {
      return [
        { body: buildArtifactComment(taskId, "code.md", "实现报告", artifactContent) },
        { body: buildTaskComment(taskId, taskContent) }
      ];
    },
    extraEnv: { GH_FAKE_PERMISSIONS: JSON.stringify({ triage: false, push: false }) },
    assertResult(result: ReturnType<typeof runValidator>) {
      assert.equal(result.status, 0, result.stderr);
      assertPayloadStatus(result, { type: "platform-sync", status: "pass" });
    }
  },
  {
    name: "validate-artifact platform-sync-preflight checks requirements inside the anchored section",
    skill: "complete-task",
    check: "platform-sync-preflight",
    issuePayload: buildIssuePayload({
      labels: [{ name: "status: in-progress" }],
      body: "# Issue\n\n## Requirements\n\n* [X] 保留最新验证输出\n",
      milestone: { title: "0.7.1" }
    }),
    comments(taskContent: string) {
      return [
        { body: buildTaskComment(taskId, taskContent) },
        { body: `<!-- sync-issue:${taskId}:summary -->\nSummary` }
      ];
    },
    assertResult(result: ReturnType<typeof runValidator>) {
      assert.equal(result.status, 0, result.stderr);
      assertPayloadStatus(result, { type: "platform-sync-preflight", status: "pass" });
    }
  },
  {
    name: "validate-artifact platform-sync-preflight fails when an anchored section is missing a checked requirement",
    skill: "complete-task",
    check: "platform-sync-preflight",
    issuePayload: buildIssuePayload({
      labels: [{ name: "status: in-progress" }],
      body: "# Issue\n\n## Requirements\n\nN/A\n",
      milestone: { title: "0.7.1" }
    }),
    comments(taskContent: string) {
      return [
        { body: buildTaskComment(taskId, taskContent) },
        { body: `<!-- sync-issue:${taskId}:summary -->\nSummary` }
      ];
    },
    assertResult(result: ReturnType<typeof runValidator>) {
      assert.equal(result.status, 1);
      assertPayloadStatus(result, {
        type: "platform-sync-preflight",
        status: "fail",
        message: /missing checked requirements/
      });
    }
  },
  {
    name: "validate-artifact platform-sync-preflight fails when requirement anchors are ambiguous",
    skill: "complete-task",
    check: "platform-sync-preflight",
    issuePayload: buildIssuePayload({
      labels: [{ name: "status: in-progress" }],
      body: "# Issue\n\n## Requirements\n\n- [x] 保留最新验证输出\n\n## 需求\n\nN/A\n",
      milestone: { title: "0.7.1" }
    }),
    comments(taskContent: string) {
      return [
        { body: buildTaskComment(taskId, taskContent) },
        { body: `<!-- sync-issue:${taskId}:summary -->\nSummary` }
      ];
    },
    assertResult(result: ReturnType<typeof runValidator>) {
      assert.equal(result.status, 1);
      assertPayloadStatus(result, {
        type: "platform-sync-preflight",
        status: "fail",
        message: /requirements section is ambiguous/
      });
    }
  }
];

for (const c of implementSyncCases) {
  test(c.name, () => withTempRoot("agent-infra-platform-sync-", (tempRoot) => {
    const ctx = setupPlatformSyncEnv(tempRoot);
    const taskContent = buildTaskContent({ issue_number: "65", ...c.taskOverrides });
    const artifactContent = loadFixture("valid-code.md");
    write(path.join(ctx.taskDir, "task.md"), taskContent);
    if (c.skill === "code-task") {
      write(path.join(ctx.taskDir, "code.md"), artifactContent);
    }
    writeJson(ctx.issuePath, c.issuePayload || buildIssuePayload());
    writeJson(ctx.commentsPath, c.comments(taskContent, artifactContent));

    const args = c.gate
      ? ["gate", "code-task", ctx.taskDir, "code.md"]
      : [
          "check",
          c.check || "platform-sync",
          ctx.taskDir,
          ...(c.skill === "code-task" ? ["code.md"] : []),
          "--skill",
          c.skill
        ];
    c.assertResult(runValidatorWithFakeGh(args, ctx, {
      GH_FAKE_ISSUE_PATH: ctx.issuePath,
      GH_FAKE_COMMENTS_PATH: ctx.commentsPath,
      ...c.extraEnv
    }));
  }));
}

const issueFieldCases = [
  {
    name: "validate-artifact platform-sync passes when Issue fields match task frontmatter",
    taskOverrides: {
      issue_number: "65",
      type: "feature",
      priority: "高",
      effort: "Medium",
      start_date: "2026-06-01"
    },
    fields: buildIssueFieldsPayload({
      pinnedFields: [
        { typename: "IssueFieldSingleSelect", name: "Priority" },
        { typename: "IssueFieldDate", name: "Start date" },
        { typename: "IssueFieldSingleSelect", name: "Effort" }
      ],
      values: [
        { typename: "IssueFieldSingleSelectValue", fieldName: "Priority", value: "High" },
        { typename: "IssueFieldSingleSelectValue", fieldName: "Effort", value: "Medium" },
        { typename: "IssueFieldDateValue", fieldName: "Start date", value: "2026-06-01" }
      ]
    }),
    expectedStatus: "pass"
  },
  {
    name: "validate-artifact platform-sync fails when an Issue field differs from task frontmatter",
    taskOverrides: {
      issue_number: "65",
      priority: "High"
    },
    fields: buildIssueFieldsPayload({
      values: [
        { typename: "IssueFieldSingleSelectValue", fieldName: "Priority", value: "Low" }
      ]
    }),
    expectedStatus: "fail",
    message: /field 'Priority' is 'Low', expected 'High'/
  }
];

for (const c of issueFieldCases) {
  test(c.name, async () => withTempRoot("agent-infra-platform-sync-issue-fields-", async (tempRoot) => {
    const ctx = setupPlatformSyncEnv(tempRoot);
    write(path.join(ctx.taskDir, "task.md"), buildTaskContent(c.taskOverrides));
    writeJson(ctx.issuePath, buildIssuePayload());
    writeJson(ctx.issueFieldsPath, c.fields);

    const result = await runPlatformSyncAdapter(ctx.taskDir, {
      when: "issue_number_exists",
      verify_issue_fields: true
    }, {
      PATH: pathWithPrependedBin(ctx.binDir),
      AGENT_INFRA_GH_BIN: process.execPath,
      AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([ctx.ghPath]),
      GH_FAKE_ISSUE_PATH: ctx.issuePath,
      GH_FAKE_ISSUE_FIELDS_PATH: ctx.issueFieldsPath
    });
    assert.equal(result.status, c.expectedStatus);
    if (c.message) {
      assert.match(result.message, c.message);
    }
  }));
}

test("validate-artifact platform-sync skips Issue field verification when fields are inapplicable or unavailable", async () => (
  withTempRoot("agent-infra-platform-sync-issue-fields-skip-", async (tempRoot) => {
    const ctx = setupPlatformSyncEnv(tempRoot);
    write(path.join(ctx.taskDir, "task.md"), buildTaskContent({
      issue_number: "65",
      target_date: "2026-06-30"
    }));
    writeJson(ctx.issuePath, buildIssuePayload());
    writeJson(ctx.issueFieldsPath, buildIssueFieldsPayload({
      pinnedFields: [
        { typename: "IssueFieldSingleSelect", name: "Priority" },
        { typename: "IssueFieldSingleSelect", name: "Effort" }
      ],
      values: []
    }));

    const inapplicableResult = await runPlatformSyncAdapter(ctx.taskDir, {
      when: "issue_number_exists",
      verify_issue_fields: true
    }, {
      PATH: pathWithPrependedBin(ctx.binDir),
      AGENT_INFRA_GH_BIN: process.execPath,
      AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([ctx.ghPath]),
      GH_FAKE_ISSUE_PATH: ctx.issuePath,
      GH_FAKE_ISSUE_FIELDS_PATH: ctx.issueFieldsPath
    });
    assert.equal(inapplicableResult.status, "pass");

    const unavailableResult = await runPlatformSyncAdapter(ctx.taskDir, {
      when: "issue_number_exists",
      verify_issue_fields: true
    }, {
      PATH: pathWithPrependedBin(ctx.binDir),
      AGENT_INFRA_GH_BIN: process.execPath,
      AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([ctx.ghPath]),
      GH_FAKE_ISSUE_PATH: ctx.issuePath,
      GH_FAKE_ISSUE_FIELDS_FAIL: "Issue fields are unavailable",
      AGENT_INFRA_PLATFORM_RETRY_DELAYS_MS: "0,0"
    });
    assert.equal(unavailableResult.status, "pass");

    writeJson(ctx.issueFieldsPath, buildIssueFieldsPayload({ issueType: null }));
    const missingTypeFieldsResult = await runPlatformSyncAdapter(ctx.taskDir, {
      when: "issue_number_exists",
      verify_issue_fields: true
    }, {
      PATH: pathWithPrependedBin(ctx.binDir),
      AGENT_INFRA_GH_BIN: process.execPath,
      AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([ctx.ghPath]),
      GH_FAKE_ISSUE_PATH: ctx.issuePath,
      GH_FAKE_ISSUE_FIELDS_PATH: ctx.issueFieldsPath
    });
    assert.equal(missingTypeFieldsResult.status, "pass");
  })
));

const createPrCases = [
  {
    name: "validate-artifact platform-sync fails when create-pr milestone is missing",
    prPayload: buildPrPayload({ labels: [{ name: "type: enhancement" }], milestone: null }),
    expectedStatus: 1,
    message: [/PR #77 has no milestone set/]
  },
  {
    name: "validate-artifact platform-sync fails when create-pr PR milestone is a release line",
    issuePayload: buildIssuePayload({ labels: [], body: "# Issue\n", milestone: { title: "0.7.1" } }),
    prPayload: buildPrPayload({ labels: [{ name: "type: enhancement" }], milestone: { title: "0.7.x" } }),
    expectedStatus: 1,
    message: [/PR #77 milestone '0\.7\.x' is a release line/]
  },
  {
    name: "validate-artifact platform-sync fails when PR and Issue in: labels diverge",
    issuePayload: buildIssuePayload({ labels: [{ name: "in: core" }], body: "# Issue\n" }),
    prPayload: buildPrPayload({ labels: [{ name: "type: enhancement" }, { name: "in: cli" }, { name: "in: core" }] }),
    expectedStatus: 1,
    message: [/in: labels mismatch/, /PR #77/, /Issue #65/]
  },
  {
    name: "validate-artifact platform-sync fails when create-pr is missing the expected type label",
    taskOverrides: { type: "feature" },
    issuePayload: buildIssuePayload({ labels: [{ name: "in: core" }], body: "# Issue\n" }),
    prPayload: buildPrPayload({ labels: [{ name: "in: core" }] }),
    expectedStatus: 1,
    message: [/Expected type label 'type: feature' not found on PR #77/]
  },
  {
    name: "validate-artifact platform-sync passes when create-pr includes the expected type label",
    taskOverrides: { type: "feature" },
    issuePayload: buildIssuePayload({ labels: [{ name: "in: core" }], body: "# Issue\n" }),
    prPayload: buildPrPayload({ labels: [{ name: "type: feature" }, { name: "in: core" }] }),
    expectedStatus: 0
  },
  {
    name: "validate-artifact platform-sync skips create-pr type label verification without triage permission",
    taskOverrides: { type: "feature" },
    issuePayload: buildIssuePayload({ labels: [{ name: "in: core" }], body: "# Issue\n" }),
    prPayload: buildPrPayload({ labels: [{ name: "in: core" }] }),
    env: { GH_FAKE_PERMISSIONS: JSON.stringify({ triage: false, push: false }) },
    expectedStatus: 0
  },
  {
    name: "validate-artifact platform-sync fails when create-pr has no assignee",
    prPayload: buildPrPayload({ labels: [{ name: "type: enhancement" }], assignees: [] }),
    expectedStatus: 1,
    message: [/PR #77 has no assignee/]
  },
  {
    name: "validate-artifact platform-sync skips create-pr assignee verification without push permission",
    prPayload: buildPrPayload({ labels: [{ name: "type: enhancement" }], assignees: [] }),
    env: { GH_FAKE_PERMISSIONS: JSON.stringify({ triage: true, push: false }) },
    expectedStatus: 0
  },
  {
    name: "validate-artifact platform-sync passes when create-pr summary comment exists on the PR",
    prPayload: buildPrPayload({ labels: [{ name: "type: enhancement" }] }),
    expectedStatus: 0
  },
  {
    name: "validate-artifact platform-sync fails when create-pr summary comment is missing on the PR",
    prPayload: buildPrPayload(),
    prComments: [],
    expectedStatus: 1,
    message: [/Expected PR comment marker/, /PR #77/]
  }
];

for (const c of createPrCases) {
  test(c.name, () => withTempRoot("agent-infra-platform-sync-pr-", (tempRoot) => {
    const ctx = setupPlatformSyncEnv(tempRoot);
    write(path.join(ctx.taskDir, "task.md"), buildTaskContent({
      issue_number: "65",
      pr_number: "77",
      ...c.taskOverrides
    }));
    writeJson(ctx.issuePath, c.issuePayload || buildIssuePayload({ labels: [], body: "# Issue\n" }));
    writeJson(ctx.prPath, c.prPayload);
    writeJson(ctx.prCommentsPath, c.prComments ?? [{ body: summaryComment }]);

    const result = runValidatorWithFakeGh(["check", "platform-sync", ctx.taskDir, "--skill", "create-pr"], ctx, {
      GH_FAKE_ISSUE_PATH: ctx.issuePath,
      GH_FAKE_PR_PATH: ctx.prPath,
      GH_FAKE_PR_COMMENTS_PATH: ctx.prCommentsPath,
      GH_FAKE_ISSUE_NUMBER: "65",
      GH_FAKE_PR_NUMBER: "77",
      ...c.env
    });
    assert.equal(result.status, c.expectedStatus, result.stderr);
    const payload = assertPayloadStatus(result, {
      type: "platform-sync",
      status: c.expectedStatus === 0 ? "pass" : "fail"
    });
    for (const matcher of c.message || []) {
      assert.match(payload.message, matcher);
    }
  }));
}

test("validate-artifact platform-sync passes for complete-manual-validation when PR summary shows passed manual validation", () => (
  withTempRoot("agent-infra-platform-sync-manual-validation-pass-", (tempRoot) => {
    const ctx = setupPlatformSyncEnv(tempRoot);
    const taskContent = buildTaskContent({
      issue_number: "65",
      pr_number: "77"
    });
    write(path.join(ctx.taskDir, "task.md"), taskContent);
    writeJson(ctx.issuePath, buildIssuePayload({ labels: [], body: "# Issue\n" }));
    writeJson(ctx.commentsPath, [{ body: buildTaskComment(taskId, taskContent) }]);
    writeJson(ctx.prCommentsPath, [{
      body: [
        "<!-- sync-pr:TASK-20260328-000001:summary -->",
        "## Review Summary",
        "",
        "### ✅ 人工验证已通过",
        "",
        "- 验证说明：staging smoke passed"
      ].join("\n")
    }]);

    const result = runValidatorWithFakeGh([
      "check",
      "platform-sync",
      ctx.taskDir,
      "--skill",
      "complete-manual-validation"
    ], ctx, {
      GH_FAKE_ISSUE_PATH: ctx.issuePath,
      GH_FAKE_COMMENTS_PATH: ctx.commentsPath,
      GH_FAKE_PR_COMMENTS_PATH: ctx.prCommentsPath,
      GH_FAKE_ISSUE_NUMBER: "65",
      GH_FAKE_PR_NUMBER: "77"
    });
    assert.equal(result.status, 0, result.stderr);
    assertPayloadStatus(result, { type: "platform-sync", status: "pass" });
  })
));

test("validate-artifact platform-sync fails for complete-manual-validation when PR summary lacks the passed heading", () => (
  withTempRoot("agent-infra-platform-sync-manual-validation-fail-", (tempRoot) => {
    const ctx = setupPlatformSyncEnv(tempRoot);
    const taskContent = buildTaskContent({
      issue_number: "65",
      pr_number: "77"
    });
    write(path.join(ctx.taskDir, "task.md"), taskContent);
    writeJson(ctx.issuePath, buildIssuePayload({ labels: [], body: "# Issue\n" }));
    writeJson(ctx.commentsPath, [{ body: buildTaskComment(taskId, taskContent) }]);
    writeJson(ctx.prCommentsPath, [{
      body: [
        "<!-- sync-pr:TASK-20260328-000001:summary -->",
        "## Review Summary",
        "",
        "### ⚠️ 需人工校验",
        "",
        "- staging smoke"
      ].join("\n")
    }]);

    const result = runValidatorWithFakeGh([
      "check",
      "platform-sync",
      ctx.taskDir,
      "--skill",
      "complete-manual-validation"
    ], ctx, {
      GH_FAKE_ISSUE_PATH: ctx.issuePath,
      GH_FAKE_COMMENTS_PATH: ctx.commentsPath,
      GH_FAKE_PR_COMMENTS_PATH: ctx.prCommentsPath,
      GH_FAKE_ISSUE_NUMBER: "65",
      GH_FAKE_PR_NUMBER: "77"
    });
    assert.equal(result.status, 1);
    assertPayloadStatus(result, {
      type: "platform-sync",
      status: "fail",
      message: /missing required pattern/
    });
  })
));

const commitCases = [
  {
    name: "validate-artifact platform-sync skips for commit when task has no pr_number",
    taskOverrides: { issue_number: "65" },
    useFakeGh: false,
    expectedStatus: 0,
    assertMessage: "Skipped: task has no pr_number"
  },
  {
    name: "validate-artifact platform-sync passes for commit when summary comment exists on the PR",
    setupHead: true,
    prComments(sha: string) {
      return [{ body: summaryCommentWithSha(sha) }];
    },
    expectedStatus: 0
  },
  {
    name: "validate-artifact platform-sync fails for commit when summary comment last-commit metadata mismatches HEAD",
    setupHead: true,
    prComments() {
      return [{ body: "<!-- sync-pr:TASK-20260328-000001:summary -->\n<!-- last-commit: deadbee -->\n## Review Summary\n\nLooks good." }];
    },
    expectedStatus: 1,
    message: /last-commit metadata mismatch/
  },
  {
    name: "validate-artifact platform-sync fails for commit when summary comment last-commit metadata is missing",
    setupHead: true,
    prComments() {
      return [{ body: summaryComment }];
    },
    expectedStatus: 1,
    message: /missing '<!-- last-commit: <sha> -->' metadata/
  },
  {
    name: "validate-artifact platform-sync fails for commit when summary comment is missing on the PR",
    prComments() {
      return [];
    },
    expectedStatus: 1,
    message: /Expected PR comment marker/
  }
];

for (const c of commitCases) {
  test(c.name, () => withTempRoot("agent-infra-platform-sync-commit-", (tempRoot) => {
    const ctx = setupPlatformSyncEnv(tempRoot);
    const headSha = c.setupHead ? createHeadCommit(tempRoot) : "";
    write(path.join(ctx.taskDir, "task.md"), buildTaskContent({
      issue_number: "65",
      ...(c.useFakeGh === false ? {} : { pr_number: "77" }),
      ...c.taskOverrides
    }));
    if (c.useFakeGh !== false) {
      writeJson(ctx.issuePath, buildIssuePayload({ labels: [], body: "# Issue\n" }));
      writeJson(ctx.prCommentsPath, c.prComments?.(headSha) || []);
    }

    const result = c.useFakeGh === false
      ? runValidator(["check", "platform-sync", ctx.taskDir, "--skill", "commit"])
      : runValidatorWithFakeGh(["check", "platform-sync", ctx.taskDir, "--skill", "commit"], ctx, {
          GH_FAKE_ISSUE_PATH: ctx.issuePath,
          GH_FAKE_PR_COMMENTS_PATH: ctx.prCommentsPath,
          GH_FAKE_ISSUE_NUMBER: "65",
          GH_FAKE_PR_NUMBER: "77"
        });
    assert.equal(result.status, c.expectedStatus, result.stderr);
    const payload = assertPayloadStatus(result, {
      type: "platform-sync",
      status: c.expectedStatus === 0 ? "pass" : "fail"
    });
    if (c.assertMessage) {
      assert.equal(payload.message, c.assertMessage);
    }
    if (c.message) {
      assert.match(payload.message, c.message);
    }
  }));
}

test("validate-artifact platform-sync passes for commit with last-commit from task branch worktree", () => (
  withTempRoot("agent-infra-platform-sync-commit-worktree-pass-", (tempRoot) => {
    const ctx = setupPlatformSyncEnv(tempRoot);
    const branch = "agent-infra-feature-pr";
    const worktreePath = path.join(tempRoot, "sandbox-worktree");
    const mainSha = createHeadCommit(tempRoot);
    addWorktree(tempRoot, worktreePath, branch);
    const prSha = commitInWorktree(worktreePath, "sandbox commit");
    assert.notEqual(prSha, mainSha);
    write(path.join(ctx.taskDir, "task.md"), buildTaskContent({ branch, issue_number: "65", pr_number: "77" }));
    writeJson(ctx.issuePath, buildIssuePayload({ labels: [], body: "# Issue\n" }));
    writeJson(ctx.prCommentsPath, [{ body: summaryCommentWithSha(prSha) }]);

    const result = runValidatorWithFakeGh(["check", "platform-sync", ctx.taskDir, "--skill", "commit"], ctx, {
      GH_FAKE_ISSUE_PATH: ctx.issuePath,
      GH_FAKE_PR_COMMENTS_PATH: ctx.prCommentsPath,
      GH_FAKE_ISSUE_NUMBER: "65",
      GH_FAKE_PR_NUMBER: "77",
      GH_FAKE_PR_HEAD_SHA: prSha
    });
    assert.equal(result.status, 0, result.stderr);
    assertPayloadStatus(result, { type: "platform-sync", status: "pass" });
  })
));

test("validate-artifact platform-sync falls back to taskDir HEAD when task branch is missing", () => (
  withTempRoot("agent-infra-platform-sync-commit-no-branch-", (tempRoot) => {
    const ctx = setupPlatformSyncEnv(tempRoot);
    const mainSha = createHeadCommit(tempRoot);
    write(path.join(ctx.taskDir, "task.md"), buildTaskContent({ issue_number: "65", pr_number: "77" }));
    writeJson(ctx.issuePath, buildIssuePayload({ labels: [], body: "# Issue\n" }));
    writeJson(ctx.prCommentsPath, [{ body: summaryCommentWithSha(mainSha) }]);

    const result = runValidatorWithFakeGh(["check", "platform-sync", ctx.taskDir, "--skill", "commit"], ctx, {
      GH_FAKE_ISSUE_PATH: ctx.issuePath,
      GH_FAKE_PR_COMMENTS_PATH: ctx.prCommentsPath,
      GH_FAKE_ISSUE_NUMBER: "65",
      GH_FAKE_PR_NUMBER: "77"
    });
    assert.equal(result.status, 0, result.stderr);
    assertPayloadStatus(result, { type: "platform-sync", status: "pass" });
  })
));

test("validate-artifact platform-sync falls back to taskDir HEAD when task branch worktree is unmatched", () => (
  withTempRoot("agent-infra-platform-sync-commit-unmatched-branch-", (tempRoot) => {
    const ctx = setupPlatformSyncEnv(tempRoot);
    const mainSha = createHeadCommit(tempRoot);
    write(path.join(ctx.taskDir, "task.md"), buildTaskContent({
      branch: "agent-infra-feature-missing",
      issue_number: "65",
      pr_number: "77"
    }));
    writeJson(ctx.issuePath, buildIssuePayload({ labels: [], body: "# Issue\n" }));
    writeJson(ctx.prCommentsPath, [{ body: summaryCommentWithSha(mainSha) }]);

    const result = runValidatorWithFakeGh(["check", "platform-sync", ctx.taskDir, "--skill", "commit"], ctx, {
      GH_FAKE_ISSUE_PATH: ctx.issuePath,
      GH_FAKE_PR_COMMENTS_PATH: ctx.prCommentsPath,
      GH_FAKE_ISSUE_NUMBER: "65",
      GH_FAKE_PR_NUMBER: "77"
    });
    assert.equal(result.status, 0, result.stderr);
    assertPayloadStatus(result, { type: "platform-sync", status: "pass" });
  })
));

test("validate-artifact platform-sync blocks after retry exhaustion on gh network errors", () => (
  withTempRoot("agent-infra-gate-blocked-", (tempRoot) => {
    const taskDir = path.join(tempRoot, taskId);
    const binDir = path.join(tempRoot, "bin");
    const ghPath = path.join(binDir, "gh");
    write(path.join(taskDir, "task.md"), buildTaskContent({ issue_number: "65" }));
    write(path.join(taskDir, "code.md"), loadFixture("valid-code.md"));
    write(ghPath, "#!/bin/sh\necho 'network timeout' >&2\nexit 1\n");
    fs.chmodSync(ghPath, 0o755);

    const result = runValidator(["gate", "code-task", taskDir, "code.md"], {
      env: {
        PATH: pathWithPrependedBin(binDir),
        AGENT_INFRA_PLATFORM_RETRY_DELAYS_MS: "0,0"
      }
    });
    assert.equal(result.status, 2);
    const payload = parseValidatorPayload(result.stdout);
    assert.equal(payload.gate, "blocked");
    const githubCheck = payload.checks.find((check) => check.type === "platform-sync");
    if (!githubCheck) {
      throw new Error("expected platform-sync check");
    }
    assert.equal(githubCheck.status, "blocked");
    assert.equal(githubCheck.fail_type, "network_error");
  })
));

const retryCases = [
  {
    name: "validate-artifact platform-sync retries upstream repo lookup on transient gh failure",
    prefix: "agent-infra-platform-sync-retry-upstream-",
    matcher: "api repos/fitlab-ai/agent-infra"
  },
  {
    name: "validate-artifact platform-sync retries capability context lookup on transient gh failure",
    prefix: "agent-infra-platform-sync-retry-permissions-",
    matcher: "api repos/fitlab-ai/agent-infra"
  }
];

for (const c of retryCases) {
  test(c.name, () => withTempRoot(c.prefix, (tempRoot) => {
    const ctx = setupPlatformSyncEnv(tempRoot);
    const counterPath = path.join(tempRoot, "transient.count");
    const taskContent = buildTaskContent({ issue_number: "65" });
    const artifactContent = loadFixture("valid-code.md");
    write(path.join(ctx.taskDir, "task.md"), taskContent);
    write(path.join(ctx.taskDir, "code.md"), artifactContent);
    writeJson(ctx.issuePath, buildIssuePayload());
    writeJson(ctx.commentsPath, [
      { body: buildArtifactComment(taskId, "code.md", "实现报告", artifactContent) },
      { body: buildTaskComment(taskId, taskContent) }
    ]);
    write(counterPath, "1");

    const result = runValidatorWithFakeGh(["gate", "code-task", ctx.taskDir, "code.md"], ctx, {
      GH_FAKE_ISSUE_PATH: ctx.issuePath,
      GH_FAKE_COMMENTS_PATH: ctx.commentsPath,
      GH_FAKE_TRANSIENT_FAIL_MATCHER: c.matcher,
      GH_FAKE_TRANSIENT_FAIL_COUNTER_FILE: counterPath,
      AGENT_INFRA_PLATFORM_RETRY_DELAYS_MS: "0,0"
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(counterPath, "utf8").trim(), "0");
    assert.equal(parseValidatorPayload(result.stdout).gate, "pass");
  }));
}

test("platform-sync rejects status labels on closed issues without triage permission", async () => (
  withTempRoot("agent-infra-platform-sync-closed-status-", async (tempRoot) => {
    const ctx = setupPlatformSyncEnv(tempRoot);
    write(path.join(ctx.taskDir, "task.md"), buildTaskContent({ issue_number: "65" }));
    writeJson(ctx.issuePath, buildIssuePayload({
      state: "CLOSED",
      labels: [{ name: "status: in-progress" }, { name: "priority: high" }]
    }));

    const result = await runPlatformSyncAdapter(ctx.taskDir, {
      when: "issue_number_exists",
      verify_closed_issue_has_no_status_labels: true
    }, {
      PATH: pathWithPrependedBin(ctx.binDir),
      AGENT_INFRA_GH_BIN: process.execPath,
      AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([ctx.ghPath]),
      GH_FAKE_ISSUE_PATH: ctx.issuePath,
      GH_FAKE_PERMISSIONS: JSON.stringify({ triage: false, push: false })
    });

    assert.equal(result.status, "fail");
    assert.equal(result.fail_type, "check_failed");
    assert.match(result.message, /status: in-progress/);
  })
));

for (const issuePayload of [
  buildIssuePayload({ state: "CLOSED", labels: [{ name: "priority: high" }] }),
  buildIssuePayload({ state: "OPEN", labels: [{ name: "status: in-progress" }] })
]) {
  test(`platform-sync accepts lifecycle status state for ${issuePayload.state.toLowerCase()} issues`, async () => (
    withTempRoot("agent-infra-platform-sync-valid-status-", async (tempRoot) => {
      const ctx = setupPlatformSyncEnv(tempRoot);
      write(path.join(ctx.taskDir, "task.md"), buildTaskContent({ issue_number: "65" }));
      writeJson(ctx.issuePath, issuePayload);

      const result = await runPlatformSyncAdapter(ctx.taskDir, {
        when: "issue_number_exists",
        verify_closed_issue_has_no_status_labels: true
      }, {
        PATH: pathWithPrependedBin(ctx.binDir),
        AGENT_INFRA_GH_BIN: process.execPath,
        AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([ctx.ghPath]),
        GH_FAKE_ISSUE_PATH: ctx.issuePath
      });

      assert.equal(result.status, "pass");
    })
  ));
}
