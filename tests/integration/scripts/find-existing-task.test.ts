import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";

import { filePath } from "../../helpers.ts";

const scriptPath = filePath(".agents/scripts/find-existing-task.js");

type IssueComment = {
  created_at: string;
  body: string;
};
type RunScriptOptions = {
  rawInput?: string;
};

function runScript(comments: IssueComment[], options: RunScriptOptions = {}) {
  const input = options.rawInput !== undefined
    ? options.rawInput
    : comments.map((c) => JSON.stringify(c)).join("\n");

  return spawnSync(process.execPath, [scriptPath], {
    cwd: filePath("."),
    encoding: "utf8",
    input,
    env: process.env
  });
}

function parseStdout(result: SpawnSyncReturns<string>): Record<string, unknown> & {
  found?: boolean;
  task_id?: string;
  frontmatter: Record<string, string>;
  candidates?: unknown;
} {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function comment(body: string, createdAt: string = "2026-04-12T03:51:33Z"): IssueComment {
  return {
    created_at: createdAt,
    body
  };
}

function taskComment(taskId: string, frontmatterLines: string[] = []) {
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

test("find-existing-task exits 1 when stdin is not valid JSON", () => {
  const result = runScript([], { rawInput: "{not json" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot parse stdin as JSON/);
});

test("find-existing-task reports no match for empty stdin", () => {
  const result = runScript([]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { found: false });
});
