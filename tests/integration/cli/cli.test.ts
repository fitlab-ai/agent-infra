import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { CLI_PATH, cliArgs, cliCommand, envWithPrependedPath, escapeRegExp, exists, filePath, read, supportsPosixModeBits, writeNodeCommandShim } from "../../helpers.ts";

const PLATFORM_DEFAULT_ENGINES: Partial<Record<NodeJS.Platform, string>> = {
  linux: "native",
  darwin: "colima",
  win32: "wsl2"
};
const CURRENT_PLATFORM = os.platform();
const DEFAULT_SANDBOX_ENGINE = PLATFORM_DEFAULT_ENGINES[CURRENT_PLATFORM] ?? null;
const ENGINE_NL = DEFAULT_SANDBOX_ENGINE ? "\\n" : "";

test("bootstrap CLI files exist", () => {
  assert.ok(exists("install.sh"), "install.sh should exist");
  assert.ok(exists("bin/cli.ts"), "bin/cli.ts (node) should exist");

  const installSh = read("install.sh");
  assert.match(installSh, /npm install/);
  assert.match(installSh, /@fitlab-ai\/agent-infra/);

  const nodeCli = read("bin/cli.ts");
  assert.match(nodeCli, /agent-infra/);
  assert.match(nodeCli, /sandbox/);

  if (supportsPosixModeBits()) {
    const nodeStats = fs.statSync(CLI_PATH);
    assert.ok(nodeStats.mode & 0o111, "bin/cli.ts should be executable");
  } else {
    const output = execFileSync(process.execPath, cliArgs("version"), {
      encoding: "utf8"
    });
    assert.match(output, /^agent-infra v/);
  }
});

test("cli version output stays in sync with package.json", () => {
  const pkg = JSON.parse(read("package.json"));
  const output = execFileSync(process.execPath, cliArgs("version"), {
    encoding: "utf8"
  });

  assert.equal(output.trim(), `agent-infra v${pkg.version}`);
});

test("cli version raw output returns the bare version string", () => {
  const pkg = JSON.parse(read("package.json"));
  const output = execFileSync(process.execPath, cliArgs("version", "--raw"), {
    encoding: "utf8"
  });

  assert.equal(output.trim(), `v${pkg.version}`);
});

test("cli usage header includes version (help and bare)", () => {
  const pkg = JSON.parse(read("package.json"));
  const expected = new RegExp(`^agent-infra v${escapeRegExp(pkg.version)} - bootstrap`);

  for (const args of [["help"], []]) {
    const output = execFileSync(process.execPath, cliArgs(...args), {
      encoding: "utf8"
    });

    assert.match(output.split("\n")[0] ?? "", expected);
  }
});

