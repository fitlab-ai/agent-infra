import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { filePath, exists, read } from "./helpers.js";

const scriptPath = filePath(".agents/scripts/validate-artifact.js");

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + " " + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(":");
}

function write(filePathname, content) {
  fs.mkdirSync(path.dirname(filePathname), { recursive: true });
  fs.writeFileSync(filePathname, content, "utf8");
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

function runValidator(args, options = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    cwd: filePath("."),
    env: {
      ...process.env,
      ...options.env
    }
  });
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
    const staleTimestamp = formatTimestamp(new Date(Date.now() - 45 * 60_000));
    const staleTask = buildTaskContent(
      { updated_at: staleTimestamp },
      { NOW: staleTimestamp }
    );

    write(path.join(taskDir, "task.md"), staleTask);
    write(path.join(taskDir, "implementation.md"), loadFixture("valid-implementation.md"));

    const result = runValidator(["check", "activity-log", taskDir, "--skill", "implement-task"], {
      env: {
        TZ: "Asia/Shanghai"
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

test("validate-artifact github-sync blocks after retry exhaustion on gh network errors", () => {
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
        PATH: `${binDir}:${process.env.PATH}`,
        VALIDATE_ARTIFACT_RETRY_DELAYS_MS: "0,0"
      }
    });

    assert.equal(result.status, 2);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.gate, "blocked");
    const githubCheck = payload.checks.find((check) => check.type === "github-sync");
    assert.equal(githubCheck.status, "blocked");
    assert.equal(githubCheck.fail_type, "network_error");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("verification assets are present in local and template trees", () => {
  [
    ".agents/scripts/validate-artifact.js",
    "templates/.agents/scripts/validate-artifact.js",
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
});
