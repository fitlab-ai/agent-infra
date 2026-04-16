import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { filePath, read } from "../helpers.js";

const scriptPath = filePath(".github/scripts/sync-labels-to-set.sh");

function write(filePathname, content) {
  fs.mkdirSync(path.dirname(filePathname), { recursive: true });
  fs.writeFileSync(filePathname, content, "utf8");
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync-labels-script-"));
}

function writeFakeGh(binDir) {
  const fakeGhPath = path.join(binDir, "gh");
  write(fakeGhPath, `#!/usr/bin/env node
const fs = require("node:fs");

const args = process.argv.slice(2);
const statePath = process.env.GH_FAKE_STATE_PATH;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));

function save() {
  fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
}

function printLabels(kind) {
  const labels = kind === "issue" ? state.issueLabels : state.prLabels;
  process.stdout.write(labels.filter((label) => label.startsWith(state.prefix)).join("\\n"));
}

if (state.failMode === "always") {
  process.stderr.write("forced gh failure\\n");
  process.exit(1);
}

if ((args[0] === "issue" || args[0] === "pr") && args[1] === "view") {
  state.calls.push(args);
  save();
  printLabels(args[0]);
  process.exit(0);
}

if ((args[0] === "issue" || args[0] === "pr") && args[1] === "edit") {
  state.calls.push(args);
  const labelsKey = args[0] === "issue" ? "issueLabels" : "prLabels";
  const addIndex = args.indexOf("--add-label");
  const removeIndex = args.indexOf("--remove-label");

  if (state.failMode === "edit") {
    save();
    process.stderr.write("forced edit failure\\n");
    process.exit(1);
  }

  if (addIndex !== -1) {
    const label = args[addIndex + 1];
    if (!state[labelsKey].includes(label)) {
      state[labelsKey].push(label);
    }
  }

  if (removeIndex !== -1) {
    const label = args[removeIndex + 1];
    state[labelsKey] = state[labelsKey].filter((value) => value !== label);
  }

  save();
  process.exit(0);
}

process.stderr.write(\`unexpected gh args: \${args.join(" ")}\\n\`);
process.exit(1);
`);
  fs.chmodSync(fakeGhPath, 0o755);
}

function runScript({ kind = "issue", currentLabels = [], targets = [], prefix = "type:", failMode = "" } = {}) {
  const tempDir = makeTempDir();
  const statePath = path.join(tempDir, "state.json");
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });

  write(statePath, JSON.stringify({
    calls: [],
    prefix,
    issueLabels: kind === "issue" ? currentLabels : [],
    prLabels: kind === "pr" ? currentLabels : [],
    failMode
  }));
  writeFakeGh(binDir);

  const args = [
    scriptPath,
    "--repo", "fitlab-ai/agent-infra",
    kind === "issue" ? "--issue" : "--pr", "214",
    "--prefix", prefix
  ];

  targets.forEach((label) => {
    args.push("--target", label);
  });

  const result = spawnSync("sh", args, {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      GH_FAKE_STATE_PATH: statePath
    }
  });

  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  fs.rmSync(tempDir, { recursive: true, force: true });
  return { result, state };
}

function editCalls(state, kind) {
  return state.calls.filter((args) => args[0] === kind && args[1] === "edit");
}

test("sync-labels script stays in sync with the template copy", () => {
  assert.equal(
    read(".github/scripts/sync-labels-to-set.sh"),
    read("templates/.github/scripts/sync-labels-to-set.sh")
  );
});

