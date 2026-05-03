import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadFreshEsm, read, supportsPosixModeBits } from "../helpers.js";

function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
}

function writeJson(root, relativePath, value) {
  writeFile(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createTemplateInstall(tmpDir, version = "0.0.0-test") {
  const installRoot = path.join(tmpDir, "install");
  const templateRoot = path.join(installRoot, "templates");

  fs.mkdirSync(templateRoot, { recursive: true });
  writeJson(installRoot, "package.json", {
    name: "@fitlab-ai/agent-infra",
    version
  });

  return { templateRoot };
}

function withStubbedExecSync(fn) {
  const originalExecSync = childProcess.execSync;
  childProcess.execSync = (command) => {
    if (command === "git remote get-url origin") {
      throw new Error("not a git repo");
    }
    throw new Error(`Unexpected command: ${command}`);
  };

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      childProcess.execSync = originalExecSync;
    });
}

test("gitlab projects skip github-owned managed directories", async () => withStubbedExecSync(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-platform-gating-"));

  try {
    const projectRoot = path.join(tmpDir, "project");
    const { templateRoot } = createTemplateInstall(tmpDir);

    fs.mkdirSync(projectRoot, { recursive: true });
    writeFile(templateRoot, ".github/scripts/sync-labels-to-set.sh", "#!/bin/sh\necho labels\n");
    writeFile(templateRoot, ".git-hooks/check-version-format.sh", "#!/bin/sh\necho hook\n");
    writeJson(projectRoot, ".agents/.airc.json", {
      project: "demo",
      org: "acme",
      language: "en",
      platform: { type: "gitlab" },
      files: { managed: [], merged: [], ejected: [] }
    });

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-infra/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot, templateRoot);

    assert.ok(!fs.existsSync(path.join(projectRoot, ".github/scripts/sync-labels-to-set.sh")));
    assert.ok(
      !report.registryAdded.some((entry) => entry.entry === ".github/scripts/"),
      "gitlab projects should not add GitHub-owned registry entries"
    );
    assert.ok(fs.existsSync(path.join(projectRoot, ".git-hooks/check-version-format.sh")));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}));

test("platform switch removes stale github-owned files", async () => withStubbedExecSync(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-platform-switch-"));

  try {
    const projectRoot = path.join(tmpDir, "project");
    const { templateRoot } = createTemplateInstall(tmpDir);

    fs.mkdirSync(projectRoot, { recursive: true });
    writeFile(templateRoot, ".github/scripts/sync-labels-to-set.sh", "#!/bin/sh\necho labels\n");
    writeJson(projectRoot, ".agents/.airc.json", {
      project: "demo",
      org: "acme",
      language: "en",
      platform: { type: "gitlab" },
      files: { managed: [".github/scripts/"], merged: [], ejected: [] }
    });
    writeFile(projectRoot, ".github/scripts/sync-labels-to-set.sh", "#!/bin/sh\necho stale\n");

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-infra/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot, templateRoot);

    assert.ok(!fs.existsSync(path.join(projectRoot, ".github/scripts/sync-labels-to-set.sh")));
    assert.ok(report.managed.removed.includes(".github/scripts/sync-labels-to-set.sh"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}));

test("shared hooks are distributed to all platforms", async () => withStubbedExecSync(async () => {
  const platforms = ["github", "gitlab", "gitea", "custom"];

  for (const platformType of platforms) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `ai-collab-shared-hooks-${platformType}-`));

    try {
      const projectRoot = path.join(tmpDir, "project");
      const { templateRoot } = createTemplateInstall(tmpDir);

      fs.mkdirSync(projectRoot, { recursive: true });
      writeFile(templateRoot, ".git-hooks/check-version-format.sh", "#!/bin/sh\necho hook\n");
      writeJson(projectRoot, ".agents/.airc.json", {
        project: "demo",
        org: "acme",
        language: "en",
        platform: { type: platformType },
        files: { managed: [], merged: [], ejected: [] }
      });

      const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-infra/scripts/sync-templates.js");
      const report = syncTemplates(projectRoot, templateRoot);
      const hookPath = path.join(projectRoot, ".git-hooks/check-version-format.sh");

      assert.ok(fs.existsSync(hookPath), `${platformType} should receive shared hooks`);
      assert.ok(report.managed.created.includes(".git-hooks/check-version-format.sh"));
      if (supportsPosixModeBits()) {
        assert.notEqual(fs.statSync(hookPath).mode & 0o111, 0);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}));

test("custom platforms skip all known-platform directories", async () => withStubbedExecSync(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-custom-platform-skip-"));

  try {
    const projectRoot = path.join(tmpDir, "project");
    const { templateRoot } = createTemplateInstall(tmpDir);

    fs.mkdirSync(projectRoot, { recursive: true });
    writeFile(templateRoot, ".github/scripts/sync-labels-to-set.sh", read("templates/.github/scripts/sync-labels-to-set.sh"));
    writeJson(projectRoot, ".agents/.airc.json", {
      project: "demo",
      org: "acme",
      language: "en",
      platform: { type: "custom" },
      files: { managed: [], merged: [], ejected: [] }
    });

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-infra/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot, templateRoot);

    assert.ok(!fs.existsSync(path.join(projectRoot, ".github/scripts/sync-labels-to-set.sh")));
    assert.ok(
      !report.registryAdded.some((entry) => entry.entry === ".github/scripts/"),
      "custom platforms should not add GitHub-owned registry entries"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}));
