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
  assert.match(geminiUpdate, /templateSource/);
});

test("update-ai-collaboration template copies stay in sync with working files", () => {
  const collaborator = JSON.parse(read("collaborator.json"));
  const project = collaborator.project;
  const org = collaborator.org;
  const lang = collaborator.language;

  // Select the correct language variant for template files
  function langTemplate(basePath) {
    if (lang === "zh-CN") {
      const ext = path.extname(basePath);
      const variant = basePath.replace(ext, `.zh-CN${ext}`);
      if (exists(variant)) return variant;
    }
    return basePath;
  }

  // Render {project} and {org} placeholders in template content
  function renderPlaceholders(content) {
    return content.replace(/\{project\}/g, project).replace(/\{org\}/g, org);
  }

  const syncFiles = [
    [".agents/skills/update-ai-collaboration/SKILL.md", "templates/.agents/skills/update-ai-collaboration/SKILL.md"],
    [".claude/commands/update-ai-collaboration.md", "templates/.claude/commands/update-ai-collaboration.md"],
    [".gemini/commands/ai-collaboration-installer/update-ai-collaboration.toml", "templates/.gemini/commands/_project_/update-ai-collaboration.toml"],
    [".opencode/commands/update-ai-collaboration.md", "templates/.opencode/commands/update-ai-collaboration.md"],
    [".codex/commands/ai-collaboration-installer-update-ai-collaboration.md", "templates/.codex/commands/_project_-update-ai-collaboration.md"]
  ];

  syncFiles.forEach(([source, target]) => {
    const templatePath = langTemplate(target);
    const rendered = renderPlaceholders(read(templatePath));
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
