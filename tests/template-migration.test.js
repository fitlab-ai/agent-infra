const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");

function filePath(relativePath) {
  return path.join(rootDir, relativePath);
}

function exists(relativePath) {
  return fs.existsSync(filePath(relativePath));
}

function read(relativePath) {
  return fs.readFileSync(filePath(relativePath), "utf8");
}

function listSkillNames() {
  return fs.readdirSync(filePath(".agents/skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function langTemplate(basePath, lang) {
  if (lang === "zh-CN") {
    const ext = path.extname(basePath);
    const variant = basePath.replace(ext, `.zh-CN${ext}`);
    if (exists(variant)) return variant;
  }
  return basePath;
}

function renderPlaceholders(content, replacements) {
  return content
    .replace(/\{project\}/g, replacements.project)
    .replace(/\{org\}/g, replacements.org);
}

function buildCommandSyncFiles(project) {
  return listSkillNames().flatMap((skill) => [
    [`.claude/commands/${skill}.md`, `templates/.claude/commands/${skill}.md`],
    [`.opencode/commands/${skill}.md`, `templates/.opencode/commands/${skill}.md`],
    [`.codex/commands/${project}-${skill}.md`, `templates/.codex/commands/_project_-${skill}.md`],
    [`.gemini/commands/${project}/${skill}.toml`, `templates/.gemini/commands/_project_/${skill}.toml`]
  ]);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const commandSpecs = {
  "analyze-codescan": {
    usage: "<alert-number>",
    hint: "<alert-number>",
    en: "Analyze CodeQL alert #$1.",
    zh: "分析 CodeQL 告警 #$1。"
  },
  "analyze-dependabot": {
    usage: "<alert-number>",
    hint: "<alert-number>",
    en: "Analyze Dependabot alert #$1.",
    zh: "分析 Dependabot 告警 #$1。"
  },
  "analyze-issue": {
    usage: "<issue-number>",
    hint: "<issue-number>",
    en: "Analyze Issue #$1.",
    zh: "分析 Issue #$1。"
  },
  "block-task": {
    usage: "<task-id> [reason]",
    hint: "<task-id> [reason]",
    en: "Block task: $ARGUMENTS",
    zh: "阻塞任务：$ARGUMENTS"
  },
  "check-task": {
    usage: "<task-id>",
    hint: "<task-id>",
    en: "Check status of task $1.",
    zh: "查看任务 $1 的状态。"
  },
  commit: {},
  "close-codescan": {
    usage: "<alert-number>",
    hint: "<alert-number>",
    en: "Close CodeQL alert #$1.",
    zh: "关闭 CodeQL 告警 #$1。"
  },
  "close-dependabot": {
    usage: "<alert-number>",
    hint: "<alert-number>",
    en: "Close Dependabot alert #$1.",
    zh: "关闭 Dependabot 告警 #$1。"
  },
  "complete-task": {
    usage: "<task-id>",
    hint: "<task-id>",
    en: "Complete task $1.",
    zh: "完成任务 $1。"
  },
  "create-pr": {
    usage: "[target-branch]",
    hint: "[target-branch]",
    en: "Create PR: $ARGUMENTS",
    zh: "创建 PR：$ARGUMENTS"
  },
  "create-release-note": {
    usage: "<ver> [prev]",
    hint: "<ver> [prev]",
    en: "Generate release note: $ARGUMENTS",
    zh: "生成发布说明：$ARGUMENTS"
  },
  "create-task": {
    usage: "<description>",
    hint: "<description>",
    en: "Task description: $ARGUMENTS",
    zh: "任务描述：$ARGUMENTS"
  },
  "implement-task": {
    usage: "<task-id>",
    hint: "<task-id>",
    en: "Implement task $1.",
    zh: "实施任务 $1。"
  },
  "plan-task": {
    usage: "<task-id>",
    hint: "<task-id>",
    en: "Design plan for task $1.",
    zh: "为任务 $1 设计方案。"
  },
  "refine-task": {
    usage: "<task-id>",
    hint: "<task-id>",
    en: "Refine task $1.",
    zh: "修复任务 $1 的审查问题。"
  },
  "refine-title": {
    usage: "<number>",
    hint: "<number>",
    en: "Refine title of #$1.",
    zh: "优化 #$1 的标题。"
  },
  release: {
    usage: "<version>",
    hint: "<version>",
    en: "Release version $1.",
    zh: "发布版本 $1。"
  },
  "review-task": {
    usage: "<task-id>",
    hint: "<task-id>",
    en: "Review task $1.",
    zh: "审查任务 $1。"
  },
  "sync-issue": {
    usage: "<task-id>",
    hint: "<task-id>",
    en: "Sync task $1 to Issue.",
    zh: "同步任务 $1 到 Issue。"
  },
  "sync-pr": {
    usage: "<task-id>",
    hint: "<task-id>",
    en: "Sync task $1 to PR.",
    zh: "同步任务 $1 到 PR。"
  },
  test: {},
  "test-integration": {},
  "update-ai-collaboration": {},
  "upgrade-dependency": {
    usage: "<pkg> <from> <to>",
    hint: "<pkg> <from> <to>",
    en: "Upgrade dependency: $ARGUMENTS",
    zh: "升级依赖：$ARGUMENTS"
  }
};

test("collaborator.json declares templates as the template source", () => {
  const collaborator = JSON.parse(read("collaborator.json"));

  assert.equal(collaborator.templateSource, "templates/");
});

test("required template files were migrated into templates/", () => {
  const requiredFiles = [
    "templates/.mailmap",
    "templates/.editorconfig",
    "templates/.agents/workflows/feature-development.yaml",
    "templates/.agents/templates/task.md",
    "templates/.agents/README.md",
    "templates/.agents/QUICKSTART.md",
    "templates/.agents/skills/update-ai-collaboration/SKILL.md",
    "templates/.ai-workspace/README.md",
    "templates/.ai-workspace/README.zh-CN.md",
    "templates/.claude/CLAUDE.md",
    "templates/.claude/project-rules.md",
    "templates/.claude/settings.json",
    "templates/.claude/commands/update-ai-collaboration.md",
    "templates/.codex/README.md",
    "templates/.codex/commands/_project_-update-ai-collaboration.md",
    "templates/.gemini/settings.json",
    "templates/.gemini/commands/_project_/update-ai-collaboration.toml",
    "templates/.opencode/README.md",
    "templates/.opencode/COMMAND_STYLE_GUIDE.md",
    "templates/.opencode/commands/update-ai-collaboration.md",
    "templates/.github/ISSUE_TEMPLATE/01_bug_report.yml",
    "templates/.github/workflows/pr-title-check.yml",
    "templates/.github/PULL_REQUEST_TEMPLATE.md",
    "templates/AGENTS.md",
    "templates/CONTRIBUTING.md",
    "templates/SECURITY.md",
    "templates/.gitignore",
    "templates/README.md",
    "templates/README.zh-CN.md",
    "templates/License.txt"
  ];

  requiredFiles.forEach((relativePath) => {
    assert.ok(exists(relativePath), `Missing migrated template file: ${relativePath}`);
  });
});

test("init-project files have been removed", () => {
  const removedFiles = [
    ".agents/skills/init-project/SKILL.md",
    ".claude/commands/init-project.md",
    ".codex/commands/collaborator-init-project.md",
    ".gemini/commands/collaborator/init-project.toml",
    ".opencode/commands/init-project.md",
    "templates/.agents/skills/init-project/SKILL.md",
    "templates/.claude/commands/init-project.md",
    "templates/.codex/commands/_project_-init-project.md",
    "templates/.gemini/commands/_project_/init-project.toml",
    "templates/.opencode/commands/init-project.md"
  ];

  removedFiles.forEach((relativePath) => {
    assert.ok(!exists(relativePath), `init-project file should be removed: ${relativePath}`);
  });
});

test("bootstrap CLI files exist", () => {
  assert.ok(exists("install.sh"), "install.sh should exist");
  assert.ok(exists("bin/ai-collaboration-installer"), "bin/ai-collaboration-installer should exist");

  const installSh = read("install.sh");
  assert.match(installSh, /git clone/);
  assert.match(installSh, /\.ai-collaboration-installer/);

  const cli = read("bin/ai-collaboration-installer");
  assert.match(cli, /ai-collaboration-installer init/);

  const stats = fs.statSync(filePath("bin/ai-collaboration-installer"));
  assert.ok(stats.mode & 0o111, "bin/ai-collaboration-installer should be executable");
});

test("update-ai-collaboration instructions point to templates rendering", () => {
  const updateSkill = read(".agents/skills/update-ai-collaboration/SKILL.md");
  const geminiUpdate = read(".gemini/commands/ai-collaboration-installer/update-ai-collaboration.toml");

  assert.match(updateSkill, /templateSource/);
  assert.match(updateSkill, /templates\//);
  assert.match(updateSkill, /git.*pull/);
  assert.match(geminiUpdate, /SKILL\.md/);
});

test("skill command templates use thin adapter bodies", () => {
  const skills = listSkillNames();

  skills.forEach((skill) => {
    const spec = commandSpecs[skill] || {};
    const markdownTargets = [
      `templates/.claude/commands/${skill}.md`,
      `templates/.claude/commands/${skill}.zh-CN.md`,
      `templates/.opencode/commands/${skill}.md`,
      `templates/.opencode/commands/${skill}.zh-CN.md`,
      `templates/.codex/commands/_project_-${skill}.md`,
      `templates/.codex/commands/_project_-${skill}.zh-CN.md`
    ];
    const tomlTargets = [
      `templates/.gemini/commands/_project_/${skill}.toml`,
      `templates/.gemini/commands/_project_/${skill}.zh-CN.toml`
    ];
    const skillPathPattern = new RegExp(escapeRegExp(`.agents/skills/${skill}/SKILL.md`));

    markdownTargets.forEach((target) => {
      const content = read(target);
      const isChinese = target.endsWith(".zh-CN.md");
      const contextLine = isChinese ? spec.zh : spec.en;

      assert.match(content, skillPathPattern, `${target} should reference the skill file`);
      assert.doesNotMatch(content, /^name:/m, `${target} should not declare a name field`);

      if (target.includes("/.codex/")) {
        assert.match(content, /^usage: \/prompts:/m, `${target} should declare Codex usage`);
        if (spec.hint) {
          assert.match(
            content,
            new RegExp(`^argument-hint: ${escapeRegExp(spec.hint)}$`, "m"),
            `${target} should declare the correct argument hint`
          );
        } else {
          assert.doesNotMatch(content, /^argument-hint:/m, `${target} should not declare an argument hint`);
        }
      } else {
        assert.doesNotMatch(content, /^argument-hint:/m, `${target} should not declare an argument hint`);
      }

      if (target.includes("/.claude/")) {
        if (spec.usage) {
          assert.match(
            content,
            new RegExp(`^usage: "${escapeRegExp(`/${skill} ${spec.usage}`)}"$`, "m"),
            `${target} should declare the Claude usage`
          );
        } else {
          assert.doesNotMatch(content, /^usage:/m, `${target} should not declare usage`);
        }
      } else if (!target.includes("/.codex/")) {
        assert.doesNotMatch(content, /^usage:/m, `${target} should not declare usage`);
      }

      if (target.includes("/.opencode/")) {
        assert.match(content, /^agent: general$/m, `${target} should declare the OpenCode agent`);
        assert.match(content, /^subtask: false$/m, `${target} should declare the OpenCode subtask flag`);
      }

      if (contextLine && !target.includes("/.claude/")) {
        assert.match(
          content,
          new RegExp(escapeRegExp(contextLine)),
          `${target} should include the command argument context`
        );
      } else if (!contextLine) {
        assert.doesNotMatch(content, /\$1|\$ARGUMENTS/, `${target} should not include argument placeholders`);
      }

      if (isChinese) {
        assert.match(content, /读取并执行/, `${target} should use the Chinese thin adapter body`);
        assert.match(content, /严格按照技能中定义的所有步骤执行/, `${target} should include the Chinese execution instruction`);
      } else {
        assert.match(content, /Read and execute the .* skill from/, `${target} should use the English thin adapter body`);
        assert.match(content, /Follow all steps defined in the skill exactly/, `${target} should include the English execution instruction`);
      }
    });

    tomlTargets.forEach((target) => {
      const content = read(target);
      const isChinese = target.endsWith(".zh-CN.toml");
      const contextLine = (isChinese ? spec.zh : spec.en)
        ?.replace(/\$1/g, "{{args}}")
        .replace(/\$ARGUMENTS/g, "{{args}}");

      assert.match(content, /^description = "/, `${target} should declare a TOML description`);
      assert.match(content, /^prompt = """$/m, `${target} should use a multiline TOML prompt`);
      assert.match(content, skillPathPattern, `${target} should reference the skill file`);

      if (contextLine) {
        assert.match(
          content,
          new RegExp(escapeRegExp(contextLine)),
          `${target} should include the Gemini argument context`
        );
      } else {
        assert.doesNotMatch(content, /\{\{args\}\}/, `${target} should not include Gemini arguments`);
      }

      if (isChinese) {
        assert.match(content, /读取并执行/, `${target} should use the Chinese thin adapter body`);
        assert.match(content, /严格按照技能中定义的所有步骤执行/, `${target} should include the Chinese execution instruction`);
      } else {
        assert.match(content, /Read and execute the .* skill from/, `${target} should use the English thin adapter body`);
        assert.match(content, /Follow all steps defined in the skill exactly/, `${target} should include the English execution instruction`);
      }
    });
  });
});

test("update-ai-collaboration template copies stay in sync with working files", () => {
  const collaborator = JSON.parse(read("collaborator.json"));
  const project = collaborator.project;
  const org = collaborator.org;
  const lang = collaborator.language;

  const syncFiles = [
    [".agents/skills/update-ai-collaboration/SKILL.md", "templates/.agents/skills/update-ai-collaboration/SKILL.md"],
    ...buildCommandSyncFiles(project)
  ];

  syncFiles.forEach(([source, target]) => {
    const templatePath = langTemplate(target, lang);
    const rendered = renderPlaceholders(read(templatePath), { project, org });
    assert.equal(rendered, read(source), `${templatePath} is out of sync with ${source}`);
  });
});

test("ai-collaboration-installer init generates seed files in a temp directory", () => {
  const os = require("node:os");
  const { execSync } = require("node:child_process");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-test-"));
  const cli = filePath("bin/ai-collaboration-installer");

  try {
    // symlink the real ai-collaboration-installer repo as the template source for this test HOME
    fs.symlinkSync(rootDir, path.join(tmpDir, ".ai-collaboration-installer"));

    // run init with piped input: project=testproj, org=testorg, defaults for rest
    execSync(
      `printf 'testproj\\ntestorg\\n\\n\\n' | sh "${cli}" init`,
      { cwd: tmpDir, stdio: "pipe", env: { ...process.env, HOME: tmpDir } }
    );

    // verify collaborator.json was generated
    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "collaborator.json"), "utf8")
    );
    assert.equal(config.project, "testproj");
    assert.equal(config.org, "testorg");
    assert.ok(!config.branchPrefix, "branchPrefix should not exist");
    assert.ok(!config.source, "consumer projects should not have source: self");

    // verify seed command files exist
    assert.ok(
      fs.existsSync(path.join(tmpDir, ".agents/skills/update-ai-collaboration/SKILL.md")),
      "skill should be installed"
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, ".claude/commands/update-ai-collaboration.md")),
      "claude command should be installed"
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, ".codex/commands/testproj-update-ai-collaboration.md")),
      "codex command should be installed in project dir"
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, ".codex/scripts/install-prompts.sh")),
      "codex install-prompts.sh should be installed"
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, ".codex/prompts/testproj-update-ai-collaboration.md")),
      "codex prompt should be synced to global dir"
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, ".gemini/commands/testproj/update-ai-collaboration.toml")),
      "gemini command should be installed"
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, ".opencode/commands/update-ai-collaboration.md")),
      "opencode command should be installed"
    );

    // verify placeholders were rendered
    const skill = fs.readFileSync(
      path.join(tmpDir, ".agents/skills/update-ai-collaboration/SKILL.md"), "utf8"
    );
    assert.doesNotMatch(skill, /\{project\}/, "skill should not contain unrendered {project}");
    assert.doesNotMatch(skill, /\{org\}/, "skill should not contain unrendered {org}");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ai-collaboration-installer init rejects invalid input", () => {
  const os = require("node:os");
  const { execSync } = require("node:child_process");
  const cli = filePath("bin/ai-collaboration-installer");

  const cases = [
    { input: 'demo"x\\ntestorg\\n\\n\\n', desc: "project name with quote" },
    { input: 'testproj\\ntestorg\\nbad-lang\\n\\n', desc: "unsupported language" }
  ];

  cases.forEach(({ input, desc }) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-test-"));
    try {
      fs.symlinkSync(rootDir, path.join(tmpDir, ".ai-collaboration-installer"));
      assert.throws(() => {
        execSync(
          `printf '${input}' | sh "${cli}" init`,
          { cwd: tmpDir, stdio: "pipe", env: { ...process.env, HOME: tmpDir } }
        );
      }, `should reject: ${desc}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

test("collaborator.json includes .codex/scripts/ in managed files", () => {
  const collaborator = JSON.parse(read("collaborator.json"));
  assert.ok(
    collaborator.files.managed.includes(".codex/scripts/"),
    ".codex/scripts/ should be in managed list"
  );
});

test("README documents the bootstrap installation flow", () => {
  const readme = read("README.md");
  const readmeZh = read("README.zh-CN.md");

  assert.match(readme, /install\.sh/);
  assert.match(readme, /ai-collaboration-installer init/);
  assert.match(readme, /update-ai-collaboration/);
  assert.match(readmeZh, /install\.sh/);
  assert.match(readmeZh, /ai-collaboration-installer init/);
  assert.match(readmeZh, /update-ai-collaboration/);
});
