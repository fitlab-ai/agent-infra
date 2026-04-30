import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  filePath,
  exists,
  gitSafeEnv,
  initIsolatedGitRepo,
  pathWithPrependedBin,
  read,
  writeNodeCommandShim
} from "../helpers.js";

const scriptPath = filePath(".agents/scripts/validate-artifact.js");
const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffsetMinutes / 60);
  const offsetRemainderMinutes = absoluteOffsetMinutes % 60;

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + " " + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(":") + `${sign}${pad(offsetHours)}:${pad(offsetRemainderMinutes)}`;
}

function formatTimestampInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value])
  );

  const offsetPart = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset"
  }).formatToParts(date).find(({ type }) => type === "timeZoneName")?.value;
  const normalizedOffset = offsetPart === "GMT" ? "+00:00" : offsetPart?.replace("GMT", "") || "+00:00";

  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}${normalizedOffset}`;
}

function write(filePathname, content) {
  fs.mkdirSync(path.dirname(filePathname), { recursive: true });
  fs.writeFileSync(filePathname, content, "utf8");
}

function writeJson(filePathname, value) {
  write(filePathname, JSON.stringify(value));
}

function buildTaskFrontmatter(overrides = {}) {
  const now = new Date();
  const metadata = {
    id: "TASK-20260328-000001",
    type: "refactor",
    workflow: "refactoring",
    status: "active",
    created_at: formatTimestamp(new Date(now.getTime() - 60_000)),
    updated_at: formatTimestamp(now),
    issue_number: "N/A",
    created_by: "human",
    current_step: "implementation",
    assigned_to: "codex",
    ...overrides
  };

  return [
    "---",
    ...Object.entries(metadata).map(([key, value]) => `${key}: ${value}`),
    "---"
  ].join("\n");
}

function loadFixture(name, replacements = {}) {
  let content = read(path.join("tests/fixtures/validate-artifact", name));

  for (const [key, value] of Object.entries(replacements)) {
    content = content.split(`{{${key}}}`).join(value);
  }

  return content;
}

function buildTaskContent(overrides = {}, replacements = {}) {
  return loadFixture("valid-task.md", {
    FRONTMATTER: buildTaskFrontmatter(overrides),
    NOW: formatTimestamp(new Date()),
    ...replacements
  });
}

function buildCompletedTaskContent(checklistLines, overrides = {}) {
  const now = formatTimestamp(new Date());
  return [
    buildTaskFrontmatter({
      status: "completed",
      current_step: "commit",
      completed_at: now,
      updated_at: now,
      ...overrides
    }),
    "",
    "# 任务：完成任务校验",
    "",
    "## 需求",
    "",
    "- [x] 保留最新验证输出",
    "",
    "## 活动日志",
    "",
    `- ${now} — **Completed** by codex — Task archived to completed/`,
    "",
    "## 完成检查清单",
    "",
    ...checklistLines
  ].join("\n");
}

function runValidator(args, options = {}) {
  const env = gitSafeEnv(options.env);
  if (env.PATH) {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "path") {
        env[key] = env.PATH;
      }
    }
  }

  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    cwd: filePath("."),
    env
  });
}

function writeFakeGh(filePathname) {
  write(filePathname, loadFixture("fake-gh.js"));
  if (process.platform === "win32") {
    writeNodeCommandShim(filePathname, filePathname);
  } else {
    fs.chmodSync(filePathname, 0o755);
  }
}

function buildArtifactMarker(taskId, artifactFile) {
  return `<!-- sync-issue:${taskId}:${path.basename(artifactFile, path.extname(artifactFile))} -->`;
}

function buildArtifactComment(taskId, artifactFile, title, body) {
  return loadFixture("artifact-comment.md", {
    MARKER: buildArtifactMarker(taskId, artifactFile),
    TITLE: title,
    BODY: body.trim(),
    TASK_ID: taskId,
    AGENT: "codex"
  });
}

function buildTaskComment(taskId, taskContent, options = {}) {
  const match = taskContent.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const body = match ? taskContent.slice(match[0].length).trim() : taskContent.trim();
  const summaryText = options.summaryText || "元数据 (frontmatter)";
  const detailsBlock = match
    ? [
        `<details><summary>${summaryText}</summary>`,
        "",
        "```yaml",
        match[0].trim(),
        "```",
        "",
        "</details>"
      ].join("\n")
    : "";
  const renderedBody = options.rawBody
    ? taskContent.trim()
    : [detailsBlock, body].filter(Boolean).join("\n\n");

  return loadFixture("task-comment.md", {
    TASK_ID: taskId,
    AGENT: "codex",
    BODY: renderedBody
  });
}

function buildMilestone(title = "Sprint 24") {
  return { title };
}

function buildIssueType(name = "Task") {
  return { name };
}

function buildIssuePayload(overrides = {}) {
  return {
    state: "OPEN",
    labels: [{ name: "status: in-progress" }],
    body: "# Issue\n\n- [x] 保留最新验证输出\n",
    milestone: buildMilestone(),
    type: buildIssueType(),
    ...overrides
  };
}

function buildPrPayload(overrides = {}) {
  return {
    labels: [],
    milestone: buildMilestone(),
    assignees: [{ login: "test-user" }],
    ...overrides
  };
}

function assertPointsToPrSyncRule(filePathname) {
  const content = read(filePathname);
  assert.match(content, /`\.agents\/rules\/pr-sync\.md`/);
}

function assertHasCanonicalPrSyncStructure(filePathname, headings) {
  const content = read(filePathname);
  assert.match(content, /<!-- sync-pr:\{task-id\}:summary -->/);
  assert.match(content, /<!-- last-commit: \{git-head-sha\} -->/);
  for (const heading of headings) {
    assert.match(content, heading);
  }
}

function createHeadCommit(repoRoot) {
  const env = gitSafeEnv();
  const emailResult = spawnSync("git", ["config", "user.email", "codex@example.com"], {
    cwd: repoRoot,
    encoding: "utf8",
    env
  });
  assert.equal(emailResult.status, 0, emailResult.stderr);

  const nameResult = spawnSync("git", ["config", "user.name", "Codex"], {
    cwd: repoRoot,
    encoding: "utf8",
    env
  });
  assert.equal(nameResult.status, 0, nameResult.stderr);

  write(path.join(repoRoot, "README.md"), "# temp\n");

  const addResult = spawnSync("git", ["add", "README.md"], {
    cwd: repoRoot,
    encoding: "utf8",
    env
  });
  assert.equal(addResult.status, 0, addResult.stderr);

  const commitResult = spawnSync("git", ["commit", "-qm", "test commit"], {
    cwd: repoRoot,
    encoding: "utf8",
    env
  });
  assert.equal(commitResult.status, 0, commitResult.stderr);

  const revParseResult = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    env
  });
  assert.equal(revParseResult.status, 0, revParseResult.stderr);

  return revParseResult.stdout.trim();
}

