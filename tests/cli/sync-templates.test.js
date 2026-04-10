import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { loadFreshEsm, read } from "../helpers.js";

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

test("syncTemplates resolves template roots via PATH lookup and removes legacy templateSource", async () => {
  const originalExecSync = childProcess.execSync;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-sync-"));

  try {
    const projectRoot = path.join(tmpDir, "project");
    const installRoot = path.join(tmpDir, "install");
    const templateRoot = path.join(installRoot, "templates");

    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(path.join(installRoot, "bin"), { recursive: true });

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
    writeJson(installRoot, "package.json", {
      name: "@fitlab-ai/agent-infra",
      version: "0.0.0-test"
    });
    writeFile(installRoot, "bin/cli.js", "console.log('ai');\n");

    writeJson(projectRoot, ".agents/.airc.json", {
      project: "demo",
      org: "acme",
      language: "zh-CN",
      templateSource: "custom-source",
      files: {
        managed: ["docs/", "_project_/script.sh", ".github/release.yml"],
        merged: ["docs/merge.md", "**child.md"],
        ejected: ["local-only.md"]
      }
    });

    childProcess.execSync = (command, options = {}) => {
      if (command === "command -v ai") {
        assert.equal(options.encoding, "utf8");
        return path.join(installRoot, "bin", "cli.js");
      }
      if (command === "git remote get-url origin") {
        throw new Error("not a git repo");
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-infra/scripts/sync-templates.js");

    const firstReport = syncTemplates(projectRoot);
    const afterFirstRun = fs.readFileSync(path.join(projectRoot, ".agents", ".airc.json"), "utf8");
    const secondReport = syncTemplates(projectRoot);
    const afterSecondRun = fs.readFileSync(path.join(projectRoot, ".agents", ".airc.json"), "utf8");
    const parsedConfig = JSON.parse(afterSecondRun);

    assert.equal(
      normalize(firstReport.templateRoot),
      normalize(fs.realpathSync(templateRoot))
    );
    assert.equal(firstReport.configUpdated, true);
    assert.ok(!("templateSource" in parsedConfig));
    assert.ok(firstReport.registryAdded.some((entry) => entry.entry === ".agents/skills/" && entry.list === "managed"));
    assert.deepEqual(firstReport.managed.created.sort(), ["demo/script.sh", "docs/empty.txt", "docs/guide.md"]);
    assert.deepEqual(firstReport.managed.written, []);
    assert.deepEqual(firstReport.managed.skippedMerged, ["docs/merge.md", ".github/release.yml"]);
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
    assert.deepEqual(secondReport.managed.skippedMerged, ["docs/merge.md", ".github/release.yml"]);
    assert.deepEqual(secondReport.managed.removed, []);
    assert.deepEqual(secondReport.ejected.created, []);
    assert.deepEqual(secondReport.ejected.skipped, ["local-only.md"]);
    assert.equal(secondReport.configUpdated, false);
    assert.equal(afterSecondRun, afterFirstRun);
  } finally {
    childProcess.execSync = originalExecSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates resolves Windows npm wrappers via .cmd launchers", async () => {
  const originalExecSync = childProcess.execSync;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-sync-win32-"));

  try {
    const projectRoot = path.join(tmpDir, "project");
    const globalRoot = path.join(tmpDir, "npm-global");
    const packageRoot = path.join(globalRoot, "node_modules", "@fitlab-ai", "agent-infra");
    const templateRoot = path.join(packageRoot, "templates");
    const wrapperPath = path.join(globalRoot, "ai.cmd");

    fs.mkdirSync(projectRoot, { recursive: true });

    writeFile(templateRoot, "README.md", "Hello {{project}}\n");
    writeJson(packageRoot, "package.json", {
      name: "@fitlab-ai/agent-infra",
      version: "0.0.0-test"
    });
    writeFile(globalRoot, "ai.cmd", "@ECHO OFF\r\n");

    writeJson(projectRoot, ".agents/.airc.json", {
      project: "demo",
      org: "acme",
      language: "en",
      files: {
        managed: ["README.md"],
        merged: [],
        ejected: []
      }
    });

    Object.defineProperty(process, "platform", { value: "win32" });
    childProcess.execSync = (command) => {
      if (command === "where ai") {
        return wrapperPath;
      }
      if (command === "git remote get-url origin") {
        throw new Error("not a git repo");
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-infra/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot);

    assert.equal(normalize(report.templateRoot), normalize(templateRoot));
    assert.equal(fs.readFileSync(path.join(projectRoot, "README.md"), "utf8"), "Hello demo\n");
  } finally {
    childProcess.execSync = originalExecSync;
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates reports the bundled installer version with a v prefix", async () => {
  const originalExecSync = childProcess.execSync;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-sync-installer-version-"));

  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = path.join(tmpDir, "template-root");

    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(templateRoot, { recursive: true });

    writeFile(templateRoot, "README.md", "Hello {{project}}\n");
    writeJson(projectRoot, ".agents/.airc.json", {
      project: "demo",
      org: "acme",
      language: "en",
      files: {
        managed: ["README.md"],
        merged: [],
        ejected: []
      }
    });

    childProcess.execSync = (command) => {
      if (command === "git remote get-url origin") {
        throw new Error("not a git repo");
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-infra/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot, templateRoot);

    assert.equal(
      report.templateVersion,
      `v${JSON.parse(read("package.json")).version}`
    );
  } finally {
    childProcess.execSync = originalExecSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates removes stale managed files but preserves merged and ejected files", async () => {
  const originalExecSync = childProcess.execSync;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-sync-cleanup-"));

  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = path.join(tmpDir, "template-root");

    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(templateRoot, { recursive: true });

    writeFile(templateRoot, "docs/guide.md", "Guide\n");
    writeFile(templateRoot, ".agents/keep.md", "AI enabled\n");
    writeFile(templateRoot, ".github/workflows/release.yml", "name: release\n");
    writeFile(templateRoot, "preserved.md", "Existing\n");

    writeJson(projectRoot, ".agents/.airc.json", {
      project: "demo",
      org: "acme",
      language: "en",
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

    childProcess.execSync = (command) => {
      if (command === "git remote get-url origin") {
        throw new Error("not a git repo");
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-infra/scripts/sync-templates.js");

    const firstReport = syncTemplates(projectRoot, templateRoot);
    const secondReport = syncTemplates(projectRoot, templateRoot);

    assert.deepEqual(firstReport.managed.removed.sort(), ["docs/stale.md", "docs/subdir/orphan.md"]);
    assert.ok(!fs.existsSync(path.join(projectRoot, "docs/stale.md")));
    assert.ok(!fs.existsSync(path.join(projectRoot, "docs/subdir")));
    assert.equal(fs.readFileSync(path.join(projectRoot, "docs/merged.md"), "utf8"), "keep merged\n");
    assert.equal(fs.readFileSync(path.join(projectRoot, "docs/ejected.md"), "utf8"), "keep ejected\n");
    assert.equal(fs.readFileSync(path.join(projectRoot, ".github/workflows/release.yml"), "utf8"), "name: custom\n");
    assert.deepEqual(firstReport.managed.skippedMerged, [".github/workflows/release.yml"]);
    assert.deepEqual(secondReport.managed.removed, []);
    assert.ok(secondReport.managed.unchanged.includes("docs/guide.md"));
    assert.ok(secondReport.managed.unchanged.includes(".agents/keep.md"));
    assert.deepEqual(secondReport.managed.skippedMerged, [".github/workflows/release.yml"]);
  } finally {
    childProcess.execSync = originalExecSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates preserves stale files that match merged glob patterns", async () => {
  const originalExecSync = childProcess.execSync;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-sync-glob-"));

  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = path.join(tmpDir, "template-root");

    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(templateRoot, { recursive: true });

    writeFile(templateRoot, "docs/guide.md", "Guide\n");
    writeJson(projectRoot, ".agents/.airc.json", {
      project: "demo",
      org: "acme",
      language: "en",
      files: {
        managed: ["docs/"],
        merged: ["docs/**/*.md"],
        ejected: []
      }
    });

    writeFile(projectRoot, "docs/guide.md", "Guide\n");
    writeFile(projectRoot, "docs/stale/note.md", "keep merged glob\n");
    writeFile(projectRoot, "docs/stale/extra.txt", "remove non-md\n");

    childProcess.execSync = (command) => {
      if (command === "git remote get-url origin") {
        throw new Error("not a git repo");
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-infra/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot, templateRoot);

    assert.equal(fs.readFileSync(path.join(projectRoot, "docs/stale/note.md"), "utf8"), "keep merged glob\n");
    assert.ok(!fs.existsSync(path.join(projectRoot, "docs/stale/extra.txt")));
    assert.deepEqual(report.managed.removed, ["docs/stale/extra.txt"]);
  } finally {
    childProcess.execSync = originalExecSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates syncs the managed github hook as a single file", async () => {
  const originalExecSync = childProcess.execSync;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-sync-github-hook-"));

  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = path.join(tmpDir, "template-root");

    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(templateRoot, { recursive: true });

    writeFile(
      templateRoot,
      ".github/hooks/check-version-format.sh",
      "#!/bin/sh\necho github hook\n"
    );

    writeJson(projectRoot, ".agents/.airc.json", {
      project: "demo",
      org: "acme",
      language: "en",
      files: {
        managed: [],
        merged: [],
        ejected: []
      }
    });

    writeFile(projectRoot, ".github/hooks/custom.sh", "#!/bin/sh\necho keep me\n");

    childProcess.execSync = (command) => {
      if (command === "git remote get-url origin") {
        throw new Error("not a git repo");
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-infra/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot, templateRoot);

    assert.ok(
      report.registryAdded.some(
        (entry) => entry.entry === ".github/hooks/check-version-format.sh" && entry.list === "managed"
      )
    );
    assert.deepEqual(report.managed.created, [".github/hooks/check-version-format.sh"]);
    assert.equal(
      fs.readFileSync(path.join(projectRoot, ".github/hooks/check-version-format.sh"), "utf8"),
      "#!/bin/sh\necho github hook\n"
    );
    assert.notEqual(
      fs.statSync(path.join(projectRoot, ".github/hooks/check-version-format.sh")).mode & 0o111,
      0
    );
    assert.equal(
      fs.readFileSync(path.join(projectRoot, ".github/hooks/custom.sh"), "utf8"),
      "#!/bin/sh\necho keep me\n"
    );
  } finally {
    childProcess.execSync = originalExecSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates reports github pre-commit as a merged pending file", async () => {
  const originalExecSync = childProcess.execSync;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-sync-github-pre-commit-"));

  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = path.join(tmpDir, "template-root");

    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(templateRoot, { recursive: true });

    writeFile(templateRoot, ".github/hooks/pre-commit", "#!/bin/sh\n");

    writeJson(projectRoot, ".agents/.airc.json", {
      project: "demo",
      org: "acme",
      language: "en",
      files: {
        managed: [],
        merged: [],
        ejected: []
      }
    });

    childProcess.execSync = (command) => {
      if (command === "git remote get-url origin") {
        throw new Error("not a git repo");
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-infra/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot, templateRoot);

    assert.ok(
      report.registryAdded.some(
        (entry) => entry.entry === ".github/hooks/pre-commit" && entry.list === "merged"
      )
    );
    assert.deepEqual(
      report.merged.pending.filter((entry) => entry.target === ".github/hooks/pre-commit"),
      [{ target: ".github/hooks/pre-commit", template: ".github/hooks/pre-commit" }]
    );
  } finally {
    childProcess.execSync = originalExecSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
