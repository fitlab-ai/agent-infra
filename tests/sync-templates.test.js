const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { loadFresh } = require("./helpers");

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

test("syncTemplates respects templateSource and stays idempotent", () => {
  const originalHomedir = os.homedir;
  const childProcess = require("node:child_process");
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

    writeJson(projectRoot, "collaborator.json", {
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

    const { syncTemplates } = loadFresh(".agents/skills/update-ai-collaboration/scripts/sync-templates.cjs");

    const firstReport = syncTemplates(projectRoot);
    const afterFirstRun = fs.readFileSync(path.join(projectRoot, "collaborator.json"), "utf8");
    const secondReport = syncTemplates(projectRoot);
    const afterSecondRun = fs.readFileSync(path.join(projectRoot, "collaborator.json"), "utf8");

    assert.equal(normalize(firstReport.templateRoot), normalize(templateRoot));
    assert.ok(
      firstReport.registryAdded.some((entry) => entry.entry === ".editorconfig" && entry.list === "managed")
    );
    assert.deepEqual(firstReport.managed.created.sort(), ["demo/script.sh", "docs/empty.txt", "docs/guide.md"]);
    assert.deepEqual(firstReport.managed.written, []);
    assert.deepEqual(firstReport.managed.skippedMerged, ["docs/merge.md"]);
    assert.deepEqual(firstReport.managed.skippedModule, [".github/release.yml"]);
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
    assert.deepEqual(secondReport.ejected.created, []);
    assert.deepEqual(secondReport.ejected.skipped, ["local-only.md"]);
    assert.equal(afterSecondRun, afterFirstRun);
  } finally {
    os.homedir = originalHomedir;
    childProcess.execSync = originalExecSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncTemplates runs git pull and reports the install SHA when clone metadata exists", () => {
  const originalHomedir = os.homedir;
  const childProcess = require("node:child_process");
  const originalExecSync = childProcess.execSync;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-sync-home-"));

  try {
    const homeDir = path.join(tmpDir, "home");
    const installDir = path.join(homeDir, ".ai-collaboration-installer");
    const projectRoot = path.join(tmpDir, "project");
    const templateRoot = path.join(tmpDir, "template-root");
    const commands = [];

    fs.mkdirSync(path.join(installDir, ".git"), { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(templateRoot, { recursive: true });

    writeFile(templateRoot, "README.md", "Hello {{project}}\n");
    writeJson(projectRoot, "collaborator.json", {
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

      if (command === "git pull --quiet") {
        return "";
      }
      if (command === "git rev-parse --short HEAD") {
        return "abc123\n";
      }
      if (command === "git remote get-url origin") {
        throw new Error("not a git repo");
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    const { syncTemplates } = loadFresh(".agents/skills/update-ai-collaboration/scripts/sync-templates.cjs");
    const report = syncTemplates(projectRoot);

    assert.equal(report.templateSha, "abc123");
    assert.ok(commands.some((entry) => entry.command === "git pull --quiet" && entry.cwd === installDir));
    assert.ok(commands.some((entry) => entry.command === "git rev-parse --short HEAD" && entry.cwd === installDir));
  } finally {
    os.homedir = originalHomedir;
    childProcess.execSync = originalExecSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