test("cli unknown command prints versioned usage and exits 1", () => {
  const pkg = JSON.parse(read("package.json"));
  const result = spawnSync(process.execPath, cliArgs("definitely-not-a-real-command"), {
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Unknown command: definitely-not-a-real-command/);
  assert.match(
    result.stdout.split("\n")[0] ?? "",
    new RegExp(`^agent-infra v${escapeRegExp(pkg.version)} - bootstrap`)
  );
});

test("cli --version and -v match the default version command output", () => {
  const expected = execFileSync(process.execPath, cliArgs("version"), {
    encoding: "utf8"
  });

  for (const flag of ["--version", "-v"]) {
    const output = execFileSync(process.execPath, cliArgs(flag), {
      encoding: "utf8"
    });

    assert.equal(output, expected);
  }
});

test("cli does not intercept --version after a subcommand", () => {
  const pkg = JSON.parse(read("package.json"));
  const result = spawnSync(process.execPath, cliArgs("sandbox", "--version"), {
    encoding: "utf8"
  });

  assert.notEqual(result.stdout.trim(), `agent-infra v${pkg.version}`);
});

test("agent-infra init generates seed files in a temp directory", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-test-"));
  const cli = CLI_PATH;

  try {
    execSync(
      `printf 'testproj\\ntestorg\\n\\n${ENGINE_NL}\\n\\n\\n' | ${cliCommand("init")}`,
      { cwd: tmpDir, stdio: "pipe" }
    );

    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".agents", ".airc.json"), "utf8")
    );
    assert.equal(config.project, "testproj");
    assert.equal(config.org, "testorg");
    assert.deepEqual(config.platform, { type: "github" });
    assert.equal(config.templateVersion, `v${JSON.parse(read("package.json")).version}`);
    assert.ok(!("templateSource" in config), "init should not generate templateSource");
    assert.ok(!("templates" in config), "blank template sources should not generate templates config");
    assert.ok(!("skills" in config), "blank skill sources should not generate skills config");
    assert.ok(!config.branchPrefix, "branchPrefix should not exist");
    assert.ok(!config.source, "consumer projects should not have source: self");
    assert.deepEqual(config.sandbox, {
      engine: DEFAULT_SANDBOX_ENGINE,
      runtimes: ["node22"],
      tools: ["claude-code", "codex", "gemini-cli", "opencode"],
      dockerfile: null,
      vm: { cpu: null, memory: null, disk: null }
    }, "init should generate default sandbox config");
    assert.deepEqual(config.labels, { in: {} }, "init should generate empty labels.in defaults");
    assert.ok(
      config.files.managed.includes(".git-hooks/check-version-format.sh"),
      ".git-hooks/check-version-format.sh should be managed"
    );
    assert.ok(config.files.managed.includes(".agents/scripts/"), ".agents/scripts/ should be managed");
    assert.ok(config.files.managed.includes(".agents/hooks/"), ".agents/hooks/ should be managed");
    assert.ok(config.files.managed.includes(".codex/hooks.json"), ".codex/hooks.json should be managed");
    assert.ok(!config.files.managed.includes(".editorconfig"), ".editorconfig should not be managed");
    assert.ok(!config.files.merged.includes(".mailmap"), ".mailmap should not be merged");
    [
      "**/test.*",
      "**/test-integration.*",
      "**/release.*",
      "**/upgrade-dependency.*",
      ".agents/skills/test/SKILL.*",
      ".agents/skills/test-integration/SKILL.*",
      ".agents/skills/release/SKILL.*",
      ".agents/skills/upgrade-dependency/SKILL.*"
    ].forEach((pattern) => {
      assert.ok(
        config.files.merged.includes(pattern),
        `init should generate merged pattern ${pattern}`
      );
    });

    assert.ok(
      fs.existsSync(path.join(tmpDir, ".agents/skills/update-agent-infra/SKILL.md")),
      "skill should be installed"
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, ".agents/skills/update-agent-infra/scripts/package.json")),
      "skill scripts package.json should be installed"
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, ".agents/skills/update-agent-infra/scripts/sync-templates.js")),
      "skill sync script should be installed"
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, ".claude/commands/update-agent-infra.md")),
      "claude command should be installed"
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, ".codex/commands/testproj-update-agent-infra.md")),
      "codex prompt adapter should not be installed"
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, ".codex/scripts/install-prompts.sh")),
      "codex prompt sync script should not be installed"
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, ".codex/prompts/testproj-update-agent-infra.md")),
      "codex prompt should not be synced to the global dir"
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, ".gemini/commands/testproj/update-agent-infra.toml")),
      "gemini command should be installed"
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, ".opencode/commands/update-agent-infra.md")),
      "opencode command should be installed"
    );

    const skill = fs.readFileSync(
      path.join(tmpDir, ".agents/skills/update-agent-infra/SKILL.md"), "utf8"
    );
    assert.doesNotMatch(skill, /\{\{project\}\}/, "skill should not contain unrendered {{project}}");
    assert.doesNotMatch(skill, /\{\{org\}\}/, "skill should not contain unrendered {{org}}");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("agent-infra init prompts with platform-specific sandbox engine choices", () => {
  const initSource = read("lib/init.js");

  assert.match(initSource, /const PLATFORM_DEFAULT_ENGINES = Object\.freeze\(\{/);
  assert.match(initSource, /linux:\s*'native'/);
  assert.match(initSource, /darwin:\s*'colima'/);
  assert.match(initSource, /win32:\s*'wsl2'/);
  assert.match(initSource, /enginesForPlatform\(currentPlatform\)/);
  assert.match(initSource, /left === defaultEngine/);
  assert.match(initSource, /`Sandbox engine \(\$\{currentPlatform\}\)`/);
});

test("agent-infra init accepts a custom platform selected from the menu", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-test-"));
  const cli = CLI_PATH;

  try {
    const output = execSync(
      `printf 'testproj\\ntestorg\\n\\n${ENGINE_NL}2\\nmy-platform\\n\\n\\n' | ${cliCommand("init")}`,
      { cwd: tmpDir, stdio: "pipe", encoding: "utf8" }
    );

    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".agents", ".airc.json"), "utf8")
    );
    assert.deepEqual(config.platform, { type: "my-platform" });
    assert.match(
      output,
      /Custom platform 'my-platform' selected\. Built-in templates are only complete for github;/,
      "init should warn when built-in templates do not fully support the selected custom platform"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("agent-infra init remains compatible with direct platform input", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-test-"));
  const cli = CLI_PATH;

  try {
    execSync(
      `printf 'testproj\\ntestorg\\n\\n${ENGINE_NL}github\\n\\n\\n' | ${cliCommand("init")}`,
      { cwd: tmpDir, stdio: "pipe" }
    );

    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".agents", ".airc.json"), "utf8")
    );
    assert.deepEqual(config.platform, { type: "github" });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("agent-infra init warns when a custom platform is entered directly", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-test-"));
  const cli = CLI_PATH;

  try {
    const output = execSync(
      `printf 'testproj\\ntestorg\\n\\n${ENGINE_NL}gitea\\n\\n\\n' | ${cliCommand("init")}`,
      { cwd: tmpDir, stdio: "pipe", encoding: "utf8" }
    );

    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".agents", ".airc.json"), "utf8")
    );
    assert.deepEqual(config.platform, { type: "gitea" });
    assert.match(
      output,
      /Custom platform 'gitea' selected\. Built-in templates are only complete for github;/,
      "init should warn when an unlisted platform is accepted through direct input"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("agent-infra init records an optional external template source for any platform", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-init-template-source-"));
  const cli = CLI_PATH;

  try {
    execSync(
      `printf 'testproj\\ntestorg\\n\\n${ENGINE_NL}github\\n~/private-templates\\n\\n' | ${cliCommand("init")}`,
      { cwd: tmpDir, stdio: "pipe" }
    );

    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".agents", ".airc.json"), "utf8")
    );

    assert.deepEqual(config.platform, { type: "github" });
    assert.deepEqual(config.templates, {
      sources: [{ type: "local", path: "~/private-templates" }]
    });
    assert.ok(!("templateSource" in config), "init should not generate legacy templateSource");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("agent-infra init omits optional source config when source prompts are blank", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-init-template-source-blank-"));
  const cli = CLI_PATH;

  try {
    execSync(
      `printf 'testproj\\ntestorg\\n\\n${ENGINE_NL}gitea\\n\\n\\n' | ${cliCommand("init")}`,
      { cwd: tmpDir, stdio: "pipe" }
    );

    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".agents", ".airc.json"), "utf8")
    );

    assert.deepEqual(config.platform, { type: "gitea" });
    assert.ok(!("templates" in config), "blank template source should not generate templates config");
    assert.ok(!("skills" in config), "blank skill source should not generate skills config");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("agent-infra init records optional external skill sources", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-init-skill-source-"));
  const cli = CLI_PATH;

  try {
    execSync(
      `printf 'testproj\\ntestorg\\n\\n${ENGINE_NL}github\\n\\n~/private-skills, ~/team-skills\\n' | ${cliCommand("init")}`,
      { cwd: tmpDir, stdio: "pipe" }
    );

    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".agents", ".airc.json"), "utf8")
    );

    assert.deepEqual(config.skills, {
      sources: [
        { type: "local", path: "~/private-skills" },
        { type: "local", path: "~/team-skills" }
      ]
    });
    assert.ok(!("templates" in config), "blank template source should not generate templates config");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("installed sync-templates.js executes inside a type=module project", () => {
  const tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-esm-")));
  const cli = CLI_PATH;

  try {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "esm-project", type: "module" }, null, 2) + "\n",
      "utf8"
    );

    execSync(
      `printf 'esmproj\\nesmorg\\n\\n${ENGINE_NL}\\n\\n\\n' | ${cliCommand("init")}`,
      { cwd: tmpDir, stdio: "pipe" }
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(tmpDir, "package.json"), "utf8")).type,
      "module",
      "package.json should remain an ESM package after init"
    );
    const pathBinDir = path.join(tmpDir, ".path-bin");
    const packageRoot = path.join(
      pathBinDir,
      "node_modules",
      "@fitlab-ai",
      "agent-infra"
    );
    const localTemplateRoot = path.join(packageRoot, "templates");
    fs.mkdirSync(localTemplateRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@fitlab-ai/agent-infra", version: "0.0.0-test" }, null, 2) + "\n",
      "utf8"
    );
    fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "bin", "cli.js"), "console.log('ai');\n", {
      encoding: "utf8",
      mode: 0o755
    });
    fs.writeFileSync(path.join(localTemplateRoot, "README.md"), "Hello {{project}}\n", "utf8");
    fs.mkdirSync(pathBinDir, { recursive: true });
    try {
      fs.symlinkSync(path.join(packageRoot, "bin", "cli.js"), path.join(pathBinDir, "ai"));
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (process.platform !== "win32" || code !== "EPERM") {
        throw error;
      }
      writeNodeCommandShim(path.join(pathBinDir, "ai"), path.join(packageRoot, "bin", "cli.js"));
    }
    fs.writeFileSync(
      path.join(tmpDir, ".agents", ".airc.json"),
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(path.join(tmpDir, ".agents", ".airc.json"), "utf8")),
        files: {
          managed: ["README.md"],
          merged: [],
          ejected: []
        }
      }, null, 2) + "\n",
      "utf8"
    );

    const output = execFileSync(
      process.execPath,
      [path.join(".agents", "skills", "update-agent-infra", "scripts", "sync-templates.js")],
      {
        cwd: tmpDir,
        encoding: "utf8",
        env: envWithPrependedPath(process.env, pathBinDir)
      }
    );
    const report = JSON.parse(output);

    assert.ok(!report.error, "sync-templates.js should run without ESM loader errors");
    assert.equal(report.templateRoot.replace(/\\/g, "/"), fs.realpathSync(localTemplateRoot).replace(/\\/g, "/"));
    assert.equal(fs.readFileSync(path.join(tmpDir, "README.md"), "utf8"), "Hello esmproj\n");
    assert.ok(
      fs.existsSync(
        path.join(tmpDir, ".agents", "skills", "update-agent-infra", "scripts", "sync-templates.js")
      ),
      "sync-templates.js should be installed into the ESM project"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("build output is up-to-date", () => {
  execFileSync(process.execPath, [filePath("scripts/build-inline.js"), "--check"], {
    encoding: "utf8"
  });
});

test("agent-infra init rejects invalid input", () => {
  const cli = CLI_PATH;
  const cases = [
    { input: 'demo"x\\ntestorg\\n\\n\\n', desc: "project name with quote" },
    { input: 'testproj\\ntestorg\\nbad-lang\\n\\n', desc: "unsupported language" },
    { input: `testproj\\ntestorg\\n\\n${ENGINE_NL}bad platform\\n`, desc: "invalid platform type" }
  ];

  cases.forEach(({ input, desc }) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-test-"));

    try {
      assert.throws(() => {
        execFileSync(process.execPath, cliArgs("init"), {
          cwd: tmpDir,
          input: input.replace(/\\n/g, "\n"),
          stdio: "pipe"
        });
      }, `should reject: ${desc}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

test("agent-infra update refreshes seed files and syncs file registry", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-update-"));
  const cli = CLI_PATH;
  const config = {
    version: "0.1.0",
    project: "seedproj",
    org: "seedorg",
    language: "zh-CN",
    templateVersion: "stale",
    files: {
      managed: [],
      merged: [],
      ejected: []
    }
  };

  try {
    fs.mkdirSync(path.join(tmpDir, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".agents", ".airc.json"),
      JSON.stringify(config, null, 2) + "\n",
      "utf8"
    );
    fs.mkdirSync(path.join(tmpDir, ".agents", "skills", "update-agent-infra"), {
      recursive: true
    });
    fs.writeFileSync(
      path.join(tmpDir, ".agents", "skills", "update-agent-infra", "SKILL.md"),
      "stale skill\n",
      "utf8"
    );
    fs.mkdirSync(path.join(tmpDir, ".agents", "skills", "update-agent-infra", "scripts"), {
      recursive: true
    });
    fs.writeFileSync(
      path.join(tmpDir, ".agents", "skills", "update-agent-infra", "scripts", "sync-templates.cjs"),
      "legacy script\n",
      "utf8"
    );

    const output = execSync(`${cliCommand("update")}`, {
      cwd: tmpDir,
      stdio: "pipe",
      encoding: "utf8"
    });

    assert.match(output, /Seed files updated successfully!/);

    const updated = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".agents", ".airc.json"), "utf8")
    );
    assert.deepEqual(updated.platform, { type: "github" }, "update should backfill default platform config");
    assert.deepEqual(updated.sandbox, {
      engine: null,
      runtimes: ["node22"],
      tools: ["claude-code", "codex", "gemini-cli", "opencode"],
      dockerfile: null,
      vm: { cpu: null, memory: null, disk: null }
    }, "update should backfill default sandbox config");
    assert.deepEqual(updated.labels, { in: {} }, "update should backfill empty labels.in defaults");
    assert.ok(updated.files.managed.includes(".git-hooks/check-version-format.sh"));
    assert.ok(updated.files.managed.includes(".agents/skills/"));
    assert.ok(updated.files.managed.includes(".codex/hooks.json"));
    assert.ok(updated.files.merged.includes("**/test.*"));

    const skill = fs.readFileSync(
      path.join(tmpDir, ".agents", "skills", "update-agent-infra", "SKILL.md"),
      "utf8"
    );
    assert.notEqual(skill, "stale skill\n");
    assert.match(skill, /ai update/);
    assert.doesNotMatch(skill, /\{\{project\}\}/);
    assert.doesNotMatch(skill, /\{\{org\}\}/);
    assert.ok(
      fs.existsSync(path.join(tmpDir, ".agents", "skills", "update-agent-infra", "scripts", "sync-templates.js"))
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, ".agents", "skills", "update-agent-infra", "scripts", "sync-templates.cjs"))
    );

    assert.ok(
      fs.existsSync(path.join(tmpDir, ".claude", "commands", "update-agent-infra.md"))
    );
    assert.ok(
      fs.existsSync(
        path.join(tmpDir, ".gemini", "commands", "seedproj", "update-agent-infra.toml")
      )
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, ".opencode", "commands", "update-agent-infra.md"))
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("agent-infra update requires .agents/.airc.json", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-update-"));
  const cli = CLI_PATH;

  try {
    assert.throws(() => {
      execSync(`${cliCommand("update")}`, {
        cwd: tmpDir,
        stdio: "pipe"
      });
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
