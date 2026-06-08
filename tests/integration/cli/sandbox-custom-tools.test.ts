import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  gitSafeEnv,
  loadFreshEsm,
  withGitSafeProcessEnv
} from "../../helpers.ts";

type SandboxConfigModule = typeof import("../../../lib/sandbox/config.ts");
type SandboxToolsModule = typeof import("../../../lib/sandbox/tools.ts");
type SandboxCreateModule = typeof import("../../../lib/sandbox/commands/create.ts");

type VerboseCall = {
  type: "run" | "verbose";
  engine?: string;
  cmd: string;
  args: string[];
  opts?: { cwd?: string };
};

const SHELL_INSTALL_CMD = 'curl -fsSL https://example.com/install.sh | bash';

function writeAirc(repoRoot: string, body: Record<string, unknown>): void {
  fs.mkdirSync(path.join(repoRoot, ".agents"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, ".agents", ".airc.json"),
    JSON.stringify(body, null, 2) + "\n",
    "utf8"
  );
}

test("loadConfig parses sandbox.customTools and fills sandboxBase under ~/.agent-infra/sandboxes", async () => {
  const sandboxConfig = await loadFreshEsm<SandboxConfigModule>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-custom-tools-"));
  const previousCwd = process.cwd();

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    writeAirc(tmpDir, {
      project: "demo",
      sandbox: {
        tools: ["claude-code", "my-tool"],
        customTools: [
          {
            id: "my-tool",
            name: "My Custom Tool",
            install: { type: "shell", cmd: SHELL_INSTALL_CMD },
            containerMount: "/home/devuser/.mytool",
            versionCmd: "mytool --version",
            setupHint: "fixture"
          }
        ]
      }
    });

    process.chdir(tmpDir);
    const config = withGitSafeProcessEnv(() => sandboxConfig.loadConfig());

    assert.equal(config.customTools.length, 1);
    const tool = config.customTools[0];
    assert.equal(tool?.id, "my-tool");
    assert.deepEqual(tool?.install, { type: "shell", cmd: SHELL_INSTALL_CMD });
    assert.equal(
      tool?.sandboxBase,
      path.join(process.env.HOME ?? "", ".agent-infra", "sandboxes", "my-tool")
    );
    // tools array preserves user order, including non-builtin id
    assert.deepEqual(config.tools, ["claude-code", "my-tool"]);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects customTools entries with relative containerMount", async () => {
  const sandboxConfig = await loadFreshEsm<SandboxConfigModule>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-custom-bad-mount-"));
  const previousCwd = process.cwd();

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    writeAirc(tmpDir, {
      project: "demo",
      sandbox: {
        customTools: [
          {
            id: "bad-tool",
            name: "Bad",
            install: { type: "shell", cmd: "echo hi" },
            containerMount: "relative/path",
            versionCmd: "bad --version",
            setupHint: "fixture"
          }
        ]
      }
    });

    process.chdir(tmpDir);
    assert.throws(
      () => withGitSafeProcessEnv(() => sandboxConfig.loadConfig()),
      /containerMount must be an absolute path/
    );
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects customTools entries with empty versionCmd", async () => {
  const sandboxConfig = await loadFreshEsm<SandboxConfigModule>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-custom-empty-version-"));
  const previousCwd = process.cwd();

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    writeAirc(tmpDir, {
      project: "demo",
      sandbox: {
        customTools: [
          {
            id: "no-version",
            name: "Empty Version",
            install: { type: "shell", cmd: "echo hi" },
            containerMount: "/home/devuser/.no-version",
            versionCmd: "",
            setupHint: "fixture"
          }
        ]
      }
    });

    process.chdir(tmpDir);
    // Empty versionCmd would otherwise pass through to `bash -lc ""`, which
    // exits 0 — silently masking install failures during sandbox creation.
    assert.throws(
      () => withGitSafeProcessEnv(() => sandboxConfig.loadConfig()),
      /empty versionCmd/
    );
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects customTools entries with empty setupHint", async () => {
  const sandboxConfig = await loadFreshEsm<SandboxConfigModule>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-custom-empty-hint-"));
  const previousCwd = process.cwd();

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    writeAirc(tmpDir, {
      project: "demo",
      sandbox: {
        customTools: [
          {
            id: "no-hint",
            name: "Empty Hint",
            install: { type: "shell", cmd: "echo hi" },
            containerMount: "/home/devuser/.no-hint",
            versionCmd: "no-hint --version",
            setupHint: ""
          }
        ]
      }
    });

    process.chdir(tmpDir);
    assert.throws(
      () => withGitSafeProcessEnv(() => sandboxConfig.loadConfig()),
      /empty setupHint/
    );
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig always assigns the default sandboxBase and ignores user-supplied overrides", async () => {
  const sandboxConfig = await loadFreshEsm<SandboxConfigModule>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-custom-base-"));
  const previousCwd = process.cwd();

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    writeAirc(tmpDir, {
      project: "demo",
      sandbox: {
        customTools: [
          {
            id: "fixed-base",
            name: "Fixed Base",
            install: { type: "shell", cmd: "echo hi" },
            containerMount: "/home/devuser/.fixed-base",
            // User attempts to override sandboxBase — the loader must ignore
            // it so `ai sandbox rm` / `prune` keep finding the canonical path.
            sandboxBase: "/some/unexpected/host/path",
            versionCmd: "fixed-base --version",
            setupHint: "fixture"
          }
        ]
      }
    });

    process.chdir(tmpDir);
    const config = withGitSafeProcessEnv(() => sandboxConfig.loadConfig());
    assert.equal(
      config.customTools[0]?.sandboxBase,
      path.join(process.env.HOME ?? "", ".agent-infra", "sandboxes", "fixed-base")
    );
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects customTools entries with empty install.cmd", async () => {
  const sandboxConfig = await loadFreshEsm<SandboxConfigModule>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-custom-empty-cmd-"));
  const previousCwd = process.cwd();

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    writeAirc(tmpDir, {
      project: "demo",
      sandbox: {
        customTools: [
          {
            id: "empty-cmd",
            name: "Empty",
            install: { type: "shell", cmd: "" },
            containerMount: "/home/devuser/.empty",
            versionCmd: "v",
            setupHint: "f"
          }
        ]
      }
    });

    process.chdir(tmpDir);
    assert.throws(
      () => withGitSafeProcessEnv(() => sandboxConfig.loadConfig()),
      /install\.cmd/
    );
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolveTools merges builtin and customTools, preserving sandbox.tools ordering", async () => {
  const sandboxTools = await loadFreshEsm<SandboxToolsModule>("lib/sandbox/tools.js");

  const tools = sandboxTools.resolveTools({
    home: "/home/host-user",
    project: "demo",
    tools: ["my-shell-tool", "claude-code"],
    customTools: [
      {
        id: "my-shell-tool",
        name: "My Shell Tool",
        install: { type: "shell", cmd: SHELL_INSTALL_CMD },
        sandboxBase: "/home/host-user/.agent-infra/sandboxes/my-shell-tool",
        containerMount: "/home/devuser/.my-shell-tool",
        versionCmd: "my-shell-tool --version",
        setupHint: "fixture"
      }
    ]
  });

  assert.deepEqual(
    tools.map((tool) => tool.id),
    ["my-shell-tool", "claude-code"]
  );
  assert.deepEqual(tools[0]?.install, { type: "shell", cmd: SHELL_INSTALL_CMD });
});

