import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { filePath, loadFreshEsm } from "../helpers.js";

function modeBits(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

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

test("sandbox create fails before preparing a temporary Dockerfile when Claude credentials are missing", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-create-no-credentials-"));
  const repoDir = path.join(tmpDir, "repo");
  const homeDir = path.join(tmpDir, "home");
  const project = `sandbox-no-leak-${process.pid}-${Date.now()}`;
  const dockerfilePrefix = `${project}-sandbox-`;
  const existingEntries = new Set(
    fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(dockerfilePrefix))
  );

  try {
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    execSync("git init", { cwd: repoDir, stdio: "pipe" });
    fs.mkdirSync(path.join(repoDir, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, ".agents", ".airc.json"),
      JSON.stringify({ project, org: "fitlab-ai" }, null, 2) + "\n",
      "utf8"
    );

    let commandError;
    try {
      execFileSync(
        process.execPath,
        [filePath("bin/cli.js"), "sandbox", "create", "feature/no-credentials"],
        {
          cwd: repoDir,
          env: { ...process.env, HOME: homeDir },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
    } catch (error) {
      commandError = error;
    }

    assert.ok(commandError);
    assert.match(commandError.stderr, /Claude Code credentials not found on host/);

    const leakedEntries = fs.readdirSync(os.tmpdir()).filter((entry) => (
      entry.startsWith(dockerfilePrefix) && !existingEntries.has(entry)
    ));
    assert.deepEqual(leakedEntries, []);
  } finally {
    for (const entry of fs.readdirSync(os.tmpdir())) {
      if (entry.startsWith(dockerfilePrefix) && !existingEntries.has(entry)) {
        fs.rmSync(path.join(os.tmpdir(), entry), { recursive: true, force: true });
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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
    assert.match(content, /curl wget git vim tmux file/);
    assert.match(content, /apt-get install -y gh/);
    assert.match(content, /export GPG_TTY=\$\(tty\)/);
    assert.match(content, /\[ -f ~\/\.bash_aliases \] && \. ~\/\.bash_aliases/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("composeDockerfile installs tmux for in-container session recovery", async () => {
  const sandboxDockerfile = await loadFreshEsm("lib/sandbox/dockerfile.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-tmux-"));

  try {
    const dockerfilePath = sandboxDockerfile.composeDockerfile({
      repoRoot: tmpDir,
      project: "demo",
      runtimes: ["node20"],
      dockerfile: null
    });
    const content = fs.readFileSync(dockerfilePath, "utf8");

    assert.match(content, /\btmux\b/);
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

test("terminalEnvFlags forwards iTerm2 detection variables for Shift+Enter support", async () => {
  const sandboxEnter = await loadFreshEsm("lib/sandbox/commands/enter.js");

  const flags = sandboxEnter.terminalEnvFlags({
    TERM_PROGRAM: "iTerm.app",
    TERM_PROGRAM_VERSION: "3.6.9",
    LC_TERMINAL: "iTerm2",
    LC_TERMINAL_VERSION: "3.6.9",
    UNRELATED: "ignored"
  });

  assert.deepEqual(flags, [
    "-e", "TERM_PROGRAM=iTerm.app",
    "-e", "TERM_PROGRAM_VERSION=3.6.9",
    "-e", "LC_TERMINAL=iTerm2",
    "-e", "LC_TERMINAL_VERSION=3.6.9"
  ]);
});

test("terminalEnvFlags omits unset variables instead of forwarding empty values", async () => {
  const sandboxEnter = await loadFreshEsm("lib/sandbox/commands/enter.js");

  const flags = sandboxEnter.terminalEnvFlags({
    TERM_PROGRAM: "iTerm.app",
    TERM_PROGRAM_VERSION: "",
    LC_TERMINAL: undefined
  });

  assert.deepEqual(flags, ["-e", "TERM_PROGRAM=iTerm.app"]);
});

test("claude-code tool pins CLAUDE_CONFIG_DIR so $HOME/.claude.json preseed reaches Claude Code", async () => {
  // Regression guard for the onboarding loop bug: without this env var Claude
  // Code reads .claude.json from $HOME/.claude.json (outside the bind mount),
  // so the preseeded onboarding state is silently ignored and every container
  // start lands on the theme picker.
  const sandboxTools = await loadFreshEsm("lib/sandbox/tools.js");
  const tools = sandboxTools.resolveTools({
    home: "/home/host-user",
    project: "demo",
    tools: ["claude-code"]
  });

  assert.equal(tools.length, 1);
  assert.equal(tools[0].containerMount, "/home/devuser/.claude");
  assert.equal(tools[0].envVars?.CLAUDE_CONFIG_DIR, "/home/devuser/.claude");
});

test("assertBranchAvailable allows branches that are not checked out in any worktree", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");

  assert.doesNotThrow(() => sandboxCreate.assertBranchAvailable("/repo", "feature/demo", {
    runFn(cmd, args) {
      assert.equal(cmd, "git");
      assert.deepEqual(args, ["-C", "/repo", "worktree", "list", "--porcelain"]);
      return "worktree /repo\nbranch refs/heads/main\n";
    }
  }));
});

test("assertBranchAvailable rejects branches that are already checked out", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");

  assert.throws(() => sandboxCreate.assertBranchAvailable("/repo", "feature/demo", {
    runFn: () => [
      "worktree /repo/worktrees/demo",
      "branch refs/heads/feature/demo",
      ""
    ].join("\n")
  }), /already checked out/);
});

test("assertBranchAvailable reports the conflicting worktree path", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");

  assert.throws(() => sandboxCreate.assertBranchAvailable("/repo", "feature/demo", {
    runFn: () => [
      "worktree /repo",
      "branch refs/heads/main",
      "",
      "worktree /tmp/demo-worktree",
      "branch refs/heads/feature/demo",
      ""
    ].join("\n")
  }), /\/tmp\/demo-worktree/);
});

test("assertBranchAvailable allows the current sandbox worktree to reuse the checked out branch", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");

  assert.doesNotThrow(() => sandboxCreate.assertBranchAvailable(
    "/repo",
    "feature/demo",
    {
      allowedWorktrees: ["/repo/.worktrees/feature-demo"],
      runFn: () => [
        "worktree /repo/.worktrees/feature-demo",
        "branch refs/heads/feature/demo",
        ""
      ].join("\n")
    }
  ));
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

test("ensureClaudeOnboarding populates workspace trust when only hasCompletedOnboarding is set", async () => {
  // Regression guard for the dirty-flag refactor: a prior CC session may have
  // written `hasCompletedOnboarding: true` without ever touching the projects
  // map (e.g. if no project was opened). We must still preseed the workspace
  // trust entry and persist it to disk.
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-onboarding-partial-"));

  try {
    fs.writeFileSync(
      path.join(tmpDir, ".claude.json"),
      JSON.stringify({ hasCompletedOnboarding: true }),
      "utf8"
    );
    sandboxCreate.ensureClaudeOnboarding(tmpDir);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude.json"), "utf8"));
    assert.equal(data.hasCompletedOnboarding, true);
    assert.equal(data.projects["/workspace"].hasTrustDialogAccepted, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("printInteractiveEntryTip writes a tmux-related hint to the given stream", async () => {
  const sandboxEnter = await loadFreshEsm("lib/sandbox/commands/enter.js");

  let written = "";
  const fakeStream = {
    write(chunk) {
      written += chunk;
    }
  };

  sandboxEnter.printInteractiveEntryTip(fakeStream);

  assert.match(written, /tmux/);
  assert.ok(written.endsWith("\n"), "tip should end with newline");
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

test("extractClaudeCredentialsBlob reads the full Claude Code credentials blob from macOS Keychain", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const rawBlob = JSON.stringify({
    claudeAiOauth: {
      accessToken: "mac-keychain-token",
      refreshToken: "refresh-token",
      scopes: ["user:profile", "user:sessions:claude_code"]
    }
  }, null, 2);
  Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });

  try {
    const blob = sandboxCreate.extractClaudeCredentialsBlob("/Users/demo", (cmd, args, options) => {
      assert.equal(cmd, "security");
      assert.deepEqual(args, [
        "find-generic-password",
        "-a",
        "demo",
        "-s",
        "Claude Code-credentials",
        "-w"
      ]);
      assert.deepEqual(options, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
      return `${rawBlob}\n`;
    });

    assert.equal(blob, rawBlob);
  } finally {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  }
});

test("extractClaudeCredentialsBlob returns null when macOS Keychain lookup fails", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });

  try {
    const blob = sandboxCreate.extractClaudeCredentialsBlob("/Users/demo", () => {
      throw new Error("missing keychain item");
    });

    assert.equal(blob, null);
  } finally {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  }
});

test("extractClaudeCredentialsBlob returns null for empty macOS Keychain output", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });

  try {
    const blob = sandboxCreate.extractClaudeCredentialsBlob("/Users/demo", () => "");
    assert.equal(blob, null);
  } finally {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  }
});

test("extractClaudeCredentialsBlob returns null for invalid macOS Keychain JSON", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });

  try {
    const blob = sandboxCreate.extractClaudeCredentialsBlob("/Users/demo", () => "not-json");
    assert.equal(blob, null);
  } finally {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  }
});

test("extractClaudeCredentialsBlob returns null when macOS Keychain JSON has no access token", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });

  try {
    const blob = sandboxCreate.extractClaudeCredentialsBlob("/Users/demo", () => JSON.stringify({
      claudeAiOauth: {}
    }));
    assert.equal(blob, null);
  } finally {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  }
});

