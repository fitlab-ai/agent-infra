import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildCommandSyncFiles,
  exists,
  langTemplate,
  listFilesRecursive,
  read,
  renderPlaceholders
} from "../helpers.js";

const highFrequencyCommands = [
  "analyze-task",
  "commit",
  "complete-task",
  "create-issue",
  "create-pr",
  "create-task",
  "implement-task",
  "import-issue",
  "plan-task",
  "refine-task",
  "review-task",
  "test"
];

const lowFrequencyCommands = [
  "archive-tasks",
  "block-task",
  "cancel-task",
  "check-task",
  "close-codescan",
  "close-dependabot",
  "create-release-note",
  "import-codescan",
  "import-dependabot",
  "init-labels",
  "init-milestones",
  "refine-title",
  "release",
  "restore-task",
  "test-integration",
  "update-agent-infra",
  "upgrade-dependency"
];

function claudeCommandTargets(command) {
  return [
    `.claude/commands/${command}.md`,
    `templates/.claude/commands/${command}.md`,
    `templates/.claude/commands/${command}.zh-CN.md`
  ];
}

test("required template files were migrated into templates/", () => {
  const requiredFiles = [
    "templates/.agents/workflows/feature-development.yaml",
    "templates/.agents/templates/task.md",
    "templates/.agents/README.md",
    "templates/.agents/QUICKSTART.md",
    "templates/.agents/skills/archive-tasks/SKILL.md",
    "templates/.agents/skills/archive-tasks/SKILL.zh-CN.md",
    "templates/.agents/skills/archive-tasks/scripts/archive-tasks.sh",
    "templates/.agents/skills/init-labels/SKILL.md",
    "templates/.agents/skills/init-labels/SKILL.zh-CN.md",
    "templates/.agents/skills/init-milestones/SKILL.md",
    "templates/.agents/skills/init-milestones/SKILL.zh-CN.md",
    "templates/.agents/skills/update-agent-infra/SKILL.md",
    "templates/.agents/skills/update-agent-infra/scripts/package.json",
    "templates/.agents/skills/update-agent-infra/scripts/sync-templates.js",
    "templates/.agents/workspace/README.md",
    "templates/.agents/workspace/README.zh-CN.md",
    "templates/.agents/scripts/validate-artifact.js",
    "templates/.github/hooks/check-version-format.sh",
    "templates/.github/hooks/pre-commit",
    "templates/.claude/hooks/check-version-format.sh",
    "templates/.claude/settings.json",
    "templates/.claude/commands/archive-tasks.md",
    "templates/.claude/commands/archive-tasks.zh-CN.md",
    "templates/.claude/commands/init-milestones.md",
    "templates/.claude/commands/init-milestones.zh-CN.md",
    "templates/.claude/commands/init-labels.md",
    "templates/.claude/commands/init-labels.zh-CN.md",
    "templates/.claude/commands/update-agent-infra.md",
    "templates/.gemini/settings.json",
    "templates/.gemini/commands/_project_/archive-tasks.toml",
    "templates/.gemini/commands/_project_/archive-tasks.zh-CN.toml",
    "templates/.gemini/commands/_project_/init-milestones.toml",
    "templates/.gemini/commands/_project_/init-milestones.zh-CN.toml",
    "templates/.gemini/commands/_project_/init-labels.toml",
    "templates/.gemini/commands/_project_/init-labels.zh-CN.toml",
    "templates/.gemini/commands/_project_/update-agent-infra.toml",
    "templates/.opencode/commands/archive-tasks.md",
    "templates/.opencode/commands/archive-tasks.zh-CN.md",
    "templates/.opencode/commands/init-milestones.md",
    "templates/.opencode/commands/init-milestones.zh-CN.md",
    "templates/.opencode/commands/init-labels.md",
    "templates/.opencode/commands/init-labels.zh-CN.md",
    "templates/.opencode/commands/update-agent-infra.md",
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

test("root and template gitignore both ignore node_modules", () => {
  const rootGitignore = read(".gitignore");
  const templateGitignore = read("templates/.gitignore");

  assert.match(rootGitignore, /^node_modules\/$/m);
  assert.match(templateGitignore, /^node_modules\/$/m);
});

test("update-agent-infra template copies stay in sync with working files", () => {
  const collaborator = JSON.parse(read(".agents/.airc.json"));
  const project = collaborator.project;
  const org = collaborator.org;
  const lang = collaborator.language;
  const referenceSyncFiles = listFilesRecursive("templates/.agents/skills")
    .filter((relativePath) => /\/reference\/.*\.md$/.test(relativePath) && !relativePath.includes(".zh-CN."))
    .map((templatePath) => [templatePath.replace(/^templates\//, ""), templatePath]);

  const syncFiles = [
    [".agents/QUICKSTART.md", "templates/.agents/QUICKSTART.md"],
    [".agents/README.md", "templates/.agents/README.md"],
    [".agents/templates/task.md", "templates/.agents/templates/task.md"],
    [".agents/skills/archive-tasks/SKILL.md", "templates/.agents/skills/archive-tasks/SKILL.md"],
    [".agents/skills/archive-tasks/scripts/archive-tasks.sh", "templates/.agents/skills/archive-tasks/scripts/archive-tasks.sh"],
    [".agents/skills/create-task/SKILL.md", "templates/.agents/skills/create-task/SKILL.md"],
    [".agents/skills/create-task/config/verify.json", "templates/.agents/skills/create-task/config/verify.json"],
    [".agents/skills/import-issue/SKILL.md", "templates/.agents/skills/import-issue/SKILL.md"],
    [".agents/skills/import-issue/config/verify.json", "templates/.agents/skills/import-issue/config/verify.json"],
    [".agents/skills/init-labels/SKILL.md", "templates/.agents/skills/init-labels/SKILL.md"],
    [".agents/skills/update-agent-infra/SKILL.md", "templates/.agents/skills/update-agent-infra/SKILL.md"],
    [".agents/skills/update-agent-infra/scripts/package.json", "templates/.agents/skills/update-agent-infra/scripts/package.json"],
    [".agents/skills/update-agent-infra/scripts/sync-templates.js", "templates/.agents/skills/update-agent-infra/scripts/sync-templates.js"],
    [".agents/scripts/validate-artifact.js", "templates/.agents/scripts/validate-artifact.js"],
    [".github/hooks/check-version-format.sh", "templates/.github/hooks/check-version-format.sh"],
    [".claude/hooks/check-version-format.sh", "templates/.claude/hooks/check-version-format.sh"],
    ...buildCommandSyncFiles(project),
    ...referenceSyncFiles
  ];

  syncFiles.forEach(([source, target]) => {
    const templatePath = langTemplate(target, lang);
    const rendered = renderPlaceholders(read(templatePath), { project, org });

    assert.equal(rendered, read(source), `${templatePath} is out of sync with ${source}`);
  });
});

test("Claude command disable-model-invocation settings match command frequency", () => {
  const expectedCommands = [...highFrequencyCommands, ...lowFrequencyCommands].sort();
  const localCommands = listFilesRecursive(".claude/commands")
    .filter((relativePath) => relativePath.endsWith(".md"))
    .map((relativePath) => path.basename(relativePath, ".md"))
    .sort();

  assert.deepEqual(localCommands, expectedCommands, "command coverage should stay in sync with the frequency allowlists");

  highFrequencyCommands.forEach((command) => {
    claudeCommandTargets(command).forEach((relativePath) => {
      assert.doesNotMatch(
        read(relativePath),
        /^disable-model-invocation: true$/m,
        `${relativePath} should remain available for semantic matching`
      );
    });
  });

  lowFrequencyCommands.forEach((command) => {
    claudeCommandTargets(command).forEach((relativePath) => {
      assert.match(
        read(relativePath),
        /^disable-model-invocation: true$/m,
        `${relativePath} should disable semantic preloading for low-frequency commands`
      );
    });
  });
});

test("split skill reference templates provide zh-CN variants", () => {
  const referenceTemplates = listFilesRecursive("templates/.agents/skills")
    .filter((relativePath) => /\/reference\/.*\.md$/.test(relativePath) && !relativePath.includes(".zh-CN."));

  referenceTemplates.forEach((relativePath) => {
    const zhVariant = relativePath.replace(/\.md$/, ".zh-CN.md");
    assert.ok(exists(zhVariant), `Missing zh-CN reference variant: ${zhVariant}`);
  });
});

test("version format validation hooks are wired into templates and local config", () => {
  const packageJson = JSON.parse(read("package.json"));
  const collaborator = JSON.parse(read(".agents/.airc.json"));
  const rootClaudeSettings = JSON.parse(read(".claude/settings.json"));
  const templateClaudeSettings = JSON.parse(read("templates/.claude/settings.json"));
  const localCheckScript = read(".github/hooks/check-version-format.sh");
  const templateCheckScript = read("templates/.github/hooks/check-version-format.sh");
  const localClaudeHook = read(".claude/hooks/check-version-format.sh");
  const templateClaudeHook = read("templates/.claude/hooks/check-version-format.sh");
  const localPreCommit = read(".github/hooks/pre-commit");
  const templatePreCommit = read("templates/.github/hooks/pre-commit");
  const templateQuickstart = read("templates/.agents/QUICKSTART.md");
  const templateQuickstartZh = read("templates/.agents/QUICKSTART.zh-CN.md");
  const localQuickstart = read(".agents/QUICKSTART.md");

  assert.equal(
    packageJson.scripts.prepare,
    "git config core.hooksPath .github/hooks || true",
    "package.json should install the managed hooks path during prepare"
  );

  assert.equal(
    collaborator.templateVersion,
    `v${packageJson.version}`,
    ".agents/.airc.json templateVersion should match package.json version with a v prefix"
  );

  [
    [".github/hooks/check-version-format.sh", localCheckScript],
    ["templates/.github/hooks/check-version-format.sh", templateCheckScript]
  ].forEach(([relativePath, content]) => {
    assert.match(content, /templateVersion must use v-prefixed semver/, `${relativePath} should validate the templateVersion format`);
    assert.match(content, /Version format check passed\./, `${relativePath} should log successful validation`);
    assert.doesNotMatch(content, /package\.json/, `${relativePath} should not depend on package.json`);
    assert.doesNotMatch(content, /--pre-tool-use/, `${relativePath} should remain a pure git hook`);
    assert.doesNotMatch(content, /tool_input/, `${relativePath} should not parse Claude hook payloads`);
  });

  [
    [".claude/hooks/check-version-format.sh", localClaudeHook],
    ["templates/.claude/hooks/check-version-format.sh", templateClaudeHook]
  ].forEach(([relativePath, content]) => {
    assert.match(content, /tool_input/, `${relativePath} should parse the Claude hook payload`);
    assert.match(content, /hook_command/, `${relativePath} should use a descriptive command variable name`);
    assert.match(content, /git\\ commit \| git\\ commit\\ \*/, `${relativePath} should precisely match git commit commands in PreToolUse mode`);
    assert.match(content, /\.github\/hooks\/check-version-format\.sh/, `${relativePath} should delegate to the git hook`);
    assert.match(content, /exit 2/, `${relativePath} should map git-hook failures to Claude exit code 2`);
    assert.match(content, /Claude hook: version check passed\./, `${relativePath} should log successful Claude-hook delegation`);
    assert.match(content, /Claude hook: blocking git commit \(version format error\)\./, `${relativePath} should log blocked Claude-hook delegation`);
  });

  [
    [".github/hooks/pre-commit", localPreCommit]
  ].forEach(([relativePath, content]) => {
    assert.match(content, /check-utf8-encoding\.sh/, `${relativePath} should run the UTF-8 validation hook`);
    assert.match(content, /check-version-format\.sh/, `${relativePath} should run the version format validation hook`);
  });

  [
    ["templates/.github/hooks/pre-commit", templatePreCommit]
  ].forEach(([relativePath, content]) => {
    assert.match(content, /check-version-format\.sh/, `${relativePath} should run the version format validation hook`);
    assert.doesNotMatch(content, /check-utf8-encoding\.sh/, `${relativePath} should not run the UTF-8 validation hook`);
  });

  [
    ["templates/.agents/QUICKSTART.md", templateQuickstart],
    ["templates/.agents/QUICKSTART.zh-CN.md", templateQuickstartZh],
    [".agents/QUICKSTART.md", localQuickstart]
  ].forEach(([relativePath, content]) => {
    assert.match(content, /git config core\.hooksPath \.github\/hooks/, `${relativePath} should document core.hooksPath setup`);
    assert.match(content, /\.github\/hooks\/.*pre-commit|pre-commit.*\.github\/hooks\//s, `${relativePath} should explain the shared hook path`);
  });

  [
    [".claude/settings.json", rootClaudeSettings],
    ["templates/.claude/settings.json", templateClaudeSettings]
  ].forEach(([relativePath, settings]) => {
    assert.deepEqual(
      settings.hooks?.PreToolUse,
      [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: "sh .claude/hooks/check-version-format.sh",
              timeout: 5
            }
          ]
        }
      ],
      `${relativePath} should configure the PreToolUse version format validation hook`
    );
    assert.equal(settings.hooks?.PostToolUse, undefined, `${relativePath} should not configure a PostToolUse reminder hook`);
  });
});

test("version format validation hook only blocks git commit in PreToolUse mode", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-version-hook-"));
  const hooksDir = path.join(tempRoot, ".github", "hooks");
  const claudeHooksDir = path.join(tempRoot, ".claude", "hooks");
  const configDir = path.join(tempRoot, ".agents");

  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(claudeHooksDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.copyFileSync(".github/hooks/check-version-format.sh", path.join(hooksDir, "check-version-format.sh"));
  fs.copyFileSync(".claude/hooks/check-version-format.sh", path.join(claudeHooksDir, "check-version-format.sh"));
  fs.writeFileSync(path.join(configDir, ".airc.json"), JSON.stringify({ templateVersion: "v1.2.3" }));

  const runClaudeHook = (input) => spawnSync(
    "sh",
    [path.join(claudeHooksDir, "check-version-format.sh")],
    {
      cwd: tempRoot,
      encoding: "utf8",
      input
    }
  );

  try {
    const nonCommit = runClaudeHook(JSON.stringify({ tool_input: { command: "git status" } }));
    assert.equal(nonCommit.status, 0, "PreToolUse should skip non-git-commit commands");
    assert.equal(nonCommit.stdout, "", "PreToolUse should stay silent when skipping non-git-commit commands");

    const commit = runClaudeHook(JSON.stringify({ tool_input: { command: "git commit -m test" } }));
    assert.equal(commit.status, 0, "PreToolUse should validate git commit commands");
    assert.match(commit.stdout, /Version format check passed\./, "PreToolUse should log successful validation");
    assert.match(commit.stdout, /Claude hook: version check passed\./, "PreToolUse should log successful Claude-hook delegation");

    fs.writeFileSync(path.join(configDir, ".airc.json"), JSON.stringify({ templateVersion: "1.2.3" }));

    const blockedCommit = runClaudeHook(JSON.stringify({ tool_input: { command: "git commit -m broken" } }));
    assert.equal(blockedCommit.status, 2, "PreToolUse should block invalid git commit commands with exit 2");
    assert.match(blockedCommit.stdout, /Claude hook: blocking git commit \(version format error\)\./, "PreToolUse should log blocked Claude-hook delegation");

    const preCommit = spawnSync(
      "sh",
      [path.join(hooksDir, "check-version-format.sh")],
      {
        cwd: tempRoot,
        encoding: "utf8",
        input: ""
      }
    );
    assert.equal(preCommit.status, 1, "git pre-commit should fail with exit 1 on invalid versions");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
