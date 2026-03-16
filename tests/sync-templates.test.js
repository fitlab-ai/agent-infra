import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { loadFreshEsm } from "./helpers.js";

function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
}

function writeJson(root, relativePath, value) {
  writeFile(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function normalize(targetPath) {
  return targetPath.replace(/\\/g, "/");
}

test("syncTemplates respects templateSource and stays idempotent", async () => {
  const originalHomedir = os.homedir;
  const originalExecSync = childProcess.execSync;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-sync-"));

  try {
    const homeDir = path.join(tmpDir, "home");
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = path.join(projectRoot, "custom-source");

    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });

    writeFile(templateRoot, "docs/guide.md", "Project {{project}}\n");
    writeFile(templateRoot, "docs/guide.zh-CN.md", "项目 {{project}}\n");
    writeFile(templateRoot, "docs/merge.md", "Merge {{org}}\n");
    writeFile(templateRoot, "docs/merge.zh-CN.md", "合并 {{org}}\n");
    writeFile(templateRoot, "docs/empty.txt", "");
    writeFile(templateRoot, "_project_/script.sh", "#!/bin/sh\necho {{project}}\n");
    writeFile(templateRoot, ".github/release.yml", "name: release\n");
    writeFile(templateRoot, "local-only.md", "Owner {{org}}\n");
    writeFile(templateRoot, "child.md", "Top\n");
    writeFile(templateRoot, "nested/child.md", "Nested\n");

    writeJson(projectRoot, ".aorc.json", {
      project: "demo",
      org: "acme",
      language: "zh-CN",
      templateSource: "custom-source",
      modules: ["ai"],
      files: {
        managed: ["docs/", "_project_/script.sh", ".github/release.yml"],
        merged: ["docs/merge.md", "**child.md"],
        ejected: ["local-only.md"]
      }
    });

    os.homedir = () => homeDir;
    childProcess.execSync = (command) => {
      if (command === "git remote get-url origin") {
        throw new Error("not a git repo");
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-orchestrator/scripts/sync-templates.js");

    const firstReport = syncTemplates(projectRoot);
    const afterFirstRun = fs.readFileSync(path.join(projectRoot, ".aorc.json"), "utf8");
    const secondReport = syncTemplates(projectRoot);
    const afterSecondRun = fs.readFileSync(path.join(projectRoot, ".aorc.json"), "utf8");

    assert.equal(normalize(firstReport.templateRoot), normalize(templateRoot));
    assert.ok(
      firstReport.registryAdded.some((entry) => entry.entry === ".editorconfig" && entry.list === "managed")
    );
    assert.deepEqual(firstReport.managed.created.sort(), ["demo/script.sh", "docs/empty.txt", "docs/guide.md"]);
    assert.deepEqual(firstReport.managed.written, []);
    assert.deepEqual(firstReport.managed.skippedMerged, ["docs/merge.md"]);
    assert.deepEqual(firstReport.managed.skippedModule, [".github/release.yml"]);
    assert.deepEqual(firstReport.managed.removed, []);
    assert.deepEqual(firstReport.ejected.created, ["local-only.md"]);
    assert.deepEqual(firstReport.ejected.skipped, []);
    assert.deepEqual(firstReport.merged.pending, [
      { target: "docs/merge.md", template: "docs/merge.zh-CN.md" },
      { target: "child.md", template: "child.md" },
      { target: ".github/release.yml", template: ".github/release.yml" }
    ]);

    assert.equal(fs.readFileSync(path.join(projectRoot, "docs/empty.txt"), "utf8"), "");
    assert.equal(fs.readFileSync(path.join(projectRoot, "docs/guide.md"), "utf8"), "项目 demo\n");
    assert.equal(fs.readFileSync(path.join(projectRoot, "local-only.md"), "utf8"), "Owner acme\n");
    assert.equal(fs.readFileSync(path.join(projectRoot, "demo/script.sh"), "utf8"), "#!/bin/sh\necho demo\n");
    assert.notEqual(fs.statSync(path.join(projectRoot, "demo/script.sh")).mode & 0o111, 0);

    assert.deepEqual(secondReport.managed.created, []);
    assert.deepEqual(secondReport.managed.written, []);
    assert.ok(secondReport.managed.unchanged.includes("docs/guide.md"));
    assert.ok(secondReport.managed.unchanged.includes("demo/script.sh"));
    assert.deepEqual(secondReport.managed.skippedMerged, ["docs/merge.md"]);
    assert.deepEqual(secondReport.managed.removed, []);
    assert.deepEqual(secondReport.ejected.created, []);
    assert.deepEqual(secondReport.ejected.skipped, ["local-only.md"]);
    assert.equal(afterSecondRun, afterFirstRun);
  } finally {
    os.homedir = originalHomedir;
    childProcess.execSync = originalExecSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates prefers the latest tag and reports the template version when clone metadata exists", async () => {
  const originalHomedir = os.homedir;
  const originalExecSync = childProcess.execSync;
  const originalExecFileSync = childProcess.execFileSync;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-sync-home-"));

  try {
    const homeDir = path.join(tmpDir, "home");
    const installDir = path.join(homeDir, ".agent-orchestrator");
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = path.join(tmpDir, "template-root");
    const commands = [];

    fs.mkdirSync(path.join(installDir, ".git"), { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(templateRoot, { recursive: true });

    writeFile(templateRoot, "README.md", "Hello {{project}}\n");
    writeJson(projectRoot, ".aorc.json", {
      project: "demo",
      org: "acme",
      language: "en",
      templateSource: templateRoot,
      modules: [],
      files: {
        managed: ["README.md"],
        merged: [],
        ejected: []
      }
    });

    os.homedir = () => homeDir;
    childProcess.execSync = (command, options = {}) => {
      commands.push({ command, cwd: options.cwd });

      if (command === "git fetch --tags --quiet") {
        return "";
      }
      if (command === "git tag --sort=-v:refname") {
        return "v1.0.0\nv0.9.0\n";
      }
      if (command === "git checkout v1.0.0 --quiet") {
        return "";
      }
      if (command === "git remote get-url origin") {
        throw new Error("not a git repo");
      }
      throw new Error(`Unexpected command: ${command}`);
    };
    childProcess.execFileSync = (file, args, options = {}) => {
      const command = [file, ...args].join(" ");
      commands.push({ command, cwd: options.cwd });

      if (file === "git" && args.join(" ") === "checkout v1.0.0 --quiet") {
        return "";
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-orchestrator/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot);

    assert.equal(report.templateVersion, "v1.0.0");
    assert.deepEqual(report.managed.removed, []);
    assert.deepEqual(commands.slice(0, 3), [
      { command: "git fetch --tags --quiet", cwd: installDir },
      { command: "git tag --sort=-v:refname", cwd: installDir },
      { command: "git checkout v1.0.0 --quiet", cwd: installDir }
    ]);
    assert.ok(!commands.some((entry) => entry.command === "git rev-parse --short HEAD"));
  } finally {
    os.homedir = originalHomedir;
    childProcess.execSync = originalExecSync;
    childProcess.execFileSync = originalExecFileSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates returns an error when no tags exist", async () => {
  const originalHomedir = os.homedir;
  const originalExecSync = childProcess.execSync;
  const originalExecFileSync = childProcess.execFileSync;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-sync-no-tags-"));

  try {
    const homeDir = path.join(tmpDir, "home");
    const installDir = path.join(homeDir, ".agent-orchestrator");
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = path.join(tmpDir, "template-root");
    const commands = [];

    fs.mkdirSync(path.join(installDir, ".git"), { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(templateRoot, { recursive: true });

    writeFile(templateRoot, "README.md", "Hello {{project}}\n");
    writeJson(projectRoot, ".aorc.json", {
      project: "demo",
      org: "acme",
      language: "en",
      templateSource: templateRoot,
      modules: [],
      files: {
        managed: ["README.md"],
        merged: [],
        ejected: []
      }
    });

    os.homedir = () => homeDir;
    childProcess.execSync = (command, options = {}) => {
      commands.push({ command, cwd: options.cwd });

      if (command === "git fetch --tags --quiet") {
        return "";
      }
      if (command === "git tag --sort=-v:refname") {
        return "\n";
      }
      if (command === "git remote get-url origin") {
        throw new Error("not a git repo");
      }
      throw new Error(`Unexpected command: ${command}`);
    };
    childProcess.execFileSync = () => {
      throw new Error("checkout should not run when no tags exist");
    };

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-orchestrator/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot);

    assert.deepEqual(report, {
      error: "No tags found in agent-orchestrator repository. This is unexpected — please reinstall."
    });
    assert.deepEqual(commands.slice(0, 2), [
      { command: "git fetch --tags --quiet", cwd: installDir },
      { command: "git tag --sort=-v:refname", cwd: installDir }
    ]);
    assert.ok(!commands.some((entry) => entry.command.startsWith("git checkout v")));
  } finally {
    os.homedir = originalHomedir;
    childProcess.execSync = originalExecSync;
    childProcess.execFileSync = originalExecFileSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates returns an error when tag listing fails", async () => {
  const originalHomedir = os.homedir;
  const originalExecSync = childProcess.execSync;
  const originalExecFileSync = childProcess.execFileSync;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-sync-tag-failure-"));

  try {
    const homeDir = path.join(tmpDir, "home");
    const installDir = path.join(homeDir, ".agent-orchestrator");
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = path.join(tmpDir, "template-root");
    const commands = [];

    fs.mkdirSync(path.join(installDir, ".git"), { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(templateRoot, { recursive: true });

    writeFile(templateRoot, "README.md", "Hello {{project}}\n");
    writeJson(projectRoot, ".aorc.json", {
      project: "demo",
      org: "acme",
      language: "en",
      templateSource: templateRoot,
      modules: [],
      files: {
        managed: ["README.md"],
        merged: [],
        ejected: []
      }
    });

    os.homedir = () => homeDir;
    childProcess.execSync = (command, options = {}) => {
      commands.push({ command, cwd: options.cwd });

      if (command === "git fetch --tags --quiet") {
        return "";
      }
      if (command === "git tag --sort=-v:refname") {
        throw new Error("git tag failed");
      }
      if (command === "git remote get-url origin") {
        throw new Error("not a git repo");
      }
      throw new Error(`Unexpected command: ${command}`);
    };
    childProcess.execFileSync = () => {
      throw new Error("checkout should not run when tag listing fails");
    };

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-orchestrator/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot);

    assert.deepEqual(report, {
      error: "Failed to list tags in agent-orchestrator repository. Please check git installation."
    });
    assert.deepEqual(commands.slice(0, 2), [
      { command: "git fetch --tags --quiet", cwd: installDir },
      { command: "git tag --sort=-v:refname", cwd: installDir }
    ]);
  } finally {
    os.homedir = originalHomedir;
    childProcess.execSync = originalExecSync;
    childProcess.execFileSync = originalExecFileSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates outputs both SECURITY language variants for zh-CN merged files", async () => {
  const originalHomedir = os.homedir;
  const originalExecSync = childProcess.execSync;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-sync-security-zh-"));

  try {
    const homeDir = path.join(tmpDir, "home");
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = path.join(tmpDir, "template-root");

    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(templateRoot, { recursive: true });

    writeFile(templateRoot, "SECURITY.md", "Security EN\n");
    writeFile(templateRoot, "SECURITY.zh-CN.md", "Security ZH\n");
    writeJson(projectRoot, ".aorc.json", {
      project: "demo",
      org: "acme",
      language: "zh-CN",
      templateSource: templateRoot,
      modules: [],
      files: {
        managed: [],
        merged: ["SECURITY.md"],
        ejected: []
      }
    });

    os.homedir = () => homeDir;
    childProcess.execSync = (command) => {
      if (command === "git remote get-url origin") {
        throw new Error("not a git repo");
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-orchestrator/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot);

    assert.deepEqual(report.merged.pending, [
      { target: "SECURITY.md", template: "SECURITY.md" },
      { target: "SECURITY.zh-CN.md", template: "SECURITY.zh-CN.md" }
    ]);
  } finally {
    os.homedir = originalHomedir;
    childProcess.execSync = originalExecSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates outputs both SECURITY language variants for en merged files", async () => {
  const originalHomedir = os.homedir;
  const originalExecSync = childProcess.execSync;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-sync-security-en-"));

  try {
    const homeDir = path.join(tmpDir, "home");
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = path.join(tmpDir, "template-root");

    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(templateRoot, { recursive: true });

    writeFile(templateRoot, "SECURITY.md", "Security EN\n");
    writeFile(templateRoot, "SECURITY.zh-CN.md", "Security ZH\n");
    writeJson(projectRoot, ".aorc.json", {
      project: "demo",
      org: "acme",
      language: "en",
      templateSource: templateRoot,
      modules: [],
      files: {
        managed: [],
        merged: ["SECURITY.md"],
        ejected: []
      }
    });

    os.homedir = () => homeDir;
    childProcess.execSync = (command) => {
      if (command === "git remote get-url origin") {
        throw new Error("not a git repo");
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-orchestrator/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot);

    assert.deepEqual(report.merged.pending, [
      { target: "SECURITY.md", template: "SECURITY.md" },
      { target: "SECURITY.zh-CN.md", template: "SECURITY.zh-CN.md" }
    ]);
  } finally {
    os.homedir = originalHomedir;
    childProcess.execSync = originalExecSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates removes stale managed files but preserves merged, ejected, and disabled-module files", async () => {
  const originalHomedir = os.homedir;
  const originalExecSync = childProcess.execSync;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-sync-cleanup-"));

  try {
    const homeDir = path.join(tmpDir, "home");
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = path.join(tmpDir, "template-root");

    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(templateRoot, { recursive: true });

    writeFile(templateRoot, "docs/guide.md", "Guide\n");
    writeFile(templateRoot, ".agents/keep.md", "AI enabled\n");
    writeFile(templateRoot, ".github/workflows/release.yml", "name: release\n");
    writeFile(templateRoot, "preserved.md", "Existing\n");

    writeJson(projectRoot, ".aorc.json", {
      project: "demo",
      org: "acme",
      language: "en",
      templateSource: templateRoot,
      modules: ["ai"],
      files: {
        managed: ["docs/", ".agents/", ".github/"],
        merged: ["docs/merged.md"],
        ejected: ["docs/ejected.md"]
      }
    });

    writeFile(projectRoot, "docs/guide.md", "Guide\n");
    writeFile(projectRoot, "docs/stale.md", "remove me\n");
    writeFile(projectRoot, "docs/merged.md", "keep merged\n");
    writeFile(projectRoot, "docs/ejected.md", "keep ejected\n");
    writeFile(projectRoot, "docs/subdir/orphan.md", "remove orphan\n");
    writeFile(projectRoot, ".agents/keep.md", "AI enabled\n");
    writeFile(projectRoot, ".github/workflows/release.yml", "name: custom\n");

    os.homedir = () => homeDir;
    childProcess.execSync = (command) => {
      if (command === "git remote get-url origin") {
        throw new Error("not a git repo");
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-orchestrator/scripts/sync-templates.js");

    const firstReport = syncTemplates(projectRoot);
    const secondReport = syncTemplates(projectRoot);

    assert.deepEqual(firstReport.managed.removed.sort(), ["docs/stale.md", "docs/subdir/orphan.md"]);
    assert.ok(!fs.existsSync(path.join(projectRoot, "docs/stale.md")));
    assert.ok(!fs.existsSync(path.join(projectRoot, "docs/subdir")));
    assert.equal(fs.readFileSync(path.join(projectRoot, "docs/merged.md"), "utf8"), "keep merged\n");
    assert.equal(fs.readFileSync(path.join(projectRoot, "docs/ejected.md"), "utf8"), "keep ejected\n");
    assert.equal(fs.readFileSync(path.join(projectRoot, ".github/workflows/release.yml"), "utf8"), "name: custom\n");
    assert.deepEqual(firstReport.managed.skippedModule, [".github/workflows/release.yml"]);
    assert.deepEqual(firstReport.managed.skippedMerged, []);
    assert.deepEqual(secondReport.managed.removed, []);
    assert.ok(secondReport.managed.unchanged.includes("docs/guide.md"));
    assert.ok(secondReport.managed.unchanged.includes(".agents/keep.md"));
  } finally {
    os.homedir = originalHomedir;
    childProcess.execSync = originalExecSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates preserves stale files that match merged glob patterns", async () => {
  const originalHomedir = os.homedir;
  const originalExecSync = childProcess.execSync;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-sync-glob-"));

  try {
    const homeDir = path.join(tmpDir, "home");
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = path.join(tmpDir, "template-root");

    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(templateRoot, { recursive: true });

    writeFile(templateRoot, "docs/guide.md", "Guide\n");
    writeJson(projectRoot, ".aorc.json", {
      project: "demo",
      org: "acme",
      language: "en",
      templateSource: templateRoot,
      modules: [],
      files: {
        managed: ["docs/"],
        merged: ["docs/**/*.md"],
        ejected: []
      }
    });

    writeFile(projectRoot, "docs/guide.md", "Guide\n");
    writeFile(projectRoot, "docs/stale/note.md", "keep merged glob\n");
    writeFile(projectRoot, "docs/stale/extra.txt", "remove non-md\n");

    os.homedir = () => homeDir;
    childProcess.execSync = (command) => {
      if (command === "git remote get-url origin") {
        throw new Error("not a git repo");
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-orchestrator/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot);

    assert.equal(fs.readFileSync(path.join(projectRoot, "docs/stale/note.md"), "utf8"), "keep merged glob\n");
    assert.ok(!fs.existsSync(path.join(projectRoot, "docs/stale/extra.txt")));
    assert.deepEqual(report.managed.removed, ["docs/stale/extra.txt"]);
  } finally {
    os.homedir = originalHomedir;
    childProcess.execSync = originalExecSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
