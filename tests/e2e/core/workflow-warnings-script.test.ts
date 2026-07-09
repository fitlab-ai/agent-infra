import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { buildTaskContent, parseValidatorPayload, runValidator, withTempRoot, write } from "./validate-artifact-helpers.ts";
import { filePath } from "../../helpers.ts";

const scriptPath = filePath(".agents/scripts/workflow-warnings.js");

function runWarningScript(args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    cwd: filePath(".")
  });
}

test("workflow-warnings script inserts, deduplicates, lists, and closes warnings", () => (
  withTempRoot("agent-infra-workflow-warnings-", (tempRoot) => {
    const taskDir = path.join(tempRoot, "TASK-20260328-000001");
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

    const added = runWarningScript(addArgs);
    assert.equal(added.status, 0, added.stderr);
    assert.equal(JSON.parse(added.stdout).created, true);

    const duplicate = runWarningScript(addArgs);
    assert.equal(duplicate.status, 0, duplicate.stderr);
    assert.equal(JSON.parse(duplicate.stdout).created, false);

    const listed = runWarningScript(["list", taskDir, "--status", "open", "--format", "json"]);
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
    ]);
    assert.equal(closed.status, 0, closed.stderr);
    assert.equal(JSON.parse(closed.stdout).warning.status, "resolved");

    const payload = parseValidatorPayload(runValidator(["check", "task-meta", taskDir, "--skill", "code-task"]).stdout);
    assert.equal(payload.status, "pass");
  })
));
