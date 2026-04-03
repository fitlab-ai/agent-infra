import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { filePath, loadFreshEsm } from "../helpers.js";

test("agent-infra sandbox help is wired into the main CLI", () => {
  const output = execFileSync(process.execPath, [filePath("bin/cli.js"), "sandbox", "--help"], {
    encoding: "utf8"
  });

  assert.match(output, /Usage: ai sandbox <command> \[options\]/);
  assert.match(output, /create <branch> \[base\]/);
  assert.match(output, /rebuild \[--quiet\]/);
});

test("sandbox create help documents the host aliases file", () => {
  const output = execFileSync(process.execPath, [filePath("bin/cli.js"), "sandbox", "create", "--help"], {
    encoding: "utf8"
  });

  assert.match(output, /Usage: ai sandbox create <branch> \[base\] \[--cpu <n>\] \[--memory <n>\]/);
  assert.match(output, /~\/\.ai-sandbox-aliases/);
  assert.match(output, /\/home\/devuser\/\.bash_aliases/);
});

test("loadConfig derives sandbox defaults from .agents/.airc.json", async () => {
  const sandboxConfig = await loadFreshEsm("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-config-"));
  const previousCwd = process.cwd();

  try {
    execSync("git init", { cwd: tmpDir, stdio: "pipe" });
    fs.mkdirSync(path.join(tmpDir, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".agents", ".airc.json"),
      JSON.stringify({ project: "demo", org: "fitlab-ai" }, null, 2) + "\n",
      "utf8"
    );

    process.chdir(tmpDir);
    const config = sandboxConfig.loadConfig();

    assert.equal(config.project, "demo");
    assert.equal(config.org, "fitlab-ai");
    assert.equal(config.containerPrefix, "demo-dev");
    assert.equal(config.imageName, "demo-sandbox:latest");
    assert.deepEqual(config.runtimes, ["node20"]);
    assert.deepEqual(config.tools, ["claude-code", "codex", "opencode", "gemini-cli"]);
    assert.deepEqual(config.vm, { cpu: null, memory: null, disk: null });
    assert.equal(config.worktreeBase, path.join(process.env.HOME, ".demo-worktrees"));
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig fails when .agents/.airc.json is missing", async () => {
  const sandboxConfig = await loadFreshEsm("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-missing-config-"));
  const previousCwd = process.cwd();

  try {
    execSync("git init", { cwd: tmpDir, stdio: "pipe" });
    process.chdir(tmpDir);
    assert.throws(() => sandboxConfig.loadConfig(), /No \.agents\/\.airc\.json found/);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("composeDockerfile joins runtime fragments in order", async () => {
  const sandboxDockerfile = await loadFreshEsm("lib/sandbox/dockerfile.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-dockerfile-"));

  try {
    const dockerfilePath = sandboxDockerfile.composeDockerfile({
      repoRoot: tmpDir,
      project: "demo",
      runtimes: ["node20", "python3"],
      dockerfile: null
    });
    const content = fs.readFileSync(dockerfilePath, "utf8");

    assert.match(content, /^FROM ubuntu:22\.04/m);
    assert.match(content, /setup_20\.x/);
    assert.match(content, /python3 python3-pip python3-venv/);
    assert.match(content, /AI_TOOL_PACKAGES build arg is required/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("composeDockerfile includes gh CLI and bash_aliases sourcing", async () => {
  const sandboxDockerfile = await loadFreshEsm("lib/sandbox/dockerfile.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-gh-"));

  try {
    const dockerfilePath = sandboxDockerfile.composeDockerfile({
      repoRoot: tmpDir,
      project: "demo",
      runtimes: ["node20"],
      dockerfile: null
    });
    const content = fs.readFileSync(dockerfilePath, "utf8");

    assert.match(content, /cli\.github\.com\/packages/);
    assert.match(content, /curl wget git vim file/);
    assert.match(content, /apt-get install -y gh/);
    assert.match(content, /export GPG_TTY=\$\(tty\)/);
    assert.match(content, /\[ -f ~\/\.bash_aliases \] && \. ~\/\.bash_aliases/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("buildContainerEnvArgs injects GH_TOKEN when available", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");

  const envArgs = sandboxCreate.buildContainerEnvArgs([
    { tool: { envVars: { FOO: "bar" } } },
    { tool: { envVars: { BAZ: "qux" } } }
  ], (cmd, args) => {
    assert.equal(cmd, "gh");
    assert.deepEqual(args, ["auth", "token"]);
    return "token-123";
  });

  assert.deepEqual(envArgs, [
    "-e", "FOO=bar",
    "-e", "BAZ=qux",
    "-e", "GH_TOKEN=token-123"
  ]);
});

test("buildContainerEnvArgs skips GH_TOKEN when auth token is unavailable", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");

  const envArgs = sandboxCreate.buildContainerEnvArgs([
    { tool: { envVars: { FOO: "bar" } } }
  ], () => "");

  assert.deepEqual(envArgs, ["-e", "FOO=bar"]);
});

test("ensureSandboxAliasesFile creates the default aliases once", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-aliases-defaults-"));

  try {
    const created = sandboxCreate.ensureSandboxAliasesFile(tmpDir);
    assert.equal(created.created, true);
    assert.equal(created.path, path.join(tmpDir, ".ai-sandbox-aliases"));

    const content = fs.readFileSync(created.path, "utf8");
    assert.match(content, /alias claude-yolo='claude --dangerously-skip-permissions'/);
    assert.match(content, /alias gy='gemini --yolo'/);

    const second = sandboxCreate.ensureSandboxAliasesFile(tmpDir);
    assert.equal(second.created, false);
    assert.equal(fs.readFileSync(created.path, "utf8"), content);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncShellAliases skips missing alias files and copies existing aliases", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-aliases-"));

  try {
    const calls = [];
    const missing = sandboxCreate.syncShellAliases("demo-container", tmpDir, (...args) => calls.push(args));
    assert.equal(missing, false);
    assert.deepEqual(calls, []);

    const aliasesPath = path.join(tmpDir, ".ai-sandbox-aliases");
    fs.writeFileSync(aliasesPath, "alias cy='claude --dangerously-skip-permissions'\n", "utf8");

    const copied = sandboxCreate.syncShellAliases("demo-container", tmpDir, (...args) => calls.push(args));
    assert.equal(copied, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "docker");
    assert.deepEqual(calls[0][1], [
      "exec",
      "-i",
      "demo-container",
      "sh",
      "-c",
      "cat > /home/devuser/.bash_aliases"
    ]);
    assert.deepEqual(calls[0][2], {
      input: "alias cy='claude --dangerously-skip-permissions'\n",
      stdio: ["pipe", "pipe", "pipe"]
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("detectGpgConfig identifies host gitconfig that requires GPG support", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");

  assert.equal(sandboxCreate.detectGpgConfig("[commit]\n  gpgsign = true\n"), true);
  assert.equal(sandboxCreate.detectGpgConfig("[gpg]\n  program = /opt/homebrew/bin/gpg\n"), true);
  assert.equal(sandboxCreate.detectGpgConfig("[gpg \"ssh\"]\n  program = /opt/homebrew/bin/ssh-keygen\n"), true);
  assert.equal(sandboxCreate.detectGpgConfig("[user]\n  name = Demo User\n"), false);
});

test("sanitizeGitConfig rewrites paths and keeps container GPG config usable", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const home = "/Users/demo";
  const gitconfig = [
    "[user]",
    "  name = Demo User",
    "  signingKey = /Users/demo/.gnupg/pubring.kbx",
    "[gpg]",
    "  program = /opt/homebrew/bin/gpg",
    "  format = openpgp",
    "[difftool \"sourcetree\"]",
    "  cmd = /Applications/Sourcetree.app",
    "[core]",
    "  excludesfile = /Users/demo/.gitignore_global",
    ""
  ].join("\n");

  const sanitized = sandboxCreate.sanitizeGitConfig(gitconfig, home);

  assert.match(sanitized, /\[user\]/);
  assert.match(sanitized, /signingKey = \/home\/devuser\/\.gnupg\/pubring\.kbx/);
  assert.match(sanitized, /\[gpg\]/);
  assert.match(sanitized, /format = openpgp/);
  assert.doesNotMatch(sanitized, /program = \/opt\/homebrew\/bin\/gpg/);
  assert.doesNotMatch(sanitized, /\[difftool "sourcetree"\]/);
  assert.match(sanitized, /excludesfile = \/home\/devuser\/\.gitignore_global/);
});

test("sanitizeGitConfig strips GPG sections when host keys are unavailable", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const gitconfig = [
    "[commit]",
    "  gpgsign = true",
    "[gpg]",
    "  program = /opt/homebrew/bin/gpg",
    "[gpg \"ssh\"]",
    "  allowedSignersFile = ~/.ssh/allowed_signers",
    "[user]",
    "  name = Demo User",
    ""
  ].join("\n");

  const sanitized = sandboxCreate.sanitizeGitConfig(gitconfig, "/Users/demo", { stripGpg: true });

  assert.match(sanitized, /\[commit\]/);
  assert.match(sanitized, /gpgsign = true/);
  assert.match(sanitized, /\[user\]/);
  assert.doesNotMatch(sanitized, /\[gpg\]/);
  assert.doesNotMatch(sanitized, /\[gpg "ssh"\]/);
  assert.doesNotMatch(sanitized, /allowedSignersFile/);
});

test("syncGpgKeys returns false when the host has no public keys to import", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const calls = [];

  const synced = sandboxCreate.syncGpgKeys("demo-container", "/Users/demo", (cmd, args, options) => {
    calls.push([cmd, args, options]);
    if (cmd === "gpg" && args[0] === "--export") {
      return Buffer.alloc(0);
    }
    throw new Error("unexpected call");
  }, () => {
    throw new Error("runSafe should not be called");
  });

  assert.equal(synced, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "gpg");
  assert.deepEqual(calls[0][1], ["--export"]);
  assert.equal(calls[0][2].env.HOME, "/Users/demo");
});

test("syncGpgKeys returns false when the host has no secret keys to import", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const calls = [];

  const synced = sandboxCreate.syncGpgKeys("demo-container", "/Users/demo", (cmd, args, options) => {
    calls.push([cmd, args, options]);
    if (cmd !== "gpg") {
      throw new Error("unexpected command");
    }
    if (args[0] === "--export") {
      return Buffer.from("pub");
    }
    if (args[0] === "--export-secret-keys") {
      return Buffer.alloc(0);
    }
    throw new Error("unexpected gpg args");
  }, () => {
    throw new Error("runSafe should not be called");
  });

  assert.equal(synced, false);
  assert.deepEqual(calls.map(([cmd, args]) => [cmd, args]), [
    ["gpg", ["--export"]],
    ["gpg", ["--export-secret-keys"]]
  ]);
});

test("syncGpgKeys imports host public and secret keys into the container", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const calls = [];
  const runSafeCalls = [];

  const synced = sandboxCreate.syncGpgKeys("demo-container", "/Users/demo", (cmd, args, options) => {
    calls.push([cmd, args, options]);
    if (cmd === "gpg" && args[0] === "--export") {
      return Buffer.from("pub");
    }
    if (cmd === "gpg" && args[0] === "--export-secret-keys") {
      return Buffer.from("sec");
    }
    if (cmd === "docker" && args.at(-1) === "--import") {
      return Buffer.from("");
    }
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  }, (cmd, args) => {
    runSafeCalls.push([cmd, args]);
    return "";
  });

  assert.equal(synced, true);
  assert.deepEqual(calls.map(([cmd, args]) => [cmd, args]), [
    ["gpg", ["--export"]],
    ["gpg", ["--export-secret-keys"]],
    ["docker", ["exec", "-i", "demo-container", "gpg", "--import"]],
    ["docker", ["exec", "-i", "demo-container", "gpg", "--batch", "--import"]]
  ]);
  assert.equal(calls[0][2].env.HOME, "/Users/demo");
  assert.deepEqual(calls[2][2], {
    input: Buffer.from("pub"),
    stdio: ["pipe", "pipe", "pipe"]
  });
  assert.deepEqual(calls[3][2], {
    input: Buffer.from("sec"),
    stdio: ["pipe", "pipe", "pipe"]
  });
  assert.deepEqual(runSafeCalls, [
    ["docker", ["exec", "demo-container", "gpgconf", "--launch", "gpg-agent"]]
  ]);
});

test("composeDockerfile rejects unknown runtimes", async () => {
  const sandboxDockerfile = await loadFreshEsm("lib/sandbox/dockerfile.js");

  assert.throws(() => sandboxDockerfile.composeDockerfile({
    repoRoot: process.cwd(),
    project: "demo",
    runtimes: ["ruby3"],
    dockerfile: null
  }), /Unknown runtime: ruby3/);
});

test("assertValidBranchName rejects invalid branch names", async () => {
  const sandboxConstants = await loadFreshEsm("lib/sandbox/constants.js");

  assert.throws(() => sandboxConstants.assertValidBranchName("bad branch name"), /Invalid branch name/);
});

test("resolveTaskBranch returns plain branch names unchanged", async () => {
  const taskResolver = await loadFreshEsm("lib/sandbox/task-resolver.js");

  assert.equal(
    taskResolver.resolveTaskBranch("agent-infra-feature-cli-generic-sandbox", process.cwd()),
    "agent-infra-feature-cli-generic-sandbox"
  );
});

test("resolveTaskBranch reads branch from task frontmatter", async () => {
  const taskResolver = await loadFreshEsm("lib/sandbox/task-resolver.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-task-frontmatter-"));
  const taskDir = path.join(tmpDir, ".agents", "workspace", "active", "TASK-20260401-180000");

  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "task.md"), [
      "---",
      "id: TASK-20260401-180000",
      "type: feature",
      "branch: agent-infra-feature-cli-generic-sandbox",
      "---",
      "",
      "# task"
    ].join("\n"));

    assert.equal(
      taskResolver.resolveTaskBranch("TASK-20260401-180000", tmpDir),
      "agent-infra-feature-cli-generic-sandbox"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolveTaskBranch falls back to the context branch for legacy tasks", async () => {
  const taskResolver = await loadFreshEsm("lib/sandbox/task-resolver.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-task-context-"));
  const taskDir = path.join(tmpDir, ".agents", "workspace", "active", "TASK-20260401-180001");

  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "task.md"), [
      "---",
      "id: TASK-20260401-180001",
      "type: feature",
      "---",
      "",
      "## 上下文",
      "",
      "- **分支**：agent-infra-feature-cli-generic-sandbox"
    ].join("\n"));

    assert.equal(
      taskResolver.resolveTaskBranch("TASK-20260401-180001", tmpDir),
      "agent-infra-feature-cli-generic-sandbox"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolveTaskBranch rejects missing task files and missing branch metadata", async () => {
  const taskResolver = await loadFreshEsm("lib/sandbox/task-resolver.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-task-errors-"));
  const taskDir = path.join(tmpDir, ".agents", "workspace", "active", "TASK-20260401-180002");

  try {
    assert.throws(
      () => taskResolver.resolveTaskBranch("TASK-20260401-180002", tmpDir),
      /Task not found/
    );

    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "task.md"), "---\nid: TASK-20260401-180002\n---\n\n# task\n");

    assert.throws(
      () => taskResolver.resolveTaskBranch("TASK-20260401-180002", tmpDir),
      /has no branch field/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
