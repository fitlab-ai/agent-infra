import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  cliArgs,
  envWithPrependedPath,
  gitSafeEnv,
  loadFreshEsm,
  onPlatforms,
  writeSandboxEngineFixture
} from "../../helpers.ts";

type CommandOptions = Record<string, unknown> & {
  env?: NodeJS.ProcessEnv;
  input?: Buffer | string;
  encoding?: BufferEncoding;
  stdio?: unknown;
};
type ResolvedToolFixture = {
  tool: {
    envVars?: Record<string, string>;
    id?: string;
  };
};
type EnvFileResult = {
  dockerArgs: string[];
  cleanup(): void;
};
type GpgCache = {
  pub: Buffer;
  sec: Buffer;
};
type ExecFn = (cmd: string, args: string[], options?: CommandOptions) => string | Buffer | void;
type EngineExecFn = (engine: string, cmd: string, args: string[], options?: CommandOptions) => string | Buffer | void;
type RunSafeFn = (cmd: string, args: string[]) => string;
type EngineRunSafeFn = (engine: string, cmd: string, args: string[]) => string;
type SandboxCreateModule = {
  create(args: string[]): Promise<void>;
  buildContainerEnvFile(tools: ResolvedToolFixture[], engine: string, runSafe?: EngineRunSafeFn, options?: CommandOptions): EnvFileResult;
  buildDotfilesVolumeArgs(engine: string, snapshotDir: string | null | undefined, existsFn?: (targetPath: string) => boolean): string[];
  assertBranchAvailable(repoRoot: string, branch: string, options?: { allowedWorktrees?: string[]; runFn?: RunSafeFn }): void;
  ensureClaudeOnboarding(toolDir: string, hostHomeDir?: string): void;
  ensureClaudeSettings(toolDir: string, hostHomeDir?: string): void;
  ensureCodexModelInheritance(toolDir: string, hostHomeDir?: string): void;
  ensureCodexWorkspaceTrust(toolDir: string): void;
  ensureOpenCodeModelInheritance(toolDir: string, hostHomeDir?: string): void;
  ensureGeminiWorkspaceTrust(toolDir: string): void;
  buildImage(config: Record<string, unknown>, tools: Array<Record<string, unknown>>, dockerfilePath: string, imageSignature: string, deps?: Record<string, unknown>): void;
  commandErrorMessage(error: unknown): string;
  hostHasGpgKeys(home: string, execFn?: ExecFn): boolean;
  ensureShellConfigSymlinks(engine: string, container: string, execFn?: EngineExecFn): void;
  ensureSandboxAliasesFile(home: string): { created: boolean; path: string };
  buildClipboardVolumeArgs(engine: string, home: string): string[];
  prepareHostShellConfig(config: Record<string, unknown>): {
    hostDir: string;
    mounts: Array<{ hostPath: string; containerPath: string; options?: string }>;
  };
  detectGpgConfig(content: string): boolean;
  sanitizeGitConfig(content: string, home: string, options?: Record<string, unknown>): string;
  writeSanitizedGitconfig(config: Record<string, unknown>): string;
  syncGpgKeys(container: string, home: string, project: string, execFn: ExecFn, runSafeFn: RunSafeFn, options?: Record<string, unknown>): boolean;
  currentKeyringFingerprint(home: string, execFn: ExecFn): string | null;
  getGitSigningKey(options: Record<string, unknown>): string | null;
  readGpgCache(home: string, project: string, fingerprintFn: ExecFn, signingKey?: string): GpgCache | null;
  writeGpgCache(home: string, project: string, pub: Buffer, sec: Buffer, fingerprint: string, signingKey?: string): boolean;
};
type EnterModule = {
  terminalEnvFlags(env?: NodeJS.ProcessEnv): string[];
  formatCredentialSyncStatus(result: { status: string }): string;
  clipboardBridgeDisabled(env?: NodeJS.ProcessEnv): boolean;
  runSandboxInteractive(params: {
    engine: string;
    dockerArgs: string[];
    container: string;
    home: string;
    env?: NodeJS.ProcessEnv;
    runBridge?: (params: {
      engine: string;
      dockerArgs: string[];
      container: string;
      home: string;
    }) => number | Promise<number>;
    runInteractive?: (engine: string, cmd: string, args: string[]) => number;
  }): number | Promise<number>;
};

