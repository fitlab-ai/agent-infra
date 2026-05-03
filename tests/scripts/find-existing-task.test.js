import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { filePath, writeNodeCommandShim } from "../helpers.js";

const scriptPath = filePath(".agents/scripts/platform-adapters/find-existing-task.js");

function writeFile(filePathname, content) {
  fs.mkdirSync(path.dirname(filePathname), { recursive: true });
  fs.writeFileSync(filePathname, content, "utf8");
}

function writeFakeGh(tmpDir, comments, options = {}) {
  const dataPath = path.join(tmpDir, "comments.json");
  writeFile(dataPath, JSON.stringify(comments));

  const fakeGhPath = path.join(tmpDir, "fake-gh.js");
  writeFile(fakeGhPath, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "if (process.env.FAKE_GH_FAIL === '1') {",
    "  console.error('simulated gh failure');",
    "  process.exit(1);",
    "}",
    "if (args[0] === 'api' && args[1].includes('/issues/') && args[1].endsWith('/comments')) {",
    "  const comments = JSON.parse(fs.readFileSync(process.env.FAKE_GH_COMMENTS, 'utf8'));",
    "  for (const comment of comments) {",
    "    console.log(JSON.stringify(comment));",
    "  }",
    "  process.exit(0);",
    "}",
    "console.error(`unexpected gh args: ${args.join(' ')}`);",
    "process.exit(1);"
  ].join("\n"));

  const commandPath = process.platform === "win32"
    ? writeNodeCommandShim(path.join(tmpDir, "gh"), fakeGhPath)
    : fakeGhPath;
  if (process.platform !== "win32") {
    fs.chmodSync(commandPath, 0o755);
  }

  return {
    commandPath,
    env: {
      ...process.env,
      FAKE_GH_COMMENTS: dataPath,
      FAKE_GH_FAIL: options.fail ? "1" : "0",
      IMPORT_ISSUE_GH_BIN: process.execPath,
      IMPORT_ISSUE_GH_ARGS_JSON: JSON.stringify([fakeGhPath])
    }
  };
}

function runScript(comments, options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-import-issue-"));
  const { env } = writeFakeGh(tmpDir, comments, options);

  return spawnSync(process.execPath, [
    scriptPath,
    "--issue",
    "184",
    "--repo",
    "fitlab-ai/agent-infra"
  ], {
    cwd: filePath("."),
    encoding: "utf8",
    env
  });
}

function parseStdout(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function comment(body, createdAt = "2026-04-12T03:51:33Z") {
  return {
    created_at: createdAt,
    body
  };
}

function taskComment(taskId, frontmatterLines = []) {
  return [
    `<!-- sync-issue:${taskId}:task -->`,
    "## 任务文件",
    "",
    "> **codex** · TASK-20260412-114725",
    "",
    "<details><summary>元数据 (frontmatter)</summary>",
    "",
    "```yaml",
    "---",
    ...frontmatterLines,
    "---",
    "```",
    "",
    "</details>",
    "",
    "# 任务：示例"
  ].join("\n");
}

test("find-existing-task reports no match when comments have no sync marker", () => {
  const result = parseStdout(runScript([
    comment("plain comment")
  ]));

  assert.deepEqual(result, { found: false });
});

test("find-existing-task recovers frontmatter from a single task candidate", () => {
  const result = parseStdout(runScript([
    comment("<!-- sync-issue:TASK-20260412-114725:analysis -->\n# 分析", "2026-04-12T03:55:00Z"),
    comment(taskComment("TASK-20260412-114725", [
      "id: TASK-20260412-114725",
      "type: bugfix",
      "workflow: bug-fix",
      "created_at: 2026-04-12 11:47:25+08:00",
      "current_step: review",
      "assigned_to: codex"
    ]), "2026-04-12T03:51:33Z")
  ]));

  assert.equal(result.found, true);
  assert.equal(result.task_id, "TASK-20260412-114725");
  assert.equal(result.frontmatter.id, "TASK-20260412-114725");
  assert.equal(result.frontmatter.current_step, "review");
});

test("find-existing-task selects the earliest candidate deterministically", () => {
  const result = parseStdout(runScript([
    comment(taskComment("TASK-20260426-120458", ["id: TASK-20260426-120458"]), "2026-04-26T04:04:58Z"),
    comment(taskComment("TASK-20260412-114725", ["id: TASK-20260412-114725"]), "2026-04-12T03:51:33Z")
  ]));

  assert.equal(result.task_id, "TASK-20260412-114725");
  assert.equal(result.frontmatter.id, "TASK-20260412-114725");
  assert.equal(result.candidates, undefined);
});

test("find-existing-task keeps the task id when no task comment exists", () => {
  const result = parseStdout(runScript([
    comment("<!-- sync-issue:TASK-20260412-114725:analysis -->\n# 分析")
  ]));

  assert.equal(result.found, true);
  assert.equal(result.task_id, "TASK-20260412-114725");
  assert.equal(result.frontmatter, undefined);
});

test("find-existing-task keeps the task id when frontmatter is damaged", () => {
  const result = parseStdout(runScript([
    comment([
      "<!-- sync-issue:TASK-20260412-114725:task -->",
      "## 任务文件",
      "",
      "<details><summary>元数据 (frontmatter)</summary>",
      "",
      "not a yaml fence",
      "",
      "</details>"
    ].join("\n"))
  ]));

  assert.equal(result.found, true);
  assert.equal(result.task_id, "TASK-20260412-114725");
  assert.equal(result.frontmatter, undefined);
});

test("find-existing-task skips damaged frontmatter lines when useful fields remain", () => {
  const result = parseStdout(runScript([
    comment(taskComment("TASK-20260412-114725", [
      "id: TASK-20260412-114725",
      "damaged yaml line",
      "created_at: 2026-04-12 11:47:25+08:00"
    ]))
  ]));

  assert.equal(result.found, true);
  assert.equal(result.task_id, "TASK-20260412-114725");
  assert.equal(result.frontmatter.id, "TASK-20260412-114725");
  assert.equal(result.frontmatter.created_at, "2026-04-12 11:47:25+08:00");
});

test("find-existing-task exits 2 when gh fails", () => {
  const result = runScript([], { fail: true });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /simulated gh failure/);
});