function addWorktree(repoRoot, worktreePath, branch) {
  const result = spawnSync("git", ["worktree", "add", worktreePath, "-b", branch], {
    cwd: repoRoot,
    encoding: "utf8",
    env: gitSafeEnv()
  });
  assert.equal(result.status, 0, result.stderr);
}

function commitInWorktree(worktreePath, message) {
  const commitResult = spawnSync("git", ["commit", "--allow-empty", "-qm", message], {
    cwd: worktreePath,
    encoding: "utf8",
    env: gitSafeEnv()
  });
  assert.equal(commitResult.status, 0, commitResult.stderr);

  const revParseResult = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: worktreePath,
    encoding: "utf8",
    env: gitSafeEnv()
  });
  assert.equal(revParseResult.status, 0, revParseResult.stderr);

  return revParseResult.stdout.trim();
}

test("validate-artifact gate passes for implement-task with fresh task and artifact", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gate-pass-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");

  try {
    write(path.join(taskDir, "task.md"), buildTaskContent());
    write(path.join(taskDir, "implementation.md"), loadFixture("valid-implementation.md"));

    const result = runValidator(["gate", "implement-task", taskDir, "implementation.md"]);
    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.gate, "pass");
    assert.equal(payload.checks.length, 4);
    assert.deepEqual(
      payload.checks.map((check) => check.status),
      ["pass", "pass", "pass", "pass"]
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact gate supports human-readable text output", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gate-text-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");

  try {
    write(path.join(taskDir, "task.md"), buildTaskContent());
    write(path.join(taskDir, "implementation.md"), loadFixture("valid-implementation.md"));

    const result = runValidator([
      "gate",
      "implement-task",
      taskDir,
      "implementation.md",
      "--format",
      "text"
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Verification: pass \| Skill: implement-task$/m);
    assert.match(result.stdout, /^\s+\[pass\] task-meta - /m);
    assert.match(result.stdout, /^\s+\[pass\] artifact - /m);
    assert.match(result.stdout, /^Result: 4 passed, 0 failed - All declared checks passed$/m);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact create-task task-meta accepts a generated branch", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-create-task-branch-pass-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");

  try {
    write(path.join(taskDir, "task.md"), [
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
      `- ${formatTimestamp(new Date())} — **Task Created** by codex — Task created from description`
    ].join("\n"));

    const result = runValidator(["check", "task-meta", taskDir, "--skill", "create-task"]);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact create-task task-meta rejects invalid branch naming", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-create-task-branch-fail-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");

  try {
    write(path.join(taskDir, "task.md"), [
      buildTaskFrontmatter({
        branch: "wrong-prefix-feature-cli-generic-sandbox",
        current_step: "requirement-analysis"
      }),
      "",
      "# 任务：创建任务"
    ].join("\n"));

    const result = runValidator(["check", "task-meta", taskDir, "--skill", "create-task"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Invalid branch/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact artifact check fails when a required section is missing", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gate-fail-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");

  try {
    write(path.join(taskDir, "task.md"), buildTaskContent());
    write(path.join(taskDir, "implementation.md"), loadFixture("missing-section-implementation.md"));

    const result = runValidator(["check", "artifact", taskDir, "implementation.md", "--skill", "implement-task"]);
    assert.equal(result.status, 1);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "artifact");
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /missing sections/i);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact activity-log freshness uses local timestamps", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gate-stale-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");

  try {
    const staleTimestamp = formatTimestampInTimeZone(new Date(Date.now() - 45 * 60_000), localTimeZone);
    const staleTask = buildTaskContent(
      { updated_at: staleTimestamp },
      { NOW: staleTimestamp }
    );

    write(path.join(taskDir, "task.md"), staleTask);
    write(path.join(taskDir, "implementation.md"), loadFixture("valid-implementation.md"));

    const result = runValidator(["check", "activity-log", taskDir, "--skill", "implement-task"], {
      env: {
        TZ: localTimeZone
      }
    });

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "activity-log");
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /stale/i);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact task-meta supports cancel-task cancelled_at requirements", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-cancel-task-meta-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const cancelledAt = formatTimestamp(new Date());

  try {
    write(path.join(taskDir, "task.md"), buildTaskContent({
      status: "completed",
      cancelled_at: cancelledAt,
      cancel_reason: "No longer needed after investigation"
    }, {
      NOW: cancelledAt
    }));

    const result = runValidator(["check", "task-meta", taskDir, "--skill", "cancel-task"]);
    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "task-meta");
    assert.equal(payload.status, "pass");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact gate passes for complete-task when completion checklist is fully checked", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-complete-task-pass-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");

  try {
    write(path.join(taskDir, "task.md"), buildCompletedTaskContent([
      "- [x] 所有需求已满足",
      "- [x] 测试已编写并通过",
      "- [x] 代码已审查",
      "- [x] 文档已更新（如适用）",
      "- [x] PR 已创建"
    ]));

    const result = runValidator(["gate", "complete-task", taskDir]);
    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.gate, "pass");
    assert.deepEqual(
      payload.checks.map((check) => check.type),
      ["task-meta", "activity-log", "completion-checklist", "platform-sync"]
    );
    assert.deepEqual(
      payload.checks.map((check) => check.status),
      ["pass", "pass", "pass", "pass"]
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact completion-checklist fails when a complete-task item is unchecked", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-complete-task-checklist-fail-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");

  try {
    write(path.join(taskDir, "task.md"), buildCompletedTaskContent([
      "- [x] 所有需求已满足",
      "- [ ] 测试已编写并通过",
      "- [x] 代码已审查"
    ]));

    const result = runValidator(["check", "completion-checklist", taskDir, "--skill", "complete-task"]);
    assert.equal(result.status, 1, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "completion-checklist");
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /Completion Checklist has unchecked items: 测试已编写并通过/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact platform-sync blocks after retry exhaustion on gh network errors", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gate-blocked-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const binDir = path.join(tempRoot, "bin");
  const ghPath = path.join(binDir, "gh");

  try {
    write(
      path.join(taskDir, "task.md"),
      buildTaskContent({ issue_number: "65" })
    );
    write(path.join(taskDir, "implementation.md"), loadFixture("valid-implementation.md"));
    write(
      ghPath,
      "#!/bin/sh\n" +
        "echo 'network timeout' >&2\n" +
        "exit 1\n"
    );
    fs.chmodSync(ghPath, 0o755);

    const result = runValidator(["gate", "implement-task", taskDir, "implementation.md"], {
      env: {
        PATH: pathWithPrependedBin(binDir),
        VALIDATE_ARTIFACT_RETRY_DELAYS_MS: "0,0"
      }
    });

    assert.equal(result.status, 2);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.gate, "blocked");
    const githubCheck = payload.checks.find((check) => check.type === "platform-sync");
    assert.equal(githubCheck.status, "blocked");
    assert.equal(githubCheck.fail_type, "network_error");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact platform-sync skips when no platform adapter is registered", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-platform-sync-skip-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const scriptCopy = path.join(tempRoot, ".agents/scripts/validate-artifact.js");
  const verifyCopy = path.join(tempRoot, ".agents/skills/implement-task/config/verify.json");

  try {
    write(path.join(tempRoot, "package.json"), JSON.stringify({ type: "module" }, null, 2));
    write(scriptCopy, read(".agents/scripts/validate-artifact.js"));
    write(verifyCopy, read(".agents/skills/implement-task/config/verify.json"));
    write(path.join(taskDir, "task.md"), buildTaskContent({ issue_number: "65" }));
    write(path.join(taskDir, "implementation.md"), loadFixture("valid-implementation.md"));

    const result = spawnSync(
      process.execPath,
      [scriptCopy, "check", "platform-sync", taskDir, "implementation.md", "--skill", "implement-task"],
      {
        encoding: "utf8",
        cwd: tempRoot,
        env: process.env
      }
    );

    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "platform-sync");
    assert.equal(payload.status, "pass");
    assert.equal(payload.message, "Skipped: no platform adapter registered for 'platform-sync'");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact gate passes when synced artifact and task comments match local files", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-platform-sync-pass-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const binDir = path.join(tempRoot, "bin");
  const ghPath = path.join(binDir, "gh");
  const issuePath = path.join(tempRoot, "issue.json");
  const commentsPath = path.join(tempRoot, "comments.json");

  try {
    initIsolatedGitRepo(tempRoot, { remote: "git@github.com:fitlab-ai/agent-infra.git" });
    writeFakeGh(ghPath);

    const taskContent = buildTaskContent({ issue_number: "65" });
    const artifactContent = loadFixture("valid-implementation.md");

    write(path.join(taskDir, "task.md"), taskContent);
    write(path.join(taskDir, "implementation.md"), artifactContent);
    writeJson(issuePath, buildIssuePayload());
    writeJson(commentsPath, [
      { body: buildArtifactComment("TASK-20260328-000001", "implementation.md", "实现报告", artifactContent) },
      { body: buildTaskComment("TASK-20260328-000001", taskContent) }
    ]);

    const result = runValidator(["gate", "implement-task", taskDir, "implementation.md"], {
      env: {
        PATH: pathWithPrependedBin(binDir),
        GH_FAKE_ISSUE_PATH: issuePath,
        GH_FAKE_COMMENTS_PATH: commentsPath
      }
    });

    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.gate, "pass");
    assert.deepEqual(
      payload.checks.map((check) => check.status),
      ["pass", "pass", "pass", "pass"]
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact platform-sync fails when artifact comment content differs from the local artifact", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-platform-sync-artifact-mismatch-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const binDir = path.join(tempRoot, "bin");
  const ghPath = path.join(binDir, "gh");
  const issuePath = path.join(tempRoot, "issue.json");
  const commentsPath = path.join(tempRoot, "comments.json");

  try {
    initIsolatedGitRepo(tempRoot, { remote: "git@github.com:fitlab-ai/agent-infra.git" });
    writeFakeGh(ghPath);

    const taskContent = buildTaskContent({ issue_number: "65" });
    const artifactContent = loadFixture("valid-implementation.md");

    write(path.join(taskDir, "task.md"), taskContent);
    write(path.join(taskDir, "implementation.md"), artifactContent);
    writeJson(issuePath, buildIssuePayload());
    writeJson(commentsPath, [
      { body: buildArtifactComment("TASK-20260328-000001", "implementation.md", "实现报告", "# 摘要\n\n这不是原文。") },
      { body: buildTaskComment("TASK-20260328-000001", taskContent) }
    ]);

    const result = runValidator([
      "check",
      "platform-sync",
      taskDir,
      "implementation.md",
      "--skill",
      "implement-task"
    ], {
      env: {
        PATH: pathWithPrependedBin(binDir),
        GH_FAKE_ISSUE_PATH: issuePath,
        GH_FAKE_COMMENTS_PATH: commentsPath
      }
    });

    assert.equal(result.status, 1);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "platform-sync");
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /Comment content mismatch for 'implementation'/);
    assert.match(payload.message, /first difference near char \d+/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact platform-sync fails when the task comment does not use the rendered frontmatter details block", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-platform-sync-task-mismatch-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const binDir = path.join(tempRoot, "bin");
  const ghPath = path.join(binDir, "gh");
  const issuePath = path.join(tempRoot, "issue.json");
  const commentsPath = path.join(tempRoot, "comments.json");

  try {
    initIsolatedGitRepo(tempRoot, { remote: "git@github.com:fitlab-ai/agent-infra.git" });
    writeFakeGh(ghPath);

    const taskContent = buildTaskContent({ issue_number: "65" });
    const artifactContent = loadFixture("valid-implementation.md");

    write(path.join(taskDir, "task.md"), taskContent);
    write(path.join(taskDir, "implementation.md"), artifactContent);
    writeJson(issuePath, buildIssuePayload());
    writeJson(commentsPath, [
      { body: buildArtifactComment("TASK-20260328-000001", "implementation.md", "实现报告", artifactContent) },
      { body: buildTaskComment("TASK-20260328-000001", taskContent, { rawBody: true }) }
    ]);

    const result = runValidator([
      "check",
      "platform-sync",
      taskDir,
      "implementation.md",
      "--skill",
      "implement-task"
    ], {
      env: {
        PATH: pathWithPrependedBin(binDir),
        GH_FAKE_ISSUE_PATH: issuePath,
        GH_FAKE_COMMENTS_PATH: commentsPath
      }
    });

    assert.equal(result.status, 1);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "platform-sync");
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /Comment content mismatch for 'task'/);
    assert.match(payload.message, /line \d+, column \d+/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact platform-sync fails when the Issue Type does not match task type", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-platform-sync-issue-type-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const binDir = path.join(tempRoot, "bin");
  const ghPath = path.join(binDir, "gh");
  const issuePath = path.join(tempRoot, "issue.json");
  const commentsPath = path.join(tempRoot, "comments.json");

  try {
    initIsolatedGitRepo(tempRoot, { remote: "git@github.com:fitlab-ai/agent-infra.git" });
    writeFakeGh(ghPath);

    const taskContent = buildTaskContent({ issue_number: "65", type: "feature" });
    const artifactContent = loadFixture("valid-implementation.md");

    write(path.join(taskDir, "task.md"), taskContent);
    write(path.join(taskDir, "implementation.md"), artifactContent);
    writeJson(issuePath, buildIssuePayload({
      type: buildIssueType("Task")
    }));
    writeJson(commentsPath, [
      { body: buildArtifactComment("TASK-20260328-000001", "implementation.md", "实现报告", artifactContent) },
      { body: buildTaskComment("TASK-20260328-000001", taskContent) }
    ]);

    const result = runValidator([
      "check",
      "platform-sync",
      taskDir,
      "implementation.md",
      "--skill",
      "implement-task"
    ], {
      env: {
        PATH: pathWithPrependedBin(binDir),
        GH_FAKE_ISSUE_PATH: issuePath,
        GH_FAKE_COMMENTS_PATH: commentsPath
      }
    });

    assert.equal(result.status, 1);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "platform-sync");
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /has type 'Task', expected 'Feature'/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact platform-sync skips Issue Type verification when the REST query is unavailable", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-platform-sync-issue-type-skip-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const binDir = path.join(tempRoot, "bin");
  const ghPath = path.join(binDir, "gh");
  const issuePath = path.join(tempRoot, "issue.json");
  const commentsPath = path.join(tempRoot, "comments.json");

  try {
    initIsolatedGitRepo(tempRoot, { remote: "git@github.com:fitlab-ai/agent-infra.git" });
    writeFakeGh(ghPath);

    const taskContent = buildTaskContent({ issue_number: "65" });
    const artifactContent = loadFixture("valid-implementation.md");

    write(path.join(taskDir, "task.md"), taskContent);
    write(path.join(taskDir, "implementation.md"), artifactContent);
    writeJson(issuePath, buildIssuePayload());
    writeJson(commentsPath, [
      { body: buildArtifactComment("TASK-20260328-000001", "implementation.md", "实现报告", artifactContent) },
      { body: buildTaskComment("TASK-20260328-000001", taskContent) }
    ]);

    const result = runValidator([
      "check",
      "platform-sync",
      taskDir,
      "implementation.md",
      "--skill",
      "implement-task"
    ], {
      env: {
        PATH: pathWithPrependedBin(binDir),
        GH_FAKE_ISSUE_PATH: issuePath,
        GH_FAKE_COMMENTS_PATH: commentsPath,
        GH_FAKE_ISSUE_REST_FAIL: "Issue Types are unavailable",
        VALIDATE_ARTIFACT_RETRY_DELAYS_MS: "0,0"
      }
    });

    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "platform-sync");
    assert.equal(payload.status, "pass");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact platform-sync accepts English task frontmatter summary when language override is en", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-platform-sync-task-en-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const binDir = path.join(tempRoot, "bin");
  const ghPath = path.join(binDir, "gh");
  const issuePath = path.join(tempRoot, "issue.json");
  const commentsPath = path.join(tempRoot, "comments.json");

  try {
    initIsolatedGitRepo(tempRoot, { remote: "git@github.com:fitlab-ai/agent-infra.git" });
    writeFakeGh(ghPath);

    const taskContent = buildTaskContent({ issue_number: "65" });
    const artifactContent = loadFixture("valid-implementation.md");

    write(path.join(taskDir, "task.md"), taskContent);
    write(path.join(taskDir, "implementation.md"), artifactContent);
    writeJson(issuePath, buildIssuePayload());
    writeJson(commentsPath, [
      { body: buildArtifactComment("TASK-20260328-000001", "implementation.md", "Implementation Report", artifactContent) },
      { body: buildTaskComment("TASK-20260328-000001", taskContent, { summaryText: "Metadata (frontmatter)" }) }
    ]);

    const result = runValidator([
      "check",
      "platform-sync",
      taskDir,
      "implementation.md",
      "--skill",
      "implement-task"
    ], {
      env: {
        PATH: pathWithPrependedBin(binDir),
        GH_FAKE_ISSUE_PATH: issuePath,
        GH_FAKE_COMMENTS_PATH: commentsPath,
        VALIDATE_ARTIFACT_LANGUAGE: "en"
      }
    });

    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "platform-sync");
    assert.equal(payload.status, "pass");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact platform-sync fails when create-pr milestone is missing", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-platform-sync-pr-milestone-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const binDir = path.join(tempRoot, "bin");
  const ghPath = path.join(binDir, "gh");
  const issuePath = path.join(tempRoot, "issue.json");
  const prPath = path.join(tempRoot, "pr.json");
  const prCommentsPath = path.join(tempRoot, "pr-comments.json");

  try {
    initIsolatedGitRepo(tempRoot, { remote: "git@github.com:fitlab-ai/agent-infra.git" });
    writeFakeGh(ghPath);

    write(path.join(taskDir, "task.md"), buildTaskContent({ issue_number: "65", pr_number: "77" }));
    writeJson(issuePath, buildIssuePayload({
      labels: [],
      body: "# Issue\n"
    }));
    writeJson(prPath, buildPrPayload({
      labels: [{ name: "type: enhancement" }],
      milestone: null
    }));
    writeJson(prCommentsPath, [
      { body: "<!-- sync-pr:TASK-20260328-000001:summary -->\n## Review Summary\n\nLooks good." }
    ]);

    const result = runValidator([
      "check",
      "platform-sync",
      taskDir,
      "--skill",
      "create-pr"
    ], {
      env: {
        PATH: pathWithPrependedBin(binDir),
        GH_FAKE_ISSUE_PATH: issuePath,
        GH_FAKE_PR_PATH: prPath,
        GH_FAKE_PR_COMMENTS_PATH: prCommentsPath,
        GH_FAKE_ISSUE_NUMBER: "65",
        GH_FAKE_PR_NUMBER: "77"
      }
    });

    assert.equal(result.status, 1);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "platform-sync");
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /PR #77 has no milestone set/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact platform-sync fails when PR and Issue in: labels diverge", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-platform-sync-in-labels-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const binDir = path.join(tempRoot, "bin");
  const ghPath = path.join(binDir, "gh");
  const issuePath = path.join(tempRoot, "issue.json");
  const prPath = path.join(tempRoot, "pr.json");
  const prCommentsPath = path.join(tempRoot, "pr-comments.json");

  try {
    initIsolatedGitRepo(tempRoot, { remote: "git@github.com:fitlab-ai/agent-infra.git" });
    writeFakeGh(ghPath);

    write(path.join(taskDir, "task.md"), buildTaskContent({ issue_number: "65", pr_number: "77" }));
    writeJson(issuePath, buildIssuePayload({
      labels: [{ name: "in: core" }],
      body: "# Issue\n"
    }));
    writeJson(prPath, buildPrPayload({
      labels: [{ name: "type: enhancement" }, { name: "in: cli" }, { name: "in: core" }]
    }));
    writeJson(prCommentsPath, [
      { body: "<!-- sync-pr:TASK-20260328-000001:summary -->\n## Review Summary\n\nLooks good." }
    ]);

    const result = runValidator([
      "check",
      "platform-sync",
      taskDir,
      "--skill",
      "create-pr"
    ], {
      env: {
        PATH: pathWithPrependedBin(binDir),
        GH_FAKE_ISSUE_PATH: issuePath,
        GH_FAKE_PR_PATH: prPath,
        GH_FAKE_PR_COMMENTS_PATH: prCommentsPath,
        GH_FAKE_ISSUE_NUMBER: "65",
        GH_FAKE_PR_NUMBER: "77"
      }
    });

    assert.equal(result.status, 1);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "platform-sync");
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /in: labels mismatch/);
    assert.match(payload.message, /PR #77/);
    assert.match(payload.message, /Issue #65/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact platform-sync fails when create-pr is missing the expected type label", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-platform-sync-pr-type-label-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const binDir = path.join(tempRoot, "bin");
  const ghPath = path.join(binDir, "gh");
  const issuePath = path.join(tempRoot, "issue.json");
  const prPath = path.join(tempRoot, "pr.json");
  const prCommentsPath = path.join(tempRoot, "pr-comments.json");

  try {
    initIsolatedGitRepo(tempRoot, { remote: "git@github.com:fitlab-ai/agent-infra.git" });
    writeFakeGh(ghPath);

    write(path.join(taskDir, "task.md"), buildTaskContent({
      type: "feature",
      issue_number: "65",
      pr_number: "77"
    }));
    writeJson(issuePath, buildIssuePayload({
      labels: [{ name: "in: core" }],
      body: "# Issue\n"
    }));
    writeJson(prPath, buildPrPayload({
      labels: [{ name: "in: core" }]
    }));
    writeJson(prCommentsPath, [
      { body: "<!-- sync-pr:TASK-20260328-000001:summary -->\n## Review Summary\n\nLooks good." }
    ]);

    const result = runValidator([
      "check",
      "platform-sync",
      taskDir,
      "--skill",
      "create-pr"
    ], {
      env: {
        PATH: pathWithPrependedBin(binDir),
        GH_FAKE_ISSUE_PATH: issuePath,
        GH_FAKE_PR_PATH: prPath,
        GH_FAKE_PR_COMMENTS_PATH: prCommentsPath,
        GH_FAKE_ISSUE_NUMBER: "65",
        GH_FAKE_PR_NUMBER: "77"
      }
    });

    assert.equal(result.status, 1);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "platform-sync");
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /Expected type label 'type: feature' not found on PR #77/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact platform-sync passes when create-pr includes the expected type label", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-platform-sync-pr-type-label-pass-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const binDir = path.join(tempRoot, "bin");
  const ghPath = path.join(binDir, "gh");
  const issuePath = path.join(tempRoot, "issue.json");
  const prPath = path.join(tempRoot, "pr.json");
  const prCommentsPath = path.join(tempRoot, "pr-comments.json");

  try {
    initIsolatedGitRepo(tempRoot, { remote: "git@github.com:fitlab-ai/agent-infra.git" });
    writeFakeGh(ghPath);

    write(path.join(taskDir, "task.md"), buildTaskContent({
      type: "feature",
      issue_number: "65",
      pr_number: "77"
    }));
    writeJson(issuePath, buildIssuePayload({
      labels: [{ name: "in: core" }],
      body: "# Issue\n"
    }));
    writeJson(prPath, buildPrPayload({
      labels: [{ name: "type: feature" }, { name: "in: core" }]
    }));
    writeJson(prCommentsPath, [
      { body: "<!-- sync-pr:TASK-20260328-000001:summary -->\n## Review Summary\n\nLooks good." }
    ]);

    const result = runValidator([
      "check",
      "platform-sync",
      taskDir,
      "--skill",
      "create-pr"
    ], {
      env: {
        PATH: pathWithPrependedBin(binDir),
        GH_FAKE_ISSUE_PATH: issuePath,
        GH_FAKE_PR_PATH: prPath,
        GH_FAKE_PR_COMMENTS_PATH: prCommentsPath,
        GH_FAKE_ISSUE_NUMBER: "65",
        GH_FAKE_PR_NUMBER: "77"
      }
    });

    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "platform-sync");
    assert.equal(payload.status, "pass");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact platform-sync skips create-pr type label verification without triage permission", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-platform-sync-pr-type-label-skip-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const binDir = path.join(tempRoot, "bin");
  const ghPath = path.join(binDir, "gh");
  const issuePath = path.join(tempRoot, "issue.json");
  const prPath = path.join(tempRoot, "pr.json");
  const prCommentsPath = path.join(tempRoot, "pr-comments.json");

  try {
    initIsolatedGitRepo(tempRoot, { remote: "git@github.com:fitlab-ai/agent-infra.git" });
    writeFakeGh(ghPath);

    write(path.join(taskDir, "task.md"), buildTaskContent({
      type: "feature",
      issue_number: "65",
      pr_number: "77"
    }));
    writeJson(issuePath, buildIssuePayload({
      labels: [{ name: "in: core" }],
      body: "# Issue\n"
    }));
    writeJson(prPath, buildPrPayload({
      labels: [{ name: "in: core" }]
    }));
    writeJson(prCommentsPath, [
      { body: "<!-- sync-pr:TASK-20260328-000001:summary -->\n## Review Summary\n\nLooks good." }
    ]);

    const result = runValidator([
      "check",
      "platform-sync",
      taskDir,
      "--skill",
      "create-pr"
    ], {
      env: {
        PATH: pathWithPrependedBin(binDir),
        GH_FAKE_ISSUE_PATH: issuePath,
        GH_FAKE_PR_PATH: prPath,
        GH_FAKE_PR_COMMENTS_PATH: prCommentsPath,
        GH_FAKE_ISSUE_NUMBER: "65",
        GH_FAKE_PR_NUMBER: "77",
        GH_FAKE_PERMISSIONS: JSON.stringify({ triage: false, push: false })
      }
    });

    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "platform-sync");
    assert.equal(payload.status, "pass");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact platform-sync fails when create-pr has no assignee", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-platform-sync-pr-assignee-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const binDir = path.join(tempRoot, "bin");
  const ghPath = path.join(binDir, "gh");
  const issuePath = path.join(tempRoot, "issue.json");
  const prPath = path.join(tempRoot, "pr.json");
  const prCommentsPath = path.join(tempRoot, "pr-comments.json");

  try {
    initIsolatedGitRepo(tempRoot, { remote: "git@github.com:fitlab-ai/agent-infra.git" });
    writeFakeGh(ghPath);

    write(path.join(taskDir, "task.md"), buildTaskContent({ issue_number: "65", pr_number: "77" }));
    writeJson(issuePath, buildIssuePayload({
      labels: [],
      body: "# Issue\n"
    }));
    writeJson(prPath, buildPrPayload({
      labels: [{ name: "type: enhancement" }],
      assignees: []
    }));
    writeJson(prCommentsPath, [
      { body: "<!-- sync-pr:TASK-20260328-000001:summary -->\n## Review Summary\n\nLooks good." }
    ]);

    const result = runValidator([
      "check",
      "platform-sync",
      taskDir,
      "--skill",
      "create-pr"
    ], {
      env: {
        PATH: pathWithPrependedBin(binDir),
        GH_FAKE_ISSUE_PATH: issuePath,
        GH_FAKE_PR_PATH: prPath,
        GH_FAKE_PR_COMMENTS_PATH: prCommentsPath,
        GH_FAKE_ISSUE_NUMBER: "65",
        GH_FAKE_PR_NUMBER: "77"
      }
    });

    assert.equal(result.status, 1);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "platform-sync");
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /PR #77 has no assignee/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact platform-sync skips create-pr assignee verification without push permission", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-platform-sync-pr-assignee-skip-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const binDir = path.join(tempRoot, "bin");
  const ghPath = path.join(binDir, "gh");
  const issuePath = path.join(tempRoot, "issue.json");
  const prPath = path.join(tempRoot, "pr.json");
  const prCommentsPath = path.join(tempRoot, "pr-comments.json");

  try {
    initIsolatedGitRepo(tempRoot, { remote: "git@github.com:fitlab-ai/agent-infra.git" });
    writeFakeGh(ghPath);

    write(path.join(taskDir, "task.md"), buildTaskContent({ issue_number: "65", pr_number: "77" }));
    writeJson(issuePath, buildIssuePayload({
      labels: [],
      body: "# Issue\n"
    }));
    writeJson(prPath, buildPrPayload({
      labels: [{ name: "type: enhancement" }],
      assignees: []
    }));
    writeJson(prCommentsPath, [
      { body: "<!-- sync-pr:TASK-20260328-000001:summary -->\n## Review Summary\n\nLooks good." }
    ]);

    const result = runValidator([
      "check",
      "platform-sync",
      taskDir,
      "--skill",
      "create-pr"
    ], {
      env: {
        PATH: pathWithPrependedBin(binDir),
        GH_FAKE_ISSUE_PATH: issuePath,
        GH_FAKE_PR_PATH: prPath,
        GH_FAKE_PR_COMMENTS_PATH: prCommentsPath,
        GH_FAKE_ISSUE_NUMBER: "65",
        GH_FAKE_PR_NUMBER: "77",
        GH_FAKE_PERMISSIONS: JSON.stringify({ triage: true, push: false })
      }
    });

    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "platform-sync");
    assert.equal(payload.status, "pass");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact platform-sync passes when create-pr summary comment exists on the PR", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-platform-sync-pr-comment-pass-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const binDir = path.join(tempRoot, "bin");
  const ghPath = path.join(binDir, "gh");
  const issuePath = path.join(tempRoot, "issue.json");
  const prPath = path.join(tempRoot, "pr.json");
  const prCommentsPath = path.join(tempRoot, "pr-comments.json");

  try {
    initIsolatedGitRepo(tempRoot, { remote: "git@github.com:fitlab-ai/agent-infra.git" });
    writeFakeGh(ghPath);

    write(path.join(taskDir, "task.md"), buildTaskContent({ issue_number: "65", pr_number: "77" }));
    writeJson(issuePath, buildIssuePayload({
      labels: [],
      body: "# Issue\n"
    }));
    writeJson(prPath, buildPrPayload({
      labels: [{ name: "type: enhancement" }]
    }));
    writeJson(prCommentsPath, [
      { body: "<!-- sync-pr:TASK-20260328-000001:summary -->\n## Review Summary\n\nLooks good." }
    ]);

    const result = runValidator([
      "check",
      "platform-sync",
      taskDir,
      "--skill",
      "create-pr"
    ], {
      env: {
        PATH: pathWithPrependedBin(binDir),
        GH_FAKE_ISSUE_PATH: issuePath,
        GH_FAKE_PR_PATH: prPath,
        GH_FAKE_PR_COMMENTS_PATH: prCommentsPath,
        GH_FAKE_ISSUE_NUMBER: "65",
        GH_FAKE_PR_NUMBER: "77"
      }
    });

    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "platform-sync");
    assert.equal(payload.status, "pass");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

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
  const zhHeadings = [/## 审查摘要/, /### 关键技术决策/, /### 审查历程/, /### 测试结果/];
  assertHasCanonicalPrSyncStructure(".agents/rules/pr-sync.md", zhHeadings);
  assertHasCanonicalPrSyncStructure("templates/.agents/rules/pr-sync.github.zh-CN.md", zhHeadings);
});

test("template English rule contains the canonical PR summary structure", () => {
  const enHeadings = [/## Review Summary/, /### Key Technical Decisions/, /### Review History/, /### Test Results/];
  assertHasCanonicalPrSyncStructure("templates/.agents/rules/pr-sync.github.en.md", enHeadings);
});

test("validate-artifact platform-sync skips for commit when task has no pr_number", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-platform-sync-commit-skip-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");

  try {
    initIsolatedGitRepo(tempRoot, { remote: "git@github.com:fitlab-ai/agent-infra.git" });
    write(path.join(taskDir, "task.md"), buildTaskContent({ issue_number: "65" }));

    const result = runValidator([
      "check",
      "platform-sync",
      taskDir,
      "--skill",
      "commit"
    ]);

    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "platform-sync");
    assert.equal(payload.status, "pass");
    assert.equal(payload.message, "Skipped: task has no pr_number");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact platform-sync passes for commit when summary comment exists on the PR", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-platform-sync-commit-pass-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const binDir = path.join(tempRoot, "bin");
  const ghPath = path.join(binDir, "gh");
  const issuePath = path.join(tempRoot, "issue.json");
  const prCommentsPath = path.join(tempRoot, "pr-comments.json");

  try {
    initIsolatedGitRepo(tempRoot, { remote: "git@github.com:fitlab-ai/agent-infra.git" });
    const headSha = createHeadCommit(tempRoot);
    writeFakeGh(ghPath);

    write(path.join(taskDir, "task.md"), buildTaskContent({ issue_number: "65", pr_number: "77" }));
    writeJson(issuePath, buildIssuePayload({
      labels: [],
      body: "# Issue\n"
    }));
    writeJson(prCommentsPath, [
      { body: `<!-- sync-pr:TASK-20260328-000001:summary -->\n<!-- last-commit: ${headSha} -->\n## Review Summary\n\nLooks good.` }
    ]);

    const result = runValidator([
      "check",
      "platform-sync",
      taskDir,
      "--skill",
      "commit"
    ], {
      env: {
        PATH: pathWithPrependedBin(binDir),
        GH_FAKE_ISSUE_PATH: issuePath,
        GH_FAKE_PR_COMMENTS_PATH: prCommentsPath,
        GH_FAKE_ISSUE_NUMBER: "65",
        GH_FAKE_PR_NUMBER: "77"
      }
    });

    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "platform-sync");
    assert.equal(payload.status, "pass");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact platform-sync passes for commit with last-commit from task branch worktree", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-platform-sync-commit-worktree-pass-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const worktreePath = path.join(tempRoot, "sandbox-worktree");
  const binDir = path.join(tempRoot, "bin");
  const ghPath = path.join(binDir, "gh");
  const issuePath = path.join(tempRoot, "issue.json");
  const prCommentsPath = path.join(tempRoot, "pr-comments.json");
  const branch = "agent-infra-feature-pr";

  try {
    initIsolatedGitRepo(tempRoot, { remote: "git@github.com:fitlab-ai/agent-infra.git" });
    const mainSha = createHeadCommit(tempRoot);
    addWorktree(tempRoot, worktreePath, branch);
    const prSha = commitInWorktree(worktreePath, "sandbox commit");
    assert.notEqual(prSha, mainSha);
    writeFakeGh(ghPath);

    write(path.join(taskDir, "task.md"), buildTaskContent({ branch, issue_number: "65", pr_number: "77" }));
    writeJson(issuePath, buildIssuePayload({
      labels: [],
      body: "# Issue\n"
    }));
    writeJson(prCommentsPath, [
      { body: `<!-- sync-pr:TASK-20260328-000001:summary -->\n<!-- last-commit: ${prSha} -->\n## Review Summary\n\nLooks good.` }
    ]);

    const result = runValidator([
      "check",
      "platform-sync",
      taskDir,
      "--skill",
      "commit"
    ], {
      env: {
        PATH: pathWithPrependedBin(binDir),
        GH_FAKE_ISSUE_PATH: issuePath,
        GH_FAKE_PR_COMMENTS_PATH: prCommentsPath,
        GH_FAKE_ISSUE_NUMBER: "65",
        GH_FAKE_PR_NUMBER: "77"
      }
    });

    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "platform-sync");
    assert.equal(payload.status, "pass");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact platform-sync falls back to taskDir HEAD when task branch is missing", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-platform-sync-commit-no-branch-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const binDir = path.join(tempRoot, "bin");
  const ghPath = path.join(binDir, "gh");
  const issuePath = path.join(tempRoot, "issue.json");
  const prCommentsPath = path.join(tempRoot, "pr-comments.json");

  try {
    initIsolatedGitRepo(tempRoot, { remote: "git@github.com:fitlab-ai/agent-infra.git" });
    const mainSha = createHeadCommit(tempRoot);
    writeFakeGh(ghPath);

    write(path.join(taskDir, "task.md"), buildTaskContent({ issue_number: "65", pr_number: "77" }));
    writeJson(issuePath, buildIssuePayload({
      labels: [],
      body: "# Issue\n"
    }));
    writeJson(prCommentsPath, [
      { body: `<!-- sync-pr:TASK-20260328-000001:summary -->\n<!-- last-commit: ${mainSha} -->\n## Review Summary\n\nLooks good.` }
    ]);

    const result = runValidator([
      "check",
      "platform-sync",
      taskDir,
      "--skill",
      "commit"
    ], {
      env: {
        PATH: pathWithPrependedBin(binDir),
        GH_FAKE_ISSUE_PATH: issuePath,
        GH_FAKE_PR_COMMENTS_PATH: prCommentsPath,
        GH_FAKE_ISSUE_NUMBER: "65",
        GH_FAKE_PR_NUMBER: "77"
      }
    });

    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "platform-sync");
    assert.equal(payload.status, "pass");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact platform-sync falls back to taskDir HEAD when task branch worktree is unmatched", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-platform-sync-commit-unmatched-branch-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const binDir = path.join(tempRoot, "bin");
  const ghPath = path.join(binDir, "gh");
  const issuePath = path.join(tempRoot, "issue.json");
  const prCommentsPath = path.join(tempRoot, "pr-comments.json");

  try {
    initIsolatedGitRepo(tempRoot, { remote: "git@github.com:fitlab-ai/agent-infra.git" });
    const mainSha = createHeadCommit(tempRoot);
    writeFakeGh(ghPath);

    write(path.join(taskDir, "task.md"), buildTaskContent({
      branch: "agent-infra-feature-missing",
      issue_number: "65",
      pr_number: "77"
    }));
    writeJson(issuePath, buildIssuePayload({
      labels: [],
      body: "# Issue\n"
    }));
    writeJson(prCommentsPath, [
      { body: `<!-- sync-pr:TASK-20260328-000001:summary -->\n<!-- last-commit: ${mainSha} -->\n## Review Summary\n\nLooks good.` }
    ]);

    const result = runValidator([
      "check",
      "platform-sync",
      taskDir,
      "--skill",
      "commit"
    ], {
      env: {
        PATH: pathWithPrependedBin(binDir),
        GH_FAKE_ISSUE_PATH: issuePath,
        GH_FAKE_PR_COMMENTS_PATH: prCommentsPath,
        GH_FAKE_ISSUE_NUMBER: "65",
        GH_FAKE_PR_NUMBER: "77"
      }
    });

    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "platform-sync");
    assert.equal(payload.status, "pass");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact platform-sync fails for commit when summary comment last-commit metadata mismatches HEAD", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-platform-sync-commit-head-fail-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const binDir = path.join(tempRoot, "bin");
  const ghPath = path.join(binDir, "gh");
  const issuePath = path.join(tempRoot, "issue.json");
  const prCommentsPath = path.join(tempRoot, "pr-comments.json");

  try {
    initIsolatedGitRepo(tempRoot, { remote: "git@github.com:fitlab-ai/agent-infra.git" });
    createHeadCommit(tempRoot);
    writeFakeGh(ghPath);

    write(path.join(taskDir, "task.md"), buildTaskContent({ issue_number: "65", pr_number: "77" }));
    writeJson(issuePath, buildIssuePayload({
      labels: [],
      body: "# Issue\n"
    }));
    writeJson(prCommentsPath, [
      { body: "<!-- sync-pr:TASK-20260328-000001:summary -->\n<!-- last-commit: deadbee -->\n## Review Summary\n\nLooks good." }
    ]);

    const result = runValidator([
      "check",
      "platform-sync",
      taskDir,
      "--skill",
      "commit"
    ], {
      env: {
        PATH: pathWithPrependedBin(binDir),
        GH_FAKE_ISSUE_PATH: issuePath,
        GH_FAKE_PR_COMMENTS_PATH: prCommentsPath,
        GH_FAKE_ISSUE_NUMBER: "65",
        GH_FAKE_PR_NUMBER: "77"
      }
    });

    assert.equal(result.status, 1);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "platform-sync");
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /last-commit metadata mismatch/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact platform-sync fails for commit when summary comment last-commit metadata is missing", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-platform-sync-commit-head-missing-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const binDir = path.join(tempRoot, "bin");
  const ghPath = path.join(binDir, "gh");
  const issuePath = path.join(tempRoot, "issue.json");
  const prCommentsPath = path.join(tempRoot, "pr-comments.json");

  try {
    initIsolatedGitRepo(tempRoot, { remote: "git@github.com:fitlab-ai/agent-infra.git" });
    createHeadCommit(tempRoot);
    writeFakeGh(ghPath);

    write(path.join(taskDir, "task.md"), buildTaskContent({ issue_number: "65", pr_number: "77" }));
    writeJson(issuePath, buildIssuePayload({
      labels: [],
      body: "# Issue\n"
    }));
    writeJson(prCommentsPath, [
      { body: "<!-- sync-pr:TASK-20260328-000001:summary -->\n## Review Summary\n\nLooks good." }
    ]);

    const result = runValidator([
      "check",
      "platform-sync",
      taskDir,
      "--skill",
      "commit"
    ], {
      env: {
        PATH: pathWithPrependedBin(binDir),
        GH_FAKE_ISSUE_PATH: issuePath,
        GH_FAKE_PR_COMMENTS_PATH: prCommentsPath,
        GH_FAKE_ISSUE_NUMBER: "65",
        GH_FAKE_PR_NUMBER: "77"
      }
    });

    assert.equal(result.status, 1);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "platform-sync");
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /missing '<!-- last-commit: <sha> -->' metadata/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact platform-sync fails when create-pr summary comment is missing on the PR", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-platform-sync-pr-comment-fail-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const binDir = path.join(tempRoot, "bin");
  const ghPath = path.join(binDir, "gh");
  const issuePath = path.join(tempRoot, "issue.json");
  const prPath = path.join(tempRoot, "pr.json");
  const prCommentsPath = path.join(tempRoot, "pr-comments.json");

  try {
    initIsolatedGitRepo(tempRoot, { remote: "git@github.com:fitlab-ai/agent-infra.git" });
    writeFakeGh(ghPath);

    write(path.join(taskDir, "task.md"), buildTaskContent({ issue_number: "65", pr_number: "77" }));
    writeJson(issuePath, buildIssuePayload({
      labels: [],
      body: "# Issue\n"
    }));
    writeJson(prPath, buildPrPayload());
    writeJson(prCommentsPath, []);

    const result = runValidator([
      "check",
      "platform-sync",
      taskDir,
      "--skill",
      "create-pr"
    ], {
      env: {
        PATH: pathWithPrependedBin(binDir),
        GH_FAKE_ISSUE_PATH: issuePath,
        GH_FAKE_PR_PATH: prPath,
        GH_FAKE_PR_COMMENTS_PATH: prCommentsPath,
        GH_FAKE_ISSUE_NUMBER: "65",
        GH_FAKE_PR_NUMBER: "77"
      }
    });

    assert.equal(result.status, 1);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "platform-sync");
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /Expected PR comment marker/);
    assert.match(payload.message, /PR #77/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact platform-sync fails for commit when summary comment is missing on the PR", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-platform-sync-commit-fail-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const binDir = path.join(tempRoot, "bin");
  const ghPath = path.join(binDir, "gh");
  const issuePath = path.join(tempRoot, "issue.json");
  const prCommentsPath = path.join(tempRoot, "pr-comments.json");

  try {
    initIsolatedGitRepo(tempRoot, { remote: "git@github.com:fitlab-ai/agent-infra.git" });
    writeFakeGh(ghPath);

    write(path.join(taskDir, "task.md"), buildTaskContent({ issue_number: "65", pr_number: "77" }));
    writeJson(issuePath, buildIssuePayload({
      labels: [],
      body: "# Issue\n"
    }));
    writeJson(prCommentsPath, []);

    const result = runValidator([
      "check",
      "platform-sync",
      taskDir,
      "--skill",
      "commit"
    ], {
      env: {
        PATH: pathWithPrependedBin(binDir),
        GH_FAKE_ISSUE_PATH: issuePath,
        GH_FAKE_PR_COMMENTS_PATH: prCommentsPath,
        GH_FAKE_ISSUE_NUMBER: "65",
        GH_FAKE_PR_NUMBER: "77"
      }
    });

    assert.equal(result.status, 1);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "platform-sync");
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /Expected PR comment marker/);
    assert.match(payload.message, /PR #77/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validate-artifact platform-sync fails for create-task when the task comment is missing", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-platform-sync-create-task-task-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const binDir = path.join(tempRoot, "bin");
  const ghPath = path.join(binDir, "gh");
  const issuePath = path.join(tempRoot, "issue.json");
  const commentsPath = path.join(tempRoot, "comments.json");

  try {
    initIsolatedGitRepo(tempRoot, { remote: "git@github.com:fitlab-ai/agent-infra.git" });
    writeFakeGh(ghPath);

    write(path.join(taskDir, "task.md"), buildTaskContent({ issue_number: "65" }));
    writeJson(issuePath, buildIssuePayload({
      labels: [{ name: "status: waiting-for-triage" }],
      body: "# Issue\n"
    }));
    writeJson(commentsPath, []);

    const result = runValidator([
      "check",
      "platform-sync",
      taskDir,
      "--skill",
      "create-task"
    ], {
      env: {
        PATH: pathWithPrependedBin(binDir),
        GH_FAKE_ISSUE_PATH: issuePath,
        GH_FAKE_COMMENTS_PATH: commentsPath,
        GH_FAKE_ISSUE_NUMBER: "65"
      }
    });

    assert.equal(result.status, 1);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.type, "platform-sync");
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /sync-issue:TASK-20260328-000001:task/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("verification assets are present in local and template trees", () => {
  [
    ".agents/scripts/validate-artifact.js",
    ".agents/scripts/platform-adapters/platform-sync.js",
    "templates/.agents/scripts/validate-artifact.js",
    "templates/.agents/scripts/platform-adapters/platform-sync.github.js",
    ".agents/skills/implement-task/config/verify.json",
    "templates/.agents/skills/implement-task/config/verify.json"
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
