import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { loadFreshEsm, read } from "./helpers.js";

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
  const originalExecSync = childProcess.execSync;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-sync-"));

  try {
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = path.join(projectRoot, "custom-source");

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

    childProcess.execSync = (command) => {
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

    assert.equal(normalize(firstReport.templateRoot), normalize(templateRoot));
    assert.ok(firstReport.registryAdded.some((entry) => entry.entry === ".agents/skills/" && entry.list === "managed"));
    assert.deepEqual(firstReport.managed.created.sort(), ["demo/script.sh", "docs/empty.txt", "docs/guide.md"]);
    assert.deepEqual(firstReport.managed.written, []);
    assert.deepEqual(firstReport.managed.skippedMerged, ["docs/merge.md"]);
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
    childProcess.execSync = originalExecSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates prunes retired config entries during sync", async () => {
  const originalExecSync = childProcess.execSync;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-sync-prune-"));

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
      templateSource: templateRoot,
      modules: ["ai", "github"],
      files: {
        managed: [".editorconfig", "README.md"],
        merged: [".mailmap"],
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
    syncTemplates(projectRoot);

    const updated = JSON.parse(fs.readFileSync(path.join(projectRoot, ".agents", ".airc.json"), "utf8"));
    assert.ok(!("modules" in updated));
    assert.ok(!updated.files.managed.includes(".editorconfig"));
    assert.ok(!updated.files.merged.includes(".mailmap"));
  } finally {
    childProcess.execSync = originalExecSync;
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
      templateSource: templateRoot,
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
    const report = syncTemplates(projectRoot);

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
      templateSource: templateRoot,
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

    const firstReport = syncTemplates(projectRoot);
    const secondReport = syncTemplates(projectRoot);

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
      templateSource: templateRoot,
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
    const report = syncTemplates(projectRoot);

    assert.equal(fs.readFileSync(path.join(projectRoot, "docs/stale/note.md"), "utf8"), "keep merged glob\n");
    assert.ok(!fs.existsSync(path.join(projectRoot, "docs/stale/extra.txt")));
    assert.deepEqual(report.managed.removed, ["docs/stale/extra.txt"]);
  } finally {
    childProcess.execSync = originalExecSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
