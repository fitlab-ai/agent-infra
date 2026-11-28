import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { createTempDir, envWithPrependedPath, filePath, read, writeNodeCommandShim } from "../../helpers.ts";

const scriptPath = filePath(".github/scripts/sync-labels-to-set.sh");

type RunScriptOptions = {
  kind?: "issue" | "pr";
  currentLabels?: string[];
  targets?: string[];
  prefix?: string;
  failMode?: "" | "always" | "edit" | "read42" | "remove43" | "add44";
  strict?: boolean;
};
type FakeGhState = {
  calls: string[][];
};

function write(filePathname: string, content: string) {
  fs.mkdirSync(path.dirname(filePathname), { recursive: true });
  fs.writeFileSync(filePathname, content, "utf8");
}

function writeFakeGh(binDir: string) {
  const fakeGhScriptPath = path.join(binDir, "gh.js");
  write(fakeGhScriptPath, `const fs = require("node:fs");

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
  if (state.failMode === "read42") { fs.writeSync(2, "read failed\\n"); process.exit(42); }
  printLabels(args[0]);
  process.exit(0);
}

if ((args[0] === "issue" || args[0] === "pr") && args[1] === "edit") {
  state.calls.push(args);
  const labelsKey = args[0] === "issue" ? "issueLabels" : "prLabels";
  const addIndex = args.indexOf("--add-label");
  const removeIndex = args.indexOf("--remove-label");

  if ((state.failMode === "remove43" && removeIndex !== -1) || (state.failMode === "add44" && addIndex !== -1)) {
    save();
    process.stderr.write("write failed\\n");
    process.exit(removeIndex !== -1 ? 43 : 44);
  }

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
  const fakeGhPath = path.join(binDir, "gh");
  writeNodeCommandShim(fakeGhPath, fakeGhScriptPath);
  if (process.platform === "win32") {
    write(
      fakeGhPath,
      `#!/bin/sh\nexec "${process.execPath.replaceAll("\\", "/")}" "${fakeGhScriptPath.replaceAll("\\", "/")}" "$@"\n`
    );
    fs.chmodSync(fakeGhPath, 0o755);
  }
}

function runScript({ kind = "issue", currentLabels = [], targets = [], prefix = "type:", failMode = "", strict = false }: RunScriptOptions = {}) {
  const tempDir = createTempDir("sync-labels-script-");
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

  if (strict) args.push("--strict");

  targets.forEach((label) => {
    args.push("--target", label);
  });

  const result = spawnSync("sh", args, {
    encoding: "utf8",
    env: {
      ...envWithPrependedPath(process.env, binDir),
      GH_FAKE_STATE_PATH: statePath
    }
  });

  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  fs.rmSync(tempDir, { recursive: true, force: true });
  return { result, state };
}

function editCalls(state: FakeGhState, kind: "issue" | "pr") {
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


test("strict sync stops after a failed read without writing", () => {
  const { result, state } = runScript({ strict: true, failMode: "read42", targets: ["type: bug"] });
  assert.equal(result.status, 42);
  assert.match(result.stderr, /read failed/);
  assert.deepEqual(editCalls(state, "issue"), []);
});

test("strict sync stops after a failed removal without adding", () => {
  const { result, state } = runScript({ strict: true, failMode: "remove43", currentLabels: ["type: feature"], targets: ["type: bug"] });
  assert.equal(result.status, 43);
  assert.equal(editCalls(state, "issue").length, 1);
  assert.ok(editCalls(state, "issue")[0]!.includes("--remove-label"));
});

test("strict sync reports a failed addition after an earlier successful removal", () => {
  const { result, state } = runScript({ strict: true, failMode: "add44", currentLabels: ["type: feature", "other"], targets: ["type: bug", "type: fix"] });
  assert.equal(result.status, 44);
  assert.equal(editCalls(state, "issue").length, 2);
  assert.deepEqual(state.issueLabels, ["other"]);
});

test("PR label entry writes verified targets and reads back failed writes", () => {
  for (const scenario of ["unique", "unknown", "write-fails"]) {
    const root = createTempDir("pr-label-entry-");
    const bin = path.join(root, "bin");
    const statePath = path.join(root, "state.json");
    const fake = path.join(bin, "fake-gh.cjs");
    write(statePath, JSON.stringify({ scenario, calls: [], labels: { "1": ["keep"], "5": ["keep"] } }));
    write(fake, `
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.GH_FAKE_STATE, 'utf8'));
const args = process.argv.slice(2); state.calls.push(args); fs.writeFileSync(process.env.GH_FAKE_STATE, JSON.stringify(state));
const endpoint = args[1];
if (endpoint === 'graphql') { console.log(JSON.stringify({ data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [{ number: 5, ...(state.scenario === 'unknown' ? {} : { repository: { nameWithOwner: 'fitlab-ai/agent-infra' } }) }], pageInfo: { hasNextPage: false, endCursor: null } } } } } })); process.exit(0); }
if (endpoint.includes('/pulls/')) { console.log(JSON.stringify([[{ filename: 'lib/example.ts' }]])); process.exit(0); }
if (endpoint.includes('/issues/')) {
  const id = endpoint.match(/issues\\/(\\d+)/)[1];
  if (args.includes('POST')) {
    if (state.scenario === 'write-fails') { console.error('denied'); process.exit(1); }
    state.labels[id].push('in: cli'); fs.writeFileSync(process.env.GH_FAKE_STATE, JSON.stringify(state)); console.log('{}'); process.exit(0);
  }
  console.log(JSON.stringify([state.labels[id].map(name => ({ name }))])); process.exit(0);
}
console.log(JSON.stringify([[{ name: 'in: cli' }]]));
`);
    writeNodeCommandShim(path.join(bin, "gh"), fake);
    const result = spawnSync(process.execPath, ["--experimental-strip-types", filePath(".github/scripts/sync-pr-in-labels.ts")], {
      cwd: filePath("."), encoding: "utf8", env: { ...envWithPrependedPath(process.env, bin), GH_FAKE_STATE: statePath, GITHUB_REPOSITORY: "fitlab-ai/agent-infra", PR_NUMBER: "1" }
    });
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (scenario === "write-fails") {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /denied/);
      assert.equal(state.calls.filter((call: string[]) => call[1]?.includes("/issues/1/labels?")).length, 2);
      assert.equal(state.calls.filter((call: string[]) => call.includes("POST")).length, 1);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(state.labels["1"], ["keep", "in: cli"]);
      assert.deepEqual(state.labels["5"], scenario === "unique" ? ["keep", "in: cli"] : ["keep"]);
    }
  }
});
