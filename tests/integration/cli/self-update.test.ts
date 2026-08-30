import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CLI_PATH, filePath, onPlatforms, read, writeNodeCommandShim } from "../../helpers.ts";

function writeFile(filePathname: string, content: string): void {
  fs.mkdirSync(path.dirname(filePathname), { recursive: true });
  fs.writeFileSync(filePathname, content, "utf8");
}

function copyInstall(root: string): { packageRoot: string; entry: string } {
  const packageRoot = path.join(root, "node_modules", "@fitlab-ai", "agent-infra");
  fs.cpSync(filePath("node_modules"), path.join(root, "node_modules"), { recursive: true });
  fs.cpSync(filePath("dist"), path.join(packageRoot, "dist"), { recursive: true });
  writeFile(path.join(packageRoot, "package.json"), read("package.json"));
  return {
    packageRoot,
    entry: path.join(packageRoot, "dist", "bin", "cli.js")
  };
}

function makeManagerScript(scriptPath: string, prefix: string, globalRoot: string, status: number): void {
  writeFile(scriptPath, [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    `const prefix = ${JSON.stringify(prefix)};`,
    `const globalRoot = ${JSON.stringify(globalRoot)};`,
    `const status = ${status};`,
    "if (process.env.SELF_UPDATE_CALLS) fs.appendFileSync(process.env.SELF_UPDATE_CALLS, JSON.stringify(args) + '\\n');",
    "if (args.join(' ') === 'prefix --global') { console.log(prefix); process.exit(0); }",
    "if (args.join(' ') === 'root --global') { console.log(globalRoot); process.exit(0); }",
    "if (status !== 0) process.exit(status);"
  ].join("\n"));
}

function makeExecutable(filePathname: string, content: string): void {
  writeFile(filePathname, content);
  fs.chmodSync(filePathname, 0o755);
}

function readCalls(filePathname: string): string[][] {
  return fs.existsSync(filePathname)
    ? fs.readFileSync(filePathname, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[])
    : [];
}

test("ai update runs npm self-update from a persistent npm global install", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-self-update-cli-"));
  try {
    const prefix = path.join(root, "npm-prefix");
    const globalRoot = path.join(prefix, "node_modules");
    const install = copyInstall(prefix);
    const managerBin = path.join(prefix, "bin");
    const managerScript = path.join(root, "npm-manager.js");
    const callsPath = path.join(root, "npm-calls.jsonl");
    makeManagerScript(managerScript, prefix, globalRoot, 0);
    writeNodeCommandShim(path.join(managerBin, "npm"), managerScript);
    const project = path.join(root, "project");
    fs.mkdirSync(project, { recursive: true });
    const env = { ...process.env, PATH: managerBin, SELF_UPDATE_CALLS: callsPath };

    const result = spawnSync(process.execPath, [install.entry, "update"], {
      cwd: project,
      env,
      encoding: "utf8"
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /updated successfully/i);
    assert.equal(fs.existsSync(path.join(project, ".agents")), false);
    assert.deepEqual(readCalls(callsPath).at(-1), ["update", "--global", "@fitlab-ai/agent-infra"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ai update propagates a non-zero npm manager exit code", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-self-update-cli-failure-"));
  try {
    const prefix = path.join(root, "npm-prefix");
    const globalRoot = path.join(prefix, "node_modules");
    const install = copyInstall(prefix);
    const managerBin = path.join(prefix, "bin");
    const managerScript = path.join(root, "npm-manager.js");
    makeManagerScript(managerScript, prefix, globalRoot, 17);
    writeNodeCommandShim(path.join(managerBin, "npm"), managerScript);
    const result = spawnSync(process.execPath, [install.entry, "update"], {
      cwd: root,
      env: { ...process.env, PATH: managerBin },
      encoding: "utf8"
    });

    assert.equal(result.status, 17, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /17|npm/i);
    assert.doesNotMatch(result.stdout, /updated successfully/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ai update fails closed when the running CLI has no supported persistent source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-self-update-unknown-"));
  const emptyPath = path.join(root, "empty-bin");
  fs.mkdirSync(emptyPath);
  try {
    const result = spawnSync(process.execPath, [CLI_PATH, "update"], {
      cwd: root,
      env: { ...process.env, PATH: emptyPath },
      encoding: "utf8"
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /persistent|npm|brew|source/i);
    assert.equal(fs.existsSync(path.join(root, ".agents")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ai update fails closed instead of using a cwd manager when PATH has no npm", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-self-update-cwd-manager-"));
  try {
    const prefix = path.join(root, "npm-prefix");
    const globalRoot = path.join(prefix, "node_modules");
    const install = copyInstall(prefix);
    const decoy = path.join(prefix, "npm");
    makeExecutable(decoy, [
      "#!/bin/sh",
      `if [ \"$1 $2\" = \"prefix --global\" ]; then printf '%s\\n' '${prefix}'; exit 0; fi`,
      `if [ \"$1 $2\" = \"root --global\" ]; then printf '%s\\n' '${globalRoot}'; exit 0; fi`,
      "printf 'decoy update called\\n' >&2",
      "exit 0"
    ].join("\n"));

    const result = spawnSync(process.execPath, [install.entry, "update"], {
      cwd: prefix,
      env: { ...process.env, PATH: path.join(root, "empty-bin") },
      encoding: "utf8"
    });

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /persistent|source|npm/i);
    assert.doesNotMatch(result.stderr, /decoy update called/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows npm.cmd works when Node and global package directories are separate", onPlatforms("win32"), () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-self-update-win-"));
  try {
    const prefix = path.join(root, "AppData", "npm");
    const globalRoot = path.join(prefix, "node_modules");
    const install = copyInstall(prefix);
    const nodeHome = path.join(root, "Program Files", "nodejs");
    const managerScript = path.join(root, "npm-manager.cjs");
    const callsPath = path.join(root, "npm-calls.jsonl");
    makeManagerScript(managerScript, prefix, globalRoot, 0);
    writeNodeCommandShim(path.join(nodeHome, "npm"), managerScript);
    const result = spawnSync(process.execPath, [install.entry, "update"], {
      cwd: root,
      env: {
        ...process.env,
        Path: nodeHome,
        PATH: nodeHome,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        SELF_UPDATE_CALLS: callsPath
      },
      encoding: "utf8"
    });

    assert.equal(result.status, 0);
    assert.deepEqual(readCalls(callsPath).at(-1), ["update", "--global", "@fitlab-ai/agent-infra"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
