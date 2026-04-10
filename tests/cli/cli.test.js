import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { exists, filePath, read } from "../helpers.js";

test("bootstrap CLI files exist", () => {
  assert.ok(exists("install.sh"), "install.sh should exist");
  assert.ok(exists("bin/cli.js"), "bin/cli.js (node) should exist");

  const installSh = read("install.sh");
  assert.match(installSh, /npm install/);
  assert.match(installSh, /@fitlab-ai\/agent-infra/);

  const nodeCli = read("bin/cli.js");
  assert.match(nodeCli, /agent-infra/);
  assert.match(nodeCli, /sandbox/);

  const nodeStats = fs.statSync(filePath("bin/cli.js"));
  assert.ok(nodeStats.mode & 0o111, "bin/cli.js should be executable");
});

test("cli version output stays in sync with package.json", () => {
  const pkg = JSON.parse(read("package.json"));
  const output = execFileSync(process.execPath, [filePath("bin/cli.js"), "version"], {
    encoding: "utf8"
  });

  assert.equal(output.trim(), `agent-infra v${pkg.version}`);
});

test("agent-infra init generates seed files in a temp directory", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-test-"));
  const cli = filePath("bin/cli.js");

  try {
    execSync(
      `printf 'testproj\\ntestorg\\n\\n' | node "${cli}" init`,
      { cwd: tmpDir, stdio: "pipe" }
    );

    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".agents", ".airc.json"), "utf8")
    );
    assert.equal(config.project, "testproj");
    assert.equal(config.org, "testorg");
    assert.equal(config.templateVersion, `v${JSON.parse(read("package.json")).version}`);
    assert.ok(!("templateSource" in config), "init should not generate templateSource");
    assert.ok(!config.branchPrefix, "branchPrefix should not exist");
    assert.ok(!config.source, "consumer projects should not have source: self");
    assert.deepEqual(config.sandbox, {
      runtimes: ["node20"],
      tools: ["claude-code", "codex", "opencode", "gemini-cli"],
      dockerfile: null,
      vm: { cpu: null, memory: null, disk: null }
    }, "init should generate default sandbox config");
    assert.deepEqual(config.labels, { in: {} }, "init should generate empty labels.in defaults");
    assert.ok(
      config.files.managed.includes(".github/hooks/check-version-format.sh"),
      ".github/hooks/check-version-format.sh should be managed"
    );
    assert.ok(config.files.managed.includes(".agents/scripts/"), ".agents/scripts/ should be managed");
    assert.ok(config.files.managed.includes(".claude/hooks/"), ".claude/hooks/ should be managed");
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

test("installed sync-templates.js executes inside a type=module project", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-esm-"));
  const cli = filePath("bin/cli.js");

  try {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "esm-project", type: "module" }, null, 2) + "\n",
      "utf8"
    );

    execSync(
      `printf 'esmproj\\nesmorg\\n\\n' | node "${cli}" init`,
      { cwd: tmpDir, stdio: "pipe" }
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(tmpDir, "package.json"), "utf8")).type,
      "module",
      "package.json should remain an ESM package after init"
    );
    const packageRoot = path.join(
      tmpDir,
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
    const pathBinDir = path.join(tmpDir, ".path-bin");
    fs.mkdirSync(pathBinDir, { recursive: true });
    fs.symlinkSync(path.join(packageRoot, "bin", "cli.js"), path.join(pathBinDir, "ai"));
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
        env: {
          ...process.env,
          PATH: `${pathBinDir}:${process.env.PATH || ""}`
        }
      }
    );
    const report = JSON.parse(output);

    assert.ok(!report.error, "sync-templates.js should run without ESM loader errors");
    assert.equal(report.templateRoot, fs.realpathSync(localTemplateRoot));
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
  const cli = filePath("bin/cli.js");
  const cases = [
    { input: 'demo"x\\ntestorg\\n\\n', desc: "project name with quote" },
    { input: 'testproj\\ntestorg\\nbad-lang\\n', desc: "unsupported language" }
  ];

  cases.forEach(({ input, desc }) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-test-"));

    try {
      assert.throws(() => {
        execSync(
          `printf '${input}' | node "${cli}" init`,
          { cwd: tmpDir, stdio: "pipe" }
        );
      }, `should reject: ${desc}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

test("agent-infra update refreshes seed files and syncs file registry", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-update-"));
  const cli = filePath("bin/cli.js");
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

    const output = execSync(`node "${cli}" update`, {
      cwd: tmpDir,
      stdio: "pipe",
      encoding: "utf8"
    });

    assert.match(output, /Seed files updated successfully!/);

    const updated = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".agents", ".airc.json"), "utf8")
    );
    assert.deepEqual(updated.sandbox, {
      runtimes: ["node20"],
      tools: ["claude-code", "codex", "opencode", "gemini-cli"],
      dockerfile: null,
      vm: { cpu: null, memory: null, disk: null }
    }, "update should backfill default sandbox config");
    assert.deepEqual(updated.labels, { in: {} }, "update should backfill empty labels.in defaults");
    assert.ok(updated.files.managed.includes(".github/hooks/check-version-format.sh"));
    assert.ok(updated.files.managed.includes(".agents/skills/"));
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
  const cli = filePath("bin/cli.js");

  try {
    assert.throws(() => {
      execSync(`node "${cli}" update`, {
        cwd: tmpDir,
        stdio: "pipe"
      });
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
