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

function makeProject(projectRoot, overrides = {}) {
  writeJson(projectRoot, ".agents/.airc.json", {
    project: "demo",
    org: "acme",
    language: "en",
    platform: { type: "github" },
    files: {
      managed: [".agents/skills/", ".claude/commands/", ".gemini/commands/", ".opencode/commands/"],
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

function makeReferenceSource(tmpDir, content) {
  const sourceRoot = fs.mkdtempSync(path.join(tmpDir, "custom-tool-source-"));
  writeFile(sourceRoot, ".acme/commands/analyze-task.cmd", content);
  return sourceRoot;
}

test("syncTemplates learns custom TUI command format from existing command files", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-custom-tools-"));

  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = makeTemplateRoot(tmpDir);
    const sourceRoot = makeReferenceSource(
      tmpDir,
      [
        "title: Analyze",
        "description: Analyze requirements for analyze-task",
        "skill: .agents/skills/analyze-task/SKILL.md",
        "invoke: analyze-task",
        ""
      ].join("\n")
    );

    makeProject(projectRoot, {
      customTools: [{ name: "Acme TUI", dir: ".acme/commands", invoke: "acme {name}" }],
      templates: { sources: [{ type: "local", path: sourceRoot }] },
      files: {
        managed: [
          ".agents/skills/",
          ".claude/commands/",
          ".gemini/commands/",
          ".opencode/commands/",
          ".acme/commands/"
        ],
        merged: [],
        ejected: []
      }
    });

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-infra/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot, templateRoot);
    const command = fs.readFileSync(path.join(projectRoot, ".acme/commands/local-check.cmd"), "utf8");

    assert.ok(report.custom.commands.generated.includes(".acme/commands/local-check.cmd"));
    assert.match(command, /description: Manual check/);
    assert.match(command, /skill: \.agents\/skills\/local-check\/SKILL\.md/);
    assert.match(command, /invoke: local-check/);
    assert.doesNotMatch(command, /analyze-task/);
    assert.doesNotMatch(command, /Analyze requirements/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates skips custom TUI generation when the reference directory is empty", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-custom-tools-empty-"));

  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = makeTemplateRoot(tmpDir);
    makeProject(projectRoot, {
      customTools: [{ name: "Acme TUI", dir: ".acme/commands", invoke: "acme {name}" }]
    });
    fs.mkdirSync(path.join(projectRoot, ".acme/commands"), { recursive: true });

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-infra/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot, templateRoot);

    assert.equal(fs.existsSync(path.join(projectRoot, ".acme/commands/local-check.cmd")), false);
    assert.equal(report.custom.commands.generated.length, 3);
    assert.deepEqual(report.custom.customTools.skipped, [
      { index: 0, name: "Acme TUI", dir: ".acme/commands", reason: "no command files" }
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates skips custom TUI generation when reference files do not identify a built-in skill", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-custom-tools-no-ref-"));

  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = makeTemplateRoot(tmpDir);
    const sourceRoot = makeReferenceSource(tmpDir, "description: Analyze requirements\nskill: missing reference\n");
    makeProject(projectRoot, {
      customTools: [{ name: "Acme TUI", dir: ".acme/commands", invoke: "acme {name}" }],
      templates: { sources: [{ type: "local", path: sourceRoot }] },
      files: {
        managed: [
          ".agents/skills/",
          ".claude/commands/",
          ".gemini/commands/",
          ".opencode/commands/",
          ".acme/commands/"
        ],
        merged: [],
        ejected: []
      }
    });

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-infra/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot, templateRoot);

    assert.equal(fs.existsSync(path.join(projectRoot, ".acme/commands/local-check.cmd")), false);
    assert.equal(report.custom.commands.generated.length, 3);
    assert.deepEqual(report.custom.customTools.skipped, [
      { index: 0, name: "Acme TUI", dir: ".acme/commands", reason: "no usable reference command file" }
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates skips mismatched reference descriptions and uses the next valid custom TUI reference", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-custom-tools-desc-"));

  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = makeTemplateRoot(tmpDir);
    const sourceRoot = fs.mkdtempSync(path.join(tmpDir, "custom-tool-source-"));
    writeFile(
      sourceRoot,
      ".acme/commands/01-analyze-task.cmd",
      "description: Analyze requirements\nskill: .agents/skills/analyze-task/SKILL.md\n"
    );
    writeFile(
      sourceRoot,
      ".acme/commands/02-analyze-task.cmd",
      "description: Analyze requirements for analyze-task\nskill: .agents/skills/analyze-task/SKILL.md\n"
    );
    makeProject(projectRoot, {
      customTools: [{ name: "Acme TUI", dir: ".acme/commands", invoke: "acme {name}" }],
      templates: { sources: [{ type: "local", path: sourceRoot }] },
      files: {
        managed: [
          ".agents/skills/",
          ".claude/commands/",
          ".gemini/commands/",
          ".opencode/commands/",
          ".acme/commands/"
        ],
        merged: [],
        ejected: []
      }
    });

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-infra/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot, templateRoot);
    const command = fs.readFileSync(path.join(projectRoot, ".acme/commands/02-local-check.cmd"), "utf8");

    assert.match(command, /description: Manual check/);
    assert.match(command, /skill: \.agents\/skills\/local-check\/SKILL\.md/);
    assert.ok(report.custom.commands.generated.includes(".acme/commands/02-local-check.cmd"));
    assert.deepEqual(report.custom.customTools.skippedRefs, [
      {
        index: 0,
        name: "Acme TUI",
        dir: ".acme/commands",
        file: "01-analyze-task.cmd",
        skill: "analyze-task",
        reason: "description not found in reference command file"
      }
    ]);
    assert.deepEqual(report.custom.customTools.skipped, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates protects generated custom TUI command files during managed cleanup", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-custom-tools-protect-"));

  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = makeTemplateRoot(tmpDir);
    const sourceRoot = makeReferenceSource(
      tmpDir,
      "description: Analyze requirements for analyze-task\nskill: .agents/skills/analyze-task/SKILL.md\n"
    );
    makeProject(projectRoot, {
      customTools: [{ name: "Acme TUI", dir: "./.acme/commands", invoke: "acme {name}" }],
      templates: { sources: [{ type: "local", path: sourceRoot }] },
      files: {
        managed: [
          ".agents/skills/",
          ".claude/commands/",
          ".gemini/commands/",
          ".opencode/commands/",
          ".acme/commands/"
        ],
        merged: [],
        ejected: []
      }
    });

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-infra/scripts/sync-templates.js");
    syncTemplates(projectRoot, templateRoot);
    const secondReport = syncTemplates(projectRoot, templateRoot);

    assert.equal(fs.existsSync(path.join(projectRoot, ".acme/commands/local-check.cmd")), true);
    assert.ok(!secondReport.managed.removed.includes(".acme/commands/local-check.cmd"));
    assert.ok(secondReport.custom.commands.unchanged.includes(".acme/commands/local-check.cmd"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates removes stale custom TUI files that only contain a custom skill name substring", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-custom-tools-protect-exact-"));

  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = makeTemplateRoot(tmpDir);
    const sourceRoot = makeReferenceSource(
      tmpDir,
      "description: Analyze requirements for analyze-task\nskill: .agents/skills/analyze-task/SKILL.md\n"
    );
    makeProject(projectRoot, {
      customTools: [{ name: "Acme TUI", dir: ".acme/commands", invoke: "acme {name}" }],
      templates: { sources: [{ type: "local", path: sourceRoot }] },
      files: {
        managed: [
          ".agents/skills/",
          ".claude/commands/",
          ".gemini/commands/",
          ".opencode/commands/",
          ".acme/commands/"
        ],
        merged: [],
        ejected: []
      }
    });
    writeFile(projectRoot, ".acme/commands/local-check-notes.cmd", "stale\n");

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-infra/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot, templateRoot);

    assert.equal(fs.existsSync(path.join(projectRoot, ".acme/commands/local-check-notes.cmd")), false);
    assert.ok(report.managed.removed.includes(".acme/commands/local-check-notes.cmd"));
    assert.ok(report.custom.commands.generated.includes(".acme/commands/local-check.cmd"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates rejects custom TUI directories outside the project root", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-custom-tools-outside-"));

  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = makeTemplateRoot(tmpDir);
    makeProject(projectRoot, {
      customTools: [{ name: "Acme TUI", dir: "../outside", invoke: "acme {name}" }]
    });

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-infra/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot, templateRoot);

    assert.deepEqual(report.custom.customTools.skipped, [
      {
        index: 0,
        name: "Acme TUI",
        dir: "../outside",
        reason: "dir must be a relative path inside the project root"
      }
    ]);
    assert.equal(fs.existsSync(path.join(tmpDir, "outside")), false);
    assert.equal(report.custom.commands.generated.length, 3);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates generates commands for multiple custom TUI tools and custom skills", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-custom-tools-multi-"));

  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = makeTemplateRoot(tmpDir);
    const sourceRoot = fs.mkdtempSync(path.join(tmpDir, "custom-tool-source-"));
    writeFile(
      sourceRoot,
      ".acme/commands/analyze-task.cmd",
      "description: Analyze requirements for analyze-task\nskill: .agents/skills/analyze-task/SKILL.md\n"
    );
    writeFile(
      sourceRoot,
      ".beta/prompts/cmd-analyze-task.md",
      "desc = Analyze requirements for analyze-task\nrun .agents/skills/analyze-task/SKILL.md\n"
    );
    makeProject(projectRoot, {
      customTools: [
        { name: "Acme TUI", dir: ".acme/commands", invoke: "acme {name}" },
        { name: "Beta TUI", dir: ".beta/prompts", invoke: "beta run {name}" }
      ],
      templates: { sources: [{ type: "local", path: sourceRoot }] },
      files: {
        managed: [
          ".agents/skills/",
          ".claude/commands/",
          ".gemini/commands/",
          ".opencode/commands/",
          ".acme/commands/",
          ".beta/prompts/"
        ],
        merged: [],
        ejected: []
      }
    });
    writeFile(
      projectRoot,
      ".agents/skills/local-plan/SKILL.md",
      "---\nname: local-plan\ndescription: \"Manual plan\"\n---\n"
    );

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-infra/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot, templateRoot);

    assert.equal(report.custom.commands.generated.length, 10);
    assert.ok(report.custom.commands.generated.includes(".acme/commands/local-check.cmd"));
    assert.ok(report.custom.commands.generated.includes(".acme/commands/local-plan.cmd"));
    assert.ok(report.custom.commands.generated.includes(".beta/prompts/cmd-local-check.md"));
    assert.ok(report.custom.commands.generated.includes(".beta/prompts/cmd-local-plan.md"));
    assert.match(
      fs.readFileSync(path.join(projectRoot, ".beta/prompts/cmd-local-plan.md"), "utf8"),
      /desc = Manual plan/
    );
    assert.deepEqual(report.custom.customTools.skipped, []);
    assert.deepEqual(report.custom.customTools.skippedRefs, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates keeps built-in custom skill command generation unchanged without customTools", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-custom-tools-compatible-"));

  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = makeTemplateRoot(tmpDir);
    makeProject(projectRoot);

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-infra/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot, templateRoot);

    assert.deepEqual(report.custom.detected, ["local-check"]);
    assert.equal(report.custom.commands.generated.length, 3);
    assert.ok(report.custom.commands.generated.includes(".claude/commands/local-check.md"));
    assert.ok(report.custom.commands.generated.includes(".gemini/commands/demo/local-check.toml"));
    assert.ok(report.custom.commands.generated.includes(".opencode/commands/local-check.md"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
