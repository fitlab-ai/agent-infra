import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cliArgs, createTempDir, onPlatforms } from "../../helpers.ts";

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
    const projectRows = listed.stdout.split("\n").filter((line) => line.split("\t")[3] === "custom-guide");
    assert.deepEqual(projectRows.map((line) => line.split("\t").slice(0, 4)), [["registered", "available", "project", "custom-guide"]]);
    assert.match(listed.stdout, /builtin\tupdate-agent-infra/u);

    const removed = run(root, "remove", "custom-guide");
    assert.equal(removed.status, 0, removed.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).skills.registrations, []);
    assert.equal(fs.existsSync(path.join(root, ".agents/skills/custom-guide/SKILL.md")), true);

    const builtin = run(root, "remove", "update-agent-infra");
    assert.equal(builtin.status, 1);
    assert.match(builtin.stderr, /cannot be removed/u);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).skills.registrations, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skill remove retains files reached through a symlinked skill target", () => {
  const root = createTempDir("ai-skill-symlink-remove-");
  const outside = createTempDir("ai-skill-symlink-outside-");
  try {
    fs.mkdirSync(path.join(root, ".agents/skills"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, ".agents/skills/linked-guide"), "dir");
    fs.mkdirSync(path.join(root, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agents/.airc.json"), JSON.stringify({
      project: "demo",
      skills: { sources: [], registrations: [{ name: "linked-guide", type: "local", path: path.join(outside, "source") }] }
    }));
    fs.writeFileSync(path.join(outside, "SKILL.md"), "keep outside\n");

    const removed = run(root, "remove", "linked-guide");
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(fs.readFileSync(path.join(outside, "SKILL.md"), "utf8"), "keep outside\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("skill remove does not enumerate project skill candidates", () => {
  const root = createTempDir("ai-skill-remove-no-scan-");
  const skillsPath = path.join(root, ".agents/skills");
  try {
    fs.mkdirSync(path.join(root, ".agents"), { recursive: true });
    fs.writeFileSync(skillsPath, "candidate root is not a directory\n");
    const configPath = path.join(root, ".agents/.airc.json");
    fs.writeFileSync(configPath, JSON.stringify({
      project: "demo",
      skills: {
        sources: [],
        registrations: [{ name: "external-guide", type: "local", path: path.join(root, "outside/external-guide") }]
      },
      files: { managedBaselines: {} }
    }));

    const removed = run(root, "remove", "external-guide");
    assert.equal(removed.status, 0, removed.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).skills.registrations, []);
    assert.equal(fs.readFileSync(skillsPath, "utf8"), "candidate root is not a directory\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skill remove clears retained command baselines before a same-name source is rebound", () => {
  const root = createTempDir("ai-skill-rebind-baseline-");
  const sourceA = path.join(root, "source-a");
  const sourceB = path.join(root, "source-b");
  const commandTarget = path.join(root, ".claude/commands/guide.md");
  const originalCommand = "generated command\n";
  const editedCommand = "user edited command\n";
  try {
    const sourceBodies: [string, string][] = [[sourceA, "A"], [sourceB, "B"]];
    for (const [source, body] of sourceBodies) {
      fs.mkdirSync(path.join(source, "guide"), { recursive: true });
      fs.writeFileSync(path.join(source, "guide/SKILL.md"), `---\nname: guide\n---\n${body}\n`);
    }
    fs.mkdirSync(path.dirname(commandTarget), { recursive: true });
    fs.writeFileSync(commandTarget, editedCommand);
    fs.mkdirSync(path.join(root, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agents/.airc.json"), JSON.stringify({
      project: "demo",
      skills: { sources: [{ type: "local", path: sourceA }], registrations: [{ name: "guide", type: "local", path: path.join(sourceA, "guide") }] },
      files: { managedBaselines: {
        ".claude/commands/guide.md": `sha256:${crypto.createHash("sha256").update(originalCommand).digest("hex")}`
      } }
    }));

    const removed = run(root, "remove", "guide");
    assert.equal(removed.status, 0, removed.stderr);
    let config = JSON.parse(fs.readFileSync(path.join(root, ".agents/.airc.json"), "utf8"));
    assert.equal(config.files.managedBaselines[".claude/commands/guide.md"], undefined);
    assert.equal(fs.readFileSync(commandTarget, "utf8"), editedCommand);

    config.skills.sources = [{ type: "local", path: sourceB }];
    fs.writeFileSync(path.join(root, ".agents/.airc.json"), JSON.stringify(config));
    const added = run(root, "add", "guide");
    assert.equal(added.status, 0, added.stderr);
    assert.equal(fs.readFileSync(commandTarget, "utf8"), editedCommand);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skill remove continues cleanup when a client command directory cannot be listed", onPlatforms("linux", "darwin"), () => {
  const root = createTempDir("ai-skill-permission-cleanup-");
  const commandBodies = ["claude command\n", "opencode command\n"];
  const commandTargets = [".claude/commands/custom-guide.md", ".opencode/commands/custom-guide.md"];
  try {
    project(root);
    const configPath = path.join(root, ".agents/.airc.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.skills.registrations = [{ name: "custom-guide", type: "project", path: ".agents/skills/custom-guide" }];
    config.files.managedBaselines = Object.fromEntries(commandTargets.map((target, index) => {
      const commandPath = path.join(root, target);
      fs.mkdirSync(path.dirname(commandPath), { recursive: true });
      fs.writeFileSync(commandPath, commandBodies[index]!);
      return [target, `sha256:${crypto.createHash("sha256").update(commandBodies[index]!).digest("hex")}`];
    }));
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const claudeCommands = path.join(root, ".claude/commands");
    fs.chmodSync(claudeCommands, 0o300);
    const removed = run(root, "remove", "custom-guide");
    fs.chmodSync(claudeCommands, 0o700);

    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(fs.existsSync(path.join(root, commandTargets[0]!)), false, JSON.stringify({ stdout: removed.stdout, stderr: removed.stderr }));
    assert.equal(fs.existsSync(path.join(root, commandTargets[1]!)), false);
    const updated = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.deepEqual(updated.skills.registrations, []);
    assert.deepEqual(updated.files.managedBaselines, {});
    assert.equal(fs.existsSync(path.join(root, ".agents/skills/custom-guide/SKILL.md")), true);
  } finally {
    const commands = path.join(root, ".claude/commands");
    if (fs.existsSync(commands)) fs.chmodSync(commands, 0o700);
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
    const projectLink = path.join(root, ".agents/skills/team-guide");
    fs.mkdirSync(path.dirname(projectLink), { recursive: true });
    fs.symlinkSync(path.join(sourceRoot, "team-guide"), projectLink, process.platform === "win32" ? "junction" : "dir");
    const removed = run(root, "remove", "team-guide");
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(fs.existsSync(path.join(sourceRoot, "team-guide/SKILL.md")), true);
    assert.equal(fs.lstatSync(projectLink, { throwIfNoEntry: false }), undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).skills.registrations, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
