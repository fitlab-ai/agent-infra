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

test("loadConfig parses the minimal {id, install} customTools entry and fills all other fields with defaults", async () => {
  const sandboxConfig = await loadFreshEsm<SandboxConfigModule>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-custom-tools-minimal-"));
  const previousCwd = process.cwd();

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    // The minimal entry is the contract that documentation promises: 2 fields
    // (id + install) are required; everything else gets a sensible default.
    writeAirc(tmpDir, {
      project: "demo",
      sandbox: {
        tools: ["claude-code", "my-tool"],
        customTools: [
          {
            id: "my-tool",
            install: { type: "shell", cmd: SHELL_INSTALL_CMD }
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
    // Defaults derived from id
    assert.equal(tool?.name, "my-tool");
    assert.equal(tool?.containerMount, "/home/devuser/.my-tool");
    assert.equal(tool?.versionCmd, "which my-tool");
    assert.match(tool?.setupHint ?? "", /^Run/);
    // sandboxBase is always derived; not user-configurable
    assert.equal(
      tool?.sandboxBase,
      path.join(process.env.HOME ?? "", ".agent-infra", "sandboxes", "my-tool")
    );
    // Optional integration fields stay undefined when omitted
    assert.equal(tool?.envVars, undefined);
    assert.equal(tool?.hostLiveMounts, undefined);
    assert.equal(tool?.hostPreSeedFiles, undefined);
    assert.equal(tool?.hostPreSeedDirs, undefined);
    assert.equal(tool?.pathRewriteFiles, undefined);
    assert.equal(tool?.postSetupCmds, undefined);
    // tools array preserves user order, including non-builtin id
    assert.deepEqual(config.tools, ["claude-code", "my-tool"]);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig honours user-supplied versionCmd to support binary names that differ from the tool id", async () => {
  const sandboxConfig = await loadFreshEsm<SandboxConfigModule>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-custom-tools-versioncmd-"));
  const previousCwd = process.cwd();

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    // Realistic case: npm package is @anthropic-ai/claude-code, binary is
    // `claude`, user picks `anthropic-claude` as a disambiguated id.
    // The default `which anthropic-claude` would fail; user must override.
    writeAirc(tmpDir, {
      project: "demo",
      sandbox: {
        tools: ["anthropic-claude"],
        customTools: [
          {
            id: "anthropic-claude",
            install: { type: "npm", cmd: "@anthropic-ai/claude-code@stable" },
            versionCmd: "claude --version",
            hostLiveMounts: [
              { hostPath: "/home/u/.claude/.credentials.json", containerSubpath: ".credentials.json" }
            ]
          }
        ]
      }
    });

    process.chdir(tmpDir);
    const config = withGitSafeProcessEnv(() => sandboxConfig.loadConfig());

    const tool = config.customTools[0];
    assert.equal(tool?.versionCmd, "claude --version");
    assert.deepEqual(tool?.hostLiveMounts, [
      { hostPath: "/home/u/.claude/.credentials.json", containerSubpath: ".credentials.json" }
    ]);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects an explicit relative containerMount even though the field is now optional", async () => {
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
            install: { type: "shell", cmd: "echo hi" },
            containerMount: "relative/path"
          }
        ]
      }
    });

    process.chdir(tmpDir);
    assert.throws(
      () => withGitSafeProcessEnv(() => sandboxConfig.loadConfig()),
      /"containerMount" must be an absolute path/
    );
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects an explicit empty versionCmd to prevent bash -lc '' from silently passing", async () => {
  const sandboxConfig = await loadFreshEsm<SandboxConfigModule>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-custom-empty-version-"));
  const previousCwd = process.cwd();

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    // Round 4 distinguishes "omitted" (legal, use default) from "explicit empty
    // string" (illegal). The explicit empty case would, if accepted, run
    // `bash -lc ""` which exits 0 — silently masking install failures.
    writeAirc(tmpDir, {
      project: "demo",
      sandbox: {
        customTools: [
          {
            id: "no-version",
            install: { type: "shell", cmd: "echo hi" },
            versionCmd: ""
          }
        ]
      }
    });

    process.chdir(tmpDir);
    assert.throws(
      () => withGitSafeProcessEnv(() => sandboxConfig.loadConfig()),
      /"versionCmd" must be non-empty when provided/
    );
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects an explicit empty setupHint while accepting omission", async () => {
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
            install: { type: "shell", cmd: "echo hi" },
            setupHint: ""
          }
        ]
      }
    });

    process.chdir(tmpDir);
    assert.throws(
      () => withGitSafeProcessEnv(() => sandboxConfig.loadConfig()),
      /"setupHint" must be non-empty when provided/
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
            install: { type: "shell", cmd: "echo hi" },
            // User attempts to override sandboxBase — the loader must ignore
            // it so `ai sandbox rm` / `prune` keep finding the canonical path.
            sandboxBase: "/some/unexpected/host/path"
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
            install: { type: "shell", cmd: "" }
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