test("resolveTools throws when customTools id collides with a built-in tool", async () => {
  const sandboxTools = await loadFreshEsm<SandboxToolsModule>("lib/sandbox/tools.js");

  assert.throws(
    () =>
      sandboxTools.resolveTools({
        home: "/home/host-user",
        project: "demo",
        tools: ["claude-code"],
        customTools: [
          {
            id: "claude-code",
            name: "Imposter",
            install: { type: "shell", cmd: "echo override" },
            sandboxBase: "/home/host-user/.agent-infra/sandboxes/claude-code",
            containerMount: "/home/devuser/.claude",
            versionCmd: "claude --version",
            setupHint: "fixture"
          }
        ]
      }),
    /collides with a built-in tool/
  );
});

test("resolveTools throws when two customTools share the same id", async () => {
  const sandboxTools = await loadFreshEsm<SandboxToolsModule>("lib/sandbox/tools.js");

  const dup = {
    id: "dup-tool",
    name: "Dup",
    install: { type: "shell" as const, cmd: "echo dup" },
    sandboxBase: "/home/host-user/.agent-infra/sandboxes/dup-tool",
    containerMount: "/home/devuser/.dup",
    versionCmd: "dup --version",
    setupHint: "fixture"
  };

  assert.throws(
    () =>
      sandboxTools.resolveTools({
        home: "/home/host-user",
        project: "demo",
        tools: ["dup-tool"],
        customTools: [dup, { ...dup }]
      }),
    /Duplicate sandbox tool id/
  );
});

