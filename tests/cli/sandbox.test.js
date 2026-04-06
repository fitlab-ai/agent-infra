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

test("assertBranchAvailable allows branches that are not checked out in any worktree", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");

  assert.doesNotThrow(() => sandboxCreate.assertBranchAvailable("/repo", "feature/demo", (cmd, args) => {
    assert.equal(cmd, "git");
    assert.deepEqual(args, ["-C", "/repo", "worktree", "list", "--porcelain"]);
    return "worktree /repo\nbranch refs/heads/main\n";
  }));
});

test("assertBranchAvailable rejects branches that are already checked out", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");

  assert.throws(() => sandboxCreate.assertBranchAvailable("/repo", "feature/demo", () => [
    "worktree /repo/worktrees/demo",
    "branch refs/heads/feature/demo",
    ""
  ].join("\n")), /already checked out/);
});

test("assertBranchAvailable reports the conflicting worktree path", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");

  assert.throws(() => sandboxCreate.assertBranchAvailable("/repo", "feature/demo", () => [
    "worktree /repo",
    "branch refs/heads/main",
    "",
    "worktree /tmp/demo-worktree",
    "branch refs/heads/feature/demo",
    ""
  ].join("\n")), /\/tmp\/demo-worktree/);
});

test("ensureClaudeOnboarding creates .claude.json with onboarding and workspace trust", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-onboarding-"));

  try {
    sandboxCreate.ensureClaudeOnboarding(tmpDir);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude.json"), "utf8"));
    assert.equal(data.hasCompletedOnboarding, true);
    assert.equal(data.projects["/workspace"].hasTrustDialogAccepted, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureClaudeOnboarding preserves existing fields", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-onboarding-existing-"));

  try {
    fs.writeFileSync(path.join(tmpDir, ".claude.json"), JSON.stringify({ theme: "dark", userID: "abc" }), "utf8");
    sandboxCreate.ensureClaudeOnboarding(tmpDir);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude.json"), "utf8"));
    assert.equal(data.hasCompletedOnboarding, true);
    assert.equal(data.theme, "dark");
    assert.equal(data.userID, "abc");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureClaudeOnboarding skips write when flag already set", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-onboarding-noop-"));
  const filePath = path.join(tmpDir, ".claude.json");

  try {
    fs.writeFileSync(filePath, JSON.stringify({
      hasCompletedOnboarding: true,
      projects: { "/workspace": { hasTrustDialogAccepted: true } }
    }), "utf8");
    const mtimeBefore = fs.statSync(filePath).mtimeMs;
    sandboxCreate.ensureClaudeOnboarding(tmpDir);
    const mtimeAfter = fs.statSync(filePath).mtimeMs;
    assert.equal(mtimeBefore, mtimeAfter);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureClaudeSettings creates settings.json with skipDangerousModePermissionPrompt", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-settings-"));

  try {
    sandboxCreate.ensureClaudeSettings(tmpDir);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, "settings.json"), "utf8"));
    assert.equal(data.skipDangerousModePermissionPrompt, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureClaudeSettings skips write when skipDangerousModePermissionPrompt is already set", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-settings-noop-"));
  const settingsPath = path.join(tmpDir, "settings.json");

  try {
    fs.writeFileSync(settingsPath, JSON.stringify({
      skipDangerousModePermissionPrompt: true
    }), "utf8");
    const mtimeBefore = fs.statSync(settingsPath).mtimeMs;
    sandboxCreate.ensureClaudeSettings(tmpDir);
    const mtimeAfter = fs.statSync(settingsPath).mtimeMs;
    assert.equal(mtimeBefore, mtimeAfter);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("extractClaudeOAuthToken returns the environment token before checking the host", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  process.env.CLAUDE_CODE_OAUTH_TOKEN = "env-token-123";

  try {
    const token = sandboxCreate.extractClaudeOAuthToken("/Users/demo", () => {
      throw new Error("execFn should not be called");
    });

    assert.equal(token, "env-token-123");
  } finally {
    if (originalToken === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
    }
  }
});

test("extractClaudeOAuthToken reads the Claude Code OAuth token from macOS Keychain", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });

  try {
    const token = sandboxCreate.extractClaudeOAuthToken("/Users/demo", (cmd, args, options) => {
      assert.equal(cmd, "security");
      assert.deepEqual(args, [
        "find-generic-password",
        "-s",
        "Claude Code-credentials",
        "-w"
      ]);
      assert.deepEqual(options, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
      return JSON.stringify({
        claudeAiOauth: {
          accessToken: "mac-keychain-token"
        }
      });
    });

    assert.equal(token, "mac-keychain-token");
  } finally {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    if (originalToken === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
    }
  }
});

test("extractClaudeOAuthToken falls back to an empty string when macOS Keychain lookup fails", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });

  try {
    const token = sandboxCreate.extractClaudeOAuthToken("/Users/demo", () => {
      throw new Error("missing keychain item");
    });

    assert.equal(token, "");
  } finally {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    if (originalToken === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
    }
  }
});

