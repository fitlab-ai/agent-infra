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
type ClaudeSandboxModule = {
  formatCredentialSyncStatus(
    result: { status: string; authoritative?: string | null; expiresAt?: unknown; filesWritten?: string[]; warnings?: unknown[] },
    isTTY?: boolean,
    providerAuthAvailable?: boolean
  ): string | null;
};
type ImageBuildModule = {
  buildImageSignature(preparedDockerfile: Record<string, unknown>, tools: Array<Record<string, unknown>>): string;
};
type SandboxConfigModule = {
  loadConfig(): Record<string, unknown>;
};
type SandboxDockerfileModule = {
  prepareDockerfile(
    config: Record<string, unknown>,
    image?: Record<string, unknown>
  ): Record<string, unknown> & { cleanup(): void };
};
type SandboxCapabilityModule = {
  createSandboxCapabilityPlan(config: Record<string, unknown>): {
    tools: Array<Record<string, unknown>>;
    image: Record<string, unknown>;
  };
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

async function sandboxImageSignature(repoDir: string): Promise<string> {
  const imageBuild = await loadFreshEsm<ImageBuildModule>("lib/sandbox/image-build.js");
  const sandboxConfig = await loadFreshEsm<SandboxConfigModule>("lib/sandbox/config.js");
  const sandboxDockerfile = await loadFreshEsm<SandboxDockerfileModule>("lib/sandbox/dockerfile.js");
  const reconciler = await loadFreshEsm<SandboxCapabilityModule>("lib/sandbox/agent-client-reconciler.js");
  const previousCwd = process.cwd();

  try {
    process.chdir(repoDir);
    const config = sandboxConfig.loadConfig();
    const capabilityPlan = reconciler.createSandboxCapabilityPlan(config);
    const preparedDockerfile = sandboxDockerfile.prepareDockerfile(config, capabilityPlan.image);
    try {
      return imageBuild.buildImageSignature(preparedDockerfile, capabilityPlan.tools);
    } finally {
      preparedDockerfile.cleanup();
    }
  } finally {
    process.chdir(previousCwd);
  }
}

test("sandbox exec formats host keychain unavailable credential sync warnings", async () => {
  const claudeSandbox = await loadFreshEsm<ClaudeSandboxModule>("lib/agent-clients/adapters/claude-code-sandbox.js");

  assert.equal(
    claudeSandbox.formatCredentialSyncStatus({ status: "KEYCHAIN_LOCKED" }),
    'Warning: Host keychain is unavailable; Claude credential sync skipped. Run "ai sandbox refresh" for details.\n'
  );
  assert.equal(
    claudeSandbox.formatCredentialSyncStatus({ status: "KEYCHAIN_ERROR" }),
    'Warning: Host keychain is unavailable; Claude credential sync skipped. Run "ai sandbox refresh" for details.\n'
  );
});

test("sandbox exec suppresses missing OAuth warnings when Claude provider auth exists", async () => {
  const claudeSandbox = await loadFreshEsm<ClaudeSandboxModule>("lib/agent-clients/adapters/claude-code-sandbox.js");

  assert.equal(
    claudeSandbox.formatCredentialSyncStatus({ status: "MISSING" }, false, true),
    null
  );
  assert.equal(
    claudeSandbox.formatCredentialSyncStatus({ status: "STALE_ACCESS" }, false, true),
    null
  );
  assert.match(
    claudeSandbox.formatCredentialSyncStatus({ status: "KEYCHAIN_LOCKED" }, false, true) ?? "",
    /Host keychain is unavailable/
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

test("sandbox exec '#abc' fails branch validation without triggering docker IO", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-enter-bad-shortref-"));

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo" });

    const result = spawnSync(
      process.execPath,
      cliArgs("sandbox", "exec", "#abc"),
      {
        cwd: fixture.repoDir,
        env: {
          ...envWithPrependedPath(gitSafeEnv(), fixture.binDir),
          HOME: tmpDir,
          USERPROFILE: tmpDir,
          DOCKER_LOG_PATH: fixture.logPath
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000
      }
    );

    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /Invalid branch name '#abc'/);
    assert.deepEqual(fixture.readDockerCalls(), []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox exec rejects removed '#1' syntax without docker IO", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-enter-shortref-"));

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo" });

    const result = spawnSync(
      process.execPath,
      cliArgs("sandbox", "exec", "#1"),
      {
        cwd: fixture.repoDir,
        env: {
          ...envWithPrependedPath(gitSafeEnv(), fixture.binDir),
          HOME: tmpDir,
          USERPROFILE: tmpDir,
          DOCKER_LOG_PATH: fixture.logPath
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000
      }
    );

    assert.notEqual(result.status, 0);
    // Round 4: '#1' no longer falls back to "N-th running sandbox"; missing
    // registry entry throws a short-ref-not-found error before any docker call.
    assert.match(String(result.stderr), /must use bare digits/);

    // No docker calls should have happened — resolution failed before listing
    // sandboxes.
    const dockerCalls = fixture.readDockerCalls();
    assert.equal(dockerCalls.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox exec enters tmux automatically for interactive shells", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-enter-"));

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, {
      project: "demo",
      dockerStdoutForPs: "demo-dev-agent-infra-feature-cli-generic-sandbox\tUp 5 minutes\tdemo.sandbox.branch=agent-infra-feature-cli-generic-sandbox"
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
    // exec now queries all containers via fetchSandboxRows (docker ps -a + label filter).
    // Assert the stable prefix only: the Windows .cmd shim runs with shell:true and `%*`,
    // which splits the tab-bearing `--format` value into separate args. The exact format
    // string is covered by the containerListFormat() unit test in sandbox-core.test.ts.
    assert.deepEqual(dockerCalls[0]!.slice(0, 5), [
      "ps",
      "-a",
      "--filter",
      "label=demo.sandbox",
      "--format"
    ]);
    const interactiveCall = dockerCalls.find((call) => call[0] === "exec" && call.includes("-it"));
    assert.deepEqual(interactiveCall, [
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

test("sandbox exec redacts tokens from dotfiles snapshot rebuild errors", onPlatforms("linux", "darwin", "win32"), () => {
  const token = "ghp_123456789012345678901234567890123456";
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-infra-${token}-`));

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, {
      project: "demo",
      dockerStdoutForPs: "demo-dev-agent-infra-feature-cli-generic-sandbox\tUp 5 minutes\tdemo.sandbox.branch=agent-infra-feature-cli-generic-sandbox"
    });
    fs.mkdirSync(path.join(tmpDir, ".agent-infra", "dotfiles"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".agent-infra", ".cache"), "not a directory", "utf8");

    const result = spawnSync(
      process.execPath,
      cliArgs("sandbox", "exec", "agent-infra-feature-cli-generic-sandbox"),
      {
        cwd: fixture.repoDir,
        env: {
          ...envWithPrependedPath(gitSafeEnv(), fixture.binDir),
          HOME: tmpDir,
          USERPROFILE: tmpDir,
          DOCKER_LOG_PATH: fixture.logPath
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /dotfiles snapshot rebuild failed/);
    assert.match(result.stderr, /\[REDACTED github token\]/);
    assert.doesNotMatch(result.stderr, new RegExp(token));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox exec rejects a relative Claude credentials override", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-enter-relative-credentials-"));

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, {
      project: "demo",
      sandbox: { tools: ["claude-code"] },
      dockerStdoutForPs: "demo-dev-agent-infra-feature-cli-generic-sandbox\tUp 5 minutes\tdemo.sandbox.branch=agent-infra-feature-cli-generic-sandbox"
    });

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
          AGENT_INFRA_CLAUDE_CREDENTIALS_FILE: "relative/credentials.json"
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid AGENT_INFRA_CLAUDE_CREDENTIALS_FILE value/);
    assert.match(result.stderr, /absolute file path/);
    assert.equal(
      fixture.readDockerCalls().some((call) => call[0] === "exec" && call.includes("-it")),
      false
    );
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
    assert.ok(
      fixture.readRawDockerCalls().some((call) =>
        call[0] === "--context" && call[1] === "desktop-linux" && call[2] === "ps"
      ),
      "expected sandbox ls to select the configured Docker Desktop context explicitly"
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
    assert.ok(
      fixture.readRawDockerCalls().some((call) =>
        call[0] === "--context"
        && call[1] === "desktop-linux"
        && call[2] === "buildx"
        && call[3] === "inspect"
        && call[4] === "--bootstrap"
      ),
      "expected BuildKit probing to use the configured Docker Desktop context"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox rebuild fails before build when BuildKit is unavailable", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-rebuild-buildkit-"));

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo" });
    const result = spawnSandboxCli(fixture, tmpDir, ["rebuild", "--quiet"], {
      DOCKER_EXIT_FOR_BUILDX_INSPECT: "1"
    });
    const dockerCalls = fixture.readDockerCalls();

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /docker buildx inspect --bootstrap/);
    assert.ok(dockerCalls.some((call) => call[0] === "buildx" && call[1] === "inspect"));
    assert.equal(dockerCalls.some((call) => call[0] === "build"), false);
    assert.equal(dockerCalls.some((call) => call[0] === "image" && call[1] === "prune"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox rebuild build failure omits build-proxy guidance without -B", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-rebuild-fail-"));

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo" });
    const result = spawnSandboxCli(fixture, tmpDir, ["rebuild", "--quiet"], {
      DOCKER_EXIT_FOR_BUILD: "1"
    });

    assert.notEqual(result.status, 0);
    assert.equal(
      `${result.stdout}\n${result.stderr}`.includes("Build-step proxy inheritance is enabled"),
      false,
      "expected a build failure without -B to omit build-proxy guidance"
    );
    assert.equal(
      fixture.readDockerCalls().some((call) => call[0] === "image" && call[1] === "prune"),
      false
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox rebuild forwards refresh flags to docker build", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-rebuild-refresh-"));

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo" });

    const result = spawnSandboxCli(fixture, tmpDir, ["rebuild", "--refresh", "--quiet"]);
    const buildCall = fixture.readDockerCalls().find((call) => call[0] === "build");

    assert.equal(result.status, 0, result.stderr);
    assert.ok(buildCall, "expected sandbox rebuild to call docker build");
    assert.ok(buildCall.includes("--no-cache"), "expected docker build to receive --no-cache");
    assert.ok(buildCall.includes("--pull"), "expected docker build to receive --pull");
    assert.ok(
      buildCall.some((arg) => /^demo\.sandbox\.last-refresh=\d+$/.test(arg)),
      "expected docker build to receive last-refresh label"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox rebuild preserves last refresh label without refresh", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-rebuild-preserve-refresh-"));

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, {
      project: "demo",
      dockerLabelsForInspect: {
        "demo.sandbox.last-refresh": "1234"
      }
    });

    const result = spawnSandboxCli(fixture, tmpDir, ["rebuild", "--quiet"], {
      DOCKER_EXIT_FOR_IMAGE_INSPECT: "0"
    });
    const buildCall = fixture.readDockerCalls().find((call) => call[0] === "build");

    assert.equal(result.status, 0, result.stderr);
    assert.ok(buildCall, "expected sandbox rebuild to call docker build");
    assert.equal(buildCall.includes("--no-cache"), false);
    assert.equal(buildCall.includes("--pull"), false);
    assert.ok(buildCall.includes("demo.sandbox.last-refresh=1234"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox rebuild succeeds when an old image exists and rmi would fail", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-rebuild-no-rmi-"));

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo" });

    const result = spawnSandboxCli(fixture, tmpDir, ["rebuild", "--quiet"], {
      DOCKER_EXIT_FOR_IMAGE_INSPECT: "0",
      DOCKER_EXIT_FOR_RMI: "1"
    });

    assert.equal(
      result.status,
      0,
      `expected rebuild to succeed even when old image exists and rmi would fail; stderr=${result.stderr}`
    );
    const dockerCalls = fixture.readDockerCalls();
    const rmiCalls = dockerCalls.filter((call) => call[0] === "rmi");
    assert.deepEqual(rmiCalls, [], "expected sandbox rebuild not to call docker rmi");
    assert.ok(
      dockerCalls.some((call) => call[0] === "build"),
      "expected sandbox rebuild to still call docker build"
    );
    assert.ok(
      dockerCalls.some((call) => call[0] === "image" && call[1] === "prune"),
      "expected sandbox rebuild to still call docker image prune"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox rebuild prunes project-scoped dangling images after build", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-rebuild-prune-"));

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo" });

    const result = spawnSandboxCli(fixture, tmpDir, ["rebuild", "--quiet"]);

    assert.equal(result.status, 0, result.stderr);
    const dockerCalls = fixture.readDockerCalls();
    const buildIndex = dockerCalls.findIndex((call) => call[0] === "build");
    const pruneIndex = dockerCalls.findIndex(
      (call) => call[0] === "image" && call[1] === "prune"
    );
    const pruneCall = pruneIndex >= 0 ? dockerCalls[pruneIndex] : undefined;

    assert.ok(pruneCall, "expected sandbox rebuild to call docker image prune");
    assert.ok(pruneCall.includes("-f"), "expected docker image prune to be non-interactive (-f)");
    const filterIndex = pruneCall.indexOf("--filter");
    assert.ok(filterIndex >= 0, "expected docker image prune to use --filter");
    assert.equal(
      pruneCall[filterIndex + 1],
      "label=demo.sandbox",
      "expected docker image prune filter to scope to this project's sandbox label"
    );
    assert.ok(
      buildIndex >= 0 && pruneIndex > buildIndex,
      "expected docker image prune to run after docker build"
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

test("sandbox create fails before image inspection when BuildKit is unavailable", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-create-buildkit-"));

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, {
      project: "demo",
      sandbox: { tools: ["codex"] }
    });
    const result = spawnSandboxCli(
      fixture,
      tmpDir,
      ["create", "feature-x", "--cpu", "1", "--memory", "1"],
      { DOCKER_EXIT_FOR_BUILDX_INSPECT: "1" }
    );
    const dockerCalls = fixture.readDockerCalls();

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /docker buildx inspect --bootstrap/);
    assert.ok(dockerCalls.some((call) => call[0] === "buildx" && call[1] === "inspect"));
    assert.equal(dockerCalls.some((call) => call[0] === "image" && call[1] === "inspect"), false);
    assert.equal(dockerCalls.some((call) => call[0] === "build"), false);
    assert.equal(dockerCalls.some((call) => call[0] === "run"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox create refreshes stale image before docker run", onPlatforms("linux", "darwin", "win32"), async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-create-refresh-due-"));

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, {
      project: "demo",
      sandbox: { tools: ["codex"] }
    });
    const signature = await sandboxImageSignature(fixture.repoDir);

    spawnSandboxCli(
      fixture,
      tmpDir,
      ["create", "feature-x", "--cpu", "1", "--memory", "1"],
      {
        DOCKER_EXIT_FOR_IMAGE_INSPECT: "0",
        DOCKER_LABELS_FOR_IMAGE_INSPECT: JSON.stringify({
          "demo.sandbox.image-config": signature,
          "demo.sandbox.last-refresh": "0"
        }),
        DOCKER_EXIT_FOR_RUN: "1"
      },
      { timeout: 5_000 }
    );

    const dockerCalls = fixture.readDockerCalls();
    const buildCall = dockerCalls.find((call) => call[0] === "build");

    assert.ok(buildCall, "expected sandbox create to refresh stale image");
    assert.ok(buildCall.includes("--no-cache"), "expected refresh build to receive --no-cache");
    assert.ok(buildCall.includes("--pull"), "expected refresh build to receive --pull");
    assert.ok(
      buildCall.some((arg) => /^demo\.sandbox\.last-refresh=\d+$/.test(arg)),
      "expected refresh build to write last-refresh label"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox create skips due refresh with CLI flag", onPlatforms("linux", "darwin", "win32"), async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-create-no-refresh-"));

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, {
      project: "demo",
      sandbox: { tools: ["codex"] }
    });
    const signature = await sandboxImageSignature(fixture.repoDir);

    spawnSandboxCli(
      fixture,
      tmpDir,
      ["create", "feature-x", "--cpu", "1", "--memory", "1", "--no-refresh"],
      {
        DOCKER_EXIT_FOR_IMAGE_INSPECT: "0",
        DOCKER_LABELS_FOR_IMAGE_INSPECT: JSON.stringify({
          "demo.sandbox.image-config": signature,
          "demo.sandbox.last-refresh": "0"
        }),
        DOCKER_EXIT_FOR_RUN: "1"
      },
      { timeout: 5_000 }
    );

    assert.equal(
      fixture.readDockerCalls().some((call) => call[0] === "build"),
      false,
      "expected --no-refresh to skip due refresh build"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox create continues when due refresh build fails", onPlatforms("linux", "darwin", "win32"), async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-create-refresh-fail-"));

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, {
      project: "demo",
      sandbox: { tools: ["codex"] }
    });
    fs.writeFileSync(path.join(fixture.repoDir, "README.md"), "fixture\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: fixture.repoDir, env: gitSafeEnv(), stdio: "pipe" });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"],
      { cwd: fixture.repoDir, env: gitSafeEnv(), stdio: "pipe" }
    );
    const signature = await sandboxImageSignature(fixture.repoDir);

    const result = spawnSandboxCli(
      fixture,
      tmpDir,
      ["create", "feature-x", "--cpu", "1", "--memory", "1"],
      {
        DOCKER_EXIT_FOR_IMAGE_INSPECT: "0",
        DOCKER_LABELS_FOR_IMAGE_INSPECT: JSON.stringify({
          "demo.sandbox.image-config": signature,
          "demo.sandbox.last-refresh": "0"
        }),
        DOCKER_EXIT_FOR_BUILD: "1",
        DOCKER_EXIT_FOR_RUN: "1"
      }
    );

    const dockerCalls = fixture.readDockerCalls();
    assert.ok(dockerCalls.some((call) => call[0] === "build"), "expected due refresh build attempt");
    assert.ok(dockerCalls.some((call) => call[0] === "run"), "expected create to continue to docker run");
    assert.equal(
      `${result.stdout}\n${result.stderr}`.includes("Build-step proxy inheritance is enabled"),
      false,
      "expected a build failure without -B to omit build-proxy guidance"
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

test("opencode tool pins XDG roots inside its sandbox volume", async () => {
  const sandboxTools = await loadFreshEsm<typeof import("../../../lib/sandbox/tools.ts")>("lib/sandbox/tools.js");
  const tools = sandboxTools.resolveTools({
    home: "/home/host-user",
    project: "demo",
    tools: ["opencode"]
  });

  assert.equal(tools.length, 1);
  const tool = required(tools[0]);
  assert.equal(tool.containerMount, "/home/devuser/.local/share/opencode");
  assert.deepEqual(tool.envVars, {
    XDG_DATA_HOME: "/home/devuser/.local/share",
    XDG_CONFIG_HOME: "/home/devuser/.local/share/opencode/.xdg/config",
    XDG_STATE_HOME: "/home/devuser/.local/share/opencode/.xdg/state"
  });
});

test("antigravity-cli tool preseeds keybindings and MCP config without host settings", async () => {
  const sandboxTools = await loadFreshEsm<typeof import("../../../lib/sandbox/tools.ts")>("lib/sandbox/tools.js");
  const [maybeTool] = sandboxTools.resolveTools({
    home: "/home/host-user",
    project: "demo",
    tools: ["antigravity-cli"]
  });

  const tool = required(maybeTool);
  assert.deepEqual(tool.hostPreSeedFiles, [
    {
      hostPath: "/home/host-user/.gemini/antigravity-cli/keybindings.json",
      sandboxName: "antigravity-cli/keybindings.json"
    },
    {
      hostPath: "/home/host-user/.gemini/config/mcp_config.json",
      sandboxName: "config/mcp_config.json"
    }
  ]);
});

test("agent-infra tool exposes the ai CLI without credentials or tmpfs state", async () => {
  const sandboxTools = await loadFreshEsm<typeof import("../../../lib/sandbox/tools.ts")>("lib/sandbox/tools.js");
  const [maybeTool] = sandboxTools.resolveTools({
    home: "/home/host-user",
    project: "demo",
    tools: ["agent-infra"]
  });

  const tool = required(maybeTool);
  assert.equal(tool.id, "agent-infra");
  assert.equal(tool.install.type, "npm");
  assert.equal(tool.install.cmd, "@fitlab-ai/agent-infra@latest");
  assert.equal(tool.sandboxBase, "/home/host-user/.agent-infra/sandboxes/agent-infra");
  assert.equal(tool.containerMount, "/home/devuser/.agent-infra-cli");
  assert.equal(tool.versionCmd, "ai version --raw");
  assert.equal(tool.tmpfs, undefined);
  assert.equal(tool.hostLiveMounts, undefined);
  assert.equal(tool.hostPreSeedFiles, undefined);
  assert.equal(tool.hostPreSeedDirs, undefined);
});

test("resolveTools consolidates sandbox bases under ~/.agent-infra", async () => {
  const sandboxTools = await loadFreshEsm<typeof import("../../../lib/sandbox/tools.ts")>("lib/sandbox/tools.js");
  const tools = sandboxTools.resolveTools({
    home: "/home/host-user",
    project: "demo",
    tools: ["agent-infra", "claude-code", "codex", "antigravity-cli", "opencode"]
  });

  assert.deepEqual(tools.map((tool) => ({
    id: tool.id,
    sandboxBase: tool.sandboxBase
  })), [
    {
      id: "agent-infra",
      sandboxBase: "/home/host-user/.agent-infra/sandboxes/agent-infra"
    },
    {
      id: "claude-code",
      sandboxBase: "/home/host-user/.agent-infra/sandboxes/claude-code"
    },
    {
      id: "codex",
      sandboxBase: "/home/host-user/.agent-infra/sandboxes/codex"
    },
    {
      id: "antigravity-cli",
      sandboxBase: "/home/host-user/.agent-infra/sandboxes/antigravity-cli"
    },
    {
      id: "opencode",
      sandboxBase: "/home/host-user/.agent-infra/sandboxes/opencode"
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

test("codex tool declares a tmpfs mount so its high-churn logs stay in RAM", async () => {
  const sandboxTools = await loadFreshEsm<typeof import("../../../lib/sandbox/tools.ts")>("lib/sandbox/tools.js");
  const [maybeTool] = sandboxTools.resolveTools({
    home: "/home/host-user",
    project: "demo",
    tools: ["codex"]
  });

  assert.deepEqual(required(maybeTool).tmpfs, { size: "512m", seed: ["config.toml", "model-catalogs"] });
});

test("non-tmpfs builtin tools leave the tmpfs field unset", async () => {
  const sandboxTools = await loadFreshEsm<typeof import("../../../lib/sandbox/tools.ts")>("lib/sandbox/tools.js");
  const [maybeTool] = sandboxTools.resolveTools({
    home: "/home/host-user",
    project: "demo",
    tools: ["claude-code"]
  });

  assert.equal(required(maybeTool).tmpfs, undefined);
});

test("parseCustomTool accepts a tmpfs object and rejects malformed tmpfs", async () => {
  const sandboxTools = await loadFreshEsm<typeof import("../../../lib/sandbox/tools.ts")>("lib/sandbox/tools.js");

  const parsed = sandboxTools.parseCustomTool(
    { id: "ram-tool", install: { type: "shell", cmd: "echo hi" }, tmpfs: { size: "256m", seed: ["config.toml"] } },
    0,
    { home: "/home/host-user" }
  );
  assert.deepEqual(parsed.tmpfs, { size: "256m", seed: ["config.toml"] });

  assert.throws(
    () => sandboxTools.parseCustomTool(
      { id: "ram-tool", install: { type: "shell", cmd: "echo hi" }, tmpfs: "512m" },
      0,
      { home: "/home/host-user" }
    ),
    /"tmpfs" must be an object/
  );

  assert.throws(
    () => sandboxTools.parseCustomTool(
      { id: "ram-tool", install: { type: "shell", cmd: "echo hi" }, tmpfs: { size: "" } },
      0,
      { home: "/home/host-user" }
    ),
    /"tmpfs.size" must be non-empty/
  );
});

test("buildTmpfsRunArgs emits a sized --tmpfs flag for the container mount", async () => {
  const create = await loadFreshEsm<typeof import("../../../lib/sandbox/commands/create.ts")>("lib/sandbox/commands/create.js");

  assert.deepEqual(
    create.buildTmpfsRunArgs("/home/devuser/.codex", { size: "512m" }),
    ["--tmpfs", "/home/devuser/.codex:rw,size=512m"]
  );
  // Missing size falls back to the 512m default.
  assert.deepEqual(
    create.buildTmpfsRunArgs("/home/devuser/.codex", {}),
    ["--tmpfs", "/home/devuser/.codex:rw,size=512m"]
  );
});
