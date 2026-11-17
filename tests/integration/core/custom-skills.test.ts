import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { createTempDir, loadFreshEsm } from "../../helpers.ts";
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
  fs.mkdirSync(path.join(templateRoot, ".agents/skills"), { recursive: true });
  fs.mkdirSync(path.join(templateRoot, ".claude/commands"), { recursive: true });
  fs.mkdirSync(path.join(templateRoot, ".opencode/commands"), { recursive: true });
  return templateRoot;
}

function parseMarkdownFrontmatter(content: string) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  const frontmatter = match?.[1];
  assert.ok(frontmatter, "generated Markdown command should include frontmatter");
  return parseYaml(frontmatter);
}

test("syncTemplates preserves manual custom skills and generates commands for manual and sourced skills", async () => {
  const tmpDir = createTempDir("agent-infra-custom-skills-");
  const sourceRoot = createTempDir("agent-infra-custom-source-");

  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = makeTemplateRoot(tmpDir);

    fs.mkdirSync(projectRoot, { recursive: true });

    writeJson(projectRoot, ".agents/.airc.json", {
      project: "demo",
      org: "acme",
      language: "zh-CN",
      agentClients: CANONICAL_AGENT_CLIENTS,
      platform: { type: "github" },
      skills: {
        sources: [
          { type: "local", path: sourceRoot }
        ],
        registrations: [
          { name: "local-rules", type: "project", path: ".agents/skills/local-rules" },
          { name: "shared-rules", type: "local", path: path.join(sourceRoot, "shared-rules") }
        ]
      },
      files: {
        managed: [".agents/skills/", ".claude/commands/", ".opencode/commands/"],
        merged: [],
        ejected: []
      }
    });

    writeFile(
      projectRoot,
      ".agents/skills/local-rules/SKILL.md",
      [
        "---",
        'name: local-rules',
        'description: |',
        '  本地规范检查。',
        '  当提交前需要本地规则时使用。',
        'args: "<task-id>"',
        'disable-model-invocation: true',
        "---",
        "",
        "# Local Rules",
        ""
      ].join("\n")
    );
    writeFile(projectRoot, ".agents/skills/local-rules/reference/checklist.md", "manual checklist\n");

    writeFile(
      sourceRoot,
      "shared-rules/SKILL.md",
      [
        "---",
        "name: shared-rules",
        "description: >",
        "  Shared source rules",
        "---",
        "",
        "# Shared Rules",
        ""
      ].join("\n")
    );
    writeFile(sourceRoot, "shared-rules/reference/guide.md", "source guide\n");

    const { syncTemplates } = await loadFreshEsm<SyncTemplatesModule>(".agents/skills/update-agent-infra/scripts/sync-templates.js");
    const firstReport = syncTemplates(projectRoot, templateRoot);
    const secondReport = syncTemplates(projectRoot, templateRoot);

    assert.deepEqual(firstReport.custom.detected, ["local-rules", "shared-rules"]);
    assert.ok(firstReport.custom.generated.includes(".agents/skills/shared-rules/SKILL.md"));
    assert.ok(firstReport.custom.generated.includes(".agents/skills/shared-rules/reference/guide.md"));
    assert.equal(
      fs.readFileSync(path.join(projectRoot, ".agents/skills/local-rules/reference/checklist.md"), "utf8"),
      "manual checklist\n"
    );
    assert.equal(
      fs.readFileSync(path.join(projectRoot, ".agents/skills/shared-rules/reference/guide.md"), "utf8"),
      "source guide\n"
    );

    const claudeCommand = fs.readFileSync(path.join(projectRoot, ".claude/commands/local-rules.md"), "utf8");
    const openCodeCommand = fs.readFileSync(path.join(projectRoot, ".opencode/commands/local-rules.md"), "utf8");
    const traeCommand = fs.readFileSync(path.join(projectRoot, ".traecli/commands/local-rules.md"), "utf8");
    const expectedDescription = "本地规范检查。\n当提交前需要本地规则时使用。";

    assert.match(claudeCommand, /^description: \|-\n  本地规范检查。\n  当提交前需要本地规则时使用。$/m);
    assert.match(claudeCommand, /usage: "\/local-rules <task-id>"/);
    assert.match(claudeCommand, /^disable-model-invocation: true$/m);
    assert.doesNotMatch(claudeCommand, /ARGUMENTS:/);
    assert.match(claudeCommand, /读取并执行 `\.agents\/skills\/local-rules\/SKILL\.md` 中的 local-rules 技能。/);
    assert.doesNotMatch(openCodeCommand, /disable-model-invocation/);
    assert.match(openCodeCommand, /参数：\$ARGUMENTS/);
    assert.match(openCodeCommand, /^description: \|-\n  本地规范检查。\n  当提交前需要本地规则时使用。$/m);
    assert.equal(parseMarkdownFrontmatter(claudeCommand).description, expectedDescription);
    assert.equal(parseMarkdownFrontmatter(openCodeCommand).description, expectedDescription);
    assert.equal(parseMarkdownFrontmatter(traeCommand).description, expectedDescription);
    assert.match(traeCommand, /参数：\$ARGUMENTS/);
    assert.match(traeCommand, /读取并执行 `\.agents\/skills\/local-rules\/SKILL\.md`/);

    const sharedClaudeCommand = fs.readFileSync(path.join(projectRoot, ".claude/commands/shared-rules.md"), "utf8");
    assert.doesNotMatch(sharedClaudeCommand, /^disable-model-invocation: true$/m);

    assert.equal(firstReport.custom.commands.generated.length, 6);
    assert.equal(fs.existsSync(path.join(projectRoot, ".traecli/commands/local-rules.md")), true);
    assert.equal(fs.existsSync(path.join(projectRoot, ".trae/skills/local-rules.md")), false);
    assert.equal(secondReport.custom.commands.updated.length, 0);
    assert.equal(secondReport.custom.commands.generated.length, 0);
    assert.ok(secondReport.custom.commands.unchanged.includes(".claude/commands/local-rules.md"));
    assert.ok(fs.existsSync(path.join(projectRoot, ".agents/skills/local-rules/SKILL.md")));
    assert.ok(fs.existsSync(path.join(projectRoot, ".claude/commands/shared-rules.md")));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test("syncTemplates cleans stale files from sourced skills without touching manual custom skills", async () => {
  const tmpDir = createTempDir("agent-infra-custom-cleanup-");
  const sourceRoot = createTempDir("agent-infra-custom-cleanup-source-");

  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = makeTemplateRoot(tmpDir);

    fs.mkdirSync(projectRoot, { recursive: true });

    writeJson(projectRoot, ".agents/.airc.json", {
      project: "demo",
      org: "acme",
      language: "en",
      agentClients: CANONICAL_AGENT_CLIENTS,
      platform: { type: "github" },
      skills: {
        sources: [
          { type: "local", path: sourceRoot }
        ],
        registrations: [
          { name: "shared-rules", type: "local", path: path.join(sourceRoot, "shared-rules") },
          { name: "manual-only", type: "project", path: ".agents/skills/manual-only" }
        ]
      },
      files: {
        managed: [".agents/skills/", ".claude/commands/", ".opencode/commands/"],
        merged: [],
        ejected: []
      }
    });

    writeFile(projectRoot, ".agents/skills/manual-only/SKILL.md", "---\nname: manual-only\ndescription: \"Manual only\"\n---\n");
    writeFile(projectRoot, ".agents/skills/manual-only/notes.md", "keep me\n");

    writeFile(sourceRoot, "shared-rules/SKILL.md", "---\nname: shared-rules\ndescription: \"Shared\"\n---\n");
    writeFile(sourceRoot, "shared-rules/reference/guide.md", "initial guide\n");

    const { syncTemplates } = await loadFreshEsm<SyncTemplatesModule>(".agents/skills/update-agent-infra/scripts/sync-templates.js");
    syncTemplates(projectRoot, templateRoot);

    fs.unlinkSync(path.join(sourceRoot, "shared-rules/reference/guide.md"));
    writeFile(projectRoot, ".agents/skills/shared-rules/reference/stale.md", "remove me\n");

    const secondReport = syncTemplates(projectRoot, templateRoot);

    assert.deepEqual(
      secondReport.custom.removed.sort(),
      [".agents/skills/shared-rules/reference/guide.md"]
    );
    assert.equal(fs.existsSync(path.join(projectRoot, ".agents/skills/shared-rules/reference/guide.md")), false);
    assert.equal(fs.readFileSync(path.join(projectRoot, ".agents/skills/shared-rules/reference/stale.md"), "utf8"), "remove me\n");
    assert.ok(secondReport.custom.sourceErrors.some((entry) => String(entry.reason).includes("unknown target preserved")));
    assert.equal(
      fs.readFileSync(path.join(projectRoot, ".agents/skills/manual-only/notes.md"), "utf8"),
      "keep me\n"
    );
    assert.ok(fs.existsSync(path.join(projectRoot, ".claude/commands/shared-rules.md")));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test("syncTemplates reports missing sources and skips built-in skill conflicts from custom sources", async () => {
  const tmpDir = createTempDir("agent-infra-custom-conflict-");
  const sourceRoot = createTempDir("agent-infra-custom-conflict-source-");

  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = makeTemplateRoot(tmpDir);
    const missingSource = path.join(tmpDir, "missing-source");

    fs.mkdirSync(projectRoot, { recursive: true });

    writeFile(
      templateRoot,
      ".agents/skills/review-code/SKILL.md",
      "---\nname: review-code\ndescription: \"Built in\"\n---\n"
    );
    writeFile(templateRoot, ".claude/commands/review-code.md", "builtin command\n");

    writeJson(projectRoot, ".agents/.airc.json", {
      project: "demo",
      org: "acme",
      language: "en",
      agentClients: CANONICAL_AGENT_CLIENTS,
      platform: { type: "github" },
      skills: {
        sources: [
          { type: "local", path: missingSource },
          { type: "local", path: sourceRoot }
        ],
        registrations: [
          { name: "qa-check", type: "local", path: path.join(sourceRoot, "qa-check") }
        ]
      },
      files: {
        managed: [".agents/skills/", ".claude/commands/", ".opencode/commands/"],
        merged: [],
        ejected: []
      }
    });

    writeFile(sourceRoot, "review-code/SKILL.md", "---\nname: review-code\ndescription: \"Override\"\n---\n");
    writeFile(sourceRoot, "qa-check/SKILL.md", "---\nname: qa-check\ndescription: \"QA\"\n---\n");

    const { syncTemplates } = await loadFreshEsm<SyncTemplatesModule>(".agents/skills/update-agent-infra/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot, templateRoot);

    assert.deepEqual(report.custom.detected, ["qa-check"]);
    assert.ok(
      report.custom.sourceErrors.some((entry) =>
        entry.source === missingSource && String(entry.reason).includes("unavailable")
      )
    );
    assert.ok(
      report.custom.sourceErrors.some((entry) =>
        entry.source === sourceRoot && entry.reason === "skill review-code conflicts with built-in skill"
      )
    );
    assert.equal(
      fs.readFileSync(path.join(projectRoot, ".agents/skills/review-code/SKILL.md"), "utf8"),
      "---\nname: review-code\ndescription: \"Built in\"\n---\n"
    );
    assert.equal(
      fs.readFileSync(path.join(projectRoot, ".agents/skills/qa-check/SKILL.md"), "utf8"),
      "---\nname: qa-check\ndescription: \"QA\"\n---\n"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test("syncTemplates does not materialize a skill through a symlinked parent", async () => {
  const tmpDir = createTempDir("agent-infra-custom-symlink-parent-");
  try {
    const projectRoot = path.join(tmpDir, "project");
    const sourceRoot = path.join(tmpDir, "source");
    const outside = path.join(tmpDir, "outside");
    const templateRoot = makeTemplateRoot(tmpDir);
    writeFile(sourceRoot, "guide/SKILL.md", "---\nname: guide\ndescription: Guide\n---\nSource\n");
    fs.mkdirSync(path.join(projectRoot, ".agents/skills"), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(projectRoot, ".agents/skills/guide"), "dir");
    writeJson(projectRoot, ".agents/.airc.json", {
      project: "demo", org: "acme", language: "en", agentClients: CANONICAL_AGENT_CLIENTS,
      platform: { type: "github" },
      skills: { sources: [{ type: "local", path: sourceRoot }], registrations: [{ name: "guide", type: "local", path: path.join(sourceRoot, "guide") }] },
      files: { managed: [], merged: [], ejected: [] }
    });
    const { syncTemplates } = await loadFreshEsm<SyncTemplatesModule>(".agents/skills/update-agent-infra/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot, templateRoot);
    assert.equal(fs.existsSync(path.join(outside, "SKILL.md")), false);
    assert.deepEqual(report.custom.commands.generated, [], JSON.stringify(report.custom));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates does not write a command through a symlinked client parent", async () => {
  const tmpDir = createTempDir("agent-infra-custom-command-symlink-parent-");
  try {
    const projectRoot = path.join(tmpDir, "project");
    const sourceRoot = path.join(tmpDir, "source");
    const outside = path.join(tmpDir, "outside");
    const templateRoot = makeTemplateRoot(tmpDir);
    writeFile(sourceRoot, "guide/SKILL.md", "---\nname: guide\ndescription: Guide\n---\nSource\n");
    fs.mkdirSync(path.join(projectRoot, ".agents"), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(projectRoot, ".claude"), "dir");
    writeJson(projectRoot, ".agents/.airc.json", {
      project: "demo", org: "acme", language: "en", agentClients: CANONICAL_AGENT_CLIENTS,
      platform: { type: "github" },
      skills: { sources: [{ type: "local", path: sourceRoot }], registrations: [{ name: "guide", type: "local", path: path.join(sourceRoot, "guide") }] },
      files: { managed: [], merged: [], ejected: [] }
    });
    const { syncTemplates } = await loadFreshEsm<SyncTemplatesModule>(".agents/skills/update-agent-infra/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot, templateRoot);
    assert.equal(fs.existsSync(path.join(projectRoot, ".agents/skills/guide/SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(outside, "commands/guide.md")), false);
    assert.equal(report.custom.commands.generated.includes(".claude/commands/guide.md"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates does not generate commands for an unowned materialized skill target", async () => {
  const tmpDir = createTempDir("agent-infra-custom-unowned-target-");
  try {
    const projectRoot = path.join(tmpDir, "project");
    const sourceRoot = path.join(tmpDir, "source");
    const templateRoot = makeTemplateRoot(tmpDir);
    writeFile(sourceRoot, "guide/SKILL.md", "---\nname: guide\ndescription: Source guide\n---\nSource\n");
    writeFile(projectRoot, ".agents/skills/guide/SKILL.md", "---\nname: user-guide\ndescription: User guide\n---\nUser\n");
    writeJson(projectRoot, ".agents/.airc.json", {
      project: "demo", org: "acme", language: "en", agentClients: CANONICAL_AGENT_CLIENTS,
      platform: { type: "github" },
      skills: { sources: [{ type: "local", path: sourceRoot }], registrations: [{ name: "guide", type: "local", path: path.join(sourceRoot, "guide") }] },
      files: { managed: [], merged: [], ejected: [] }
    });
    const { syncTemplates } = await loadFreshEsm<SyncTemplatesModule>(".agents/skills/update-agent-infra/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot, templateRoot);
    assert.equal(fs.readFileSync(path.join(projectRoot, ".agents/skills/guide/SKILL.md"), "utf8"), "---\nname: user-guide\ndescription: User guide\n---\nUser\n", JSON.stringify(report.custom));
    assert.deepEqual(report.custom.commands.generated, []);
    for (const target of [".claude/commands/guide.md", ".opencode/commands/guide.md", ".traecli/commands/guide.md"]) {
      assert.equal(fs.existsSync(path.join(projectRoot, target)), false, `${target} should not be generated`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
