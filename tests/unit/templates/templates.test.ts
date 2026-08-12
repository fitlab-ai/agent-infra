import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as semver from "semver";

import {
  buildCommandSyncFiles,
  escapeRegExp,
  exists,
  langTemplate,
  listFilesRecursive,
  read,
  renderPlaceholders
} from "../../helpers.ts";
import { copySkillDir } from "../../../lib/render.ts";

const highFrequencyCommands = [
  "analyze-task",
  "commit",
  "complete-task",
  "create-pr",
  "create-task",
  "code-task",
  "import-issue",
  "plan-task",
  "review-analysis",
  "review-code",
  "review-plan",
  "review-pr",
  "run-task",
  "test",
  "watch-pr"
];

const lowFrequencyCommands = [
  "archive-tasks",
  "block-task",
  "cancel-task",
  "check-task",
  "close-codescan",
  "close-dependabot",
  "complete-manual-validation",
  "create-release-note",
  "import-codescan",
  "import-dependabot",
  "init-labels",
  "init-milestones",
  "post-release",
  "refine-title",
  "release",
  "restore-task",
  "test-integration",
  "update-agent-infra",
  "upgrade-dependency"
];

const projectLocalCommands = [
  "entropy-check"
];

function claudeCommandTargets(command: string): string[] {
  return [
    `.claude/commands/${command}.md`,
    `templates/.claude/commands/${command}.en.md`,
    `templates/.claude/commands/${command}.zh-CN.md`
  ];
}

test("required template files were migrated into templates/", () => {
  const requiredFiles = [
    "templates/.agents/workflows/feature-development.en.yaml",
    "templates/.agents/templates/task.en.md",
    "templates/.agents/rules/version-stamp.en.md",
    "templates/.agents/rules/version-stamp.zh-CN.md",
    "templates/.agents/rules/no-mid-flow-questions.en.md",
    "templates/.agents/rules/no-mid-flow-questions.zh-CN.md",
    "templates/.agents/rules/human-decision-context.en.md",
    "templates/.agents/rules/human-decision-context.zh-CN.md",
    "templates/.agents/README.en.md",
    "templates/.agents/QUICKSTART.en.md",
    "templates/.agents/skills/archive-tasks/SKILL.en.md",
    "templates/.agents/skills/archive-tasks/SKILL.zh-CN.md",
    "templates/.agents/skills/archive-tasks/scripts/archive-tasks.sh",
    "templates/.agents/skills/init-labels/SKILL.en.md",
    "templates/.agents/skills/init-labels/SKILL.zh-CN.md",
    "templates/.agents/skills/init-milestones/SKILL.en.md",
    "templates/.agents/skills/init-milestones/SKILL.zh-CN.md",
    "templates/.agents/skills/update-agent-infra/SKILL.en.md",
    "templates/.agents/skills/update-agent-infra/scripts/package.json",
    "templates/.agents/skills/update-agent-infra/scripts/sync-templates.js",
    "templates/.agents/workspace/README.en.md",
    "templates/.agents/workspace/README.zh-CN.md",
    "templates/.git-hooks/check-large-files.cjs",
    "templates/.git-hooks/check-version-format.sh",
    "templates/.git-hooks/pre-commit",
    "templates/.agents/hooks/check-version-format.sh",
    "templates/.agents/hooks/auto-resume.sh",
    "templates/.codex/hooks.json",
    "templates/.claude/settings.json",
    "templates/.claude/commands/archive-tasks.en.md",
    "templates/.claude/commands/archive-tasks.zh-CN.md",
    "templates/.claude/commands/init-milestones.en.md",
    "templates/.claude/commands/init-milestones.zh-CN.md",
    "templates/.claude/commands/init-labels.en.md",
    "templates/.claude/commands/init-labels.zh-CN.md",
    "templates/.claude/commands/update-agent-infra.en.md",
    "templates/.opencode/commands/archive-tasks.en.md",
    "templates/.opencode/commands/archive-tasks.zh-CN.md",
    "templates/.opencode/commands/init-milestones.en.md",
    "templates/.opencode/commands/init-milestones.zh-CN.md",
    "templates/.opencode/commands/init-labels.en.md",
    "templates/.opencode/commands/init-labels.zh-CN.md",
    "templates/.opencode/commands/update-agent-infra.en.md",
    "templates/.gitignore"
  ];

  requiredFiles.forEach((relativePath) => {
    assert.ok(exists(relativePath), `Missing migrated template file: ${relativePath}`);
  });
});