test("extractClaudeOAuthToken reads Linux credentials from the Claude config directory", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-token-"));
  const claudeDir = path.join(tmpDir, ".claude");
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, ".credentials.json"), JSON.stringify({
    accessToken: "linux-file-token"
  }), "utf8");

  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  Object.defineProperty(process, "platform", { configurable: true, value: "linux" });

  try {
    const token = sandboxCreate.extractClaudeOAuthToken(tmpDir, () => {
      throw new Error("execFn should not be called on Linux");
    });

    assert.equal(token, "linux-file-token");
  } finally {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    if (originalToken === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureCodexWorkspaceTrust appends workspace trust to config.toml", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-trust-"));

  try {
    fs.writeFileSync(path.join(tmpDir, "config.toml"), 'model = "o3"\n', "utf8");
    sandboxCreate.ensureCodexWorkspaceTrust(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, "config.toml"), "utf8");
    assert.match(content, /model = "o3"/);
    assert.match(content, /\[projects\."\/workspace"\]/);
    assert.match(content, /trust_level = "trusted"/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureCodexWorkspaceTrust skips when workspace trust already exists", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-trust-noop-"));
  const configPath = path.join(tmpDir, "config.toml");

  try {
    const original = '[projects."/workspace"]\ntrust_level = "trusted"\n';
    fs.writeFileSync(configPath, original, "utf8");
    sandboxCreate.ensureCodexWorkspaceTrust(tmpDir);
    assert.equal(fs.readFileSync(configPath, "utf8"), original);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureGeminiWorkspaceTrust creates trustedFolders.json with workspace trust", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gemini-trust-"));

  try {
    sandboxCreate.ensureGeminiWorkspaceTrust(tmpDir);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, "trustedFolders.json"), "utf8"));
    assert.deepEqual(data, { "/workspace": "TRUST_FOLDER" });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureGeminiWorkspaceTrust skips write when workspace trust already exists", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gemini-trust-noop-"));
  const trustPath = path.join(tmpDir, "trustedFolders.json");

  try {
    fs.writeFileSync(trustPath, JSON.stringify({ "/workspace": "TRUST_FOLDER" }, null, 2), "utf8");
    const mtimeBefore = fs.statSync(trustPath).mtimeMs;
    sandboxCreate.ensureGeminiWorkspaceTrust(tmpDir);
    const mtimeAfter = fs.statSync(trustPath).mtimeMs;
    assert.equal(mtimeBefore, mtimeAfter);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("buildImage uses verbose docker build output while keeping host UID/GID lookups quiet", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const calls = [];

  sandboxCreate.buildImage(
    { project: "demo", imageName: "demo-sandbox:latest", repoRoot: "/repo" },
    [{ npmPackage: "@acme/tool" }],
    "/tmp/Dockerfile",
    "sig-123",
    {
      runFn(cmd, args) {
        calls.push({ type: "run", cmd, args });
        if (cmd === "id" && args[0] === "-u") {
          return "501";
        }
        if (cmd === "id" && args[0] === "-g") {
          return "20";
        }
        throw new Error(`unexpected quiet command: ${cmd} ${args.join(" ")}`);
      },
      runVerboseFn(cmd, args, opts) {
        calls.push({ type: "verbose", cmd, args, opts });
      }
    }
  );

  assert.deepEqual(calls.slice(0, 2), [
    { type: "run", cmd: "id", args: ["-u"] },
    { type: "run", cmd: "id", args: ["-g"] }
  ]);
  assert.equal(calls[2].type, "verbose");
  assert.equal(calls[2].cmd, "docker");
  assert.equal(calls[2].opts.cwd, "/repo");
  assert.deepEqual(calls[2].args, [
    "build",
    "-t",
    "demo-sandbox:latest",
    "--build-arg",
    "HOST_UID=501",
    "--build-arg",
    "HOST_GID=20",
    "--build-arg",
    "AI_TOOL_PACKAGES=@acme/tool",
    "--label",
    "demo.sandbox",
    "--label",
    "demo.sandbox.image-config=sig-123",
    "-f",
    "/tmp/Dockerfile",
    "/repo"
  ]);
});

test("commandErrorMessage prefers stderr over the generic execFileSync message", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");

  const message = sandboxCreate.commandErrorMessage({
    message: "Command failed: git worktree add ...",
    stderr: Buffer.from("fatal: invalid reference: missing-branch\n")
  });

  assert.equal(message, "fatal: invalid reference: missing-branch");
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
    assert.match(content, /alias opencode-yolo='OPENCODE_PERMISSION=.*external_directory.*doom_loop.* opencode'/);
    assert.match(content, /alias oy='OPENCODE_PERMISSION=.*external_directory.*doom_loop.* opencode'/);
    assert.match(content, /alias gy='gemini --yolo'/);

    const second = sandboxCreate.ensureSandboxAliasesFile(tmpDir);
    assert.equal(second.created, false);
    assert.equal(fs.readFileSync(created.path, "utf8"), content);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureColima uses verbose commands for install and startup", async () => {
  const sandboxEngine = await loadFreshEsm("lib/sandbox/engine.js");
  const messages = [];
  const verboseCalls = [];
  const checks = [];

  await sandboxEngine.ensureColima(
    { vm: { cpu: 4, memory: 8, disk: 60 } },
    (message) => messages.push(message),
    {
      runOkFn(cmd, args) {
        checks.push([cmd, ...args]);
        if (cmd === "which") {
          return false;
        }
        if (cmd === "colima" && args[0] === "status") {
          return false;
        }
        if (cmd === "docker" && args[0] === "info") {
          return true;
        }
        throw new Error(`unexpected check: ${cmd} ${args.join(" ")}`);
      },
      runSafeFn(cmd, args) {
        assert.equal(cmd, "uname");
        assert.deepEqual(args, ["-m"]);
        return "arm64";
      },
      runVerboseFn(cmd, args) {
        verboseCalls.push([cmd, ...args]);
      }
    }
  );

  assert.deepEqual(messages, [
    "Installing colima + docker via Homebrew...",
    "Starting Colima VM..."
  ]);
  assert.deepEqual(verboseCalls, [
    ["brew", "install", "colima", "docker"],
    ["colima", "start", "--cpu", "4", "--memory", "8", "--disk", "60", "--arch", "aarch64", "--vm-type=vz", "--mount-type=virtiofs"]
  ]);
  assert.deepEqual(checks, [
    ["which", "colima"],
    ["colima", "status"],
    ["docker", "info"]
  ]);
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
