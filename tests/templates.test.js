import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCommandSyncFiles,
  escapeRegExp,
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
    "templates/.agents/skills/init-labels/SKILL.md",
    "templates/.agents/skills/init-labels/SKILL.zh-CN.md",
    "templates/.agents/skills/init-milestones/SKILL.md",
    "templates/.agents/skills/init-milestones/SKILL.zh-CN.md",
    "templates/.agents/skills/update-agent-infra/SKILL.md",
    "templates/.agents/skills/update-agent-infra/scripts/package.json",
    "templates/.agents/skills/update-agent-infra/scripts/sync-templates.js",
    "templates/.agent-workspace/README.md",
    "templates/.agent-workspace/README.zh-CN.md",
    "templates/.claude/CLAUDE.md",
    "templates/.claude/project-rules.md",
    "templates/.claude/settings.json",
    "templates/.claude/commands/init-milestones.md",
    "templates/.claude/commands/init-milestones.zh-CN.md",
    "templates/.claude/commands/init-labels.md",
    "templates/.claude/commands/init-labels.zh-CN.md",
    "templates/.claude/commands/update-agent-infra.md",
    "templates/.codex/README.md",
    "templates/.gemini/settings.json",
    "templates/.gemini/commands/_project_/init-milestones.toml",
    "templates/.gemini/commands/_project_/init-milestones.zh-CN.toml",
    "templates/.gemini/commands/_project_/init-labels.toml",
    "templates/.gemini/commands/_project_/init-labels.zh-CN.toml",
    "templates/.gemini/commands/_project_/update-agent-infra.toml",
    "templates/.opencode/README.md",
    "templates/.opencode/COMMAND_STYLE_GUIDE.md",
    "templates/.opencode/commands/init-milestones.md",
    "templates/.opencode/commands/init-milestones.zh-CN.md",
    "templates/.opencode/commands/init-labels.md",
    "templates/.opencode/commands/init-labels.zh-CN.md",
    "templates/.opencode/commands/update-agent-infra.md",
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

test("update-agent-infra template copies stay in sync with working files", () => {
  const collaborator = JSON.parse(read(".airc.json"));
  const project = collaborator.project;
  const org = collaborator.org;
  const lang = collaborator.language;

  const syncFiles = [
    [".agents/skills/init-labels/SKILL.md", "templates/.agents/skills/init-labels/SKILL.md"],
    [".agents/skills/update-agent-infra/SKILL.md", "templates/.agents/skills/update-agent-infra/SKILL.md"],
    [".agents/skills/update-agent-infra/scripts/package.json", "templates/.agents/skills/update-agent-infra/scripts/package.json"],
    [".agents/skills/update-agent-infra/scripts/sync-templates.js", "templates/.agents/skills/update-agent-infra/scripts/sync-templates.js"],
    ...buildCommandSyncFiles(project)
  ];

  syncFiles.forEach(([source, target]) => {
    const templatePath = langTemplate(target, lang);
    const rendered = renderPlaceholders(read(templatePath), { project, org });

    assert.equal(rendered, read(source), `${templatePath} is out of sync with ${source}`);
  });
});

test("assistant template docs use import commands and analyze-task naming", () => {
  [
    "templates/.claude/CLAUDE.md",
    "templates/.claude/CLAUDE.zh-CN.md",
    "templates/.claude/project-rules.md",
    "templates/.claude/project-rules.zh-CN.md",
    "templates/.opencode/README.md",
    "templates/.opencode/README.zh-CN.md"
  ].forEach((relativePath) => {
    const content = read(relativePath);

    assert.match(content, /import-issue/, `${relativePath} should reference import-issue`);
    assert.match(content, /analyze-task/, `${relativePath} should reference analyze-task`);
    assert.doesNotMatch(content, /analyze-issue/, `${relativePath} should not reference analyze-issue`);
  });

  [
    "templates/.claude/CLAUDE.md",
    "templates/.claude/CLAUDE.zh-CN.md",
    "templates/.opencode/README.md",
    "templates/.opencode/README.zh-CN.md"
  ].forEach((relativePath) => {
    const content = read(relativePath);

    assert.match(content, /import-dependabot/, `${relativePath} should reference import-dependabot`);
    assert.match(content, /import-codescan/, `${relativePath} should reference import-codescan`);
    assert.doesNotMatch(content, /analyze-dependabot/, `${relativePath} should not reference analyze-dependabot`);
    assert.doesNotMatch(content, /analyze-codescan/, `${relativePath} should not reference analyze-codescan`);
  });
});

test("system prompt templates embed skill authoring conventions from the collaboration guide", () => {
  [
    {
      sourcePath: "templates/.agents/README.md",
      heading: "## Skill Authoring Conventions",
      nextHeading: "## ",
      comment: "<!-- Canonical source: .agents/README.md - keep in sync -->",
      replacements: [
        ["files and their templates, keep", "files, keep"]
      ],
      targets: [
        "templates/.claude/CLAUDE.md",
        "templates/AGENTS.md"
      ]
    },
    {
      sourcePath: "templates/.agents/README.zh-CN.md",
      heading: "## Skill 编写规范",
      nextHeading: "## ",
      comment: "<!-- Canonical source: .agents/README.zh-CN.md - keep in sync -->",
      replacements: [
        ["及其模板时", "时"]
      ],
      targets: [
        "templates/.claude/CLAUDE.zh-CN.md",
        "templates/AGENTS.zh-CN.md"
      ]
    }
  ].forEach(({ sourcePath, heading, nextHeading, comment, replacements, targets }) => {
    const source = read(sourcePath);
    const [, sourceSection] = source.match(
      new RegExp(`${escapeRegExp(heading)}\\n\\n([\\s\\S]*?)(?=\\n${escapeRegExp(nextHeading)}|\\s*$)`)
    ) ?? [];

    assert.ok(sourceSection, `${sourcePath} should define the canonical conventions`);

    const sectionForTemplates = (replacements ?? []).reduce(
      (section, [from, to]) => section.replace(from, to),
      sourceSection.trim()
    );

    const expected = [
      heading,
      sectionForTemplates,
      comment
    ].join("\n\n");

    targets.forEach((relativePath) => {
      assert.match(
        read(relativePath),
        new RegExp(escapeRegExp(expected)),
        `${relativePath} should embed the canonical skill authoring conventions`
      );
    });
  });
});

test("README documents the bootstrap installation flow", () => {
  const readme = read("README.md");
  const readmeZh = read("README.zh-CN.md");

  assert.match(readme, /install\.sh/);
  assert.match(readme, /ai init/);
  assert.match(readme, /update-agent-infra/);
  assert.match(readme, /npm install -g @fitlab-ai\/agent-infra/);
  assert.match(readme, /npx @fitlab-ai\/agent-infra init/);
  assert.match(readme, /Install from source/);
  assert.match(readmeZh, /install\.sh/);
  assert.match(readmeZh, /ai init/);
  assert.match(readmeZh, /update-agent-infra/);
  assert.match(readmeZh, /npm install -g @fitlab-ai\/agent-infra/);
  assert.match(readmeZh, /npx @fitlab-ai\/agent-infra init/);
  assert.match(readmeZh, /源码安装/);
});
