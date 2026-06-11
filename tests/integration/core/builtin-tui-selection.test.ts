import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadFreshEsm } from "../../helpers.ts";
import type { SyncTemplatesModule } from "../../helpers.ts";

type SyncReport = ReturnType<SyncTemplatesModule["syncTemplates"]> & {
  managed: { skippedTUI?: string[] };
};

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
  // Minimal skills/ dir so listTemplateSkillNames returns at least one entry.
  writeFile(
    templateRoot,
    ".agents/skills/analyze-task/SKILL.md",
    [
      "---",
      "name: analyze-task",
      'description: "Analyze requirements for analyze-task"',
      "---",
      ""
    ].join("\n")
  );
  // Built-in TUI template files so the sync loop finds something to write.
  writeFile(templateRoot, ".claude/commands/update-agent-infra.md", "claude command\n");
  writeFile(
    templateRoot,
    ".gemini/commands/_project_/update-agent-infra.toml",
    "gemini command\n"
  );
  writeFile(templateRoot, ".opencode/commands/update-agent-infra.md", "opencode command\n");
  writeFile(templateRoot, ".codex/hooks.json", "{}\n");
  return templateRoot;
}

function makeProject(projectRoot: string, overrides: Record<string, unknown> = {}) {
  const baseManaged = [
    ".agents/skills/",
    ".claude/commands/",
    ".gemini/commands/",
    ".opencode/commands/",
    ".codex/hooks.json"
  ];
  writeJson(projectRoot, ".agents/.airc.json", {
    project: "demo",
    org: "acme",
    language: "en",
    platform: { type: "github" },
    files: {
      managed: baseManaged,
      merged: [],
      ejected: []
    },
    ...overrides
  });
  // Custom skill so the custom-skill command generation runs.
  writeFile(
    projectRoot,
    ".agents/skills/local-check/SKILL.md",
    [
      "---",
      "name: local-check",
      'description: "Manual check"',
      "---",
      ""
    ].join("\n")
  );
}

