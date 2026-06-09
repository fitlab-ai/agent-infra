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

test("agent-infra update backfills missing requiresPullRequest to true", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-requires-pr-missing-"));
  try {
    makeStubProject(tmpDir, {});

    execFileSync(process.execPath, cliArgs("update"), {
      cwd: tmpDir,
      stdio: "pipe",
      encoding: "utf8"
    });

    const updated = readUpdatedConfig(tmpDir);
    assert.equal(updated.requiresPullRequest, true,
      "missing requiresPullRequest field should be backfilled to true");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("agent-infra update preserves an explicit requiresPullRequest=false", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-requires-pr-false-"));
  try {
    makeStubProject(tmpDir, { requiresPullRequest: false });

    execFileSync(process.execPath, cliArgs("update"), {
      cwd: tmpDir,
      stdio: "pipe",
      encoding: "utf8"
    });

    const updated = readUpdatedConfig(tmpDir);
    assert.equal(updated.requiresPullRequest, false,
      "explicit requiresPullRequest=false should be preserved as-is");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
