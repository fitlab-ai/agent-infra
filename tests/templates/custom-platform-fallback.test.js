import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { filePath, loadFreshEsm, read } from "../helpers.js";

function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
}

function writeJson(root, relativePath, value) {
  writeFile(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

test("custom platforms fall back to generic platform templates", async () => {
  const originalExecSync = childProcess.execSync;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-collab-custom-platform-"));

  const expectedTargets = [
    ".agents/rules/issue-pr-commands.md",
    ".agents/rules/issue-sync.md",
    ".agents/rules/label-milestone-setup.md",
    ".agents/rules/milestone-inference.md",
    ".agents/rules/pr-sync.md",
    ".agents/rules/release-commands.md",
    ".agents/rules/security-alerts.md",
    ".agents/scripts/platform-adapters/platform-sync.js",
    ".agents/skills/init-labels/scripts/init-labels.sh",
    ".agents/skills/init-milestones/scripts/init-milestones.sh",
    ".agents/skills/release/scripts/manage-milestones.sh",
    ".git-hooks/check-version-format.sh"
  ];

  try {
    const projectRoot = path.join(tmpDir, "project");
    const defaults = JSON.parse(read("lib/defaults.json"));

    fs.mkdirSync(projectRoot, { recursive: true });
    writeJson(projectRoot, ".agents/.airc.json", {
      project: "demo",
      org: "acme",
      language: "en",
      platform: { type: "gitea" },
      files: structuredClone(defaults.files)
    });

    childProcess.execSync = (command) => {
      if (command === "git remote get-url origin") {
        throw new Error("not a git repo");
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    const { syncTemplates } = await loadFreshEsm(".agents/skills/update-agent-infra/scripts/sync-templates.js");
    const report = syncTemplates(projectRoot, filePath("templates"));
    const created = new Set(report.managed.created);

    expectedTargets.forEach((target) => {
      assert.ok(created.has(target), `${target} should be selected for a custom platform`);
      assert.ok(fs.existsSync(path.join(projectRoot, target)), `${target} should be written`);
    });

    [
      "issue-pr-commands",
      "issue-sync",
      "label-milestone-setup",
      "milestone-inference",
      "pr-sync",
      "release-commands",
      "security-alerts"
    ].forEach((name) => {
      assert.equal(
        fs.readFileSync(path.join(projectRoot, ".agents", "rules", `${name}.md`), "utf8"),
        read(`templates/.agents/rules/${name}.en.md`),
        `${name}.md should be rendered from the generic English fallback`
      );
    });

    [
      ".agents/scripts/platform-adapters/platform-sync.js",
      ".agents/skills/init-labels/scripts/init-labels.sh",
      ".agents/skills/init-milestones/scripts/init-milestones.sh",
      ".agents/skills/release/scripts/manage-milestones.sh",
      ".git-hooks/check-version-format.sh"
    ].forEach((target) => {
      assert.equal(
        fs.readFileSync(path.join(projectRoot, target), "utf8"),
        read(`templates/${target}`),
        `${target} should be rendered from the generic fallback`
      );
    });

    assert.ok(
      !fs.existsSync(path.join(projectRoot, ".github/scripts/sync-labels-to-set.sh")),
      "custom platforms should skip GitHub-owned files"
    );
  } finally {
    childProcess.execSync = originalExecSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
