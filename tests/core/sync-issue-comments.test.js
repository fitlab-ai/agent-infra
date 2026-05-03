import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { filePath, read } from "../helpers.js";

const scriptPath = filePath(".agents/scripts/sync-issue-comments.js");

function write(filePathname, content) {
  fs.mkdirSync(path.dirname(filePathname), { recursive: true });
  fs.writeFileSync(filePathname, content, "utf8");
}

function writeJson(filePathname, value) {
  write(filePathname, JSON.stringify(value));
}

function initGitRepo(repoRoot) {
  const initResult = spawnSync("git", ["init", "-q"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  assert.equal(initResult.status, 0, initResult.stderr);

  const remoteResult = spawnSync("git", ["remote", "add", "origin", "git@github.com:fitlab-ai/agent-infra.git"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  assert.equal(remoteResult.status, 0, remoteResult.stderr);
}

function writeFakeGh(binDir) {
  const fakeGhPath = path.join(binDir, "fake-gh.js");
  write(fakeGhPath, read("tests/fixtures/validate-artifact/fake-gh.js"));

  const posixGhPath = path.join(binDir, "gh");
  write(posixGhPath, `#!/bin/sh\nexec "${process.execPath}" "${fakeGhPath}" "$@"\n`);
  fs.chmodSync(posixGhPath, 0o755);

  const windowsGhPath = path.join(binDir, "gh.cmd");
  write(windowsGhPath, `@"${process.execPath}" "${fakeGhPath}" %*\r\n`);
  return fakeGhPath;
}

function runSync(args, options = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    cwd: filePath("."),
    env: {
      ...process.env,
      ...options.env
    }
  });
}

function buildTaskContent(taskId = "TASK-20260412-114725") {
  return [
    "---",
    `id: ${taskId}`,
    "issue_number: 184",
    "type: feature",
    "workflow: feature-development",
    "status: active",
    "created_at: 2026-04-12 11:47:25",
    "updated_at: 2026-04-12 15:19:22",
    "current_step: review",
    "assigned_to: codex",
    "---",
    "",
    "# 任务：feat(sandbox): for windows",
    "",
    "## 审查反馈",
    "",
    "- Round 2：[`review-r2.md`](review-r2.md)",
    "",
    "## Activity Log",
    "",
    "- 2026-04-12 15:19:22 — **Code Review (Round 2)** by codex — Verdict: Approved, blockers: 0, major: 0, minor: 0 → review-r2.md"
  ].join("\n");
}

test("sync-issue-comments updates task comment and creates artifact comment", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sync-issue-comments-"));
  const taskDir = path.join(tempRoot, "TASK-20260412-114725");
  const binDir = path.join(tempRoot, "bin");
  const commentsPath = path.join(tempRoot, "comments.json");

  try {
    initGitRepo(tempRoot);
    const fakeGhPath = writeFakeGh(binDir);
    write(path.join(taskDir, "task.md"), buildTaskContent());
    write(path.join(taskDir, "review-r2.md"), [
      "# 代码审查报告",
      "",
      "## 审查摘要",
      "",
      "- **总体结论**：通过",
      "",
      "## 问题清单",
      "",
      "无。"
    ].join("\n"));
    writeJson(commentsPath, [
      {
        id: 10,
        body: "<!-- sync-issue:TASK-20260412-114725:task -->\nold task"
      }
    ]);

    const result = runSync([
      taskDir,
      "review-r2.md",
      "--agent",
      "codex"
    ], {
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        AGENT_INFRA_GH_BIN: process.execPath,
        AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([fakeGhPath]),
        GH_FAKE_COMMENTS_PATH: commentsPath
      }
    });

    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "pass");
    assert.deepEqual(payload.operations.map((operation) => operation.action), ["update", "create"]);

    const comments = JSON.parse(fs.readFileSync(commentsPath, "utf8"));
    assert.equal(comments.length, 2);
    assert.match(comments[0].body, /<details><summary>元数据 \(frontmatter\)<\/summary>/);
    assert.match(comments[0].body, /current_step: review/);
    assert.match(comments[1].body, /<!-- sync-issue:TASK-20260412-114725:review-r2 -->/);
    assert.match(comments[1].body, /## 审查报告（Round 2）/);
    assert.match(comments[1].body, /# 代码审查报告/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("sync-issue-comments dry-run discovers task artifacts without writing comments", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sync-issue-comments-dry-"));
  const taskDir = path.join(tempRoot, "TASK-20260412-114725");
  const binDir = path.join(tempRoot, "bin");
  const commentsPath = path.join(tempRoot, "comments.json");

  try {
    initGitRepo(tempRoot);
    const fakeGhPath = writeFakeGh(binDir);
    write(path.join(taskDir, "task.md"), buildTaskContent());
    write(path.join(taskDir, "analysis.md"), "# 需求分析报告\n");
    write(path.join(taskDir, "review-r2.md"), "# 代码审查报告\n");
    writeJson(commentsPath, []);

    const result = runSync([
      taskDir,
      "--dry-run"
    ], {
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        AGENT_INFRA_GH_BIN: process.execPath,
        AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([fakeGhPath]),
        GH_FAKE_COMMENTS_PATH: commentsPath
      }
    });

    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "pass");
    assert.deepEqual(payload.operations.map((operation) => operation.file), [
      "task.md",
      "analysis.md",
      "review-r2.md"
    ]);
    assert.deepEqual(JSON.parse(fs.readFileSync(commentsPath, "utf8")), []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("sync-issue-comments script stays in sync with template copy", () => {
  assert.equal(
    read(".agents/scripts/sync-issue-comments.js"),
    read("templates/.agents/scripts/sync-issue-comments.js")
  );
});
