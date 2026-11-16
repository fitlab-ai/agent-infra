import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cliArgs, createTempDir } from "../../helpers.ts";

function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, cliArgs("skill", ...args), { cwd: root, encoding: "utf8" });
}

function project(root: string) {
  fs.mkdirSync(path.join(root, ".agents/skills/custom-guide"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agents/skills/custom-guide/SKILL.md"), "---\nname: custom-guide\ndescription: Custom guide\n---\nBody\n");
  fs.mkdirSync(path.join(root, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agents/.airc.json"), JSON.stringify({
    project: "demo", skills: { sources: [], registrations: [] }, files: { managedBaselines: {} }
  }, null, 2));
}

test("skill add, list, and remove preserve project source files", () => {
  const root = createTempDir("ai-skill-cli-");
  try {
    project(root);
    const added = run(root, "add", "custom-guide");
    assert.equal(added.status, 0, added.stderr);
    const configPath = path.join(root, ".agents/.airc.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.deepEqual(config.skills.registrations, [{ name: "custom-guide", type: "project", path: ".agents/skills/custom-guide" }]);

    const listed = run(root, "list");
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /registered\tavailable\tproject\tcustom-guide/u);
    assert.match(listed.stdout, /builtin\tupdate-agent-infra/u);

    const removed = run(root, "remove", "custom-guide");
    assert.equal(removed.status, 0, removed.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).skills.registrations, []);
    assert.equal(fs.existsSync(path.join(root, ".agents/skills/custom-guide/SKILL.md")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skill remove rejects built-in skills", () => {
  const root = createTempDir("ai-skill-builtin-");
  try {
    project(root);
    const result = run(root, "remove", "update-agent-infra");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot be removed/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skill add registers one external candidate and remove preserves its source", () => {
  const root = createTempDir("ai-skill-external-");
  const sourceRoot = path.join(root, "private-skills");
  try {
    fs.mkdirSync(path.join(sourceRoot, "team-guide"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "team-guide/SKILL.md"), "---\nname: team-guide\ndescription: Team guide\n---\nBody\n");
    fs.mkdirSync(path.join(root, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agents/.airc.json"), JSON.stringify({
      project: "demo", skills: { sources: [{ type: "local", path: sourceRoot }], registrations: [] }, files: { managedBaselines: {} }
    }, null, 2));

    const added = run(root, "add", "team-guide");
    assert.equal(added.status, 0, added.stderr);
    const configPath = path.join(root, ".agents/.airc.json");
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).skills.registrations, [
      { name: "team-guide", type: "local", path: path.join(sourceRoot, "team-guide") }
    ]);
    assert.match(run(root, "list").stdout, /registered\tavailable\tlocal\tteam-guide/u);
    const removed = run(root, "remove", "team-guide");
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(fs.existsSync(path.join(sourceRoot, "team-guide/SKILL.md")), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).skills.registrations, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