test("syncTemplates: missing tuis field keeps full built-in TUI behavior (regression)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-tui-default-"));
  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = makeTemplateRoot(tmpDir);
    makeProject(projectRoot);

    const { syncTemplates } = await loadFreshEsm<SyncTemplatesModule>(
      ".agents/skills/update-agent-infra/scripts/sync-templates.js"
    );
    const report = syncTemplates(projectRoot, templateRoot) as SyncReport;

    assert.equal(report.managed.skippedTUI?.length ?? 0, 0);
    assert.ok(fs.existsSync(path.join(projectRoot, ".claude/commands/update-agent-infra.md")));
    assert.ok(fs.existsSync(path.join(projectRoot, ".gemini/commands/demo/update-agent-infra.toml")));
    assert.ok(fs.existsSync(path.join(projectRoot, ".opencode/commands/update-agent-infra.md")));
    assert.ok(fs.existsSync(path.join(projectRoot, ".codex/hooks.json")));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates: tuis subset skips owned managed/merged entries", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-tui-subset-"));
  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = makeTemplateRoot(tmpDir);
    makeProject(projectRoot, { tuis: ["claude-code"] });

    const { syncTemplates } = await loadFreshEsm<SyncTemplatesModule>(
      ".agents/skills/update-agent-infra/scripts/sync-templates.js"
    );
    const report = syncTemplates(projectRoot, templateRoot) as SyncReport;

    const skipped = report.managed.skippedTUI ?? [];
    assert.ok(skipped.includes(".gemini/commands/"), `expected .gemini/commands/ in skippedTUI, got ${JSON.stringify(skipped)}`);
    assert.ok(skipped.includes(".opencode/commands/"));
    assert.ok(skipped.includes(".codex/hooks.json"));
    assert.ok(fs.existsSync(path.join(projectRoot, ".claude/commands/update-agent-infra.md")));
    assert.ok(!fs.existsSync(path.join(projectRoot, ".gemini/commands/demo/update-agent-infra.toml")));
    assert.ok(!fs.existsSync(path.join(projectRoot, ".codex/hooks.json")));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates: switching tuis cleans up previously written owned files", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-tui-switch-"));
  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = makeTemplateRoot(tmpDir);
    makeProject(projectRoot, { tuis: ["claude-code", "gemini-cli"] });

    const { syncTemplates } = await loadFreshEsm<SyncTemplatesModule>(
      ".agents/skills/update-agent-infra/scripts/sync-templates.js"
    );
    syncTemplates(projectRoot, templateRoot);
    assert.ok(fs.existsSync(path.join(projectRoot, ".gemini/commands/demo/update-agent-infra.toml")));

    // Flip to disable gemini-cli.
    const cfgPath = path.join(projectRoot, ".agents/.airc.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.tuis = ["claude-code"];
    fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);

    const secondReport = syncTemplates(projectRoot, templateRoot);
    assert.ok(secondReport.managed.removed.some((p) => p.startsWith(".gemini/commands/")));
    assert.ok(!fs.existsSync(path.join(projectRoot, ".gemini/commands/demo/update-agent-infra.toml")));
    // Empty .gemini/commands/ directory should be cleaned up.
    assert.ok(!fs.existsSync(path.join(projectRoot, ".gemini/commands")));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates: independent customTUI dir is unaffected by disabled built-in TUI", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-tui-custom-indep-"));
  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = makeTemplateRoot(tmpDir);
    makeProject(projectRoot, {
      tuis: ["claude-code"],
      customTUIs: [{ name: "Acme TUI", dir: ".acme/commands", invoke: "acme ${skillName}" }]
    });
    // Seed an existing custom command file referencing analyze-task so the
    // custom-skill-command synthesis path doesn't fail. Use the seeded
    // template skill description verbatim.
    writeFile(
      projectRoot,
      ".acme/commands/analyze-task.cmd",
      "description: Analyze requirements for analyze-task\nskill: .agents/skills/analyze-task/SKILL.md\n"
    );

    const { syncTemplates } = await loadFreshEsm<SyncTemplatesModule>(
      ".agents/skills/update-agent-infra/scripts/sync-templates.js"
    );
    const report = syncTemplates(projectRoot, templateRoot);

    assert.ok(fs.existsSync(path.join(projectRoot, ".acme/commands/analyze-task.cmd")));
    // No .acme/* path should be in removed.
    assert.ok(!report.managed.removed.some((p) => p.startsWith(".acme/")));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates: customTUI dir under disabled built-in TUI owned prefix is protected", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-tui-custom-overlap-"));
  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = makeTemplateRoot(tmpDir);
    makeProject(projectRoot, {
      tuis: ["claude-code"],
      customTUIs: [{ name: "My Codex", dir: ".codex/commands", invoke: "codex ${skillName}" }]
    });
    // Seed a customTUI reference file under the disabled-TUI owned prefix.
    writeFile(
      projectRoot,
      ".codex/commands/analyze-task.cmd",
      "description: Analyze requirements for analyze-task\nskill: .agents/skills/analyze-task/SKILL.md\n"
    );
    // Also seed .codex/hooks.json — this is NOT customTUI-protected and SHOULD be removed.
    writeFile(projectRoot, ".codex/hooks.json", "{}\n");

    const { syncTemplates } = await loadFreshEsm<SyncTemplatesModule>(
      ".agents/skills/update-agent-infra/scripts/sync-templates.js"
    );
    const report = syncTemplates(projectRoot, templateRoot);

    // customTUI file under disabled-owned prefix must survive.
    assert.ok(
      fs.existsSync(path.join(projectRoot, ".codex/commands/analyze-task.cmd")),
      "customTUI file under .codex/ must not be deleted"
    );
    assert.ok(!report.managed.removed.includes(".codex/commands/analyze-task.cmd"));
    // .codex/hooks.json (built-in managed, not custom-protected) IS removed.
    assert.ok(!fs.existsSync(path.join(projectRoot, ".codex/hooks.json")));
    assert.ok(report.managed.removed.includes(".codex/hooks.json"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates: tuis: [] disables every built-in TUI and skips all owned defaults", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-tui-empty-"));
  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = makeTemplateRoot(tmpDir);
    makeProject(projectRoot, { tuis: [] });

    const { syncTemplates } = await loadFreshEsm<SyncTemplatesModule>(
      ".agents/skills/update-agent-infra/scripts/sync-templates.js"
    );
    const report = syncTemplates(projectRoot, templateRoot) as SyncReport;

    const skipped = report.managed.skippedTUI ?? [];
    // Every built-in TUI owned default path should be skipped.
    assert.ok(skipped.includes(".claude/commands/"));
    assert.ok(skipped.includes(".gemini/commands/"));
    assert.ok(skipped.includes(".opencode/commands/"));
    assert.ok(skipped.includes(".codex/hooks.json"));
    // No built-in TUI files written.
    assert.ok(!fs.existsSync(path.join(projectRoot, ".claude/commands/update-agent-infra.md")));
    assert.ok(!fs.existsSync(path.join(projectRoot, ".gemini/commands/demo/update-agent-infra.toml")));
    assert.ok(!fs.existsSync(path.join(projectRoot, ".opencode/commands/update-agent-infra.md")));
    assert.ok(!fs.existsSync(path.join(projectRoot, ".codex/hooks.json")));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates: ejected entries owned by disabled TUIs are preserved and not removed", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-tui-ejected-"));
  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = makeTemplateRoot(tmpDir);
    makeProject(projectRoot, {
      tuis: ["claude-code"],
      files: {
        managed: [
          ".agents/skills/",
          ".claude/commands/",
          ".gemini/commands/",
          ".opencode/commands/"
        ],
        merged: [],
        ejected: [".codex/hooks.json"]
      }
    });
    // Local copy that the user has explicitly retained.
    writeFile(projectRoot, ".codex/hooks.json", '{"keep": true}\n');

    const { syncTemplates } = await loadFreshEsm<SyncTemplatesModule>(
      ".agents/skills/update-agent-infra/scripts/sync-templates.js"
    );
    const report = syncTemplates(projectRoot, templateRoot);

    assert.equal(
      fs.readFileSync(path.join(projectRoot, ".codex/hooks.json"), "utf8"),
      '{"keep": true}\n'
    );
    assert.ok(!report.managed.removed.includes(".codex/hooks.json"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