function required<T>(value: T | undefined, message = "expected value"): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

function validClaudeCredentialsBlob(expiresAt: number) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: `token-${expiresAt}`,
      refreshToken: `refresh-${expiresAt}`,
      scopes: ["user:profile", "user:sessions:claude_code"],
      expiresAt
    }
  });
}

test("sandbox exec formats host keychain unavailable credential sync warnings", async () => {
  const sandboxEnter = await loadFreshEsm<EnterModule>("lib/sandbox/commands/enter.js");

  assert.equal(
    sandboxEnter.formatCredentialSyncStatus({ status: "KEYCHAIN_LOCKED" }),
    'Warning: Host keychain is unavailable; Claude credential sync skipped. Run "ai sandbox refresh" for details.\n'
  );
  assert.equal(
    sandboxEnter.formatCredentialSyncStatus({ status: "KEYCHAIN_ERROR" }),
    'Warning: Host keychain is unavailable; Claude credential sync skipped. Run "ai sandbox refresh" for details.\n'
  );
});

test("sandbox exec clipboard bridge escape hatch parses explicit truthy values", async () => {
  const sandboxEnter = await loadFreshEsm<EnterModule>("lib/sandbox/commands/enter.js");

  assert.equal(sandboxEnter.clipboardBridgeDisabled({ AI_SANDBOX_NO_CLIPBOARD_BRIDGE: "1" }), true);
  assert.equal(sandboxEnter.clipboardBridgeDisabled({ AI_SANDBOX_NO_CLIPBOARD_BRIDGE: " TRUE " }), true);
  assert.equal(sandboxEnter.clipboardBridgeDisabled({ AI_SANDBOX_NO_CLIPBOARD_BRIDGE: "yes" }), true);
  assert.equal(sandboxEnter.clipboardBridgeDisabled({}), false);
  assert.equal(sandboxEnter.clipboardBridgeDisabled({ AI_SANDBOX_NO_CLIPBOARD_BRIDGE: "" }), false);
  assert.equal(sandboxEnter.clipboardBridgeDisabled({ AI_SANDBOX_NO_CLIPBOARD_BRIDGE: "0" }), false);
  assert.equal(sandboxEnter.clipboardBridgeDisabled({ AI_SANDBOX_NO_CLIPBOARD_BRIDGE: "off" }), false);
});

test("sandbox exec clipboard bridge escape hatch routes around the bridge", async () => {
  const sandboxEnter = await loadFreshEsm<EnterModule>("lib/sandbox/commands/enter.js");
  const dockerArgs = ["exec", "-it", "demo", "bash", "/usr/local/bin/sandbox-tmux-entry"];
  const bridgeCalls: unknown[] = [];
  const interactiveCalls: string[][] = [];

  const exitCode = await sandboxEnter.runSandboxInteractive({
    engine: "native",
    dockerArgs,
    container: "demo",
    home: "/tmp/home",
    env: { AI_SANDBOX_NO_CLIPBOARD_BRIDGE: "1" },
    runBridge(params) {
      bridgeCalls.push(params);
      return 5;
    },
    runInteractive(_engine, cmd, args) {
      interactiveCalls.push([cmd, ...args]);
      return 7;
    }
  });

  assert.equal(exitCode, 7);
  assert.deepEqual(interactiveCalls, [["docker", ...dockerArgs]]);
  assert.deepEqual(bridgeCalls, []);
});

test("sandbox exec clipboard bridge route uses the bridge by default", async () => {
  const sandboxEnter = await loadFreshEsm<EnterModule>("lib/sandbox/commands/enter.js");
  const dockerArgs = ["exec", "-it", "demo", "bash", "/usr/local/bin/sandbox-tmux-entry"];
  const bridgeCalls: unknown[] = [];
  const interactiveCalls: string[][] = [];

  const exitCode = await sandboxEnter.runSandboxInteractive({
    engine: "native",
    dockerArgs,
    container: "demo",
    home: "/tmp/home",
    env: {},
    runBridge(params) {
      bridgeCalls.push(params);
      return 11;
    },
    runInteractive(_engine, cmd, args) {
      interactiveCalls.push([cmd, ...args]);
      return 13;
    }
  });

  assert.equal(exitCode, 11);
  assert.deepEqual(bridgeCalls, [{ engine: "native", dockerArgs, container: "demo", home: "/tmp/home" }]);
  assert.deepEqual(interactiveCalls, []);
});

