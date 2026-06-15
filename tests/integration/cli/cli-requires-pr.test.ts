import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CLI_PATH, cliArgs } from "../../helpers.ts";

function makeStubProject(tmpDir: string, configOverrides: Record<string, unknown>): void {
  const base = {
    project: "seedproj",
    org: "seedorg",
    language: "zh-CN",
    templateVersion: "stale",
    files: {
      managed: [],
      merged: [],
      ejected: []
    }
  };
  const config = { ...base, ...configOverrides };

  fs.mkdirSync(path.join(tmpDir, ".agents"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, ".agents", ".airc.json"),
    JSON.stringify(config, null, 2) + "\n",
    "utf8"
  );
  fs.mkdirSync(path.join(tmpDir, ".agents", "skills", "update-agent-infra"), {
    recursive: true
  });
  fs.writeFileSync(
    path.join(tmpDir, ".agents", "skills", "update-agent-infra", "SKILL.md"),
    "stale skill\n",
    "utf8"
  );
}

function readUpdatedConfig(tmpDir: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(tmpDir, ".agents", ".airc.json"), "utf8")
  );
}

function runUpdate(tmpDir: string): Record<string, unknown> {
  execFileSync(process.execPath, cliArgs("update"), {
    cwd: tmpDir,
    stdio: "pipe",
    encoding: "utf8"
  });
  return readUpdatedConfig(tmpDir);
}

test("agent-infra update migrates legacy requiresPullRequest=true to prFlow=required", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-prflow-true-"));
  try {
    makeStubProject(tmpDir, { requiresPullRequest: true });

    const updated = runUpdate(tmpDir);
    assert.equal(updated.prFlow, "required",
      "legacy requiresPullRequest=true should map to prFlow=required");
    assert.ok(!("requiresPullRequest" in updated),
      "legacy requiresPullRequest key should be removed after migration");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("agent-infra update migrates legacy requiresPullRequest=false to prFlow=disabled", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-prflow-false-"));
  try {
    makeStubProject(tmpDir, { requiresPullRequest: false });

    const updated = runUpdate(tmpDir);
    assert.equal(updated.prFlow, "disabled",
      "legacy requiresPullRequest=false should map to prFlow=disabled (no-PR preserved)");
    assert.ok(!("requiresPullRequest" in updated),
      "legacy requiresPullRequest key should be removed after migration");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("agent-infra update leaves a config without the legacy field untouched (no prFlow added)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-prflow-missing-"));
  try {
    makeStubProject(tmpDir, {});

    const updated = runUpdate(tmpDir);
    assert.ok(!("requiresPullRequest" in updated),
      "no legacy field should be introduced");
    assert.ok(!("prFlow" in updated),
      "missing field means default (recommend PR); update must not add prFlow");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("agent-infra update is idempotent for an already-migrated prFlow config", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-prflow-idempotent-"));
  try {
    makeStubProject(tmpDir, { prFlow: "required" });

    const updated = runUpdate(tmpDir);
    assert.equal(updated.prFlow, "required",
      "already-migrated prFlow should be preserved as-is");
    assert.ok(!("requiresPullRequest" in updated),
      "no legacy field should be reintroduced");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
