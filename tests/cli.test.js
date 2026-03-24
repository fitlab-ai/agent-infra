import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { exists, filePath, read } from "./helpers.js";

test("bootstrap CLI files exist", () => {
  assert.ok(exists("install.sh"), "install.sh should exist");
  assert.ok(exists("bin/cli.js"), "bin/cli.js (node) should exist");

  const installSh = read("install.sh");
  assert.match(installSh, /npm install/);
  assert.match(installSh, /@fitlab-ai\/agent-infra/);

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
      fs.readFileSync(path.join(tmpDir, ".agents", ".airc.json"), "utf8")
    );
    assert.equal(config.project, "testproj");
    assert.equal(config.org, "testorg");
    assert.equal(config.templateVersion, `v${JSON.parse(read("package.json")).version}`);
    assert.ok(!config.branchPrefix, "branchPrefix should not exist");
    assert.ok(!config.source, "consumer projects should not have source: self");
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
    fs.mkdirSync(path.join(tmpDir, "templates"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "templates", "README.md"), "Hello {{project}}\n", "utf8");
    fs.writeFileSync(
      path.join(tmpDir, ".agents", ".airc.json"),
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(path.join(tmpDir, ".agents", ".airc.json"), "utf8")),
        templateSource: path.join(tmpDir, "templates"),
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
    assert.ok(!("modules" in updated), "legacy modules field should be removed");
    assert.ok(!updated.files.managed.includes(".editorconfig"));
    assert.ok(!updated.files.merged.includes(".mailmap"));
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

test("agent-infra update migrates v0.2 legacy config and workspace paths", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-update-legacy-"));
  const cli = filePath("bin/cli.js");

  try {
    fs.writeFileSync(
      path.join(tmpDir, ".airc.json"),
      JSON.stringify({
        project: "legacyproj",
        org: "legacyorg",
        language: "en",
        templateSource: "templates/",
        templateVersion: "stale",
        modules: ["ai", "github"],
        files: {
          managed: [".editorconfig"],
          merged: [".mailmap"],
          ejected: []
        }
      }, null, 2) + "\n",
      "utf8"
    );
    fs.mkdirSync(path.join(tmpDir, ".agent-workspace"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".agent-workspace", "README.md"), "legacy\n", "utf8");

    const output = execSync(`node "${cli}" update`, {
      cwd: tmpDir,
      stdio: "pipe",
      encoding: "utf8"
    });

    assert.match(output, /Migrated \.airc\.json -> \.agents\/\.airc\.json/);
    assert.match(output, /Migrated \.agent-workspace -> \.agents\/workspace/);
    assert.ok(fs.existsSync(path.join(tmpDir, ".agents", ".airc.json")));
    const migrated = JSON.parse(fs.readFileSync(path.join(tmpDir, ".agents", ".airc.json"), "utf8"));
    assert.ok(!("modules" in migrated), "legacy modules field should be removed during migration");
    assert.ok(!migrated.files.managed.includes(".editorconfig"));
    assert.ok(!migrated.files.merged.includes(".mailmap"));
    assert.ok(fs.existsSync(path.join(tmpDir, ".agents", "workspace", "README.md")));
    assert.ok(!fs.existsSync(path.join(tmpDir, ".airc.json")));
    assert.ok(!fs.existsSync(path.join(tmpDir, ".agent-workspace")));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("agent-infra update migrates v0.3 legacy config and workspace paths", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-update-legacy-"));
  const cli = filePath("bin/cli.js");

  try {
    fs.mkdirSync(path.join(tmpDir, ".agent-infra", "workspace"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".agent-infra", "config.json"),
      JSON.stringify({
        project: "legacyproj",
        org: "legacyorg",
        language: "en",
        templateSource: "templates/",
        templateVersion: "stale",
        modules: ["ai", "github"],
        files: {
          managed: [".editorconfig"],
          merged: [".mailmap"],
          ejected: []
        }
      }, null, 2) + "\n",
      "utf8"
    );
    fs.writeFileSync(path.join(tmpDir, ".agent-infra", "workspace", "README.md"), "legacy\n", "utf8");

    const output = execSync(`node "${cli}" update`, {
      cwd: tmpDir,
      stdio: "pipe",
      encoding: "utf8"
    });

    assert.match(output, /Migrated \.agent-infra\/config\.json -> \.agents\/\.airc\.json/);
    assert.match(output, /Migrated \.agent-infra\/workspace -> \.agents\/workspace/);
    assert.ok(fs.existsSync(path.join(tmpDir, ".agents", ".airc.json")));
    assert.ok(fs.existsSync(path.join(tmpDir, ".agents", "workspace", "README.md")));
    assert.ok(!fs.existsSync(path.join(tmpDir, ".agent-infra")));

    const migrated = JSON.parse(fs.readFileSync(path.join(tmpDir, ".agents", ".airc.json"), "utf8"));
    assert.ok(!("modules" in migrated), "legacy modules field should be removed during migration");
    assert.ok(!migrated.files.managed.includes(".editorconfig"));
    assert.ok(!migrated.files.merged.includes(".mailmap"));
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
