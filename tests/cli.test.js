import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { exists, filePath, read } from "./helpers.js";

function pathExists(targetPath) {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function ensureCloneInstallFixture() {
  const installDir = path.join(os.homedir(), ".agent-infra");
  const templateSource = filePath("templates");
  const backupDir = pathExists(installDir)
    ? `${installDir}.test-backup-${process.pid}-${Date.now()}`
    : null;

  if (backupDir) {
    fs.renameSync(installDir, backupDir);
  }

  fs.mkdirSync(installDir, { recursive: true });
  fs.cpSync(templateSource, path.join(installDir, "templates"), { recursive: true });
  return () => {
    fs.rmSync(installDir, { recursive: true, force: true });
    if (backupDir) {
      fs.renameSync(backupDir, installDir);
    }
  };
}

test("bootstrap CLI files exist", () => {
  assert.ok(exists("install.sh"), "install.sh should exist");
  assert.ok(exists("bin/cli.js"), "bin/cli.js (node) should exist");

  const installSh = read("install.sh");
  assert.match(installSh, /git clone/);
  assert.match(installSh, /\.agent-infra/);

  const nodeCli = read("bin/cli.js");
  assert.match(nodeCli, /agent-infra/);

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
      fs.readFileSync(path.join(tmpDir, ".airc.json"), "utf8")
    );
    assert.equal(config.project, "testproj");
    assert.equal(config.org, "testorg");
    assert.equal(config.templateVersion, `v${JSON.parse(read("package.json")).version}`);
    assert.ok(!config.branchPrefix, "branchPrefix should not exist");
    assert.ok(!config.source, "consumer projects should not have source: self");
    assert.ok(!config.files.managed.includes(".mailmap"), ".mailmap should not be managed");
    assert.ok(config.files.merged.includes(".mailmap"), ".mailmap should be merged");
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
  const cleanupCloneInstall = ensureCloneInstallFixture();

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

    const output = execFileSync(
      process.execPath,
      [path.join(".agents", "skills", "update-agent-infra", "scripts", "sync-templates.js")],
      {
        cwd: tmpDir,
        encoding: "utf8"
      }
    );
    const report = JSON.parse(output);

    assert.ok(!report.error, "sync-templates.js should run without ESM loader errors");
    assert.ok(
      fs.existsSync(
        path.join(tmpDir, ".agents", "skills", "update-agent-infra", "scripts", "sync-templates.js")
      ),
      "sync-templates.js should be installed into the ESM project"
    );
  } finally {
    cleanupCloneInstall();
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
    templateSource: "templates/",
    templateVersion: "stale",
    modules: ["ai", "github"],
    files: {
      managed: [".editorconfig"],
      merged: [".mailmap"],
      ejected: []
    }
  };

  try {
    fs.writeFileSync(
      path.join(tmpDir, ".airc.json"),
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
      fs.readFileSync(path.join(tmpDir, ".airc.json"), "utf8")
    );
    assert.ok(updated.files.managed.includes(".agents/skills/"));
    assert.ok(updated.files.merged.includes("**/test.*"));
    assert.equal(
      updated.files.merged.filter((entry) => entry === ".mailmap").length,
      1,
      "existing merged entries should not be duplicated"
    );

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

test("agent-infra update requires .airc.json", () => {
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