test("human-decision context rules define complete comparable option blocks", () => {
  for (const relativePath of [
    ".agents/rules/human-decision-context.md",
    "templates/.agents/rules/human-decision-context.en.md",
    "templates/.agents/rules/human-decision-context.zh-CN.md"
  ]) {
    const content = read(relativePath);
    const canonical = /```markdown\n([\s\S]*?)\n```/.exec(content)?.[1];
    assert.ok(canonical, `${relativePath} should include a canonical markdown block`);

    const optionHeadings = [...canonical.matchAll(/^####\s+.+$/gm)];
    assert.ok(optionHeadings.length >= 2, `${relativePath} should define at least two options`);

    const summary = canonical.slice(0, optionHeadings[0]?.index);
    assert.match(summary, /^###\s+\{AN-N\|PL-N\|CD-N\|HD-N\}[:：].+\[needs-human-decision\]$/m);
    const summaryFields = [...summary.matchAll(/^- \*\*([^*]+)\*\*[:：]\s*.+$/gm)];
    assert.equal(summaryFields.length, 7, `${relativePath} should define seven summary fields`);
    assert.equal(new Set(summaryFields.map((match) => match[1])).size, 7, `${relativePath} summary labels should be unique`);

    let optionLabels: string[] | undefined;
    optionHeadings.forEach((option, index) => {
      const start = option.index ?? 0;
      const end = optionHeadings[index + 1]?.index ?? canonical.length;
      const fields = [...canonical.slice(start, end).matchAll(/^- \*\*([^*]+)\*\*[:：]\s*.+$/gm)];
      assert.equal(fields.length, 4, `${relativePath} option ${index + 1} should define four comparison fields`);
      const labels = fields.map((match) => match[1]!);
      assert.equal(new Set(labels).size, 4, `${relativePath} option ${index + 1} labels should be unique`);
      optionLabels ??= labels;
      assert.deepEqual(labels, optionLabels, `${relativePath} options should use the same comparison fields`);
    });
  }
});

test("decision-producing workflow docs reference the shared context contract", () => {
  const sources = [
    ".agents/skills/analyze-task/SKILL.md",
    ".agents/skills/plan-task/SKILL.md",
    ".agents/skills/code-task/SKILL.md",
    ...["review-analysis", "review-plan", "review-code"].flatMap((skill) => [
      `.agents/skills/${skill}/reference/report-template.md`,
      `.agents/skills/${skill}/reference/review-criteria.md`
    ])
  ];
  const templates = sources.flatMap((source) => {
    const base = source.replace(/^\.agents\//, "templates/.agents/");
    return [base.replace(/\.md$/, ".en.md"), base.replace(/\.md$/, ".zh-CN.md")];
  });
  [...sources, ...templates].forEach((relativePath) => {
    assert.match(read(relativePath), /\.agents\/rules\/human-decision-context\.md/);
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

test("task templates include agent-infra version metadata", () => {
  for (const relativePath of [
    ".agents/templates/task.md",
    "templates/.agents/templates/task.en.md",
    "templates/.agents/templates/task.zh-CN.md"
  ]) {
    const content = read(relativePath);
    assert.match(content, /^agent_infra_version: v0\.0\.0\b/m, `${relativePath} should stamp the CLI version field`);
  }
});

test("task templates include human ruling sections", () => {
  for (const [relativePath, heading] of [
    [".agents/templates/task.md", "## 人工裁决"],
    ["templates/.agents/templates/task.en.md", "## Human Rulings"],
    ["templates/.agents/templates/task.zh-CN.md", "## 人工裁决"]
  ] as Array<[string, string]>) {
    assert.match(read(relativePath), new RegExp(`^${escapeRegExp(heading)}$`, "m"));
  }
});

test("task templates include workflow warning sections", () => {
  for (const [relativePath, heading] of [
    [".agents/templates/task.md", "## 工作流告警"],
    ["templates/.agents/templates/task.en.md", "## Workflow Warnings"],
    ["templates/.agents/templates/task.zh-CN.md", "## 工作流告警"]
  ] as Array<[string, string]>) {
    const content = read(relativePath);
    assert.match(content, new RegExp(`^${escapeRegExp(heading)}$`, "m"));
    assert.match(content, /^\| id \| time \| step \| severity \| code \| status \| target \| message \| action \| resolved_at \| resolution \|$/m);
  }
});

test("update-agent-infra template copies stay in sync with working files", () => {
  const collaborator = JSON.parse(read(".agents/.airc.json"));
  const project = collaborator.project;
  const org = collaborator.org;
  const lang = collaborator.language;
  const referenceSyncFiles: Array<[string, string]> = listFilesRecursive("templates/.agents/skills")
    .filter((relativePath) =>
      /\/reference\/.*\.md$/.test(relativePath) &&
      relativePath.includes(".en.")
    )
    .map((templatePath) => [templatePath.replace(/^templates\//, "").replace(/\.en(?=\.[^.]+$)/, ""), templatePath]);

  const syncFiles: Array<[string, string]> = [
    [".agents/QUICKSTART.md", "templates/.agents/QUICKSTART.en.md"],
    [".agents/README.md", "templates/.agents/README.en.md"],
    [".agents/rules/README.md", "templates/.agents/rules/README.en.md"],
    [".agents/rules/debugging-guide.md", "templates/.agents/rules/debugging-guide.en.md"],
    [".agents/rules/next-step-output.md", "templates/.agents/rules/next-step-output.en.md"],
    [".agents/rules/task-management.md", "templates/.agents/rules/task-management.en.md"],
    [".agents/templates/task.md", "templates/.agents/templates/task.en.md"],
    [".agents/skills/archive-tasks/SKILL.md", "templates/.agents/skills/archive-tasks/SKILL.en.md"],
    [".agents/skills/archive-tasks/scripts/archive-tasks.sh", "templates/.agents/skills/archive-tasks/scripts/archive-tasks.sh"],
    [".agents/skills/analyze-task/SKILL.md", "templates/.agents/skills/analyze-task/SKILL.en.md"],
    [".agents/skills/code-task/SKILL.md", "templates/.agents/skills/code-task/SKILL.en.md"],
    [".agents/skills/commit/SKILL.md", "templates/.agents/skills/commit/SKILL.en.md"],
    [".agents/skills/complete-task/SKILL.md", "templates/.agents/skills/complete-task/SKILL.en.md"],
    [".agents/skills/create-pr/config/verify.json", "templates/.agents/skills/create-pr/config/verify.json"],
    [".agents/skills/create-pr/SKILL.md", "templates/.agents/skills/create-pr/SKILL.en.md"],
    [".agents/skills/create-task/SKILL.md", "templates/.agents/skills/create-task/SKILL.en.md"],
    [".agents/skills/create-task/config/verify.json", "templates/.agents/skills/create-task/config/verify.json"],
    [".agents/skills/import-issue/SKILL.md", "templates/.agents/skills/import-issue/SKILL.en.md"],
    [".agents/skills/import-issue/config/verify.json", "templates/.agents/skills/import-issue/config/verify.json"],
    [".agents/scripts/find-existing-task.js", "templates/.agents/scripts/find-existing-task.js"],
    [".agents/skills/init-labels/SKILL.md", "templates/.agents/skills/init-labels/SKILL.en.md"],
    [".agents/skills/plan-task/SKILL.md", "templates/.agents/skills/plan-task/SKILL.en.md"],
    [".agents/skills/review-analysis/SKILL.md", "templates/.agents/skills/review-analysis/SKILL.en.md"],
    [".agents/skills/review-plan/SKILL.md", "templates/.agents/skills/review-plan/SKILL.en.md"],
    [".agents/skills/review-code/SKILL.md", "templates/.agents/skills/review-code/SKILL.en.md"],
    [".agents/skills/watch-pr/SKILL.md", "templates/.agents/skills/watch-pr/SKILL.en.md"],
    [".agents/skills/update-agent-infra/SKILL.md", "templates/.agents/skills/update-agent-infra/SKILL.en.md"],
    [".agents/skills/update-agent-infra/scripts/package.json", "templates/.agents/skills/update-agent-infra/scripts/package.json"],
    [".agents/skills/update-agent-infra/scripts/sync-templates.js", "templates/.agents/skills/update-agent-infra/scripts/sync-templates.js"],
    [".agents/workflows/feature-development.yaml", "templates/.agents/workflows/feature-development.en.yaml"],
    [".agents/workflows/bug-fix.yaml", "templates/.agents/workflows/bug-fix.en.yaml"],
    [".agents/workflows/refactoring.yaml", "templates/.agents/workflows/refactoring.en.yaml"],
    [".git-hooks/check-large-files.cjs", "templates/.git-hooks/check-large-files.cjs"],
    [".git-hooks/check-version-format.sh", "templates/.git-hooks/check-version-format.sh"],
    [".agents/hooks/check-version-format.sh", "templates/.agents/hooks/check-version-format.sh"],
    [".agents/hooks/auto-resume.sh", "templates/.agents/hooks/auto-resume.sh"],
    [".agents/hooks/lifecycle-delegation.js", "templates/.agents/hooks/lifecycle-delegation.js"],
    [".codex/hooks.json", "templates/.codex/hooks.json"],
    ...buildCommandSyncFiles(project),
    ...referenceSyncFiles
  ];

  syncFiles.forEach(([source, target]: [string, string]) => {
    const templatePath = langTemplate(target, lang);
    const rendered = renderPlaceholders(read(templatePath), { project, org });

    assert.equal(rendered, read(source), `${templatePath} is out of sync with ${source}`);
  });
});

test("Claude command disable-model-invocation settings match command frequency", () => {
  const expectedCommands = [...highFrequencyCommands, ...lowFrequencyCommands, ...projectLocalCommands].sort();
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

test("project-local commands are not distributed through templates", () => {
  const collaborator = JSON.parse(read(".agents/.airc.json"));
  const project = collaborator.project;

  projectLocalCommands.forEach((command) => {
    [
      `.claude/commands/${command}.md`,
      `.opencode/commands/${command}.md`,
      `.agents/skills/${command}/SKILL.md`
    ].forEach((relativePath) => {
      assert.ok(exists(relativePath), `${relativePath} should exist locally`);
    });

    [
      `templates/.agents/skills/${command}`,
      `templates/.claude/commands/${command}.en.md`,
      `templates/.claude/commands/${command}.zh-CN.md`,
      `templates/.opencode/commands/${command}.en.md`,
      `templates/.opencode/commands/${command}.zh-CN.md`,
      `templates/.agents/skills/${command}/SKILL.en.md`,
      `templates/.agents/skills/${command}/SKILL.zh-CN.md`
    ].forEach((relativePath) => {
      assert.equal(exists(relativePath), false, `${relativePath} should not be distributed`);
    });

    assert.match(
      read(`.claude/commands/${command}.md`),
      /^disable-model-invocation: true$/m,
      `.claude/commands/${command}.md should stay disabled for semantic preloading`
    );
  });
});

test("split skill reference templates provide zh-CN variants", () => {
  const referenceTemplates = listFilesRecursive("templates/.agents/skills")
    .filter((relativePath) => /\/reference\/.*\.md$/.test(relativePath) && relativePath.includes(".en."));

  referenceTemplates.forEach((relativePath) => {
    const zhVariant = relativePath.replace(/\.en\.md$/, ".zh-CN.md");
    assert.ok(exists(zhVariant), `Missing zh-CN reference variant: ${zhVariant}`);
  });
});

test("version format validation hooks are wired into templates and local config", () => {
  const packageJson = JSON.parse(read("package.json"));
  const collaborator = JSON.parse(read(".agents/.airc.json"));
  const rootClaudeSettings = JSON.parse(read(".claude/settings.json"));
  const templateClaudeSettings = JSON.parse(read("templates/.claude/settings.json"));
  const rootCodexHooks = JSON.parse(read(".codex/hooks.json"));
  const templateCodexHooks = JSON.parse(read("templates/.codex/hooks.json"));
  const localCheckScript = read(".git-hooks/check-version-format.sh");
  const templateCheckScript = read("templates/.git-hooks/check-version-format.sh");
  const localLargeFileCheck = read(".git-hooks/check-large-files.cjs");
  const templateLargeFileCheck = read("templates/.git-hooks/check-large-files.cjs");
  const localAiHook = read(".agents/hooks/check-version-format.sh");
  const templateAiHook = read("templates/.agents/hooks/check-version-format.sh");
  const localPreCommit = read(".git-hooks/pre-commit");
  const templatePreCommit = read("templates/.git-hooks/pre-commit");
  const templateQuickstart = read("templates/.agents/QUICKSTART.en.md");
  const templateQuickstartZh = read("templates/.agents/QUICKSTART.zh-CN.md");
  const localQuickstart = read(".agents/QUICKSTART.md");

  assert.equal(
    packageJson.scripts.prepare,
    "git config core.hooksPath .git-hooks || true",
    "package.json should install the managed hooks path during prepare"
  );

  assert.equal(
    semver.valid(collaborator.templateVersion.slice(1)),
    collaborator.templateVersion.slice(1),
    ".agents/.airc.json templateVersion should be an exact v-prefixed semver"
  );

  assert.equal(templateCheckScript, localCheckScript);
  assert.equal(templateLargeFileCheck, localLargeFileCheck);
  assert.match(localLargeFileCheck, /1024 \* 1024/, "the large-file limit should be 1 MiB");
  assert.match(localLargeFileCheck, /diff.*--cached/s, "the large-file check should inspect staged changes");
  assert.match(localLargeFileCheck, /\.git-large-file-allowlist/, "the large-file check should support explicit exceptions");

  ([
    [".git-hooks/check-version-format.sh", localCheckScript],
    ["templates/.git-hooks/check-version-format.sh", templateCheckScript]
  ] as Array<[string, string]>).forEach(([relativePath, content]) => {
    assert.match(content, /templateVersion must use v-prefixed semver/, `${relativePath} should validate the templateVersion format`);
    assert.match(content, /Version format check passed\./, `${relativePath} should log successful validation`);
    assert.doesNotMatch(content, /package\.json/, `${relativePath} should not depend on package.json`);
    assert.doesNotMatch(content, /--pre-tool-use/, `${relativePath} should remain a pure git hook`);
    assert.doesNotMatch(content, /tool_input/, `${relativePath} should not parse AI hook payloads`);
  });

  ([
    [".agents/hooks/check-version-format.sh", localAiHook],
    ["templates/.agents/hooks/check-version-format.sh", templateAiHook]
  ] as Array<[string, string]>).forEach(([relativePath, content]) => {
    assert.match(content, /tool_input/, `${relativePath} should parse the AI hook payload`);
    assert.match(content, /hook_command/, `${relativePath} should use a descriptive command variable name`);
    assert.match(content, /git\\ commit \| git\\ commit\\ \*/, `${relativePath} should precisely match git commit commands in PreToolUse mode`);
    assert.match(content, /\.git-hooks\/check-version-format\.sh/, `${relativePath} should delegate to the git hook`);
    assert.match(content, /exit 2/, `${relativePath} should map git-hook failures to AI hook exit code 2`);
    assert.match(content, /AI hook: version check passed\./, `${relativePath} should log successful AI-hook delegation`);
    assert.match(content, /AI hook: blocking git commit \(version format error\)\./, `${relativePath} should log blocked AI-hook delegation`);
  });

  ([
    [".git-hooks/pre-commit", localPreCommit]
  ] as Array<[string, string]>).forEach(([relativePath, content]) => {
    assert.match(content, /check-utf8-encoding\.sh/, `${relativePath} should run the UTF-8 validation hook`);
    assert.match(content, /check-version-format\.sh/, `${relativePath} should run the version format validation hook`);
    assert.match(content, /check-large-files\.cjs/, `${relativePath} should run the large-file validation hook`);
    assert.match(content, /^npm run test:core$/m, `${relativePath} should run the project's core test layer`);
    assert.doesNotMatch(content, /\.github\/hooks\//, `${relativePath} should not delegate back to legacy github hook paths`);
  });

  ([
    ["templates/.git-hooks/pre-commit", templatePreCommit]
  ] as Array<[string, string]>).forEach(([relativePath, content]) => {
    assert.match(content, /check-version-format\.sh/, `${relativePath} should run the version format validation hook`);
    assert.match(content, /check-large-files\.cjs/, `${relativePath} should run the large-file validation hook`);
    assert.doesNotMatch(content, /check-utf8-encoding\.sh/, `${relativePath} should not run the UTF-8 validation hook`);
  });

  ([
    ["templates/.agents/QUICKSTART.en.md", templateQuickstart],
    ["templates/.agents/QUICKSTART.zh-CN.md", templateQuickstartZh],
    [".agents/QUICKSTART.md", localQuickstart]
  ] as Array<[string, string]>).forEach(([relativePath, content]) => {
    assert.match(content, /git config core\.hooksPath \.git-hooks/, `${relativePath} should document core.hooksPath setup`);
    assert.match(content, /\.git-hooks\/.*pre-commit|pre-commit.*\.git-hooks\//s, `${relativePath} should explain the shared hook path`);
  });

  ([
    [".claude/settings.json", rootClaudeSettings],
    ["templates/.claude/settings.json", templateClaudeSettings]
  ] as Array<[string, { hooks?: { PreToolUse?: unknown; PostToolUse?: unknown; StopFailure?: unknown } }]>).forEach(([relativePath, settings]) => {
    assert.deepEqual(
      settings.hooks?.PreToolUse,
      [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: "sh \"$(git rev-parse --show-toplevel)/.agents/hooks/check-version-format.sh\"",
              timeout: 5
            }
          ]
        }
      ],
      `${relativePath} should configure the PreToolUse version format validation hook`
    );
    assert.deepEqual(
      settings.hooks?.StopFailure,
      [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: "sh \"$(git rev-parse --show-toplevel)/.agents/hooks/auto-resume.sh\""
            }
          ]
        }
      ],
      `${relativePath} should configure the StopFailure auto-resume hook`
    );
    assert.equal(settings.hooks?.PostToolUse, undefined, `${relativePath} should not configure a PostToolUse reminder hook`);
  });

  ([
    [".codex/hooks.json", rootCodexHooks],
    ["templates/.codex/hooks.json", templateCodexHooks]
  ] as Array<[string, { hooks?: { PreToolUse?: unknown; PostToolUse?: unknown } }]>).forEach(([relativePath, settings]) => {
    assert.deepEqual(
      settings.hooks?.PreToolUse,
      [
        {
          matcher: "^Bash$",
          hooks: [
            {
              type: "command",
              command: "sh \"$(git rev-parse --show-toplevel)/.agents/hooks/check-version-format.sh\"",
              timeout: 5,
              statusMessage: "Checking template version before git commit"
            }
          ]
        }
      ],
      `${relativePath} should configure the Codex PreToolUse version format validation hook`
    );
    assert.equal(settings.hooks?.PostToolUse, undefined, `${relativePath} should not configure a PostToolUse reminder hook`);
  });
});

test("version format validation hooks enforce exact v-prefixed semver", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-version-hook-"));
  const hooksDir = path.join(tempRoot, ".git-hooks");
  const aiHooksDir = path.join(tempRoot, ".agents", "hooks");
  const configDir = path.join(tempRoot, ".agents");
  const configPath = path.join(configDir, ".airc.json");

  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(aiHooksDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.copyFileSync(".git-hooks/check-version-format.sh", path.join(hooksDir, "check-version-format.sh"));
  fs.copyFileSync(".agents/hooks/check-version-format.sh", path.join(aiHooksDir, "check-version-format.sh"));
  const writeTemplateVersion = (templateVersion: string) => {
    fs.writeFileSync(configPath, JSON.stringify({ templateVersion }));
  };

  const runGitHook = () => spawnSync(
    "sh",
    [path.join(hooksDir, "check-version-format.sh")],
    { cwd: tempRoot, encoding: "utf8", input: "" }
  );

  const runAiHook = (input: string) => spawnSync(
    "sh",
    [path.join(aiHooksDir, "check-version-format.sh")],
    {
      cwd: tempRoot,
      encoding: "utf8",
      input
    }
  );

  try {
    const validVersions = [
      "v0.0.0",
      "v1.2.3",
      "v1.2.3-alpha-beta",
      "v1.2.3-rc.1",
      "v1.2.3+build-x.5",
      "v1.2.3-alpha.0+build-x.5"
    ];
    const invalidVersions = [
      "1.2.3",
      "v1.2",
      "v01.2.3",
      "v1.2.3-01",
      "v1.2.3-alpha..1",
      "v1.2.3+build..1",
      "v1.2.3-alpha_1"
    ];

    for (const version of validVersions) {
      writeTemplateVersion(version);
      const result = runGitHook();
      assert.equal(result.status, 0, `${version} should be accepted: ${result.stderr}`);
      assert.match(result.stdout, /Version format check passed\./);
    }

    for (const version of invalidVersions) {
      writeTemplateVersion(version);
      const result = runGitHook();
      assert.equal(result.status, 1, `${version} should be rejected`);
      assert.match(result.stdout, /templateVersion must use v-prefixed semver/);
    }

    const nonCommit = runAiHook(JSON.stringify({ tool_input: { command: "git status" } }));
    assert.equal(nonCommit.status, 0, "PreToolUse should skip non-git-commit commands");
    assert.equal(nonCommit.stdout, "", "PreToolUse should stay silent when skipping non-git-commit commands");

    writeTemplateVersion("v1.2.3-alpha.0+build-x.5");
    const commit = runAiHook(JSON.stringify({ tool_input: { command: "git commit -m test" } }));
    assert.equal(commit.status, 0, "PreToolUse should validate git commit commands");
    assert.match(commit.stdout, /Version format check passed\./, "PreToolUse should log successful validation");
    assert.match(commit.stdout, /AI hook: version check passed\./, "PreToolUse should log successful AI-hook delegation");

    writeTemplateVersion("1.2.3");

    const blockedCommit = runAiHook(JSON.stringify({ tool_input: { command: "git commit -m broken" } }));
    assert.equal(blockedCommit.status, 2, "PreToolUse should block invalid git commit commands with exit 2");
    assert.match(blockedCommit.stderr, /AI hook: blocking git commit \(version format error\)\./, "PreToolUse should log blocked AI-hook delegation");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("template JavaScript files do not contain shebang lines", () => {
  const jsFiles = listFilesRecursive("templates")
    .filter((relativePath) => relativePath.endsWith(".js"));

  jsFiles.forEach((relativePath) => {
    const firstLine = read(relativePath).split(/\r?\n/, 1)[0];
    assert.ok(
      !(firstLine ?? "").startsWith("#!"),
      `${relativePath}: template .js files must not contain shebang lines. ` +
      "Homebrew rewrites shebangs to machine-specific absolute paths during installation, " +
      "which pollutes project files when synced. Use 'node <path>' to invoke these scripts."
    );
  });
});

test("rules README index lists every distributed rule file", () => {
  const dir = ".agents/rules";
  // Project-only (ejected) rules ship no template copy and are not distributed
  // downstream, so they must not be required in the distributed README index.
  const ejected = new Set(
    ((JSON.parse(read(".agents/.airc.json")).files?.ejected ?? []) as string[])
      .filter((entry) => entry.startsWith(`${dir}/`) && entry.endsWith(".md"))
      .map((entry) => path.basename(entry, ".md"))
  );
  const ruleNames = fs.readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".md") && fileName !== "README.md")
    .map((fileName) => fileName.replace(/\.md$/, ""))
    .filter((name) => !ejected.has(name))
    .sort();
  const index = read(`${dir}/README.md`);

  ruleNames.forEach((name) => {
    assert.ok(index.includes(name), `rules/README.md should reference ${name}`);
  });
});

test("source rules README references only existing rule files", () => {
  // Reverse of the index check above: every same-directory `.md` link in the
  // source README must resolve to a real rule file. Catches dangling entries
  // left behind when a rule is renamed or deleted. Links containing a path
  // separator (cross-directory / external) are out of scope for the index.
  const dir = ".agents/rules";
  const index = read(`${dir}/README.md`);
  const referencedNames = [...index.matchAll(/\]\(([^)/]+\.md)\)/g)].map((match) => match[1]);

  [...new Set(referencedNames)].forEach((name) => {
    assert.ok(exists(`${dir}/${name}`), `rules/README.md references missing rule file: ${name}`);
  });
});

test("rendered rules README references only distributed files", () => {
  const collaborator = JSON.parse(read(".agents/.airc.json"));
  const replacements = { project: collaborator.project, org: collaborator.org };

  for (const language of ["en", "zh-CN"]) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rules-render-"));
    try {
      copySkillDir("templates/.agents/rules", tmp, replacements, language, "github");
      const rendered = new Set(
        fs.readdirSync(tmp).filter((fileName) => fileName.endsWith(".md"))
      );
      const readme = fs.readFileSync(path.join(tmp, "README.md"), "utf8");
      const refs = [...readme.matchAll(/\]\(([^)]+\.md)\)/g)]
        .map((match) => match[1])
        .filter((ref): ref is string => ref !== undefined);

      for (const ref of refs) {
        assert.ok(
          rendered.has(ref),
          `${language} rendered rules README references ${ref}, but it is not among the rendered files`
        );
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
});