test("extractClaudeCredentialsBlob returns null when macOS Keychain JSON lacks required Claude Code scopes", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });

  try {
    const blob = sandboxCreate.extractClaudeCredentialsBlob("/Users/demo", () => JSON.stringify({
      claudeAiOauth: {
        accessToken: "token",
        refreshToken: "refresh-token",
        scopes: ["user:inference"]
      }
    }));
    assert.equal(blob, null);
  } finally {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  }
});

test("extractClaudeCredentialsBlob reads Linux credentials from the Claude config directory", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-token-"));
  const claudeDir = path.join(tmpDir, ".claude");
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const rawBlob = JSON.stringify({
    claudeAiOauth: {
      accessToken: "linux-file-token",
      refreshToken: "refresh-token",
      scopes: ["user:profile", "user:sessions:claude_code"]
    }
  }, null, 2);

  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, ".credentials.json"), rawBlob, "utf8");

  Object.defineProperty(process, "platform", { configurable: true, value: "linux" });

  try {
    const blob = sandboxCreate.extractClaudeCredentialsBlob(tmpDir, () => {
      throw new Error("execFn should not be called on Linux");
    });

    assert.equal(blob, rawBlob);
  } finally {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("extractClaudeCredentialsBlob returns null when Linux credentials file is missing", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-token-missing-"));
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  Object.defineProperty(process, "platform", { configurable: true, value: "linux" });

  try {
    const blob = sandboxCreate.extractClaudeCredentialsBlob(tmpDir, () => {
      throw new Error("execFn should not be called on Linux");
    });
    assert.equal(blob, null);
  } finally {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("extractClaudeCredentialsBlob returns null for invalid Linux credentials JSON", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-token-invalid-"));
  const claudeDir = path.join(tmpDir, ".claude");
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, ".credentials.json"), "garbage", "utf8");
  Object.defineProperty(process, "platform", { configurable: true, value: "linux" });

  try {
    const blob = sandboxCreate.extractClaudeCredentialsBlob(tmpDir, () => {
      throw new Error("execFn should not be called on Linux");
    });
    assert.equal(blob, null);
  } finally {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("extractClaudeCredentialsBlob returns null for Linux credentials without required Claude Code scopes", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-token-scopes-"));
  const claudeDir = path.join(tmpDir, ".claude");
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, ".credentials.json"), JSON.stringify({
    claudeAiOauth: {
      accessToken: "token",
      refreshToken: "refresh-token",
      scopes: ["user:inference"]
    }
  }), "utf8");
  Object.defineProperty(process, "platform", { configurable: true, value: "linux" });

  try {
    const blob = sandboxCreate.extractClaudeCredentialsBlob(tmpDir, () => {
      throw new Error("execFn should not be called on Linux");
    });
    assert.equal(blob, null);
  } finally {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("claudeCredentialsDir and claudeCredentialsPath compute shared credential paths", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");

  assert.equal(
    sandboxCreate.claudeCredentialsDir("/home/demo", "agent-infra"),
    "/home/demo/.agent-infra-claude-credentials"
  );
  assert.equal(
    sandboxCreate.claudeCredentialsPath("/home/demo", "agent-infra"),
    "/home/demo/.agent-infra-claude-credentials/.credentials.json"
  );
});

test("writeClaudeCredentialsFile creates secure shared credentials file", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-credentials-write-"));
  const rawBlob = '{"claudeAiOauth":{"accessToken":"token"}}\n';
  const credentialsDir = path.join(tmpDir, ".demo-claude-credentials");
  const credentialsPath = path.join(credentialsDir, ".credentials.json");

  try {
    sandboxCreate.writeClaudeCredentialsFile(tmpDir, "demo", rawBlob);
    assert.equal(modeBits(credentialsDir), 0o700);
    assert.equal(modeBits(credentialsPath), 0o600);
    assert.equal(fs.readFileSync(credentialsPath, "utf8"), rawBlob);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("writeClaudeCredentialsFile overwrites existing credentials blob", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-credentials-overwrite-"));
  const credentialsPath = path.join(tmpDir, ".demo-claude-credentials", ".credentials.json");

  try {
    sandboxCreate.writeClaudeCredentialsFile(tmpDir, "demo", "blob-1");
    sandboxCreate.writeClaudeCredentialsFile(tmpDir, "demo", "blob-2");
    assert.equal(fs.readFileSync(credentialsPath, "utf8"), "blob-2");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("assertClaudeCredentialsAvailable throws a readable error when credentials are missing", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  let writeCalled = false;

  assert.throws(() => sandboxCreate.assertClaudeCredentialsAvailable(
    "/Users/demo",
    "agent-infra",
    [{ tool: { id: "claude-code" }, dir: "/tmp/claude" }],
    () => null,
    () => {
      writeCalled = true;
    }
  ), /Claude Code credentials not found on host/);
  assert.equal(writeCalled, false);

  try {
    sandboxCreate.assertClaudeCredentialsAvailable(
      "/Users/demo",
      "agent-infra",
      [{ tool: { id: "claude-code" }, dir: "/tmp/claude" }],
      () => null,
      () => {}
    );
  } catch (error) {
    assert.match(error.message, /run "claude" once/i);
    assert.match(error.message, /claude \/status/);
    assert.match(error.message, /sandbox\.tools.*\.agents\/\.airc\.json/i);
  }
});

test("assertClaudeCredentialsAvailable writes shared credentials when blob extraction succeeds", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const writes = [];

  sandboxCreate.assertClaudeCredentialsAvailable(
    "/Users/demo",
    "agent-infra",
    [{ tool: { id: "claude-code" }, dir: "/tmp/claude" }],
    () => "valid-blob",
    (...args) => writes.push(args)
  );

  assert.deepEqual(writes, [
    ["/Users/demo", "agent-infra", "valid-blob"]
  ]);
});

test("assertClaudeCredentialsAvailable skips extraction when claude-code is not enabled", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  let extractCalled = false;
  let writeCalled = false;

  sandboxCreate.assertClaudeCredentialsAvailable(
    "/Users/demo",
    "agent-infra",
    [{ tool: { id: "codex" }, dir: "/tmp/codex" }],
    () => {
      extractCalled = true;
      return "blob";
    },
    () => {
      writeCalled = true;
    }
  );

  assert.equal(extractCalled, false);
  assert.equal(writeCalled, false);
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
    assert.match(content, /# >>> agent-infra managed aliases >>>/);
    assert.match(content, /alias claude-yolo='claude --dangerously-skip-permissions; tput ed'/);
    assert.match(content, /alias opencode-yolo='OPENCODE_PERMISSION=.*external_directory.*doom_loop.* opencode; tput ed'/);
    assert.match(content, /alias oy='OPENCODE_PERMISSION=.*external_directory.*doom_loop.* opencode; tput ed'/);
    assert.match(content, /alias xy='codex --yolo; tput ed'/);
    assert.match(content, /alias gy='gemini --yolo; tput ed'/);
    assert.match(content, /# <<< agent-infra managed aliases <<</);

    const second = sandboxCreate.ensureSandboxAliasesFile(tmpDir);
    assert.equal(second.created, false);
    assert.equal(fs.readFileSync(created.path, "utf8"), content);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureSandboxAliasesFile upgrades legacy generated alias files", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-aliases-upgrade-"));
  const aliasesPath = path.join(tmpDir, ".ai-sandbox-aliases");
  const legacyContent = [
    "alias claude-yolo='claude --dangerously-skip-permissions'",
    "alias opencode-yolo='opencode --dangerously-skip-permissions'",
    "alias codex-yolo='codex --yolo'",
    "alias gemini-yolo='gemini --yolo'",
    "",
    "alias cy='claude --dangerously-skip-permissions'",
    "alias oy='opencode --dangerously-skip-permissions'",
    "alias xy='codex --yolo'",
    "alias gy='gemini --yolo'",
    ""
  ].join("\n");

  try {
    fs.writeFileSync(aliasesPath, legacyContent, "utf8");
    const result = sandboxCreate.ensureSandboxAliasesFile(tmpDir);
    const content = fs.readFileSync(aliasesPath, "utf8");

    assert.equal(result.created, false);
    assert.doesNotMatch(content, /opencode --dangerously-skip-permissions/);
    assert.match(content, /# >>> agent-infra managed aliases >>>/);
    assert.match(content, /OPENCODE_PERMISSION=.*external_directory.*doom_loop.* opencode; tput ed/);
    assert.match(content, /alias cy='claude --dangerously-skip-permissions; tput ed'/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureSandboxAliasesFile writes OpenCode full yolo permissions", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-aliases-opencode-full-yolo-"));

  try {
    const { path: aliasesPath } = sandboxCreate.ensureSandboxAliasesFile(tmpDir);
    const content = fs.readFileSync(aliasesPath, "utf8");

    assert.match(content, /OPENCODE_PERMISSION=.*"read":"allow"/);
    assert.match(content, /OPENCODE_PERMISSION=.*"bash":"allow"/);
    assert.match(content, /OPENCODE_PERMISSION=.*"edit":"allow"/);
    assert.match(content, /OPENCODE_PERMISSION=.*"webfetch":"allow"/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureSandboxAliasesFile upgrades legacy OpenCode aliases to full yolo permissions", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-aliases-opencode-upgrade-full-yolo-"));
  const aliasesPath = path.join(tmpDir, ".ai-sandbox-aliases");

  try {
    fs.writeFileSync(aliasesPath, "alias oy='opencode --dangerously-skip-permissions'\n", "utf8");
    sandboxCreate.ensureSandboxAliasesFile(tmpDir);
    const content = fs.readFileSync(aliasesPath, "utf8");

    assert.match(content, /alias oy='OPENCODE_PERMISSION=.*"read":"allow".* opencode; tput ed'/);
    assert.match(content, /alias oy='OPENCODE_PERMISSION=.*"bash":"allow".* opencode; tput ed'/);
    assert.match(content, /alias oy='OPENCODE_PERMISSION=.*"edit":"allow".* opencode; tput ed'/);
    assert.match(content, /alias oy='OPENCODE_PERMISSION=.*"webfetch":"allow".* opencode; tput ed'/);
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

  const synced = sandboxCreate.syncGpgKeys("demo-container", "/Users/demo", "demo", (cmd, args, options) => {
    calls.push([cmd, args, options]);
    if (cmd === "git") {
      return "";
    }
    if (cmd === "gpg" && args[0] === "--export") {
      return Buffer.alloc(0);
    }
    throw new Error("unexpected call");
  }, () => {
    throw new Error("runSafe should not be called");
  });

  assert.equal(synced, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "git");
  assert.deepEqual(calls[0][1], ["config", "--global", "user.signingKey"]);
  assert.equal(calls[0][2].env.HOME, "/Users/demo");
  assert.equal(calls[1][0], "gpg");
  assert.deepEqual(calls[1][1], ["--export"]);
  assert.equal(calls[1][2].env.HOME, "/Users/demo");
});

test("currentKeyringFingerprint hashes the current secret keyring", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const output = "sec:u:255:22:ABCDEF1234567890:1700000000:0::::::23::0:\n";

  const fingerprint = sandboxCreate.currentKeyringFingerprint("/Users/demo", (cmd, args, options) => {
    assert.equal(cmd, "gpg");
    assert.deepEqual(args, ["--list-secret-keys", "--with-colons"]);
    assert.equal(options.encoding, "utf8");
    assert.equal(options.env.HOME, "/Users/demo");
    return output;
  });

  assert.equal(fingerprint, createHash("sha256").update(output).digest("hex"));
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
});

test("currentKeyringFingerprint returns null when gpg listing fails", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");

  const fingerprint = sandboxCreate.currentKeyringFingerprint("/Users/demo", () => {
    throw new Error("gpg failed");
  });

  assert.equal(fingerprint, null);
});

test("currentKeyringFingerprint returns null for an empty keyring listing", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");

  const fingerprint = sandboxCreate.currentKeyringFingerprint("/Users/demo", () => "   \n");

  assert.equal(fingerprint, null);
});

test("getGitSigningKey returns the configured signing key", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");

  const signingKey = sandboxCreate.getGitSigningKey({
    home: "/Users/demo",
    execFn(cmd, args, options) {
      assert.equal(cmd, "git");
      assert.deepEqual(args, ["config", "--global", "user.signingKey"]);
      assert.equal(options.encoding, "utf8");
      assert.equal(options.env.HOME, "/Users/demo");
      return "8246B1E31A62A1D6\n";
    }
  });

  assert.equal(signingKey, "8246B1E31A62A1D6");
});

test("getGitSigningKey reads repo-local signingKey when a worktree path is provided", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-signing-key-local-"));
  const repoDir = path.join(tmpDir, "repo");
  const homeDir = path.join(tmpDir, "home");

  try {
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    execSync("git init", { cwd: repoDir, stdio: "pipe" });
    execSync("git config user.signingKey LOCAL-KEY-123", { cwd: repoDir, stdio: "pipe" });

    const signingKey = sandboxCreate.getGitSigningKey({ repoPath: repoDir, home: homeDir });

    assert.equal(signingKey, "LOCAL-KEY-123");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("getGitSigningKey returns null when git config lookup fails", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");

  const signingKey = sandboxCreate.getGitSigningKey({
    home: "/Users/demo",
    execFn() {
      throw new Error("git config failed");
    }
  });

  assert.equal(signingKey, null);
});

test("getGitSigningKey returns null for empty output", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");

  const signingKey = sandboxCreate.getGitSigningKey({
    home: "/Users/demo",
    execFn: () => "   \n"
  });

  assert.equal(signingKey, null);
});

test("readGpgCache returns null when the cache does not exist", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-cache-missing-"));

  try {
    const cache = sandboxCreate.readGpgCache(tmpDir, "demo", () => {
      throw new Error("fingerprint should not be queried without state");
    });

    assert.equal(cache, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("readGpgCache returns null when the cache is missing state metadata", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-cache-missing-state-"));
  const cacheDir = path.join(tmpDir, ".demo-gpg-cache");

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "public.asc"), "pub");
    fs.writeFileSync(path.join(cacheDir, "secret.asc"), "sec");

    const cache = sandboxCreate.readGpgCache(tmpDir, "demo", () => {
      throw new Error("fingerprint should not be queried without state");
    });

    assert.equal(cache, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("readGpgCache returns cached key material when the keyring fingerprint matches", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-cache-hit-"));
  const cacheDir = path.join(tmpDir, ".demo-gpg-cache");
  const listing = "sec:u:255:22:ABCDEF1234567890:1700000000:0::::::23::0:\n";
  const fingerprint = createHash("sha256").update(listing).digest("hex");

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "public.asc"), "pub");
    fs.writeFileSync(path.join(cacheDir, "secret.asc"), "sec");
    fs.writeFileSync(path.join(cacheDir, "state.json"), `${JSON.stringify({ fingerprint })}\n`, "utf8");

    const cache = sandboxCreate.readGpgCache(tmpDir, "demo", (cmd, args) => {
      assert.equal(cmd, "gpg");
      assert.deepEqual(args, ["--list-secret-keys", "--with-colons"]);
      return listing;
    });

    assert.deepEqual(cache, {
      pub: Buffer.from("pub"),
      sec: Buffer.from("sec")
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("readGpgCache returns null when the keyring fingerprint changed", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-cache-stale-"));
  const cacheDir = path.join(tmpDir, ".demo-gpg-cache");

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "public.asc"), "pub");
    fs.writeFileSync(path.join(cacheDir, "secret.asc"), "sec");
    fs.writeFileSync(path.join(cacheDir, "state.json"), `${JSON.stringify({ fingerprint: "stale" })}\n`, "utf8");

    const cache = sandboxCreate.readGpgCache(tmpDir, "demo", () => "sec:u:255:22:NEW:1700000000:0::::::23::0:\n");

    assert.equal(cache, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("readGpgCache returns null when the cached signingKey no longer matches", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-cache-signing-key-stale-"));
  const cacheDir = path.join(tmpDir, ".demo-gpg-cache");
  const listing = "sec:u:255:22:ABCDEF1234567890:1700000000:0::::::23::0:\n";
  const fingerprint = createHash("sha256").update(listing).digest("hex");

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "public.asc"), "pub");
    fs.writeFileSync(path.join(cacheDir, "secret.asc"), "sec");
    fs.writeFileSync(
      path.join(cacheDir, "state.json"),
      `${JSON.stringify({ fingerprint, signingKey: "OLD-KEY" })}\n`,
      "utf8"
    );

    const cache = sandboxCreate.readGpgCache(tmpDir, "demo", () => listing, "NEW-KEY");

    assert.equal(cache, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("writeGpgCache creates cache files with secure permissions", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-cache-write-"));
  const cacheDir = path.join(tmpDir, ".demo-gpg-cache");

  try {
    const written = sandboxCreate.writeGpgCache(
      tmpDir,
      "demo",
      Buffer.from("pub"),
      Buffer.from("sec"),
      "fingerprint-1"
    );

    assert.equal(written, true);
    assert.equal(modeBits(cacheDir), 0o700);
    assert.equal(modeBits(path.join(cacheDir, "public.asc")), 0o600);
    assert.equal(modeBits(path.join(cacheDir, "secret.asc")), 0o600);
    assert.equal(modeBits(path.join(cacheDir, "state.json")), 0o600);
    assert.equal(fs.readFileSync(path.join(cacheDir, "state.json"), "utf8"), '{\n  "fingerprint": "fingerprint-1"\n}\n');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("writeGpgCache stores the signingKey used to build the cache", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-cache-write-signing-key-"));
  const cacheDir = path.join(tmpDir, ".demo-gpg-cache");

  try {
    const written = sandboxCreate.writeGpgCache(
      tmpDir,
      "demo",
      Buffer.from("pub"),
      Buffer.from("sec"),
      "fingerprint-1",
      "KEY-123"
    );

    assert.equal(written, true);
    assert.equal(
      fs.readFileSync(path.join(cacheDir, "state.json"), "utf8"),
      '{\n  "fingerprint": "fingerprint-1",\n  "signingKey": "KEY-123"\n}\n'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncGpgKeys reuses a caller-provided cache without re-reading from disk or git config", async () => {
  // Regression guard for the latest create() path: once the caller has already
  // resolved the cache hit and signingKey, syncGpgKeys should import the
  // provided key material directly without spawning another `git config` or
  // `gpg --list-secret-keys` subprocess.
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const calls = [];
  const providedCache = {
    pub: Buffer.from("pub-from-caller"),
    sec: Buffer.from("sec-from-caller")
  };

  const synced = sandboxCreate.syncGpgKeys(
    "demo-container",
    "/Users/demo",
    "demo",
    (cmd, args, options) => {
      calls.push([cmd, args, options]);
      if (cmd === "docker" && args.at(-1) === "--import") {
        return Buffer.from("");
      }
      throw new Error(`unexpected execFn call: ${cmd} ${args.join(" ")}`);
    },
    () => "",
    {
      cachedOverride: providedCache,
      signingKey: "KEY-123"
    }
  );

  assert.equal(synced, true);
  assert.deepEqual(calls.map(([cmd, args]) => [cmd, args]), [
    ["docker", ["exec", "-i", "demo-container", "gpg", "--import"]],
    ["docker", ["exec", "-i", "demo-container", "gpg", "--batch", "--import"]]
  ]);
  assert.deepEqual(calls[0][2], {
    input: Buffer.from("pub-from-caller"),
    stdio: ["pipe", "pipe", "pipe"]
  });
  assert.deepEqual(calls[1][2], {
    input: Buffer.from("sec-from-caller"),
    stdio: ["pipe", "pipe", "pipe"]
  });
});

test("syncGpgKeys invalidates cache when the effective signing key changed", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-sync-signing-key-changed-"));
  const cacheDir = path.join(tmpDir, ".demo-gpg-cache");
  const listing = "sec:u:255:22:ABCDEF1234567890:1700000000:0::::::23::0:\n";
  const fingerprint = createHash("sha256").update(listing).digest("hex");
  const calls = [];

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "public.asc"), "pub-old");
    fs.writeFileSync(path.join(cacheDir, "secret.asc"), "sec-old");
    fs.writeFileSync(
      path.join(cacheDir, "state.json"),
      `${JSON.stringify({ fingerprint, signingKey: "OLD-KEY" })}\n`,
      "utf8"
    );

    const synced = sandboxCreate.syncGpgKeys(
      "demo-container",
      tmpDir,
      "demo",
      (cmd, args, options) => {
        calls.push([cmd, args, options]);
        if (cmd === "git") {
          return "NEW-KEY\n";
        }
        if (cmd === "gpg" && args[0] === "--list-secret-keys") {
          return listing;
        }
        if (cmd === "gpg" && args[0] === "--export") {
          assert.deepEqual(args, ["--export", "NEW-KEY"]);
          return Buffer.from("pub-new");
        }
        if (cmd === "gpg" && args[0] === "--export-secret-keys") {
          assert.deepEqual(args, ["--export-secret-keys", "NEW-KEY"]);
          return Buffer.from("sec-new");
        }
        if (cmd === "docker" && args.at(-1) === "--import") {
          return Buffer.from("");
        }
        throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
      },
      () => "",
      {
        repoPath: "/repo/worktrees/demo"
      }
    );

    assert.equal(synced, true);
    assert.deepEqual(calls.map(([cmd, args]) => [cmd, args]), [
      ["git", ["-C", "/repo/worktrees/demo", "config", "user.signingKey"]],
      ["gpg", ["--export", "NEW-KEY"]],
      ["gpg", ["--export-secret-keys", "NEW-KEY"]],
      ["gpg", ["--list-secret-keys", "--with-colons"]],
      ["docker", ["exec", "-i", "demo-container", "gpg", "--import"]],
      ["docker", ["exec", "-i", "demo-container", "gpg", "--batch", "--import"]]
    ]);
    assert.equal(fs.readFileSync(path.join(cacheDir, "public.asc"), "utf8"), "pub-new");
    assert.equal(fs.readFileSync(path.join(cacheDir, "secret.asc"), "utf8"), "sec-new");
    assert.equal(
      fs.readFileSync(path.join(cacheDir, "state.json"), "utf8"),
      '{\n  "fingerprint": "'
        + fingerprint
        + '",\n  "signingKey": "NEW-KEY"\n}\n'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncGpgKeys uses the cache when the keyring fingerprint matches", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-sync-cache-hit-"));
  const cacheDir = path.join(tmpDir, ".demo-gpg-cache");
  const listing = "sec:u:255:22:ABCDEF1234567890:1700000000:0::::::23::0:\n";
  const fingerprint = createHash("sha256").update(listing).digest("hex");
  const calls = [];
  const runSafeCalls = [];

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "public.asc"), "pub");
    fs.writeFileSync(path.join(cacheDir, "secret.asc"), "sec");
    fs.writeFileSync(path.join(cacheDir, "state.json"), `${JSON.stringify({ fingerprint })}\n`, "utf8");

    const synced = sandboxCreate.syncGpgKeys("demo-container", tmpDir, "demo", (cmd, args, options) => {
      calls.push([cmd, args, options]);
      if (cmd === "gpg") {
        assert.deepEqual(args, ["--list-secret-keys", "--with-colons"]);
        return listing;
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
      ["git", ["config", "--global", "user.signingKey"]],
      ["gpg", ["--list-secret-keys", "--with-colons"]],
      ["docker", ["exec", "-i", "demo-container", "gpg", "--import"]],
      ["docker", ["exec", "-i", "demo-container", "gpg", "--batch", "--import"]]
    ]);
    assert.equal(calls[0][2].env.HOME, tmpDir);
    assert.equal(calls[0][2].encoding, "utf8");
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
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncGpgKeys exports host keys and writes the cache on a cache miss", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-sync-cache-miss-"));
  const calls = [];

  try {
    const synced = sandboxCreate.syncGpgKeys("demo-container", tmpDir, "demo", (cmd, args, options) => {
      calls.push([cmd, args, options]);
      if (cmd === "gpg" && args[0] === "--export") {
        return Buffer.from("pub");
      }
      if (cmd === "gpg" && args[0] === "--export-secret-keys") {
        return Buffer.from("sec");
      }
      if (cmd === "git") {
        return "";
      }
      if (cmd === "gpg" && args[0] === "--list-secret-keys") {
        return "sec:u:255:22:ABCDEF1234567890:1700000000:0::::::23::0:\n";
      }
      if (cmd === "docker" && args.at(-1) === "--import") {
        return Buffer.from("");
      }
      throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
    }, () => "");

    assert.equal(synced, true);
    assert.deepEqual(calls.map(([cmd, args]) => [cmd, args]), [
      ["git", ["config", "--global", "user.signingKey"]],
      ["gpg", ["--export"]],
      ["gpg", ["--export-secret-keys"]],
      ["gpg", ["--list-secret-keys", "--with-colons"]],
      ["docker", ["exec", "-i", "demo-container", "gpg", "--import"]],
      ["docker", ["exec", "-i", "demo-container", "gpg", "--batch", "--import"]]
    ]);
    assert.equal(
      fs.readFileSync(path.join(tmpDir, ".demo-gpg-cache", "public.asc"), "utf8"),
      "pub"
    );
    assert.equal(
      fs.readFileSync(path.join(tmpDir, ".demo-gpg-cache", "secret.asc"), "utf8"),
      "sec"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncGpgKeys exports only the configured signing key on a cache miss", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-sync-signing-key-"));
  const calls = [];

  try {
    const synced = sandboxCreate.syncGpgKeys("demo-container", tmpDir, "demo", (cmd, args, options) => {
      calls.push([cmd, args, options]);
      if (cmd === "git") {
        return "8246B1E31A62A1D6\n";
      }
      if (cmd === "gpg" && args[0] === "--export") {
        return Buffer.from("pub");
      }
      if (cmd === "gpg" && args[0] === "--export-secret-keys") {
        return Buffer.from("sec");
      }
      if (cmd === "gpg" && args[0] === "--list-secret-keys") {
        return "sec:u:255:22:ABCDEF1234567890:1700000000:0::::::23::0:\n";
      }
      if (cmd === "docker" && args.at(-1) === "--import") {
        return Buffer.from("");
      }
      throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
    }, () => "");

    assert.equal(synced, true);
    assert.deepEqual(calls.map(([cmd, args]) => [cmd, args]), [
      ["git", ["config", "--global", "user.signingKey"]],
      ["gpg", ["--export", "8246B1E31A62A1D6"]],
      ["gpg", ["--export-secret-keys", "8246B1E31A62A1D6"]],
      ["gpg", ["--list-secret-keys", "--with-colons"]],
      ["docker", ["exec", "-i", "demo-container", "gpg", "--import"]],
      ["docker", ["exec", "-i", "demo-container", "gpg", "--batch", "--import"]]
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncGpgKeys still succeeds when writing the cache fails", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-sync-cache-write-fails-"));
  const cacheDir = path.join(tmpDir, ".demo-gpg-cache");
  const calls = [];
  const writes = [];
  const originalWrite = process.stderr.write;

  try {
    fs.writeFileSync(cacheDir, "blocking-file");
    process.stderr.write = (...args) => {
      writes.push(args[0]);
      return true;
    };

    const synced = sandboxCreate.syncGpgKeys("demo-container", tmpDir, "demo", (cmd, args, options) => {
      calls.push([cmd, args, options]);
      if (cmd === "git") {
        return "";
      }
      if (cmd === "gpg" && args[0] === "--list-secret-keys") {
        return "sec:u:255:22:ABCDEF1234567890:1700000000:0::::::23::0:\n";
      }
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
    }, () => "");

    assert.equal(synced, true);
    assert.deepEqual(calls.map(([cmd, args]) => [cmd, args]), [
      ["git", ["config", "--global", "user.signingKey"]],
      ["gpg", ["--export"]],
      ["gpg", ["--export-secret-keys"]],
      ["gpg", ["--list-secret-keys", "--with-colons"]],
      ["docker", ["exec", "-i", "demo-container", "gpg", "--import"]],
      ["docker", ["exec", "-i", "demo-container", "gpg", "--batch", "--import"]]
    ]);
    assert.deepEqual(writes, [
      "Warning: failed to cache GPG keys; next sandbox create may prompt again.\n"
    ]);
  } finally {
    process.stderr.write = originalWrite;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncGpgKeys returns false when the host has no secret keys to import", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const calls = [];

  const synced = sandboxCreate.syncGpgKeys("demo-container", "/Users/demo", "demo", (cmd, args, options) => {
    calls.push([cmd, args, options]);
    if (cmd === "git") {
      return "";
    }
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
    ["git", ["config", "--global", "user.signingKey"]],
    ["gpg", ["--export"]],
    ["gpg", ["--export-secret-keys"]]
  ]);
});

test("syncGpgKeys imports host public and secret keys into the container", async () => {
  const sandboxCreate = await loadFreshEsm("lib/sandbox/commands/create.js");
  const calls = [];
  const runSafeCalls = [];

  const synced = sandboxCreate.syncGpgKeys("demo-container", "/Users/demo", "demo", (cmd, args, options) => {
    calls.push([cmd, args, options]);
    if (cmd === "git") {
      return "";
    }
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
    ["git", ["config", "--global", "user.signingKey"]],
    ["gpg", ["--export"]],
    ["gpg", ["--export-secret-keys"]],
    ["gpg", ["--list-secret-keys", "--with-colons"]],
    ["docker", ["exec", "-i", "demo-container", "gpg", "--import"]],
    ["docker", ["exec", "-i", "demo-container", "gpg", "--batch", "--import"]]
  ]);
  assert.equal(calls[0][2].env.HOME, "/Users/demo");
  assert.equal(calls[0][2].encoding, "utf8");
  assert.equal(calls[1][2].env.HOME, "/Users/demo");
  assert.equal(calls[3][2].env.HOME, "/Users/demo");
  assert.equal(calls[3][2].encoding, "utf8");
  assert.deepEqual(calls[4][2], {
    input: Buffer.from("pub"),
    stdio: ["pipe", "pipe", "pipe"]
  });
  assert.deepEqual(calls[5][2], {
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
