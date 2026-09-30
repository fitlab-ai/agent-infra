import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadFreshEsm } from "../../helpers.ts";
import type { SyncTemplatesModule } from "../../helpers.ts";

const CANONICAL_AGENT_CLIENTS = [
  "claude-code",
  "codex",
  "antigravity-cli",
  "opencode",
  "traecli"
].map((id) => ({ id, enabled: true, installInSandbox: true }));

function writeFile(root: string, relativePath: string, content: string) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
}

function writeJson(root: string, relativePath: string, value: unknown) {
  writeFile(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makeTemplateRoot(tmpDir: string) {
  const templateRoot = path.join(tmpDir, "template-root");
  writeJson(tmpDir, "package.json", {
    name: "@fitlab-ai/agent-infra",
    version: "0.0.0-test"
  });
  writeFile(
    templateRoot,
    ".agents/skills/analyze-task/SKILL.md",
    [
      "---",
      "name: analyze-task",
      'description: "Analyze requirements for analyze-task"',
      "---",
      "",
      "# Analyze Task",
      ""
    ].join("\n")
  );
  return templateRoot;
}

function makeProject(projectRoot: string, overrides: Record<string, unknown> = {}) {
  writeJson(projectRoot, ".agents/.airc.json", {
    project: "demo",
    org: "acme",
    language: "en",
    agentClients: CANONICAL_AGENT_CLIENTS,
    platform: { type: "github" },
    files: {
      managed: [".agents/skills/", ".claude/commands/", ".opencode/commands/"],
      merged: [],
      ejected: []
    },
    ...overrides
  });

  writeFile(
    projectRoot,
    ".agents/skills/local-check/SKILL.md",
    [
      "---",
      "name: local-check",
      'description: "Manual check"',
      "---",
      "",
      "# Local Check",
      ""
    ].join("\n")
  );
}

test("syncTemplates keeps built-in custom skill command generation unchanged without customTUIs", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-custom-tuis-compatible-"));

  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = makeTemplateRoot(tmpDir);
    makeProject(projectRoot);

    const { syncTemplates } = await loadFreshEsm<SyncTemplatesModule>(".agents/skills/update-agent-infra/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot, templateRoot);

    assert.deepEqual(report.custom.detected, ["local-check"]);
    assert.equal(report.custom.commands.generated.length, 3);
    assert.ok(report.custom.commands.generated.includes(".claude/commands/local-check.md"));
    assert.ok(report.custom.commands.generated.includes(".opencode/commands/local-check.md"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