test("resolveTools still throws Unknown sandbox tool when sandbox.tools references a missing id", async () => {
  const sandboxTools = await loadFreshEsm<SandboxToolsModule>("lib/sandbox/tools.js");

  assert.throws(
    () =>
      sandboxTools.resolveTools({
        home: "/home/host-user",
        project: "demo",
        tools: ["does-not-exist"],
        customTools: []
      }),
    /Unknown sandbox tool: does-not-exist/
  );
});

test("buildImage forwards AI_TOOL_PACKAGES= empty and a non-empty AI_TOOLS_SHELL_INSTALL_B64 for shell-only configs", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const calls: VerboseCall[] = [];

  sandboxCreate.buildImage(
    { project: "demo", imageName: "demo-sandbox:latest", repoRoot: "/repo" },
    [
      {
        id: "shell-only",
        name: "Shell Only",
        install: { type: "shell", cmd: SHELL_INSTALL_CMD },
        sandboxBase: "/home/host-user/.agent-infra/sandboxes/shell-only",
        containerMount: "/home/devuser/.shell-only",
        versionCmd: "shell-only --version",
        setupHint: "fixture"
      }
    ],
    "/tmp/Dockerfile",
    "sig-shell-only",
    {
      engine: "native",
      runFn(_engine: string, cmd: string, args: string[]) {
        calls.push({ type: "run", cmd, args });
        if (cmd === "id" && args[0] === "-u") return "1000";
        if (cmd === "id" && args[0] === "-g") return "1000";
        throw new Error(`unexpected quiet command: ${cmd} ${args.join(" ")}`);
      },
      runSafeFn() {
        return "";
      },
      runVerboseFn(engine: string, cmd: string, args: string[], opts?: { cwd?: string }) {
        calls.push({ type: "verbose", engine, cmd, args, opts });
      }
    }
  );

  const verbose = calls.find((c) => c.type === "verbose");
  assert.ok(verbose, "expected a verbose docker build call");
  const argString = verbose.args.join("\n");
  assert.match(argString, /AI_TOOL_PACKAGES=$/m);
  const shellArgIdx = verbose.args.findIndex((arg) => arg.startsWith("AI_TOOLS_SHELL_INSTALL_B64="));
  assert.ok(shellArgIdx >= 0, "expected AI_TOOLS_SHELL_INSTALL_B64 build arg");
  const shellArgValue = (verbose.args[shellArgIdx] ?? "").slice("AI_TOOLS_SHELL_INSTALL_B64=".length);
  assert.notEqual(shellArgValue, "");
  const decoded = Buffer.from(shellArgValue, "base64").toString("utf8");
  assert.match(decoded, /# install: shell-only/);
  assert.match(decoded, /curl -fsSL https:\/\/example\.com\/install\.sh \| bash/);
});

test("buildImage forwards AI_TOOLS_SHELL_INSTALL_B64= empty for the default npm-only configuration", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const calls: VerboseCall[] = [];

  sandboxCreate.buildImage(
    { project: "demo", imageName: "demo-sandbox:latest", repoRoot: "/repo" },
    [{ install: { type: "npm", cmd: "@acme/tool" } }],
    "/tmp/Dockerfile",
    "sig-npm-only",
    {
      engine: "native",
      runFn(_engine: string, cmd: string, args: string[]) {
        calls.push({ type: "run", cmd, args });
        if (cmd === "id" && args[0] === "-u") return "1000";
        if (cmd === "id" && args[0] === "-g") return "1000";
        throw new Error(`unexpected quiet command: ${cmd} ${args.join(" ")}`);
      },
      runSafeFn() {
        return "";
      },
      runVerboseFn(engine: string, cmd: string, args: string[], opts?: { cwd?: string }) {
        calls.push({ type: "verbose", engine, cmd, args, opts });
      }
    }
  );

  const verbose = calls.find((c) => c.type === "verbose");
  assert.ok(verbose, "expected a verbose docker build call");
  assert.ok(
    verbose.args.includes("AI_TOOLS_SHELL_INSTALL_B64="),
    "expected empty AI_TOOLS_SHELL_INSTALL_B64 for npm-only build"
  );
  assert.ok(
    verbose.args.includes("AI_TOOL_PACKAGES=@acme/tool"),
    "expected AI_TOOL_PACKAGES to carry the npm-type tool"
  );
});
