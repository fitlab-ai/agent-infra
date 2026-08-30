import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { CLI_PATH, cliArgs } from "../../helpers.ts";
import { AGENT_CLIENT_IDS } from "../../../lib/agent-clients/types.ts";

function canonical(enabled: readonly string[]) {
  return AGENT_CLIENT_IDS.map((id) => ({
    id,
    enabled: enabled.includes(id),
    installInSandbox: true
  }));
}

function makeProject(tmpDir: string, config: Record<string, unknown>) {
  fs.mkdirSync(path.join(tmpDir, ".agents"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, ".agents", ".airc.json"),
    JSON.stringify(config, null, 2) + "\n",
    "utf8"
  );
  fs.mkdirSync(path.join(tmpDir, ".agents", "skills", "update-agent-infra"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, ".agents", "skills", "update-agent-infra", "SKILL.md"),
    "stale skill\n",
    "utf8"
  );
}

test("agent-infra update with canonical state refreshes all built-in client seeds", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-update-tuis-default-"));
  try {
    makeProject(tmpDir, {
      project: "demo",
      org: "acme",
      language: "en",
      templateVersion: "stale",
      agentClients: canonical(AGENT_CLIENT_IDS),
      files: { managed: [], merged: [], ejected: [] }
    });

    execFileSync(process.execPath, cliArgs("update"), {
      cwd: tmpDir,
      stdio: "pipe",
      encoding: "utf8"
    });

    assert.ok(fs.existsSync(path.join(tmpDir, ".claude/commands/update-agent-infra.md")));
    assert.ok(fs.existsSync(path.join(tmpDir, ".opencode/commands/update-agent-infra.md")));

    const updated = JSON.parse(fs.readFileSync(path.join(tmpDir, ".agents/.airc.json"), "utf8"));
    assert.deepEqual(updated.agentClients, canonical(AGENT_CLIENT_IDS));
    // All built-in TUI owned paths still get registered.
    assert.ok(updated.files.managed.includes(".claude/commands/"));
    assert.ok(updated.files.managed.includes(".opencode/commands/"));
    assert.ok(updated.files.managed.includes(".codex/hooks.json"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("agent-infra update with canonical subset only refreshes enabled client seeds", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-update-tuis-subset-"));
  try {
    makeProject(tmpDir, {
      project: "demo",
      org: "acme",
      language: "en",
      templateVersion: "stale",
      agentClients: canonical(["claude-code"]),
      files: { managed: [], merged: [], ejected: [] }
    });

    execFileSync(process.execPath, cliArgs("update"), {
      cwd: tmpDir,
      stdio: "pipe",
      encoding: "utf8"
    });

    assert.ok(fs.existsSync(path.join(tmpDir, ".claude/commands/update-agent-infra.md")));
    assert.ok(!fs.existsSync(path.join(tmpDir, ".opencode/commands/update-agent-infra.md")));

    const updated = JSON.parse(fs.readFileSync(path.join(tmpDir, ".agents/.airc.json"), "utf8"));
    assert.deepEqual(updated.agentClients, canonical(["claude-code"]));
    // Disabled-TUI owned default paths are NOT added to managed registry.
    assert.ok(!updated.files.managed.includes(".opencode/commands/"));
    assert.ok(!updated.files.managed.includes(".codex/hooks.json"));
    // Enabled TUI owned default paths ARE registered.
    assert.ok(updated.files.managed.includes(".claude/commands/"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("agent-infra update with empty canonical state installs no built-in seeds", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-update-tuis-empty-"));
  try {
    makeProject(tmpDir, {
      project: "demo",
      org: "acme",
      language: "en",
      templateVersion: "stale",
      agentClients: canonical([]),
      files: { managed: [], merged: [], ejected: [] }
    });

    const output = execFileSync(process.execPath, cliArgs("update"), {
      cwd: tmpDir,
      stdio: "pipe",
      encoding: "utf8"
    });

    // No built-in TUI seed files installed.
    assert.ok(!fs.existsSync(path.join(tmpDir, ".claude/commands/update-agent-infra.md")));
    assert.ok(!fs.existsSync(path.join(tmpDir, ".opencode/commands/update-agent-infra.md")));

    const updated = JSON.parse(fs.readFileSync(path.join(tmpDir, ".agents/.airc.json"), "utf8"));
    assert.deepEqual(updated.agentClients, canonical([]));
    // No built-in TUI owned default paths registered.
    assert.ok(!updated.files.managed.includes(".claude/commands/"));
    assert.ok(!updated.files.managed.includes(".opencode/commands/"));
    assert.ok(!updated.files.managed.includes(".codex/hooks.json"));
    // Next-step hint points to customTUIs configuration.
    assert.match(output, /No Agent Client project integration enabled/);
    assert.match(output, /Configure "customTUIs"/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("agent-infra update is idempotent: second run does not change canonical state or duplicate entries", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-update-tuis-idempotent-"));
  try {
    makeProject(tmpDir, {
      project: "demo",
      org: "acme",
      language: "en",
      templateVersion: "stale",
      agentClients: canonical(["claude-code", "opencode"]),
      files: { managed: [], merged: [], ejected: [] }
    });

    execFileSync(process.execPath, cliArgs("update"), { cwd: tmpDir, stdio: "pipe", encoding: "utf8" });
    const afterFirst = fs.readFileSync(path.join(tmpDir, ".agents/.airc.json"), "utf8");

    execFileSync(process.execPath, cliArgs("update"), { cwd: tmpDir, stdio: "pipe", encoding: "utf8" });
    const afterSecond = fs.readFileSync(path.join(tmpDir, ".agents/.airc.json"), "utf8");

    assert.equal(afterFirst, afterSecond, "second update must be a no-op");
    const cfg = JSON.parse(afterSecond);
    assert.deepEqual(cfg.agentClients, canonical(["claude-code", "opencode"]));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
