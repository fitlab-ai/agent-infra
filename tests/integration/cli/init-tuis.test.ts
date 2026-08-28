import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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

const PLATFORM_DEFAULT_ENGINES: Partial<Record<NodeJS.Platform, string>> = {
  linux: "native",
  darwin: "colima",
  win32: "wsl2"
};
const ENGINE_NL = PLATFORM_DEFAULT_ENGINES[os.platform()] ? "\n" : "";

// Prompt sequence for `ai init` (after this task):
//   1. project name
//   2. org
//   3. language
//   4. sandbox engine (only when engineChoices.length > 0; otherwise no prompt)
//   5. platform
//   6. built-in TUI multi-select
//   7. template sources
//   8. skill sources
function makeInput(parts: {
  project?: string;
  org?: string;
  language?: string;
  platform?: string;
  tuis: string;
  templateSources?: string;
  skillSources?: string;
}): string {
  return [
    parts.project ?? "demoproj",
    parts.org ?? "demoorg",
    parts.language ?? "",          // default zh-CN
    ENGINE_NL.replace(/\n$/, ""),  // engine default (bare enter when applicable)
    parts.platform ?? "github",
    parts.tuis,
    parts.templateSources ?? "",
    parts.skillSources ?? ""
  ].join("\n") + "\n";
}

test("ai init default-selects all built-in TUIs on bare Enter", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-init-tuis-default-"));
  try {
    execFileSync(process.execPath, cliArgs("init"), {
      cwd: tmpDir,
      input: makeInput({ tuis: "" }),
      stdio: "pipe"
    });

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, ".agents/.airc.json"), "utf8"));
    assert.deepEqual(cfg.agentClients, canonical(AGENT_CLIENT_IDS));
    assert.equal("tuis" in cfg, false);
    assert.ok(fs.existsSync(path.join(tmpDir, ".claude/commands/update-agent-infra.md")));
    assert.ok(fs.existsSync(path.join(tmpDir, ".opencode/commands/update-agent-infra.md")));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ai init persists subset selection and skips seed for disabled TUIs", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-init-tuis-subset-"));
  try {
    const output = execFileSync(process.execPath, cliArgs("init"), {
      cwd: tmpDir,
      input: makeInput({ tuis: "1,3" }),
      stdio: "pipe",
      encoding: "utf8"
    });

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, ".agents/.airc.json"), "utf8"));
    assert.deepEqual(cfg.agentClients, canonical(["claude-code", "antigravity-cli"]));
    assert.ok(fs.existsSync(path.join(tmpDir, ".claude/commands/update-agent-infra.md")));
    assert.ok(!fs.existsSync(path.join(tmpDir, ".opencode/commands/update-agent-infra.md")));

    // Disabled TUI owned paths are dropped from default managed registry.
    assert.ok(!cfg.files.managed.includes(".opencode/commands/"));
    assert.ok(!cfg.files.managed.includes(".codex/hooks.json"));
    // Enabled TUI owned paths are kept.
    assert.ok(cfg.files.managed.includes(".claude/commands/"));

    // Next-step hint should advertise enabled TUIs but skip disabled rows.
    const nextStep = output.slice(output.indexOf("Next step:"));
    assert.match(nextStep, /Claude Code:\s+\/update-agent-infra/);
    assert.match(nextStep, /Antigravity CLI:\s+\/update-agent-infra/);
    assert.doesNotMatch(nextStep, /OpenCode/);
    assert.doesNotMatch(nextStep, /\$update-agent-infra/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ai init persists tuis: [] when user types 'none' and skips all built-in seed installs", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-init-tuis-none-"));
  try {
    const output = execFileSync(process.execPath, cliArgs("init"), {
      cwd: tmpDir,
      input: makeInput({ tuis: "none" }),
      stdio: "pipe",
      encoding: "utf8"
    });

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, ".agents/.airc.json"), "utf8"));
    assert.deepEqual(cfg.agentClients, canonical([]));
    // No built-in TUI seed command file is installed.
    assert.ok(!fs.existsSync(path.join(tmpDir, ".claude/commands/update-agent-infra.md")));
    assert.ok(!fs.existsSync(path.join(tmpDir, ".opencode/commands/update-agent-infra.md")));
    // No built-in TUI owned default paths added to managed registry.
    assert.ok(!cfg.files.managed.includes(".claude/commands/"));
    assert.ok(!cfg.files.managed.includes(".opencode/commands/"));
    assert.ok(!cfg.files.managed.includes(".codex/hooks.json"));
    // Next-step block points users to customTUIs.
    assert.match(output, /No Agent Client project integration enabled/);
    assert.match(output, /Configure "customTUIs"/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ai init persists tuis in canonical prompt order even when user types reversed", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-init-tuis-order-"));
  try {
    execFileSync(process.execPath, cliArgs("init"), {
      cwd: tmpDir,
      // User types "3,1" -> antigravity-cli, claude-code. AC2.2 requires the persisted
      // array to follow prompt order: claude-code, antigravity-cli.
      input: makeInput({ tuis: "3,1" }),
      stdio: "pipe"
    });

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, ".agents/.airc.json"), "utf8"));
    assert.deepEqual(cfg.agentClients, canonical(["claude-code", "antigravity-cli"]));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ai init rejects duplicate selection (1,1) with non-zero exit", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-init-tuis-dup-"));
  try {
    const result = spawnSync(process.execPath, cliArgs("init"), {
      cwd: tmpDir,
      input: makeInput({ tuis: "1,1" }),
      stdio: "pipe",
      encoding: "utf8"
    });

    assert.notEqual(result.status, 0, "init must exit non-zero on duplicate selection");
    assert.match(result.stderr, /Duplicate selection/);
    assert.ok(!fs.existsSync(path.join(tmpDir, ".agents/.airc.json")), "no .airc.json on failure");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ai init rejects whitespace-only TUI input with non-zero exit", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-init-tuis-blank-"));
  try {
    const result = spawnSync(process.execPath, cliArgs("init"), {
      cwd: tmpDir,
      input: makeInput({ tuis: " " }),
      stdio: "pipe",
      encoding: "utf8"
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /empty token/);
    assert.ok(!fs.existsSync(path.join(tmpDir, ".agents/.airc.json")));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ai init rejects out-of-range selection (6) with non-zero exit", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-init-tuis-oor-"));
  try {
    const result = spawnSync(process.execPath, cliArgs("init"), {
      cwd: tmpDir,
      input: makeInput({ tuis: "6" }),
      stdio: "pipe",
      encoding: "utf8"
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /out of range/);
    assert.ok(!fs.existsSync(path.join(tmpDir, ".agents/.airc.json")));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
