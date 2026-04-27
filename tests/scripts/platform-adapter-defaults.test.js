import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { loadFreshEsm, pathWithPrependedBin, read, writeNodeCommandShim } from "../helpers.js";

function write(filePathname, content) {
  fs.mkdirSync(path.dirname(filePathname), { recursive: true });
  fs.writeFileSync(filePathname, content, "utf8");
}

function writeJson(filePathname, value) {
  write(filePathname, JSON.stringify(value, null, 2));
}

function initGitRepo(repoRoot) {
  const initResult = spawnSync("git", ["init", "-q", "-b", "main"], {
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

function writeFakeGh(filePathname) {
  const scriptPath = `${filePathname}.cjs`;
  write(scriptPath, read("tests/fixtures/validate-artifact/fake-gh.js"));
  if (process.platform === "win32") {
    writeNodeCommandShim(filePathname, scriptPath);
  } else {
    write(filePathname, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
    fs.chmodSync(filePathname, 0o755);
  }
}

function writeTask(taskDir) {
  write(path.join(taskDir, "task.md"), [
    "---",
    "id: TASK-20260328-000001",
    "type: refactor",
    "workflow: refactoring",
    "status: active",
    "created_at: 2026-03-28 00:00:00+00:00",
    "updated_at: 2026-03-28 00:00:00+00:00",
    "current_step: implementation",
    "assigned_to: codex",
    "issue_number: 65",
    "---",
    "",
    "# 任务：Adapter defaults",
    ""
  ].join("\n"));
}

function runValidator(scriptPath, taskDir, skill, env) {
  return spawnSync(process.execPath, [scriptPath, "check", "platform-sync", taskDir, "implementation.md", "--skill", skill], {
    cwd: path.dirname(path.dirname(path.dirname(scriptPath))),
    encoding: "utf8",
    env
  });
}

test("platform-sync adapters expose default status labels and markers", async () => {
  for (const relativePath of [
    ".agents/scripts/platform-adapters/platform-sync.js",
    "templates/.agents/scripts/platform-adapters/platform-sync.github.js"
  ]) {
    const { getDefaults } = await loadFreshEsm(relativePath);
    const defaults = getDefaults();

    assert.equal(defaults.statusLabels.inProgress, "status: in-progress");
    assert.equal(defaults.statusLabels.pendingDesignWork, "status: pending-design-work");
    assert.equal(defaults.statusLabels.waitingForTriage, "status: waiting-for-triage");
    assert.equal(defaults.markers.task, "<!-- sync-issue:{task-id}:task -->");
    assert.equal(defaults.markers.artifact, "<!-- sync-issue:{task-id}:{artifact-stem} -->");
    assert.equal(defaults.markers.artifactChunk, "<!-- sync-issue:{task-id}:{artifact-stem}:{part}/{total} -->");
    assert.equal(defaults.markers.prSummary, "<!-- sync-pr:{task-id}:summary -->");
  }
});

test("platform-sync stub adapter exposes empty defaults", async () => {
  const { getDefaults } = await loadFreshEsm("templates/.agents/scripts/platform-adapters/platform-sync.js");
  assert.deepEqual(getDefaults(), { statusLabels: {}, markers: {} });
});

test("platform-sync verification keys override legacy literal values", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-platform-defaults-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const binDir = path.join(tempRoot, "bin");
  const ghPath = path.join(binDir, "gh");
  const scriptCopy = path.join(tempRoot, ".agents/scripts/validate-artifact.js");
  const adapterCopy = path.join(tempRoot, ".agents/scripts/platform-adapters/platform-sync.js");
  const issuePath = path.join(tempRoot, "issue.json");
  const commentsPath = path.join(tempRoot, "comments.json");

  try {
    initGitRepo(tempRoot);
    write(path.join(tempRoot, "package.json"), JSON.stringify({ type: "module" }));
    write(scriptCopy, read(".agents/scripts/validate-artifact.js"));
    write(adapterCopy, read(".agents/scripts/platform-adapters/platform-sync.js"));
    writeFakeGh(ghPath);
    writeTask(taskDir);
    writeJson(issuePath, {
      state: "OPEN",
      labels: [{ name: "status: in-progress" }],
      body: "",
      milestone: null
    });
    writeJson(commentsPath, [
      { body: "<!-- sync-issue:TASK-20260328-000001:implementation -->\n## Implementation" }
    ]);

    writeJson(path.join(tempRoot, ".agents/skills/key-priority/config/verify.json"), {
      checks: {
        "platform-sync": {
          when: "issue_number_exists",
          expected_status_label: "status: blocked",
          expected_status_label_key: "inProgress",
          expected_comment_marker: "<!-- sync-issue:{task-id}:wrong -->",
          expected_comment_marker_key: "artifact"
        }
      }
    });

    const result = runValidator(scriptCopy, taskDir, "key-priority", {
      ...process.env,
      PATH: pathWithPrependedBin(binDir),
      GH_FAKE_ISSUE_PATH: issuePath,
      GH_FAKE_COMMENTS_PATH: commentsPath,
      GH_FAKE_ISSUE_NUMBER: "65"
    });

    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("platform-sync verification keeps legacy literal fallback", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-platform-legacy-"));
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const binDir = path.join(tempRoot, "bin");
  const ghPath = path.join(binDir, "gh");
  const scriptCopy = path.join(tempRoot, ".agents/scripts/validate-artifact.js");
  const adapterCopy = path.join(tempRoot, ".agents/scripts/platform-adapters/platform-sync.js");
  const issuePath = path.join(tempRoot, "issue.json");

  try {
    initGitRepo(tempRoot);
    write(path.join(tempRoot, "package.json"), JSON.stringify({ type: "module" }));
    write(scriptCopy, read(".agents/scripts/validate-artifact.js"));
    write(adapterCopy, read(".agents/scripts/platform-adapters/platform-sync.js"));
    writeFakeGh(ghPath);
    writeTask(taskDir);
    writeJson(issuePath, {
      state: "OPEN",
      labels: [{ name: "status: in-progress" }],
      body: "",
      milestone: null
    });

    writeJson(path.join(tempRoot, ".agents/skills/legacy/config/verify.json"), {
      checks: {
        "platform-sync": {
          when: "issue_number_exists",
          expected_status_label: "status: in-progress"
        }
      }
    });

    const result = runValidator(scriptCopy, taskDir, "legacy", {
      ...process.env,
      PATH: pathWithPrependedBin(binDir),
      GH_FAKE_ISSUE_PATH: issuePath
    });

    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
