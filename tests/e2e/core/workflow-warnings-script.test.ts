import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { buildTaskContent, parseValidatorPayload, runValidator, withTempRoot, write } from "./validate-artifact-helpers.ts";
import { envWithPrependedPath, filePath, initIsolatedGitRepo, INTERNAL_CLI_PATH, writeNodeCommandShim } from "../../helpers.ts";

const scriptPath = filePath(".agents/scripts/workflow-warnings.js");

function runWarningScript(args: string[], cwd = filePath("."), env = process.env) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    cwd,
    env
  });
}

test("workflow-warnings script inserts, deduplicates, lists, and closes warnings", () => (
  withTempRoot("agent-infra-workflow-warnings-", (tempRoot) => {
    const repoRoot = path.join(tempRoot, "repo");
    const binDir = path.join(tempRoot, "bin");
    fs.mkdirSync(repoRoot, { recursive: true });
    initIsolatedGitRepo(repoRoot);
    writeNodeCommandShim(path.join(binDir, "agent-infra-internal"), INTERNAL_CLI_PATH);
    const env = envWithPrependedPath(process.env, binDir);
    const taskDir = path.join(repoRoot, ".agents", "workspace", "active", "TASK-20260328-000001");
    write(path.join(taskDir, "task.md"), buildTaskContent());

    const addArgs = [
      "add",
      taskDir,
      "--step",
      "issue-sync",
      "--severity",
      "ACTION_REQUIRED",
      "--code",
      "COMMENT_SYNC_FAILED",
      "--target",
      "task-comment",
      "--message",
      "failed a\\|b",
      "--action",
      "retry a\\|b"
    ];

    const added = runWarningScript(addArgs, repoRoot, env);
    assert.equal(added.status, 0, added.stderr);
    assert.equal(JSON.parse(added.stdout).created, true);

    const duplicate = runWarningScript(addArgs, repoRoot, env);
    assert.equal(duplicate.status, 0, duplicate.stderr);
    assert.equal(JSON.parse(duplicate.stdout).created, false);

    const listed = runWarningScript(["list", taskDir, "--status", "open", "--format", "json"], repoRoot, env);
    assert.equal(listed.status, 0, listed.stderr);
    const warnings = JSON.parse(listed.stdout).warnings;
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].message, "failed a\\|b");
    assert.equal(warnings[0].action, "retry a\\|b");

    const gateBeforeClose = runValidator(["check", "task-meta", taskDir, "--skill", "code-task"]);
    assert.equal(gateBeforeClose.status, 0, gateBeforeClose.stderr);

    const closed = runWarningScript([
      "set-status",
      taskDir,
      "--id",
      "WW-1",
      "--status",
      "resolved",
      "--resolution",
      "manual sync completed"
    ], repoRoot, env);
    assert.equal(closed.status, 0, closed.stderr);
    assert.equal(JSON.parse(closed.stdout).warning.status, "resolved");

    const payload = parseValidatorPayload(runValidator(["check", "task-meta", taskDir, "--skill", "code-task"]).stdout);
    assert.equal(payload.status, "pass");
  })
));

test("workflow-warnings script explains how to recover when the internal CLI is absent", () => (
  withTempRoot("agent-infra-workflow-warnings-missing-cli-", (tempRoot) => {
    const taskDir = path.join(tempRoot, "TASK-20260328-000002");
    fs.mkdirSync(taskDir, { recursive: true });
    const result = runWarningScript(["list", taskDir], tempRoot, { ...process.env, PATH: tempRoot });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /agent-infra-internal not found on PATH/);
    assert.match(result.stderr, /install/i);
  })
));
