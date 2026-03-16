import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCommandSyncFiles,
  exists,
  langTemplate,
  listFilesRecursive,
  read,
  renderPlaceholders
} from "./helpers.js";

test("required template files were migrated into templates/", () => {
  const requiredFiles = [
    "templates/.mailmap",
    "templates/.editorconfig",
    "templates/.agents/workflows/feature-development.yaml",
    "templates/.agents/templates/task.md",
    "templates/.agents/README.md",
    "templates/.agents/QUICKSTART.md",
    "templates/.agents/skills/update-agent-orchestrator/SKILL.md",
    "templates/.agents/skills/update-agent-orchestrator/scripts/package.json",
    "templates/.agents/skills/update-agent-orchestrator/scripts/sync-templates.js",
    "templates/.agent-workspace/README.md",
    "templates/.agent-workspace/README.zh-CN.md",
    "templates/.claude/CLAUDE.md",
    "templates/.claude/project-rules.md",
    "templates/.claude/settings.json",
    "templates/.claude/commands/update-agent-orchestrator.md",
    "templates/.codex/README.md",
    "templates/.gemini/settings.json",
    "templates/.gemini/commands/_project_/update-agent-orchestrator.toml",
    "templates/.opencode/README.md",
    "templates/.opencode/COMMAND_STYLE_GUIDE.md",
    "templates/.opencode/commands/update-agent-orchestrator.md",
    "templates/.github/ISSUE_TEMPLATE/01_bug_report.yml",
    "templates/.github/workflows/pr-title-check.yml",
    "templates/.github/PULL_REQUEST_TEMPLATE.md",
    "templates/AGENTS.md",
    "templates/CONTRIBUTING.md",
    "templates/SECURITY.md",
    "templates/SECURITY.zh-CN.md",
    "templates/.gitignore"
  ];

  requiredFiles.forEach((relativePath) => {
    assert.ok(exists(relativePath), `Missing migrated template file: ${relativePath}`);
  });
});

test("templates do not contain legacy single-brace project or org placeholders", () => {
  const templateFiles = listFilesRecursive("templates");

  templateFiles.forEach((relativePath) => {
    const content = read(relativePath);

    assert.doesNotMatch(
      content,
      /(?<!\{)\{project\}(?!\})/,
      `${relativePath} should not contain legacy {project} placeholders`
    );
    assert.doesNotMatch(
      content,
      /(?<!\{)\{org\}(?!\})/,
      `${relativePath} should not contain legacy {org} placeholders`
    );
  });
});

test("init-project files have been removed", () => {
  const removedFiles = [
    ".agents/skills/init-project/SKILL.md",
    ".claude/commands/init-project.md",
    ".gemini/commands/collaborator/init-project.toml",
    ".opencode/commands/init-project.md",
    "templates/.agents/skills/init-project/SKILL.md",
    "templates/.claude/commands/init-project.md",
    "templates/.gemini/commands/_project_/init-project.toml",
    "templates/.opencode/commands/init-project.md"
  ];

  removedFiles.forEach((relativePath) => {
    assert.ok(!exists(relativePath), `init-project file should be removed: ${relativePath}`);
  });
});

test("update-agent-orchestrator template copies stay in sync with working files", () => {
  const collaborator = JSON.parse(read(".aorc.json"));
  const project = collaborator.project;
  const org = collaborator.org;
  const lang = collaborator.language;

  const syncFiles = [
    [".agents/skills/update-agent-orchestrator/SKILL.md", "templates/.agents/skills/update-agent-orchestrator/SKILL.md"],
    [".agents/skills/update-agent-orchestrator/scripts/package.json", "templates/.agents/skills/update-agent-orchestrator/scripts/package.json"],
    [".agents/skills/update-agent-orchestrator/scripts/sync-templates.js", "templates/.agents/skills/update-agent-orchestrator/scripts/sync-templates.js"],
    ...buildCommandSyncFiles(project)
  ];

  syncFiles.forEach(([source, target]) => {
    const templatePath = langTemplate(target, lang);
    const rendered = renderPlaceholders(read(templatePath), { project, org });

    assert.equal(rendered, read(source), `${templatePath} is out of sync with ${source}`);
  });
});

test("README documents the bootstrap installation flow", () => {
  const readme = read("README.md");
  const readmeZh = read("README.zh-CN.md");

  assert.match(readme, /install\.sh/);
  assert.match(readme, /ao init/);
  assert.match(readme, /update-agent-orchestrator/);
  assert.match(readme, /npm install -g @fitlab-ai\/agent-orchestrator/);
  assert.match(readme, /npx @fitlab-ai\/agent-orchestrator init/);
  assert.match(readme, /Install from source/);
  assert.match(readmeZh, /install\.sh/);
  assert.match(readmeZh, /ao init/);
  assert.match(readmeZh, /update-agent-orchestrator/);
  assert.match(readmeZh, /npm install -g @fitlab-ai\/agent-orchestrator/);
  assert.match(readmeZh, /npx @fitlab-ai\/agent-orchestrator init/);
  assert.match(readmeZh, /源码安装/);
});