test("sync-labels script adds a missing single target label", () => {
  const { result, state } = runScript({
    currentLabels: [],
    targets: ["type: bug"]
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(editCalls(state, "issue"), [
    ["issue", "edit", "214", "--repo", "fitlab-ai/agent-infra", "--add-label", "type: bug"]
  ]);
});

test("sync-labels script skips edits when the target label already exists", () => {
  const { result, state } = runScript({
    currentLabels: ["type: bug"],
    targets: ["type: bug"]
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(editCalls(state, "issue"), []);
});

test("sync-labels script swaps a stale single target label", () => {
  const { result, state } = runScript({
    currentLabels: ["type: feature"],
    targets: ["type: bug"]
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(editCalls(state, "issue"), [
    ["issue", "edit", "214", "--repo", "fitlab-ai/agent-infra", "--remove-label", "type: feature"],
    ["issue", "edit", "214", "--repo", "fitlab-ai/agent-infra", "--add-label", "type: bug"]
  ]);
});

test("sync-labels script keeps the matching label and removes extra labels", () => {
  const { result, state } = runScript({
    currentLabels: ["type: bug", "type: feature"],
    targets: ["type: bug"]
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(editCalls(state, "issue"), [
    ["issue", "edit", "214", "--repo", "fitlab-ai/agent-infra", "--remove-label", "type: feature"]
  ]);
});

test("sync-labels script clears stale labels when the target set is empty", () => {
  const { result, state } = runScript({
    currentLabels: ["status: in-progress"],
    targets: [],
    prefix: "status:"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(editCalls(state, "issue"), [
    ["issue", "edit", "214", "--repo", "fitlab-ai/agent-infra", "--remove-label", "status: in-progress"]
  ]);
});

test("sync-labels script is a noop when both current and target sets are empty", () => {
  const { result, state } = runScript({
    currentLabels: [],
    targets: [],
    prefix: "status:"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(editCalls(state, "issue"), []);
});

test("sync-labels script adds newly required labels to a multi-target set", () => {
  const { result, state } = runScript({
    currentLabels: ["in: cli"],
    targets: ["in: cli", "in: core"],
    prefix: "in: "
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(editCalls(state, "issue"), [
    ["issue", "edit", "214", "--repo", "fitlab-ai/agent-infra", "--add-label", "in: core"]
  ]);
});

test("sync-labels script replaces an outdated multi-target set", () => {
  const { result, state } = runScript({
    currentLabels: ["in: cli", "in: templates"],
    targets: ["in: core"],
    prefix: "in: "
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(editCalls(state, "issue"), [
    ["issue", "edit", "214", "--repo", "fitlab-ai/agent-infra", "--remove-label", "in: cli"],
    ["issue", "edit", "214", "--repo", "fitlab-ai/agent-infra", "--remove-label", "in: templates"],
    ["issue", "edit", "214", "--repo", "fitlab-ai/agent-infra", "--add-label", "in: core"]
  ]);
});

test("sync-labels script is a noop when multi-target sets already match", () => {
  const { result, state } = runScript({
    currentLabels: ["in: cli", "in: core"],
    targets: ["in: cli", "in: core"],
    prefix: "in: "
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(editCalls(state, "issue"), []);
});

test("sync-labels script supports PR label syncs", () => {
  const { result, state } = runScript({
    kind: "pr",
    currentLabels: ["in: cli"],
    targets: ["in: core"],
    prefix: "in: "
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.calls[0][0], "pr");
  assert.deepEqual(editCalls(state, "pr"), [
    ["pr", "edit", "214", "--repo", "fitlab-ai/agent-infra", "--remove-label", "in: cli"],
    ["pr", "edit", "214", "--repo", "fitlab-ai/agent-infra", "--add-label", "in: core"]
  ]);
});

test("sync-labels script rejects targets that do not match the prefix", () => {
  const { result } = runScript({
    currentLabels: [],
    targets: ["bug"],
    prefix: "type:"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must start with prefix "type:"/);
});

test("sync-labels script requires the object selector and prefix arguments", () => {
  const result = spawnSync("sh", [scriptPath, "--repo", "fitlab-ai/agent-infra"], {
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
});

test("sync-labels script rejects simultaneous issue and PR selectors", () => {
  const result = spawnSync("sh", [
    scriptPath,
    "--repo", "fitlab-ai/agent-infra",
    "--issue", "214",
    "--pr", "215",
    "--prefix", "type:"
  ], {
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
});

test("sync-labels script tolerates gh edit failures", () => {
  const { result } = runScript({
    currentLabels: ["type: feature"],
    targets: ["type: bug"],
    failMode: "edit"
  });

  assert.equal(result.status, 0, result.stderr);
});