function spawnSandboxCli(
  fixture: ReturnType<typeof writeSandboxEngineFixture>,
  tmpDir: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
  options: { timeout?: number } = {}
) {
  return spawnSync(process.execPath, cliArgs("sandbox", ...args), {
    cwd: fixture.repoDir,
    env: {
      ...envWithPrependedPath(gitSafeEnv(), fixture.binDir),
      HOME: tmpDir,
      USERPROFILE: tmpDir,
      DOCKER_LOG_PATH: fixture.logPath,
      ...extraEnv
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 15_000
  });
}

test("sandbox exec enters tmux automatically for interactive shells", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-enter-"));

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, {
      project: "demo",
      dockerStdoutForPs: "demo-dev-agent-infra-feature-cli-generic-sandbox"
    });

    execFileSync(
      process.execPath,
      cliArgs("sandbox", "exec", "agent-infra-feature-cli-generic-sandbox"),
      {
        cwd: fixture.repoDir,
        env: {
          ...envWithPrependedPath(gitSafeEnv(), fixture.binDir),
          HOME: tmpDir,
          USERPROFILE: tmpDir,
          DOCKER_LOG_PATH: fixture.logPath,
          TERM_PROGRAM: "",
          TERM_PROGRAM_VERSION: "",
          LC_TERMINAL: "",
          LC_TERMINAL_VERSION: "",
          TZ: "Invalid Value"
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    const dockerCalls = fixture.readDockerCalls();
    assert.equal(dockerCalls.length, 2);
    assert.deepEqual(dockerCalls[0], ["ps", "--format", "{{.Names}}"]);
    assert.deepEqual(dockerCalls[1], [
      "exec",
      "-it",
      "demo-dev-agent-infra-feature-cli-generic-sandbox",
      "bash",
      "/usr/local/bin/sandbox-tmux-entry"
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox exec reconciles newer Claude credentials from a neighbouring project", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-enter-credentials-"));
  const fakeKeychainPath = path.join(tmpDir, "fake-keychain.json");
  const hostCredentialsPath = path.join(tmpDir, ".claude", ".credentials.json");
  const alphaCredentialsPath = path.join(
    tmpDir,
    ".agent-infra",
    "credentials",
    "alpha",
    "claude-code",
    ".credentials.json"
  );
  const betaCredentialsPath = path.join(
    tmpDir,
    ".agent-infra",
    "credentials",
    "beta",
    "claude-code",
    ".credentials.json"
  );
  const alphaBlob = validClaudeCredentialsBlob(Date.now() + 5_400_000);
  const newerBlob = validClaudeCredentialsBlob(Date.now() + 7_200_000);

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, {
      project: "alpha",
      sandbox: { tools: ["claude-code"] },
      dockerStdoutForPs: "alpha-dev-agent-infra-feature-cli-generic-sandbox"
    });

    fs.mkdirSync(path.dirname(hostCredentialsPath), { recursive: true });
    fs.mkdirSync(path.dirname(alphaCredentialsPath), { recursive: true });
    fs.mkdirSync(path.dirname(betaCredentialsPath), { recursive: true });
    fs.writeFileSync(hostCredentialsPath, validClaudeCredentialsBlob(Date.now() + 3_600_000), "utf8");
    fs.writeFileSync(alphaCredentialsPath, alphaBlob, "utf8");
    fs.writeFileSync(betaCredentialsPath, newerBlob, "utf8");

    if (process.platform === "darwin") {
      // Inject a fake `security` shim so the CLI subprocess does not touch the
      // real macOS Keychain on CI runners (which can hang on add-generic-password
      // due to login keychain ACL prompts). The shim reports MISSING for reads
      // and persists writes to FAKE_KEYCHAIN_FILE so the assertion can read back.
      const securityShimPath = path.join(fixture.binDir, "security");
      fs.writeFileSync(
        securityShimPath,
        `#!/bin/sh
case "$1" in
  find-generic-password) exit 44 ;;
  add-generic-password)
    shift
    while [ $# -gt 0 ]; do
      if [ "$1" = "-w" ]; then
        shift
        printf '%s' "$1" > "$FAKE_KEYCHAIN_FILE"
        exit 0
      fi
      shift
    done
    exit 1 ;;
esac
exit 2
`,
        "utf8"
      );
      fs.chmodSync(securityShimPath, 0o755);
    }

    const result = spawnSync(
      process.execPath,
      cliArgs("sandbox", "exec", "agent-infra-feature-cli-generic-sandbox", "true"),
      {
        cwd: fixture.repoDir,
        env: {
          ...envWithPrependedPath(gitSafeEnv(), fixture.binDir),
          HOME: tmpDir,
          USERPROFILE: tmpDir,
          DOCKER_LOG_PATH: fixture.logPath,
          FAKE_KEYCHAIN_FILE: fakeKeychainPath
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    assert.equal(result.status, 0);
    assert.match(result.stderr, /from sandbox refresh/);
    if (process.platform === "darwin") {
      assert.equal(fs.readFileSync(fakeKeychainPath, "utf8"), newerBlob);
    } else {
      assert.equal(fs.readFileSync(hostCredentialsPath, "utf8"), newerBlob);
    }
    assert.equal(fs.readFileSync(alphaCredentialsPath, "utf8"), newerBlob);
    assert.equal(fs.readFileSync(betaCredentialsPath, "utf8"), newerBlob);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox ls resolves to configured engine", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-ls-engine-"));

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, {
      project: "demo",
      // Matches ls.js' current docker ps format: NAMES, STATUS, BRANCH.
      dockerStdoutForPs: "demo-dev-feature-x\tUp 1 minute\tfeature-x"
    });

    const result = spawnSandboxCli(fixture, tmpDir, ["ls"]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /demo-dev-feature-x/);
    assert.ok(
      fixture.readDockerCalls().some((call) => call[0] === "ps"),
      "expected sandbox ls to call docker ps through the configured native engine"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox rebuild resolves to configured engine", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-rebuild-engine-"));

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo" });

    const result = spawnSandboxCli(fixture, tmpDir, ["rebuild", "--quiet"]);

    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      fixture.readDockerCalls().some((call) => call[0] === "build"),
      "expected sandbox rebuild to call docker build through the configured native engine"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox create resolves to configured engine", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-create-engine-"));

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, {
      project: "demo",
      sandbox: { tools: ["codex"] }
    });

    spawnSandboxCli(
      fixture,
      tmpDir,
      ["create", "feature-x", "--cpu", "1", "--memory", "1"],
      { DOCKER_EXIT_FOR_RUN: "1" },
      { timeout: 5_000 }
    );

    // Ignore exit status: this thin probe only validates engine resolution.
    assert.ok(
      fixture.readDockerCalls().some((call) => call[0] === "build"),
      "expected sandbox create to reach docker build through the configured native engine"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox create builds clipboard mount as read-only container path", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-create-clipboard-"));

  try {
    assert.deepEqual(
      sandboxCreate.buildClipboardVolumeArgs("native", tmpDir),
      ["-v", path.join(tmpDir, ".agent-infra", "clipboard") + ":/clipboard:ro"]
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("claude-code tool pins CLAUDE_CONFIG_DIR so $HOME/.claude.json preseed reaches Claude Code", async () => {
  // Regression guard for the onboarding loop bug: without this env var Claude
  // Code reads .claude.json from $HOME/.claude.json (outside the bind mount),
  // so the preseeded onboarding state is silently ignored and every container
  // start lands on the theme picker.
  const sandboxTools = await loadFreshEsm<typeof import("../../../lib/sandbox/tools.ts")>("lib/sandbox/tools.js");
  const tools = sandboxTools.resolveTools({
    home: "/home/host-user",
    project: "demo",
    tools: ["claude-code"]
  });

  assert.equal(tools.length, 1);
  const tool = required(tools[0]);
  assert.equal(tool.containerMount, "/home/devuser/.claude");
  assert.equal(tool.envVars?.CLAUDE_CONFIG_DIR, "/home/devuser/.claude");
});

test("opencode tool pins OPENCODE_CONFIG to the sandbox config file", async () => {
  const sandboxTools = await loadFreshEsm<typeof import("../../../lib/sandbox/tools.ts")>("lib/sandbox/tools.js");
  const tools = sandboxTools.resolveTools({
    home: "/home/host-user",
    project: "demo",
    tools: ["opencode"]
  });

  assert.equal(tools.length, 1);
  const tool = required(tools[0]);
  assert.equal(tool.containerMount, "/home/devuser/.local/share/opencode");
  assert.equal(
    tool.envVars?.OPENCODE_CONFIG,
    "/home/devuser/.local/share/opencode/opencode.json"
  );
});

test("gemini-cli tool preseeds host settings for model and thinking config inheritance", async () => {
  const sandboxTools = await loadFreshEsm<typeof import("../../../lib/sandbox/tools.ts")>("lib/sandbox/tools.js");
  const [maybeTool] = sandboxTools.resolveTools({
    home: "/home/host-user",
    project: "demo",
    tools: ["gemini-cli"]
  });

  const tool = required(maybeTool);
  assert.ok(tool.hostPreSeedFiles?.some((entry) => (
    entry.hostPath === "/home/host-user/.gemini/settings.json"
    && entry.sandboxName === "settings.json"
  )));
});

test("resolveTools consolidates sandbox bases under ~/.agent-infra", async () => {
  const sandboxTools = await loadFreshEsm<typeof import("../../../lib/sandbox/tools.ts")>("lib/sandbox/tools.js");
  const tools = sandboxTools.resolveTools({
    home: "/home/host-user",
    project: "demo",
    tools: ["claude-code", "codex", "opencode", "gemini-cli"]
  });

  assert.deepEqual(tools.map((tool) => ({
    id: tool.id,
    sandboxBase: tool.sandboxBase
  })), [
    {
      id: "claude-code",
      sandboxBase: "/home/host-user/.agent-infra/sandboxes/claude-code"
    },
    {
      id: "codex",
      sandboxBase: "/home/host-user/.agent-infra/sandboxes/codex"
    },
    {
      id: "opencode",
      sandboxBase: "/home/host-user/.agent-infra/sandboxes/opencode"
    },
    {
      id: "gemini-cli",
      sandboxBase: "/home/host-user/.agent-infra/sandboxes/gemini-cli"
    }
  ]);
});

test("tool directory candidates only return consolidated paths", async () => {
  const sandboxTools = await loadFreshEsm<typeof import("../../../lib/sandbox/tools.ts")>("lib/sandbox/tools.js");
  const [maybeTool] = sandboxTools.resolveTools({
    home: "/home/host-user",
    project: "demo",
    tools: ["claude-code"]
  });

  const tool = required(maybeTool);
  assert.deepEqual(sandboxTools.toolProjectDirCandidates(tool, "demo"), [
    "/home/host-user/.agent-infra/sandboxes/claude-code/demo"
  ]);
  assert.deepEqual(sandboxTools.toolConfigDirCandidates(tool, "demo", "feature/demo"), [
    "/home/host-user/.agent-infra/sandboxes/claude-code/demo/feature..demo",
    "/home/host-user/.agent-infra/sandboxes/claude-code/demo/feature-demo"
  ]);
});

test("claude-code live mount uses the consolidated credentials path", async () => {
  const sandboxTools = await loadFreshEsm<typeof import("../../../lib/sandbox/tools.ts")>("lib/sandbox/tools.js");
  const [maybeTool] = sandboxTools.resolveTools({
    home: "/home/host-user",
    project: "demo",
    tools: ["claude-code"]
  });

  assert.equal(
    required(maybeTool).hostLiveMounts?.[0]?.hostPath,
    "/home/host-user/.agent-infra/credentials/demo/claude-code/.credentials.json"
  );
});
