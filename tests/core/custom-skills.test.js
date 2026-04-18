import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadFreshEsm } from "../helpers.js";

function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
}

function writeJson(root, relativePath, value) {
  writeFile(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makeTemplateRoot(tmpDir) {
  const templateRoot = path.join(tmpDir, "template-root");
  fs.mkdirSync(path.join(templateRoot, ".agents/skills"), { recursive: true });
  fs.mkdirSync(path.join(templateRoot, ".claude/commands"), { recursive: true });
  fs.mkdirSync(path.join(templateRoot, ".gemini/commands/_project_"), { recursive: true });
  fs.mkdirSync(path.join(templateRoot, ".opencode/commands"), { recursive: true });
  return templateRoot;
}

test("syncTemplates preserves manual custom skills and generates commands for manual and sourced skills", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-custom-skills-"));
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-custom-source-"));

  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = makeTemplateRoot(tmpDir);

    fs.mkdirSync(projectRoot, { recursive: true });

    writeJson(projectRoot, ".agents/.airc.json", {
      project: "demo",
      org: "acme",
      language: "zh-CN",
      platform: { type: "github" },
      skills: {
        sources: [
          { type: "local", path: sourceRoot }
        ]
      },
      files: {
        managed: [".agents/skills/", ".claude/commands/", ".gemini/commands/", ".opencode/commands/"],
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
        'description: "本地规范检查"',
        'args: "<task-id>"',
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

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-infra/scripts/sync-templates.js");
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
    const geminiCommand = fs.readFileSync(
      path.join(projectRoot, ".gemini/commands/demo/local-rules.toml"),
      "utf8"
    );
    const openCodeCommand = fs.readFileSync(path.join(projectRoot, ".opencode/commands/local-rules.md"), "utf8");

    assert.match(claudeCommand, /usage: "\/local-rules <task-id>"/);
    assert.doesNotMatch(claudeCommand, /ARGUMENTS:/);
    assert.match(claudeCommand, /读取并执行 `\.agents\/skills\/local-rules\/SKILL\.md` 中的 local-rules 技能。/);
    assert.match(geminiCommand, /参数：\{\{args\}\}/);
    assert.match(openCodeCommand, /参数：\$ARGUMENTS/);

    assert.equal(firstReport.custom.commands.generated.length, 6);
    assert.equal(secondReport.custom.commands.updated.length, 0);
    assert.equal(secondReport.custom.commands.generated.length, 0);
    assert.ok(secondReport.custom.commands.unchanged.includes(".claude/commands/local-rules.md"));
    assert.ok(secondReport.custom.commands.unchanged.includes(".gemini/commands/demo/shared-rules.toml"));
    assert.ok(fs.existsSync(path.join(projectRoot, ".agents/skills/local-rules/SKILL.md")));
    assert.ok(fs.existsSync(path.join(projectRoot, ".claude/commands/shared-rules.md")));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test("syncTemplates cleans stale files from sourced skills without touching manual custom skills", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-custom-cleanup-"));
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-custom-cleanup-source-"));

  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = makeTemplateRoot(tmpDir);

    fs.mkdirSync(projectRoot, { recursive: true });

    writeJson(projectRoot, ".agents/.airc.json", {
      project: "demo",
      org: "acme",
      language: "en",
      platform: { type: "github" },
      skills: {
        sources: [
          { type: "local", path: sourceRoot }
        ]
      },
      files: {
        managed: [".agents/skills/", ".claude/commands/", ".gemini/commands/", ".opencode/commands/"],
        merged: [],
        ejected: []
      }
    });

    writeFile(projectRoot, ".agents/skills/manual-only/SKILL.md", "---\nname: manual-only\ndescription: \"Manual only\"\n---\n");
    writeFile(projectRoot, ".agents/skills/manual-only/notes.md", "keep me\n");

    writeFile(sourceRoot, "shared-rules/SKILL.md", "---\nname: shared-rules\ndescription: \"Shared\"\n---\n");
    writeFile(sourceRoot, "shared-rules/reference/guide.md", "initial guide\n");

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-infra/scripts/sync-templates.js");
    syncTemplates(projectRoot, templateRoot);

    fs.unlinkSync(path.join(sourceRoot, "shared-rules/reference/guide.md"));
    writeFile(projectRoot, ".agents/skills/shared-rules/reference/stale.md", "remove me\n");

    const secondReport = syncTemplates(projectRoot, templateRoot);

    assert.deepEqual(
      secondReport.custom.removed.sort(),
      [
        ".agents/skills/shared-rules/reference/guide.md",
        ".agents/skills/shared-rules/reference/stale.md"
      ]
    );
    assert.ok(!fs.existsSync(path.join(projectRoot, ".agents/skills/shared-rules/reference")));
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-custom-conflict-"));
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-custom-conflict-source-"));

  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = makeTemplateRoot(tmpDir);
    const missingSource = path.join(tmpDir, "missing-source");

    fs.mkdirSync(projectRoot, { recursive: true });

    writeFile(
      templateRoot,
      ".agents/skills/review-task/SKILL.md",
      "---\nname: review-task\ndescription: \"Built in\"\n---\n"
    );
    writeFile(templateRoot, ".claude/commands/review-task.md", "builtin command\n");

    writeJson(projectRoot, ".agents/.airc.json", {
      project: "demo",
      org: "acme",
      language: "en",
      platform: { type: "github" },
      skills: {
        sources: [
          { type: "local", path: missingSource },
          { type: "local", path: sourceRoot }
        ]
      },
      files: {
        managed: [".agents/skills/", ".claude/commands/", ".gemini/commands/", ".opencode/commands/"],
        merged: [],
        ejected: []
      }
    });

    writeFile(sourceRoot, "review-task/SKILL.md", "---\nname: review-task\ndescription: \"Override\"\n---\n");
    writeFile(sourceRoot, "qa-check/SKILL.md", "---\nname: qa-check\ndescription: \"QA\"\n---\n");

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-infra/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot, templateRoot);

    assert.deepEqual(report.custom.detected, ["qa-check"]);
    assert.ok(
      report.custom.sourceErrors.some((entry) =>
        entry.source === missingSource && entry.reason === "directory not found"
      )
    );
    assert.ok(
      report.custom.sourceErrors.some((entry) =>
        entry.source === sourceRoot && entry.reason === "skill review-task conflicts with built-in skill"
      )
    );
    assert.equal(
      fs.readFileSync(path.join(projectRoot, ".agents/skills/review-task/SKILL.md"), "utf8"),
      "---\nname: review-task\ndescription: \"Built in\"\n---\n"
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
