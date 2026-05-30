import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as toml from "smol-toml";

import {
  assertModeBits,
  cliArgs,
  envWithPrependedPath,
  filePath,
  gitSafeEnv,
  loadFreshEsm,
  onPlatforms,
  withGitSafeProcessEnv,
  writeSandboxEngineFixture
} from "../helpers.ts";
import { restoreTerminal, runInteractive, runVerbose } from "../../lib/sandbox/shell.ts";

type WriteCallback = (error?: Error | null) => void;
type DotfilesModule = {
  dotfilesCacheDir(home: string, project: string): string;
  materializeDotfiles(
    srcDir: string,
    cacheDir: string,
    options?: { writeStderr?: (chunk: string) => void } & Record<string, unknown>
  ): { cacheDir: string; warnings: Array<{ rel: string; reason: string }> } | null;
};
type SymlinkKind = "file" | "dir" | "junction";
type FakeSelinuxFs = {
  reads: number;
  readFileSync(pathname: string, encoding: BufferEncoding): string;
};
type CommandOptions = Record<string, unknown> & {
  env?: NodeJS.ProcessEnv;
  input?: Buffer | string;
  encoding?: BufferEncoding;
  stdio?: unknown;
};
type CommandCall = [cmd: string, args: string[], options?: CommandOptions];
type EngineCommandCall = [engine: string, cmd: string, args: string[], options?: CommandOptions];
type VerboseCall = {
  type: "run" | "verbose";
  engine?: string;
  cmd: string;
  args: string[];
  opts?: CommandOptions;
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
};
type AdapterModule<T extends string> = Record<`${T}Adapter`, SandboxAdapterFixture>;
type SandboxVmConfigFixture = { cpu?: number | null; memory?: number | null; disk?: number | null };
type SandboxResourceConfig = Record<string, unknown> & {
  vm?: SandboxVmConfigFixture;
  userVm?: SandboxVmConfigFixture;
  hasUserVmConfig?: (vm: SandboxVmConfigFixture | undefined) => boolean;
};
type SandboxAdapterFixture = {
  id: string;
  displayName: string;
  supportedPlatforms: string[];
  dockerContext: string | null;
  managed: boolean;
  canApplyResources: "hot" | "on-start" | "never";
  defaultResources(getHost?: () => { cpu: number; memory: number }): Record<string, number | null> | null;
  ensure(config?: SandboxResourceConfig, onMessage?: (message: string) => void, runFns?: Record<string, unknown>): Promise<boolean>;
  startVm(config?: SandboxResourceConfig, onMessage?: (message: string) => void, runFns?: Record<string, unknown>): string;
  stopVm(): never;
  syncResources(config?: SandboxResourceConfig, onMessage?: (message: string) => void, runFns?: Record<string, unknown>, options?: Record<string, unknown>): void;
};
type SandboxEngineModule = {
  detectEngine(config?: Record<string, unknown>, deps?: Record<string, unknown>): string;
  validateSandboxEngine(engine: string | null | undefined, deps?: Record<string, unknown>): string | null;
  hasUserVmConfig(vm?: Record<string, unknown>): boolean;
  resolveEffectiveVm(adapter: Record<string, unknown>, userVm?: Record<string, unknown>, deps?: Record<string, unknown>): Record<string, unknown>;
  ensureDocker(config: Record<string, unknown>, onMessage: ((message: string) => void) | null, deps?: Record<string, unknown>): Promise<void>;
  startManagedVm(config: Record<string, unknown>, deps?: Record<string, unknown>): string;
  stopManagedVm(config: Record<string, unknown>, deps?: Record<string, unknown>): string;
  isVmManaged(config?: Record<string, unknown>, deps?: Record<string, unknown>): boolean;
  engineDisplayName(engine: string): string;
};
type EnginesIndexModule = {
  ADAPTERS: Record<string, SandboxAdapterFixture>;
  enginesForPlatform(platformName: string): string[];
};
type NativeModule = AdapterModule<"native"> & {
  isRootlessDocker(options: Record<string, unknown>): boolean;
};
type RebuildModule = {
  buildArgs(config: Record<string, unknown>, tools: Array<Record<string, unknown>>, dockerfilePath: string, imageSignature: string, deps?: Record<string, unknown>): string[];
};
type Wsl2PathsModule = {
  hostJoin(basePath: string, ...segments: string[]): string;
  isWindowsDrivePath(value: unknown): boolean;
  isUncPath(value: unknown): boolean;
  windowsPathToWslPath(value: string): string;
  toEnginePath(engine: string, value: string): string;
  volumeArg(engine: string, hostPath: string, containerPath: string, suffix?: string, options?: {
    selinux?: "shared" | "none";
    fs?: FakeSelinuxFs;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  }): string;
};

function required<T>(value: T | undefined, message = "expected value"): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

function assertError(error: unknown): Error {
  assert.ok(error instanceof Error);
  return error;
}

function restoreDockerContext(previousValue: string | undefined) {
  if (previousValue === undefined) {
    delete process.env.DOCKER_CONTEXT;
  } else {
    process.env.DOCKER_CONTEXT = previousValue;
  }
}

function withTTY<T>(value: boolean, fn: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

  try {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
    return fn();
  } finally {
    if (descriptor) {
      Object.defineProperty(process.stdout, "isTTY", descriptor);
    } else {
      delete (process.stdout as Partial<typeof process.stdout>).isTTY;
    }
  }
}

function captureStdoutWrite(fn: () => void): string {
  const originalWrite = process.stdout.write;
  let output = "";

  try {
    process.stdout.write = ((chunk: string | Uint8Array, ...args: Array<string | BufferEncoding | WriteCallback>) => {
      output += String(chunk);
      const callback = args.find((arg): arg is WriteCallback => typeof arg === "function");
      callback?.();
      return true;
    }) as typeof process.stdout.write;
    fn();
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
}

function makeDotfilesFixture(prefix: string = "agent-infra-materialize-dotfiles-") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const srcDir = path.join(tmpDir, "src");
  const cacheDir = path.join(tmpDir, "cache");
  const externalDir = path.join(tmpDir, "external");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(externalDir, { recursive: true });
  return { tmpDir, srcDir, cacheDir, externalDir };
}

function trySymlink(target: string, linkPath: string, type: SymlinkKind) {
  try {
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (typeof code === "string" && ["EPERM", "EACCES", "ENOTSUP"].includes(code)) {
      return false;
    }
    throw error;
  }
}

function symlinkType(type: "file" | "dir"): SymlinkKind {
  if (type === "dir" && process.platform === "win32") {
    return "junction";
  }
  return type;
}

function readMaterializeResult(sandboxDotfiles: DotfilesModule, srcDir: string, cacheDir: string, options: Record<string, unknown> = {}) {
  const stderrChunks: string[] = [];
  const result = sandboxDotfiles.materializeDotfiles(srcDir, cacheDir, {
    writeStderr: (chunk) => stderrChunks.push(chunk),
    ...options
  });
  assert.ok(result);
  return { result, stderr: stderrChunks.join("") };
}

function withFakeStty<T>(exitCode: number, fn: () => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-fake-stty-"));
  const sttyPath = path.join(tmpDir, "stty");
  const previousPath = process.env.PATH;

  try {
    fs.writeFileSync(
      sttyPath,
      `#!/bin/sh\nexit ${exitCode}\n`,
      "utf8"
    );
    fs.chmodSync(sttyPath, 0o755);
    process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ""}`;
    return fn();
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function fakeSelinuxFs(flag: string): FakeSelinuxFs {
  return {
    reads: 0,
    readFileSync(pathname: string, encoding: BufferEncoding) {
      assert.equal(pathname, "/sys/fs/selinux/enforce");
      assert.equal(encoding, "utf8");
      this.reads += 1;
      return flag;
    }
  };
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

test("runInteractive emits terminal reset on normal exit", () => {
  const output = withFakeStty(0, () => withTTY(true, () => captureStdoutWrite(() => {
    const status = runInteractive(process.execPath, ["-e", "process.exit(0)"]);

    assert.equal(status, 0);
  })));

  assert.match(output, /\x1b\[\?1049l/);
  assert.match(output, /\x1b\[\?25h/);
  assert.match(output, /\x1b>/);
  assert.match(output, /\x1b\[\?1006l/);
});

test("runInteractive emits terminal reset on non-zero exit", () => {
  const output = withFakeStty(0, () => withTTY(true, () => captureStdoutWrite(() => {
    const status = runInteractive(process.execPath, ["-e", "process.exit(7)"]);

    assert.equal(status, 7);
  })));

  assert.match(output, /\x1b\[\?1049l/);
});

test("runInteractive emits terminal reset when spawn fails", () => {
  const output = withFakeStty(0, () => withTTY(true, () => captureStdoutWrite(() => {
    const status = runInteractive("agent-infra-missing-command", []);

    assert.notEqual(status, 0);
    assert.equal(status, 1);
  })));

  assert.match(output, /\x1b\[\?1049l/);
});

test("restoreTerminal is a no-op when stdout is not a TTY", () => {
  const output = withTTY(false, () => captureStdoutWrite(() => {
    restoreTerminal();
  }));

  assert.equal(output, "");
});

test("restoreTerminal does not throw when stty is unavailable", onPlatforms("linux", "darwin"), () => {
  const output = withFakeStty(1, () => withTTY(true, () => captureStdoutWrite(() => {
    assert.doesNotThrow(() => restoreTerminal());
  })));

  assert.match(output, /\x1b\[\?1049l/);
});

test("agent-infra sandbox help is wired into the main CLI", () => {
  const output = execFileSync(process.execPath, cliArgs("sandbox", "--help"), {
    encoding: "utf8"
  });

  assert.match(output, /Usage: ai sandbox <command> \[options\]/);
  assert.match(output, /create <branch> \[base\]/);
  assert.match(output, /^\s+refresh\s+Sync host Claude Code credentials/m);
  assert.match(output, /rebuild \[--quiet\]/);
});

test("sandbox create help documents the host aliases file", () => {
  const output = execFileSync(process.execPath, cliArgs("sandbox", "create", "--help"), {
    encoding: "utf8"
  });

  assert.match(output, /Usage: ai sandbox create <branch> \[base\] \[--cpu <n>\] \[--memory <n>\]/);
  assert.match(output, /~\/\.agent-infra\/aliases\/sandbox\.sh/);
  assert.match(output, /\/home\/devuser\/\.bash_aliases/);
});

test("sandbox create rejects invalid selinux disable environment before loading config", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const previousValue = process.env.AGENT_INFRA_SELINUX_DISABLE;

  try {
    process.env.AGENT_INFRA_SELINUX_DISABLE = "invalid";
    await assert.rejects(
      () => sandboxCreate.create(["feature/selinux-invalid-env"]),
      /Invalid AGENT_INFRA_SELINUX_DISABLE/
    );
  } finally {
    if (previousValue === undefined) {
      delete process.env.AGENT_INFRA_SELINUX_DISABLE;
    } else {
      process.env.AGENT_INFRA_SELINUX_DISABLE = previousValue;
    }
  }
});

test("sandbox rm defaults local branch deletion confirmation to yes", () => {
  const commandSource = fs.readFileSync(filePath("lib/sandbox/commands/rm.js"), "utf8");

  assert.match(
    commandSource,
    /const shouldDeleteBranch = await p\.confirm\(\{[\s\S]*?message: `Also delete local branch '\$\{effectiveBranch\}'\?`,[\s\S]*?initialValue: true[\s\S]*?\}\);/
  );
});

test("sandbox create warns and continues past missing Claude credentials", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-create-no-credentials-"));
  const project = `sandbox-no-leak-${process.pid}-${Date.now()}`;
  const dockerfilePrefix = `${project}-sandbox-`;
  const existingEntries = new Set(
    fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(dockerfilePrefix))
  );

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project });

    const result = spawnSandboxCli(
      fixture,
      tmpDir,
      ["create", "feature/no-credentials"],
      {
        // Fail at ensureDocker (the first docker call) so the test exits
        // quickly on slow CI runners (e.g. Windows). The credential gate
        // runs before ensureDocker, so a missing claude credential will
        // emit its warning to stderr first.
        DOCKER_EXIT_FOR_INFO: "1",
        AGENT_INFRA_CLAUDE_CREDENTIALS_FILE: path.join(tmpDir, "missing-claude-credentials.json")
      }
    );

    assert.equal(result.signal, null);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /WITHOUT Claude Code credentials/);

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

test("sandbox vm stop warns instead of stopping when OrbStack is not running", onPlatforms("darwin", "linux"), async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-vm-stop-orb-"));
  const repoDir = path.join(tmpDir, "repo");
  const binDir = path.join(tmpDir, "bin");
  const orbPath = path.join(binDir, "orb");
  const orbLogPath = path.join(tmpDir, "orb-log.txt");
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  try {
    fs.mkdirSync(path.join(repoDir, ".agents"), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    execSync("git init", { cwd: repoDir, env: gitSafeEnv(), stdio: "pipe" });
    fs.writeFileSync(
      path.join(repoDir, ".agents", ".airc.json"),
      JSON.stringify({
        project: "demo",
        sandbox: { engine: "orbstack" }
      }, null, 2) + "\n",
      "utf8"
    );
    fs.writeFileSync(
      orbPath,
      `#!/bin/sh
set -eu
printf '%s\\n' "$1" >> "$ORB_LOG_PATH"
if [ "$1" = "status" ]; then
  exit 1
fi
exit 0
`,
      "utf8"
    );
    fs.chmodSync(orbPath, 0o755);

    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    process.chdir(repoDir);
    process.env = {
      ...envWithPrependedPath(gitSafeEnv(), binDir),
      HOME: tmpDir,
      ORB_LOG_PATH: orbLogPath
    };

    const sandboxVm = await loadFreshEsm<typeof import("../../lib/sandbox/commands/vm.ts")>("lib/sandbox/commands/vm.js");
    await sandboxVm.vm(["stop"]);

    assert.deepEqual(fs.readFileSync(orbLogPath, "utf8").trim().split("\n"), ["status"]);
  } finally {
    process.chdir(previousCwd);
    process.env = previousEnv;
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig derives sandbox defaults from .agents/.airc.json", async () => {
  const sandboxConfig = await loadFreshEsm<typeof import("../../lib/sandbox/config.ts")>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-config-"));
  const previousCwd = process.cwd();

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    fs.mkdirSync(path.join(tmpDir, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".agents", ".airc.json"),
      JSON.stringify({ project: "demo", org: "fitlab-ai" }, null, 2) + "\n",
      "utf8"
    );

    process.chdir(tmpDir);
    const config = withGitSafeProcessEnv(() => sandboxConfig.loadConfig());

    assert.equal(config.project, "demo");
    assert.equal(config.org, "fitlab-ai");
    assert.equal(config.containerPrefix, "demo-dev");
    assert.equal(config.imageName, "demo-sandbox:latest");
    assert.deepEqual(config.runtimes, ["node22"]);
    assert.deepEqual(config.tools, ["claude-code", "codex", "gemini-cli", "opencode"]);
    assert.equal(config.engine, null);
    assert.deepEqual(config.vm, { cpu: null, memory: null, disk: null });
    assert.equal(config.worktreeBase, path.join(process.env.HOME ?? "", ".agent-infra", "worktrees", "demo"));
    assert.equal(config.shareBase, path.join(process.env.HOME ?? "", ".agent-infra", "share", "demo"));
    assert.equal(config.dotfilesDir, path.join(process.env.HOME ?? "", ".agent-infra", "dotfiles"));
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("dotfilesCacheDir returns project-scoped cache path under .agent-infra cache", async () => {
  const sandboxDotfiles = await loadFreshEsm<typeof import("../../lib/sandbox/dotfiles.ts")>("lib/sandbox/dotfiles.js");

  assert.equal(
    sandboxDotfiles.dotfilesCacheDir("/home/u", "demo"),
    "/home/u/.agent-infra/.cache/dotfiles-resolved/demo"
  );
});

test("loadConfig preserves configured sandbox engine", async () => {
  const sandboxConfig = await loadFreshEsm<typeof import("../../lib/sandbox/config.ts")>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-engine-config-"));
  const previousCwd = process.cwd();

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    fs.mkdirSync(path.join(tmpDir, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".agents", ".airc.json"),
      JSON.stringify({
        project: "demo",
        org: "fitlab-ai",
        sandbox: { engine: "docker-desktop" }
      }, null, 2) + "\n",
      "utf8"
    );

    process.chdir(tmpDir);
    const config = withGitSafeProcessEnv(() => sandboxConfig.loadConfig());

    assert.equal(config.engine, "docker-desktop");
    assert.deepEqual(config.runtimes, ["node22"]);
    assert.deepEqual(config.vm, { cpu: null, memory: null, disk: null });
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig preserves configured darwin-only sandbox engine with platform context", async () => {
  const sandboxConfig = await loadFreshEsm<typeof import("../../lib/sandbox/config.ts")>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-engine-darwin-"));
  const previousCwd = process.cwd();

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    fs.mkdirSync(path.join(tmpDir, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".agents", ".airc.json"),
      JSON.stringify({
        project: "demo",
        org: "fitlab-ai",
        sandbox: { engine: "orbstack" }
      }, null, 2) + "\n",
      "utf8"
    );

    process.chdir(tmpDir);
    const config = withGitSafeProcessEnv(() => sandboxConfig.loadConfig({ platformFn: () => "darwin" }));

    assert.equal(config.engine, "orbstack");
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects unsupported sandbox engine values", async () => {
  const sandboxConfig = await loadFreshEsm<typeof import("../../lib/sandbox/config.ts")>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-engine-invalid-"));
  const previousCwd = process.cwd();

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    fs.mkdirSync(path.join(tmpDir, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".agents", ".airc.json"),
      JSON.stringify({
        project: "demo",
        sandbox: { engine: "podman" }
      }, null, 2) + "\n",
      "utf8"
    );

    process.chdir(tmpDir);

    assert.throws(
      () => withGitSafeProcessEnv(() => sandboxConfig.loadConfig()),
      /invalid "sandbox\.engine" value "podman".*unknown sandbox engine.*Valid engines:.*colima.*orbstack.*docker-desktop.*native.*wsl2/s
    );
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig fails when .agents/.airc.json is missing", async () => {
  const sandboxConfig = await loadFreshEsm<typeof import("../../lib/sandbox/config.ts")>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-missing-config-"));
  const previousCwd = process.cwd();

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    process.chdir(tmpDir);
    assert.throws(
      () => withGitSafeProcessEnv(() => sandboxConfig.loadConfig()),
      /No \.agents\/\.airc\.json found/
    );
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("findRuntimeEngineMismatches reports node runtime engine conflicts", async () => {
  const runtimeEngines = await loadFreshEsm<typeof import("../../lib/sandbox/runtime-engines.ts")>("lib/sandbox/runtime-engines.js");

  assert.deepEqual(runtimeEngines.findRuntimeEngineMismatches(["node20"], ">=22"), [
    { runtimes: ["node20"], enginesNode: ">=22" }
  ]);
  assert.deepEqual(runtimeEngines.findRuntimeEngineMismatches(["node22"], ">=22"), []);
  assert.deepEqual(runtimeEngines.findRuntimeEngineMismatches(["node20", "node22"], ">=22"), []);
  assert.deepEqual(runtimeEngines.findRuntimeEngineMismatches(["node18", "node20"], ">=22"), [
    { runtimes: ["node18", "node20"], enginesNode: ">=22" }
  ]);
  assert.deepEqual(runtimeEngines.findRuntimeEngineMismatches(["node20"], ">=20"), []);
  assert.deepEqual(runtimeEngines.findRuntimeEngineMismatches(["node20"], "20 || 22"), []);
  assert.deepEqual(runtimeEngines.findRuntimeEngineMismatches(["node20"], undefined), []);
  assert.deepEqual(runtimeEngines.findRuntimeEngineMismatches(["node20"], "not-a-range"), []);
  assert.deepEqual(runtimeEngines.findRuntimeEngineMismatches(["java21", "python3"], ">=22"), []);
});

test("loadConfig warns when sandbox node runtime does not satisfy package engines", async () => {
  const sandboxConfig = await loadFreshEsm<typeof import("../../lib/sandbox/config.ts")>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-engine-mismatch-"));
  const previousCwd = process.cwd();
  const stderr: string[] = [];

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ engines: { node: ">=22" } }, null, 2) + "\n",
      "utf8"
    );
    fs.mkdirSync(path.join(tmpDir, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".agents", ".airc.json"),
      JSON.stringify({
        project: "demo",
        org: "fitlab-ai",
        sandbox: { runtimes: ["node20"] }
      }, null, 2) + "\n",
      "utf8"
    );

    process.chdir(tmpDir);
    const config = withGitSafeProcessEnv(() => sandboxConfig.loadConfig({
      writeStderr: (chunk) => stderr.push(chunk)
    }));

    assert.deepEqual(config.runtimes, ["node20"]);
    assert.match(stderr.join(""), /sandbox runtimes "node20" do not satisfy this project's package\.json "engines\.node" \(">=22"\)/);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig does not warn when sandbox node runtime satisfies package engines", async () => {
  const sandboxConfig = await loadFreshEsm<typeof import("../../lib/sandbox/config.ts")>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-engine-match-"));
  const previousCwd = process.cwd();
  const stderr: string[] = [];

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ engines: { node: ">=22" } }, null, 2) + "\n",
      "utf8"
    );
    fs.mkdirSync(path.join(tmpDir, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".agents", ".airc.json"),
      JSON.stringify({
        project: "demo",
        sandbox: { runtimes: ["node22"] }
      }, null, 2) + "\n",
      "utf8"
    );

    process.chdir(tmpDir);
    const config = withGitSafeProcessEnv(() => sandboxConfig.loadConfig({
      writeStderr: (chunk) => stderr.push(chunk)
    }));

    assert.deepEqual(config.runtimes, ["node22"]);
    assert.equal(stderr.join(""), "");
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig skips runtime engine warnings for invalid package json", async () => {
  const sandboxConfig = await loadFreshEsm<typeof import("../../lib/sandbox/config.ts")>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-invalid-package-"));
  const previousCwd = process.cwd();
  const stderr: string[] = [];

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{ not json", "utf8");
    fs.mkdirSync(path.join(tmpDir, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".agents", ".airc.json"),
      JSON.stringify({
        project: "demo",
        sandbox: { runtimes: ["node20"] }
      }, null, 2) + "\n",
      "utf8"
    );

    process.chdir(tmpDir);
    const config = withGitSafeProcessEnv(() => sandboxConfig.loadConfig({
      writeStderr: (chunk) => stderr.push(chunk)
    }));

    assert.deepEqual(config.runtimes, ["node20"]);
    assert.equal(stderr.join(""), "");
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig skips runtime engine warnings when a custom Dockerfile is configured", async () => {
  const sandboxConfig = await loadFreshEsm<typeof import("../../lib/sandbox/config.ts")>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-custom-dockerfile-"));
  const previousCwd = process.cwd();
  const stderr: string[] = [];

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ engines: { node: ">=22" } }, null, 2) + "\n",
      "utf8"
    );
    fs.writeFileSync(path.join(tmpDir, "Dockerfile"), "FROM node:20\n", "utf8");
    fs.mkdirSync(path.join(tmpDir, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".agents", ".airc.json"),
      JSON.stringify({
        project: "demo",
        sandbox: {
          dockerfile: "Dockerfile",
          runtimes: ["node20"]
        }
      }, null, 2) + "\n",
      "utf8"
    );

    process.chdir(tmpDir);
    const config = withGitSafeProcessEnv(() => sandboxConfig.loadConfig({
      writeStderr: (chunk) => stderr.push(chunk)
    }));

    assert.equal(config.dockerfile, "Dockerfile");
    assert.deepEqual(config.runtimes, ["node20"]);
    assert.equal(stderr.join(""), "");
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig uses os.homedir on Windows when HOME is unset", onPlatforms("win32"), async () => {
  const sandboxConfig = await loadFreshEsm<typeof import("../../lib/sandbox/config.ts")>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-userprofile-"));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    fs.mkdirSync(path.join(tmpDir, '.agents'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.agents', '.airc.json'),
      JSON.stringify({ project: 'test-project' }),
      'utf8'
    );
    process.chdir(tmpDir);
    delete process.env.HOME;
    process.env.USERPROFILE = tmpDir;

    const config = withGitSafeProcessEnv(() => sandboxConfig.loadConfig());
    assert.equal(config.home, tmpDir);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("composeDockerfile joins runtime fragments in order", async () => {
  const sandboxDockerfile = await loadFreshEsm<typeof import("../../lib/sandbox/dockerfile.ts")>("lib/sandbox/dockerfile.js");
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

// Intent: each package in AI_TOOL_PACKAGES gets its own `npm install -g <pkg>`
// invocation, so npm's batch-install path (which drops platform-specific
// optionalDependencies for `npm:` aliased packages — Issue #293) is not
// triggered. This is a behavior test: we execute the dockerfile's RUN body
// against a stubbed `npm` and a synthetic 3-package list, then assert each
// package was installed at least once. Form-agnostic — accepts `for` loops,
// `xargs -n1`, or any equivalent rewrite that preserves the semantic.
test("composeDockerfile installs each AI tool package separately", onPlatforms("linux", "darwin"), async () => {
  const sandboxDockerfile = await loadFreshEsm<typeof import("../../lib/sandbox/dockerfile.ts")>("lib/sandbox/dockerfile.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-ai-tools-loop-"));
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-npm-stub-"));

  try {
    const dockerfilePath = sandboxDockerfile.composeDockerfile({
      repoRoot: tmpDir,
      project: "demo",
      runtimes: ["node20"],
      dockerfile: null
    });
    const content = fs.readFileSync(dockerfilePath, "utf8");

    const runBlock = content
      .split(/^(?=FROM |USER |ENV |ARG |RUN |WORKDIR |CMD |COPY |ADD )/m)
      .find((block) => block.startsWith("RUN ") && block.includes("AI_TOOL_PACKAGES"));
    assert.ok(runBlock, "expected a RUN block consuming AI_TOOL_PACKAGES");

    const shellBody = runBlock.replace(/^RUN\s+/, "").replace(/\\\n\s*/g, " ").trim();

    const logFile = path.join(stubDir, "invocations.log");
    const npmStub = path.join(stubDir, "npm");
    fs.writeFileSync(npmStub, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logFile}"\n`, { mode: 0o755 });

    const packages = ["@acme/tool-a", "@acme/tool-b", "@acme/tool-c"];
    const result = spawnSync("/bin/sh", ["-c", shellBody], {
      env: {
        ...process.env,
        PATH: `${stubDir}:${process.env.PATH}`,
        AI_TOOL_PACKAGES: packages.join(" ")
      },
      encoding: "utf8"
    });

    assert.equal(result.status, 0, `RUN body exited non-zero: ${result.stderr}`);
    const invocations = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean)
      : [];
    const installedPackages = invocations
      .map((line) => line.match(/^install -g (\S+)$/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => required(match[1]));
    for (const pkg of packages) {
      const count = installedPackages.filter((p) => p === pkg).length;
      assert.ok(count >= 1, `expected ${pkg} to be installed by its own 'npm install -g <pkg>' invocation, got ${count} (invocations: ${JSON.stringify(invocations)})`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(stubDir, { recursive: true, force: true });
  }
});

test("composeDockerfile includes gh CLI and bash_aliases sourcing", async () => {
  const sandboxDockerfile = await loadFreshEsm<typeof import("../../lib/sandbox/dockerfile.ts")>("lib/sandbox/dockerfile.js");
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
    assert.match(content, /build-essential ca-certificates gnupg lsb-release/);
    assert.match(content, /curl wget git vim file/);
    assert.match(content, /apt-get install -y gh/);
    assert.match(content, /export GPG_TTY=\$\(tty\)/);
    assert.match(content, /\[ -f ~\/\.bash_aliases \] && \. ~\/\.bash_aliases/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("composeDockerfile installs tmux for in-container session recovery", async () => {
  const sandboxDockerfile = await loadFreshEsm<typeof import("../../lib/sandbox/dockerfile.ts")>("lib/sandbox/dockerfile.js");
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
    assert.match(content, /TMUX_VERSION=3\.6a/);
    assert.match(content, /apt-get purge -y pkg-config bison libevent-dev libncurses-dev/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("composeDockerfile bakes sandbox-tmux-entry script", async () => {
  const sandboxDockerfile = await loadFreshEsm<typeof import("../../lib/sandbox/dockerfile.ts")>("lib/sandbox/dockerfile.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-tmux-entry-"));

  try {
    const dockerfilePath = sandboxDockerfile.composeDockerfile({
      repoRoot: tmpDir,
      project: "demo",
      runtimes: ["node20"],
      dockerfile: null
    });
    const content = fs.readFileSync(dockerfilePath, "utf8");

    assert.match(content, /cat > \/usr\/local\/bin\/sandbox-tmux-entry <<'SCRIPT'/);
    assert.match(content, /chmod \+x \/usr\/local\/bin\/sandbox-tmux-entry/);
    assert.match(content, /command -v tmux/);
    assert.match(content, /tmux has-session -t "\$SESSION"/);
    assert.match(content, /tmux list-sessions -F '#\{session_name\} #\{session_attached\}'/);
    assert.match(content, /tmux kill-session -t "\$name"/);
    assert.match(content, /exec tmux new-session -t "\$SESSION"/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("composeDockerfile bakes sandbox-dotfiles-link script", async () => {
  const sandboxDockerfile = await loadFreshEsm<typeof import("../../lib/sandbox/dockerfile.ts")>("lib/sandbox/dockerfile.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-dotfiles-link-"));

  try {
    const dockerfilePath = sandboxDockerfile.composeDockerfile({
      repoRoot: tmpDir,
      project: "demo",
      runtimes: ["node20"],
      dockerfile: null
    });
    const content = fs.readFileSync(dockerfilePath, "utf8");

    assert.match(content, /cat > \/usr\/local\/bin\/sandbox-dotfiles-link <<'SCRIPT'/);
    assert.match(content, /chmod \+x \/usr\/local\/bin\/sandbox-dotfiles-link/);
    assert.match(content, /DOTFILES_SRC=\/dotfiles/);
    assert.match(content, /\[ -d "\$DOTFILES_SRC" \] \|\| exit 0/);
    assert.match(content, /find \. -type f -print/);
    assert.match(content, /\.ssh\|\.ssh\/\*/);
    assert.match(content, /\.gnupg\|\.gnupg\/\*/);
    assert.match(content, /\.config\/opencode\|\.config\/opencode\/\*/);
    assert.match(content, /\.gitconfig\|\.gitignore_global\|\.stCommitMsg\|\.bash_aliases/);
    assert.match(content, /mkdir -p "\$\(dirname "\$target"\)"/);
    assert.match(content, /\[ -d "\$target" \] && \[ ! -L "\$target" \]/);
    assert.match(content, /skipping %s \(existing directory; use nested path like %s\/<file> instead\)/);
    assert.match(content, /ln -sfn "\$DOTFILES_SRC\/\$rel" "\$target"/);
    assert.match(content, /printf 'sandbox-dotfiles-link: failed to link %s\\n' "\$target" >&2/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("composeDockerfile invokes sandbox-dotfiles-link from sandbox-tmux-entry", async () => {
  const sandboxDockerfile = await loadFreshEsm<typeof import("../../lib/sandbox/dockerfile.ts")>("lib/sandbox/dockerfile.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-dotfiles-entry-"));

  try {
    const dockerfilePath = sandboxDockerfile.composeDockerfile({
      repoRoot: tmpDir,
      project: "demo",
      runtimes: ["node20"],
      dockerfile: null
    });
    const content = fs.readFileSync(dockerfilePath, "utf8");

    assert.match(content, /sandbox-dotfiles-link >\/dev\/null \|\| true/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("composeDockerfile configures tmux extended keys and terminal env forwarding", async () => {
  const sandboxDockerfile = await loadFreshEsm<typeof import("../../lib/sandbox/dockerfile.ts")>("lib/sandbox/dockerfile.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-tmux-config-"));

  try {
    const dockerfilePath = sandboxDockerfile.composeDockerfile({
      repoRoot: tmpDir,
      project: "demo",
      runtimes: ["node20"],
      dockerfile: null
    });
    const content = fs.readFileSync(dockerfilePath, "utf8");

    assert.match(content, /set -g extended-keys always/);
    assert.match(content, /set -g extended-keys-format csi-u/);
    assert.match(content, /set -as terminal-features 'xterm\*:extkeys'/);
    assert.match(
      content,
      /set -ga update-environment 'TERM_PROGRAM TERM_PROGRAM_VERSION LC_TERMINAL LC_TERMINAL_VERSION'/
    );
    assert.match(content, /set -g mouse on/);
    assert.match(content, /set -g status-interval 1/);
    assert.match(content, /set -g status-right-length 80/);
    assert.match(content, /\/usr\/local\/bin\/cc-token-status/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("buildContainerEnvFile writes tool env vars to a private env file", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-env-file-"));

  try {
    const envFile = sandboxCreate.buildContainerEnvFile([
      { tool: { envVars: { FOO: "bar" } } },
      { tool: { envVars: { BAZ: "qux" } } }
    ], "native", () => "", { tmpDir });
    const envPath = required(envFile.dockerArgs[1]);

    assert.equal(envFile.dockerArgs[0], "--env-file");
    assert.equal(path.dirname(path.dirname(envPath)), tmpDir);
    assert.equal(fs.readFileSync(envPath, "utf8"), "FOO=bar\nBAZ=qux\n");
    assertModeBits(path.dirname(envPath), 0o700);
    assertModeBits(envPath, 0o600);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("buildContainerEnvFile stores GH_TOKEN in the env file but not docker argv", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-env-file-token-"));

  try {
    const envFile = sandboxCreate.buildContainerEnvFile([
      { tool: { envVars: { FOO: "bar" } } }
    ], "native", (engine: string, cmd: string, args: string[]) => {
      assert.equal(engine, "native");
      assert.equal(cmd, "gh");
      assert.deepEqual(args, ["auth", "token"]);
      return "ghp_123456789012345678901234567890123456";
    }, { tmpDir });

    const envPath = required(envFile.dockerArgs[1]);
    assert.deepEqual(envFile.dockerArgs, ["--env-file", envPath]);
    assert.ok(!envFile.dockerArgs.some((arg) => arg.includes("ghp_123456789012345678901234567890123456")));
    assert.match(fs.readFileSync(envPath, "utf8"), /GH_TOKEN=ghp_123456789012345678901234567890123456/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("buildContainerEnvFile returns empty docker args when there are no env vars", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");

  const envFile = sandboxCreate.buildContainerEnvFile([
    { tool: { envVars: {} } }
  ], "native", () => "");

  assert.deepEqual(envFile.dockerArgs, []);
  assert.doesNotThrow(() => envFile.cleanup());
});

test("buildContainerEnvFile cleanup removes the temporary directory", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-env-file-cleanup-"));

  try {
    const envFile = sandboxCreate.buildContainerEnvFile([
      { tool: { envVars: { FOO: "bar" } } }
    ], "native", () => "", { tmpDir });
    const envDir = path.dirname(required(envFile.dockerArgs[1]));

    assert.ok(fs.existsSync(envDir));
    envFile.cleanup();
    assert.equal(fs.existsSync(envDir), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("buildContainerEnvFile rejects newlines and removes the temporary directory", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-env-file-newline-"));

  try {
    assert.throws(() => sandboxCreate.buildContainerEnvFile([
      { tool: { envVars: { FOO: "bar\nbaz" } } }
    ], "native", () => "", { tmpDir }), /must not contain newlines/);
    assert.deepEqual(fs.readdirSync(tmpDir), []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("buildContainerEnvFile uses engine-aware env-file paths for WSL2", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");

  const envFile = sandboxCreate.buildContainerEnvFile([
    { tool: { envVars: { FOO: "bar" } } }
  ], "wsl2", () => "", {
    tmpDir: "F:\\tmp",
    mkdtempFn: () => "F:\\tmp\\agent-infra-env-fixed",
    writeFileFn: () => {},
    chmodFn: () => {},
    rmFn: () => {}
  });

  assert.deepEqual(envFile.dockerArgs, ["--env-file", "/mnt/f/tmp/agent-infra-env-fixed/env"]);
});

test("buildDotfilesVolumeArgs returns volume args when host dir exists", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");

  const args = sandboxCreate.buildDotfilesVolumeArgs("native", "/host/dotfiles", () => true);

  assert.deepEqual(args, ["-v", "/host/dotfiles:/dotfiles:ro"]);
});

test("buildDotfilesVolumeArgs returns empty when host dir is missing or falsy", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");

  assert.deepEqual(sandboxCreate.buildDotfilesVolumeArgs("native", "/host/dotfiles", () => false), []);
  assert.deepEqual(sandboxCreate.buildDotfilesVolumeArgs("native", null), []);
  assert.deepEqual(sandboxCreate.buildDotfilesVolumeArgs("native", ""), []);
});

test("buildDotfilesVolumeArgs applies engine-aware path on wsl2", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");

  const args = sandboxCreate.buildDotfilesVolumeArgs(
    "wsl2",
    "C:\\Users\\u\\.agent-infra\\dotfiles",
    () => true
  );

  assert.deepEqual(args, ["-v", "/mnt/c/Users/u/.agent-infra/dotfiles:/dotfiles:ro"]);
});

test("materializeDotfiles returns null when source directory is missing", async () => {
  const sandboxDotfiles = await loadFreshEsm<typeof import("../../lib/sandbox/dotfiles.ts")>("lib/sandbox/dotfiles.js");
  const { tmpDir, srcDir, cacheDir } = makeDotfilesFixture();

  try {
    fs.rmSync(srcDir, { recursive: true, force: true });

    const result = sandboxDotfiles.materializeDotfiles(srcDir, cacheDir);

    assert.equal(result, null);
    assert.equal(fs.existsSync(cacheDir), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("materializeDotfiles dereferences a regular file symlink", async () => {
  const sandboxDotfiles = await loadFreshEsm<typeof import("../../lib/sandbox/dotfiles.ts")>("lib/sandbox/dotfiles.js");
  const { tmpDir, srcDir, cacheDir, externalDir } = makeDotfilesFixture();

  try {
    const realFile = path.join(externalDir, ".tmux.conf");
    fs.writeFileSync(realFile, "set -g mouse on\n", "utf8");
    const symlinkCreated = trySymlink(realFile, path.join(srcDir, ".tmux.conf"), "file");
    if (!symlinkCreated) {
      assert.equal(fs.existsSync(path.join(srcDir, ".tmux.conf")), false);
      return;
    }

    const { result, stderr } = readMaterializeResult(sandboxDotfiles, srcDir, cacheDir);

    assert.equal(result.cacheDir, cacheDir);
    assert.deepEqual(result.warnings, []);
    assert.equal(stderr, "");
    assert.equal(fs.lstatSync(path.join(cacheDir, ".tmux.conf")).isFile(), true);
    assert.equal(fs.readFileSync(path.join(cacheDir, ".tmux.conf"), "utf8"), "set -g mouse on\n");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("materializeDotfiles dereferences a directory symlink", async () => {
  const sandboxDotfiles = await loadFreshEsm<typeof import("../../lib/sandbox/dotfiles.ts")>("lib/sandbox/dotfiles.js");
  const { tmpDir, srcDir, cacheDir, externalDir } = makeDotfilesFixture();

  try {
    const realConfigDir = path.join(externalDir, "config");
    fs.mkdirSync(path.join(realConfigDir, "lazygit"), { recursive: true });
    fs.writeFileSync(path.join(realConfigDir, "lazygit", "config.yml"), "gui:\n  nerdFontsVersion: \"3\"\n", "utf8");
    const symlinkCreated = trySymlink(realConfigDir, path.join(srcDir, ".config"), symlinkType("dir"));
    if (!symlinkCreated) {
      assert.equal(fs.existsSync(path.join(srcDir, ".config")), false);
      return;
    }

    const { result } = readMaterializeResult(sandboxDotfiles, srcDir, cacheDir);

    assert.deepEqual(result.warnings, []);
    assert.equal(
      fs.readFileSync(path.join(cacheDir, ".config", "lazygit", "config.yml"), "utf8"),
      "gui:\n  nerdFontsVersion: \"3\"\n"
    );
    assert.equal(fs.lstatSync(path.join(cacheDir, ".config")).isSymbolicLink(), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("materializeDotfiles warns on dangling symlink and continues", async () => {
  const sandboxDotfiles = await loadFreshEsm<typeof import("../../lib/sandbox/dotfiles.ts")>("lib/sandbox/dotfiles.js");
  const { tmpDir, srcDir, cacheDir } = makeDotfilesFixture();

  try {
    fs.writeFileSync(path.join(srcDir, "regular"), "kept\n", "utf8");
    const symlinkCreated = trySymlink(path.join(tmpDir, "missing"), path.join(srcDir, "broken"), "file");
    if (!symlinkCreated) {
      assert.equal(fs.existsSync(path.join(srcDir, "broken")), false);
      return;
    }

    const { result, stderr } = readMaterializeResult(sandboxDotfiles, srcDir, cacheDir);

    assert.equal(result.warnings.some((warning) => warning.rel === "broken" && warning.reason === "dangling symlink"), true);
    assert.match(stderr, /sandbox-dotfiles \(host\): skipping broken \(dangling symlink:/);
    assert.equal(fs.existsSync(path.join(cacheDir, "broken")), false);
    assert.equal(fs.readFileSync(path.join(cacheDir, "regular"), "utf8"), "kept\n");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("materializeDotfiles breaks symlink cycles via active realpath set", async () => {
  const sandboxDotfiles = await loadFreshEsm<typeof import("../../lib/sandbox/dotfiles.ts")>("lib/sandbox/dotfiles.js");
  const { tmpDir, srcDir, cacheDir } = makeDotfilesFixture();

  try {
    const realDir = path.join(srcDir, "dir");
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, "kept"), "kept\n", "utf8");
    const symlinkCreated = trySymlink(srcDir, path.join(realDir, "back"), symlinkType("dir"));
    if (!symlinkCreated) {
      assert.equal(fs.existsSync(path.join(realDir, "back")), false);
      return;
    }

    const { result, stderr } = readMaterializeResult(sandboxDotfiles, srcDir, cacheDir);

    assert.equal(result.warnings.some((warning) => warning.rel === "dir/back" && warning.reason === "symlink loop"), true);
    assert.match(stderr, /sandbox-dotfiles \(host\): skipping dir\/back \(symlink loop\)/);
    assert.equal(fs.readFileSync(path.join(cacheDir, "dir", "kept"), "utf8"), "kept\n");
    assert.equal(fs.existsSync(path.join(cacheDir, "dir", "back", "dir", "back")), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("materializeDotfiles caps recursion at maxDepth", async () => {
  const sandboxDotfiles = await loadFreshEsm<typeof import("../../lib/sandbox/dotfiles.ts")>("lib/sandbox/dotfiles.js");
  const { tmpDir, srcDir, cacheDir } = makeDotfilesFixture();

  try {
    const deepDir = path.join(srcDir, "one", "two", "three");
    fs.mkdirSync(deepDir, { recursive: true });
    fs.writeFileSync(path.join(deepDir, "too-deep"), "hidden\n", "utf8");

    const { result, stderr } = readMaterializeResult(sandboxDotfiles, srcDir, cacheDir, { maxDepth: 2 });

    assert.equal(result.warnings.some((warning) => warning.rel === "one/two/three" && warning.reason === "depth exceeds limit"), true);
    assert.match(stderr, /sandbox-dotfiles \(host\): skipping one\/two\/three \(depth exceeds limit: 2\)/);
    assert.equal(fs.existsSync(path.join(cacheDir, "one", "two", "three", "too-deep")), false);
    assert.equal(fs.existsSync(path.join(cacheDir, "one", "two", "three")), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("materializeDotfiles dereferences symlinks pointing outside the source tree", async () => {
  const sandboxDotfiles = await loadFreshEsm<typeof import("../../lib/sandbox/dotfiles.ts")>("lib/sandbox/dotfiles.js");
  const { tmpDir, srcDir, cacheDir, externalDir } = makeDotfilesFixture();

  try {
    const hostFile = path.join(externalDir, "host-tmux.conf");
    fs.writeFileSync(hostFile, "set -g status-position top\n", "utf8");
    const symlinkCreated = trySymlink(hostFile, path.join(srcDir, ".tmux.conf"), "file");
    if (!symlinkCreated) {
      assert.equal(fs.existsSync(path.join(srcDir, ".tmux.conf")), false);
      return;
    }

    const { result } = readMaterializeResult(sandboxDotfiles, srcDir, cacheDir);

    assert.deepEqual(result.warnings, []);
    assert.equal(fs.readFileSync(path.join(cacheDir, ".tmux.conf"), "utf8"), "set -g status-position top\n");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("materializeDotfiles empties cacheDir contents without removing cacheDir itself", async () => {
  const sandboxDotfiles = await loadFreshEsm<typeof import("../../lib/sandbox/dotfiles.ts")>("lib/sandbox/dotfiles.js");
  const { tmpDir, srcDir, cacheDir } = makeDotfilesFixture();

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "old"), "old\n", "utf8");
    const before = fs.statSync(cacheDir);
    fs.writeFileSync(path.join(srcDir, "new"), "new\n", "utf8");

    readMaterializeResult(sandboxDotfiles, srcDir, cacheDir);

    const after = fs.statSync(cacheDir);
    assert.equal(after.ino, before.ino);
    assert.equal(fs.existsSync(path.join(cacheDir, "old")), false);
    assert.equal(fs.readFileSync(path.join(cacheDir, "new"), "utf8"), "new\n");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("materializeDotfiles preserves regular files alongside symlinks", async () => {
  const sandboxDotfiles = await loadFreshEsm<typeof import("../../lib/sandbox/dotfiles.ts")>("lib/sandbox/dotfiles.js");
  const { tmpDir, srcDir, cacheDir, externalDir } = makeDotfilesFixture();

  try {
    fs.writeFileSync(path.join(srcDir, ".inputrc"), "set editing-mode vi\n", "utf8");
    const hostFile = path.join(externalDir, ".tmux.conf");
    fs.writeFileSync(hostFile, "set -g history-limit 100000\n", "utf8");
    const symlinkCreated = trySymlink(hostFile, path.join(srcDir, ".tmux.conf"), "file");
    if (!symlinkCreated) {
      assert.equal(fs.existsSync(path.join(srcDir, ".tmux.conf")), false);
      return;
    }

    const { result } = readMaterializeResult(sandboxDotfiles, srcDir, cacheDir);

    assert.deepEqual(result.warnings, []);
    assert.equal(fs.readFileSync(path.join(cacheDir, ".inputrc"), "utf8"), "set editing-mode vi\n");
    assert.equal(fs.readFileSync(path.join(cacheDir, ".tmux.conf"), "utf8"), "set -g history-limit 100000\n");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("materializeDotfiles skips fifos silently", onPlatforms("linux", "darwin"), async () => {
  const sandboxDotfiles = await loadFreshEsm<typeof import("../../lib/sandbox/dotfiles.ts")>("lib/sandbox/dotfiles.js");
  const { tmpDir, srcDir, cacheDir } = makeDotfilesFixture();

  try {
    execFileSync("mkfifo", [path.join(srcDir, "pipe")]);

    const { result, stderr } = readMaterializeResult(sandboxDotfiles, srcDir, cacheDir);

    assert.deepEqual(result.warnings, []);
    assert.equal(stderr, "");
    assert.equal(fs.existsSync(path.join(cacheDir, "pipe")), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("terminalEnvFlags forwards iTerm2 detection variables for Shift+Enter support", async () => {
  const sandboxEnter = await loadFreshEsm<EnterModule>("lib/sandbox/commands/enter.js");

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
  const sandboxEnter = await loadFreshEsm<EnterModule>("lib/sandbox/commands/enter.js");

  const flags = sandboxEnter.terminalEnvFlags({
    TERM_PROGRAM: "iTerm.app",
    TERM_PROGRAM_VERSION: "",
    LC_TERMINAL: undefined
  });

  assert.deepEqual(flags, ["-e", "TERM_PROGRAM=iTerm.app"]);
});

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
          LC_TERMINAL_VERSION: ""
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

test("claude-code tool pins CLAUDE_CONFIG_DIR so $HOME/.claude.json preseed reaches Claude Code", async () => {
  // Regression guard for the onboarding loop bug: without this env var Claude
  // Code reads .claude.json from $HOME/.claude.json (outside the bind mount),
  // so the preseeded onboarding state is silently ignored and every container
  // start lands on the theme picker.
  const sandboxTools = await loadFreshEsm<typeof import("../../lib/sandbox/tools.ts")>("lib/sandbox/tools.js");
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
  const sandboxTools = await loadFreshEsm<typeof import("../../lib/sandbox/tools.ts")>("lib/sandbox/tools.js");
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
  const sandboxTools = await loadFreshEsm<typeof import("../../lib/sandbox/tools.ts")>("lib/sandbox/tools.js");
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
  const sandboxTools = await loadFreshEsm<typeof import("../../lib/sandbox/tools.ts")>("lib/sandbox/tools.js");
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
  const sandboxTools = await loadFreshEsm<typeof import("../../lib/sandbox/tools.ts")>("lib/sandbox/tools.js");
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
  const sandboxTools = await loadFreshEsm<typeof import("../../lib/sandbox/tools.ts")>("lib/sandbox/tools.js");
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

test("assertBranchAvailable allows branches that are not checked out in any worktree", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");

  assert.doesNotThrow(() => sandboxCreate.assertBranchAvailable("/repo", "feature/demo", {
    runFn(cmd: string, args: string[]) {
      assert.equal(cmd, "git");
      assert.deepEqual(args, ["-C", "/repo", "worktree", "list", "--porcelain"]);
      return "worktree /repo\nbranch refs/heads/main\n";
    }
  }));
});

test("assertBranchAvailable rejects branches that are already checked out", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");

  assert.throws(() => sandboxCreate.assertBranchAvailable("/repo", "feature/demo", {
    runFn: () => [
      "worktree /repo/worktrees/demo",
      "branch refs/heads/feature/demo",
      ""
    ].join("\n")
  }), /already checked out/);
});

test("assertBranchAvailable reports the conflicting worktree path", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");

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
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");

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
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
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
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
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
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
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

test("ensureClaudeOnboarding skips write when flag already set", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
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

test("ensureClaudeOnboarding inherits host model when sandbox model is absent", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-onboarding-model-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-host-model-"));

  try {
    fs.writeFileSync(path.join(hostHome, ".claude.json"), JSON.stringify({ model: "claude-opus-4-7" }), "utf8");
    sandboxCreate.ensureClaudeOnboarding(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude.json"), "utf8"));
    assert.equal(data.model, "claude-opus-4-7");
    assert.equal(data.hasCompletedOnboarding, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureClaudeOnboarding preserves existing sandbox model", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-onboarding-keep-model-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-host-keep-model-"));

  try {
    fs.writeFileSync(path.join(hostHome, ".claude.json"), JSON.stringify({ model: "claude-opus-4-7" }), "utf8");
    fs.writeFileSync(path.join(tmpDir, ".claude.json"), JSON.stringify({ model: "claude-sonnet-4-5" }), "utf8");
    sandboxCreate.ensureClaudeOnboarding(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude.json"), "utf8"));
    assert.equal(data.model, "claude-sonnet-4-5");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureClaudeOnboarding skips host model when it is missing", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-onboarding-missing-model-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-host-missing-model-"));

  try {
    fs.writeFileSync(path.join(hostHome, ".claude.json"), JSON.stringify({ theme: "dark" }), "utf8");
    sandboxCreate.ensureClaudeOnboarding(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude.json"), "utf8"));
    assert.equal(Object.hasOwn(data, "model"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureClaudeOnboarding skips empty host model", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-onboarding-empty-model-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-host-empty-model-"));

  try {
    fs.writeFileSync(path.join(hostHome, ".claude.json"), JSON.stringify({ model: "" }), "utf8");
    sandboxCreate.ensureClaudeOnboarding(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude.json"), "utf8"));
    assert.equal(Object.hasOwn(data, "model"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureClaudeOnboarding ignores malformed host json", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-onboarding-malformed-host-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-host-malformed-"));

  try {
    fs.writeFileSync(path.join(hostHome, ".claude.json"), "{", "utf8");
    assert.doesNotThrow(() => sandboxCreate.ensureClaudeOnboarding(tmpDir, hostHome));
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude.json"), "utf8"));
    assert.equal(Object.hasOwn(data, "model"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureClaudeOnboarding inherits host launch-pin flag when sandbox is absent", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-launchpin-inherit-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-launchpin-host-"));

  try {
    fs.writeFileSync(
      path.join(hostHome, ".claude.json"),
      JSON.stringify({ unpinOpus47LaunchEffort: true }),
      "utf8"
    );
    sandboxCreate.ensureClaudeOnboarding(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude.json"), "utf8"));
    assert.equal(data.unpinOpus47LaunchEffort, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureClaudeOnboarding preserves existing sandbox launch-pin flag value", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-launchpin-preserve-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-launchpin-host-preserve-"));

  try {
    fs.writeFileSync(
      path.join(hostHome, ".claude.json"),
      JSON.stringify({ unpinOpus47LaunchEffort: true }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(tmpDir, ".claude.json"),
      JSON.stringify({ unpinOpus47LaunchEffort: false }),
      "utf8"
    );
    sandboxCreate.ensureClaudeOnboarding(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude.json"), "utf8"));
    assert.equal(data.unpinOpus47LaunchEffort, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureClaudeOnboarding skips launch-pin flag when host omits it", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-launchpin-omit-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-launchpin-host-omit-"));

  try {
    fs.writeFileSync(path.join(hostHome, ".claude.json"), JSON.stringify({ theme: "dark" }), "utf8");
    sandboxCreate.ensureClaudeOnboarding(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude.json"), "utf8"));
    assert.equal(Object.hasOwn(data, "unpinOpus47LaunchEffort"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureClaudeOnboarding inherits all matching launch-pin flags for future models", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-launchpin-future-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-launchpin-host-future-"));

  try {
    fs.writeFileSync(
      path.join(hostHome, ".claude.json"),
      JSON.stringify({
        unpinOpus47LaunchEffort: true,
        unpinOpus48LaunchEffort: true
      }),
      "utf8"
    );
    sandboxCreate.ensureClaudeOnboarding(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude.json"), "utf8"));
    assert.equal(data.unpinOpus47LaunchEffort, true);
    assert.equal(data.unpinOpus48LaunchEffort, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureClaudeOnboarding skips launch-pin flag values that are not strictly true", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-launchpin-nonboolean-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-launchpin-host-nonboolean-"));

  try {
    fs.writeFileSync(
      path.join(hostHome, ".claude.json"),
      JSON.stringify({
        unpinOpus47LaunchEffort: "true",
        unpinOpus48LaunchEffort: 1,
        unpinOpus49LaunchEffort: false
      }),
      "utf8"
    );
    sandboxCreate.ensureClaudeOnboarding(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude.json"), "utf8"));
    assert.equal(Object.hasOwn(data, "unpinOpus47LaunchEffort"), false);
    assert.equal(Object.hasOwn(data, "unpinOpus48LaunchEffort"), false);
    assert.equal(Object.hasOwn(data, "unpinOpus49LaunchEffort"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureClaudeSettings creates settings.json with skipDangerousModePermissionPrompt", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
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
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
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

test("ensureClaudeSettings inherits host effort level when sandbox field is absent", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-settings-effort-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-host-effort-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".claude", "settings.json"),
      JSON.stringify({ effortLevel: "high" }),
      "utf8"
    );
    sandboxCreate.ensureClaudeSettings(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, "settings.json"), "utf8"));
    assert.equal(data.effortLevel, "high");
    assert.equal(data.skipDangerousModePermissionPrompt, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureClaudeSettings preserves existing sandbox effort level", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-settings-keep-effort-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-host-keep-effort-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".claude", "settings.json"),
      JSON.stringify({ effortLevel: "xhigh" }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(tmpDir, "settings.json"),
      JSON.stringify({ skipDangerousModePermissionPrompt: true, effortLevel: "low" }),
      "utf8"
    );
    sandboxCreate.ensureClaudeSettings(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, "settings.json"), "utf8"));
    assert.equal(data.effortLevel, "low");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureClaudeSettings skips missing host effort level", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-settings-missing-effort-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-host-missing-effort-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(hostHome, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }), "utf8");
    sandboxCreate.ensureClaudeSettings(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, "settings.json"), "utf8"));
    assert.equal(Object.hasOwn(data, "effortLevel"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureClaudeSettings skips empty host effort level", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-settings-empty-effort-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-host-empty-effort-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(hostHome, ".claude", "settings.json"), JSON.stringify({ effortLevel: "" }), "utf8");
    sandboxCreate.ensureClaudeSettings(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, "settings.json"), "utf8"));
    assert.equal(Object.hasOwn(data, "effortLevel"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexModelInheritance creates config with host model fields", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-model-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-host-model-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".codex", "config.toml"),
      'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n',
      "utf8"
    );
    sandboxCreate.ensureCodexModelInheritance(tmpDir, hostHome);
    const data = toml.parse(fs.readFileSync(path.join(tmpDir, "config.toml"), "utf8"));
    assert.equal(data.model, "gpt-5.5");
    assert.equal(data.model_reasoning_effort, "high");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexModelInheritance keeps model fields before workspace trust section", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-model-order-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-host-order-"));
  const configPath = path.join(tmpDir, "config.toml");

  try {
    fs.mkdirSync(path.join(hostHome, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".codex", "config.toml"),
      'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n',
      "utf8"
    );
    fs.writeFileSync(configPath, '[projects."/workspace"]\ntrust_level = "trusted"\n', "utf8");
    sandboxCreate.ensureCodexModelInheritance(tmpDir, hostHome);
    const content = fs.readFileSync(configPath, "utf8");
    const data = toml.parse(content) as {
      model?: string;
      model_reasoning_effort?: string;
      projects: Record<string, { trust_level?: string }>;
    };
    assert.equal(data.model, "gpt-5.5");
    assert.equal(data.model_reasoning_effort, "high");
    assert.equal(data.projects["/workspace"]?.trust_level, "trusted");
    const lines = content.split(/\r?\n/);
    const modelLine = lines.findIndex((line) => line.startsWith("model = "));
    const sectionLine = lines.findIndex((line) => line.startsWith("[projects."));
    assert.ok(modelLine >= 0);
    assert.ok(sectionLine > modelLine);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexModelInheritance ignores model fields outside the root table", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-model-section-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-host-section-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".codex", "config.toml"),
      '[profiles.default]\nmodel = "gpt-5.5"\nmodel_reasoning_effort = "high"\n',
      "utf8"
    );
    sandboxCreate.ensureCodexModelInheritance(tmpDir, hostHome);
    assert.equal(fs.existsSync(path.join(tmpDir, "config.toml")), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexModelInheritance preserves existing sandbox model field", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-model-keep-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-host-keep-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".codex", "config.toml"),
      'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n',
      "utf8"
    );
    fs.writeFileSync(path.join(tmpDir, "config.toml"), 'model = "gpt-5.4"\n', "utf8");
    sandboxCreate.ensureCodexModelInheritance(tmpDir, hostHome);
    const data = toml.parse(fs.readFileSync(path.join(tmpDir, "config.toml"), "utf8"));
    assert.equal(data.model, "gpt-5.4");
    assert.equal(data.model_reasoning_effort, "high");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexModelInheritance ignores malformed host config", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-model-malformed-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-host-malformed-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(hostHome, ".codex", "config.toml"), "=", "utf8");
    assert.doesNotThrow(() => sandboxCreate.ensureCodexModelInheritance(tmpDir, hostHome));
    assert.equal(fs.existsSync(path.join(tmpDir, "config.toml")), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexModelInheritance leaves malformed sandbox config alone", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-model-malformed-sandbox-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-host-valid-for-malformed-sandbox-"));
  const configPath = path.join(tmpDir, "config.toml");

  try {
    fs.mkdirSync(path.join(hostHome, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".codex", "config.toml"),
      'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n',
      "utf8"
    );
    fs.writeFileSync(configPath, "=", "utf8");
    assert.doesNotThrow(() => sandboxCreate.ensureCodexModelInheritance(tmpDir, hostHome));
    assert.equal(fs.readFileSync(configPath, "utf8"), "=");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureOpenCodeModelInheritance creates config with host model fields", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-model-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-host-model-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".config", "opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".config", "opencode", "opencode.json"),
      JSON.stringify({
        model: "anthropic/claude-opus-4-7",
        small_model: "openai/gpt-5.5-mini"
      }),
      "utf8"
    );
    sandboxCreate.ensureOpenCodeModelInheritance(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, "opencode.json"), "utf8"));
    assert.equal(data.model, "anthropic/claude-opus-4-7");
    assert.equal(data.small_model, "openai/gpt-5.5-mini");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureOpenCodeModelInheritance preserves existing sandbox model fields", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-model-keep-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-host-keep-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".config", "opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".config", "opencode", "opencode.json"),
      JSON.stringify({
        model: "anthropic/claude-opus-4-7",
        small_model: "openai/gpt-5.5-mini"
      }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(tmpDir, "opencode.json"),
      JSON.stringify({
        model: "openai/gpt-5.5",
        small_model: "anthropic/claude-sonnet-4-5"
      }),
      "utf8"
    );
    sandboxCreate.ensureOpenCodeModelInheritance(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, "opencode.json"), "utf8"));
    assert.equal(data.model, "openai/gpt-5.5");
    assert.equal(data.small_model, "anthropic/claude-sonnet-4-5");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureOpenCodeModelInheritance inherits small model when host model is missing", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-small-model-only-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-host-small-model-only-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".config", "opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".config", "opencode", "opencode.json"),
      JSON.stringify({ small_model: "openai/gpt-5.5-mini" }),
      "utf8"
    );
    sandboxCreate.ensureOpenCodeModelInheritance(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, "opencode.json"), "utf8"));
    assert.equal(Object.hasOwn(data, "model"), false);
    assert.equal(data.small_model, "openai/gpt-5.5-mini");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureOpenCodeModelInheritance skips missing host model fields", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-model-missing-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-host-missing-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".config", "opencode"), { recursive: true });
    fs.writeFileSync(path.join(hostHome, ".config", "opencode", "opencode.json"), JSON.stringify({ theme: "dark" }), "utf8");
    sandboxCreate.ensureOpenCodeModelInheritance(tmpDir, hostHome);
    assert.equal(fs.existsSync(path.join(tmpDir, "opencode.json")), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureOpenCodeModelInheritance skips empty host model fields", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-model-empty-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-host-empty-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".config", "opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".config", "opencode", "opencode.json"),
      JSON.stringify({ model: "", small_model: "" }),
      "utf8"
    );
    sandboxCreate.ensureOpenCodeModelInheritance(tmpDir, hostHome);
    assert.equal(fs.existsSync(path.join(tmpDir, "opencode.json")), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureOpenCodeModelInheritance ignores malformed host json", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-model-malformed-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-host-malformed-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".config", "opencode"), { recursive: true });
    fs.writeFileSync(path.join(hostHome, ".config", "opencode", "opencode.json"), "{", "utf8");
    assert.doesNotThrow(() => sandboxCreate.ensureOpenCodeModelInheritance(tmpDir, hostHome));
    assert.equal(fs.existsSync(path.join(tmpDir, "opencode.json")), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureOpenCodeModelInheritance leaves malformed sandbox config alone", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-model-malformed-sandbox-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-host-valid-for-malformed-sandbox-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".config", "opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".config", "opencode", "opencode.json"),
      JSON.stringify({ model: "anthropic/claude-opus-4-7" }),
      "utf8"
    );
    const configPath = path.join(tmpDir, "opencode.json");
    fs.writeFileSync(configPath, "{", "utf8");
    assert.doesNotThrow(() => sandboxCreate.ensureOpenCodeModelInheritance(tmpDir, hostHome));
    assert.equal(fs.readFileSync(configPath, "utf8"), "{");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexWorkspaceTrust appends workspace trust to config.toml", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
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
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
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
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
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
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
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
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const calls: VerboseCall[] = [];

  sandboxCreate.buildImage(
    { project: "demo", imageName: "demo-sandbox:latest", repoRoot: "/repo" },
    [{ npmPackage: "@acme/tool" }],
    "/tmp/Dockerfile",
    "sig-123",
    {
      engine: "native",
      runFn(cmd: string, args: string[]) {
        const [, actualCmd, actualArgs] = arguments;
        calls.push({ type: "run", cmd: actualCmd, args: actualArgs });
        if (actualCmd === "id" && actualArgs[0] === "-u") {
          return "501";
        }
        if (actualCmd === "id" && actualArgs[0] === "-g") {
          return "20";
        }
        throw new Error(`unexpected quiet command: ${actualCmd} ${actualArgs.join(" ")}`);
      },
      runSafeFn() {
        return "";
      },
      runVerboseFn(engine: string, cmd: string, args: string[], opts?: CommandOptions) {
        calls.push({ type: "verbose", engine, cmd, args, opts });
      }
    }
  );

  assert.deepEqual(calls.slice(0, 2), [
    { type: "run", cmd: "id", args: ["-u"] },
    { type: "run", cmd: "id", args: ["-g"] }
  ]);
  const buildCall = required(calls[2]);
  assert.equal(buildCall.type, "verbose");
  assert.equal(buildCall.engine, "native");
  assert.equal(buildCall.cmd, "docker");
  assert.equal(buildCall.opts?.cwd, "/repo");
  assert.deepEqual(buildCall.args, [
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

test("windowsPathToWslPath converts drive paths and rejects UNC mounts", async () => {
  const windowsPaths = await loadFreshEsm<Wsl2PathsModule>("lib/sandbox/engines/wsl2-paths.js");

  assert.equal(
    windowsPaths.windowsPathToWslPath("F:\\ai\\agent-infra"),
    "/mnt/f/ai/agent-infra"
  );
  assert.equal(
    windowsPaths.windowsPathToWslPath("C:/Users/Demo Repo/project"),
    "/mnt/c/Users/Demo Repo/project"
  );
  assert.equal(windowsPaths.windowsPathToWslPath("/home/demo/project"), "/home/demo/project");
  assert.throws(
    () => windowsPaths.windowsPathToWslPath("\\\\server\\share\\repo"),
    /UNC paths are not supported/
  );
});

test("commandForEngine wraps commands with wsl.exe for WSL2", async () => {
  const sandboxShell = await loadFreshEsm<typeof import("../../lib/sandbox/shell.ts")>("lib/sandbox/shell.js");

  assert.deepEqual(
    sandboxShell.commandForEngine("wsl2", "docker", ["info"]),
    { cmd: "wsl.exe", args: ["--", "docker", "info"] }
  );
  assert.deepEqual(
    sandboxShell.commandForEngine("native", "docker", ["info"]),
    { cmd: "docker", args: ["info"] }
  );
});

test("sandbox exec routes through wsl.exe with single-arg entry script on wsl2", async () => {
  const sandboxShell = await loadFreshEsm<typeof import("../../lib/sandbox/shell.ts")>("lib/sandbox/shell.js");
  const command = sandboxShell.commandForEngine("wsl2", "docker", [
    "exec",
    "-it",
    "demo-dev-agent-infra-feature-cli-generic-sandbox",
    "bash",
    "/usr/local/bin/sandbox-tmux-entry"
  ]);

  assert.deepEqual(command, {
    cmd: "wsl.exe",
    args: [
      "--",
      "docker",
      "exec",
      "-it",
      "demo-dev-agent-infra-feature-cli-generic-sandbox",
      "bash",
      "/usr/local/bin/sandbox-tmux-entry"
    ]
  });
  assert.equal(command.args.some((arg) => arg.includes("\n")), false);
});

test("sandbox command modules route docker calls through engine-aware helpers", () => {
  for (const relativePath of [
    "lib/sandbox/commands/create.js",
    "lib/sandbox/commands/enter.js",
    "lib/sandbox/commands/ls.js",
    "lib/sandbox/commands/rm.js",
    "lib/sandbox/commands/rebuild.js"
  ]) {
    const content = fs.readFileSync(filePath(relativePath), "utf8");
    assert.doesNotMatch(content, /runSafe\('docker'/, relativePath);
    assert.doesNotMatch(content, /runOk\('docker'/, relativePath);
    assert.doesNotMatch(content, /runInteractive\('docker'/, relativePath);
    assert.doesNotMatch(content, /run\('docker'/, relativePath);
    assert.doesNotMatch(content, /execFn\('docker'/, relativePath);
  }
});

test("sandbox command modules do not call detectEngine without config", () => {
  const commandsDir = filePath("lib/sandbox/commands");
  const offenders: string[] = [];

  for (const entry of fs.readdirSync(commandsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) {
      continue;
    }

    const content = fs.readFileSync(path.join(commandsDir, entry.name), "utf8");
    const matches = [...content.matchAll(/\bdetectEngine\(\s*\)/g)];
    if (matches.length > 0) {
      offenders.push(`${entry.name}: ${matches.length} bare detectEngine() call(s)`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Found detectEngine() called without config. Pass the loadConfig() result so sandbox.engine does not silently fall back to platform defaults.\n${offenders.join("\n")}`
  );
});

test("wsl2BackendStatus checks WSL2 and Docker without Colima", async () => {
  const sandboxVm = await loadFreshEsm<typeof import("../../lib/sandbox/commands/vm.ts")>("lib/sandbox/commands/vm.js");
  const checks: string[][] = [];

  const status = sandboxVm.wsl2BackendStatus({
    runOkFn(cmd: string, args: string[]) {
      checks.push([cmd, ...args]);
      return cmd === "wsl.exe" && (args[0] === "--status" || args[1] === "docker");
    }
  });

  assert.deepEqual(status, { wslAvailable: true, dockerAvailable: true });
  assert.deepEqual(checks, [
    ["wsl.exe", "--status"],
    ["wsl.exe", "--", "docker", "info"]
  ]);
});

test("WSL2 adapter checks WSL and Docker Desktop integration", async () => {
  const { wsl2Adapter } = await loadFreshEsm<AdapterModule<"wsl2">>("lib/sandbox/engines/wsl2.js");
  const checks: string[][] = [];
  const messages: string[] = [];

  await wsl2Adapter.ensure({}, (message) => messages.push(message), {
    runOk(cmd: string, args: string[]) {
      checks.push([cmd, ...args]);
      return cmd === "wsl.exe" && (args[0] === "--status" || args[1] === "docker");
    }
  });

  assert.deepEqual(checks, [
    ["wsl.exe", "--status"],
    ["wsl.exe", "--", "docker", "info"]
  ]);
  assert.deepEqual(messages, ["Checking Docker Desktop from WSL2..."]);
});

test("buildImage converts Docker build paths for WSL2", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const calls: VerboseCall[] = [];

  sandboxCreate.buildImage(
    { project: "demo", imageName: "demo-sandbox:latest", repoRoot: "F:\\repo" },
    [{ npmPackage: "@acme/tool" }],
    "F:\\tmp\\Dockerfile",
    "sig-123",
    {
      engine: "wsl2",
      runFn(engine: string, cmd: string, args: string[]) {
        calls.push({ type: "run", engine, cmd, args });
        return "1000";
      },
      runVerboseFn(engine: string, cmd: string, args: string[], opts?: CommandOptions) {
        calls.push({ type: "verbose", engine, cmd, args, opts });
      }
    }
  );

  const dockerBuild = required(calls.find((call) => call.type === "verbose"));
  assert.equal(dockerBuild.engine, "wsl2");
  assert.equal(dockerBuild.cmd, "docker");
  assert.equal(dockerBuild.args.at(-3), "-f");
  assert.equal(dockerBuild.args.at(-2), "/mnt/f/tmp/Dockerfile");
  assert.equal(dockerBuild.args.at(-1), "/mnt/f/repo");
});

test("volumeArg converts host mount paths for WSL2", async () => {
  const wsl2Paths = await loadFreshEsm<Wsl2PathsModule>("lib/sandbox/engines/wsl2-paths.js");

  assert.equal(
    wsl2Paths.volumeArg("wsl2", "F:\\repo\\.agents\\workspace", "/workspace/.agents/workspace"),
    "/mnt/f/repo/.agents/workspace:/workspace/.agents/workspace"
  );
  assert.equal(
    wsl2Paths.volumeArg("native", "/repo/.ssh", "/home/devuser/.ssh", ":ro"),
    "/repo/.ssh:/home/devuser/.ssh:ro"
  );
});

test("volumeArg without selinux fallback stays unchanged", async () => {
  const wsl2Paths = await loadFreshEsm<Wsl2PathsModule>("lib/sandbox/engines/wsl2-paths.js");

  assert.equal(
    wsl2Paths.volumeArg("native", "/repo", "/workspace", "", {
      platform: "darwin",
      fs: fakeSelinuxFs("1\n"),
      env: {}
    }),
    "/repo:/workspace"
  );
  assert.equal(
    wsl2Paths.volumeArg("native", "/repo", "/workspace", ":ro", {
      platform: "linux",
      fs: fakeSelinuxFs("0\n"),
      env: {}
    }),
    "/repo:/workspace:ro"
  );
});

test("volumeArg adds shared selinux labels on native enforcing hosts", async () => {
  const wsl2Paths = await loadFreshEsm<Wsl2PathsModule>("lib/sandbox/engines/wsl2-paths.js");
  const fsImpl = fakeSelinuxFs("1\n");

  assert.equal(
    wsl2Paths.volumeArg("native", "/repo", "/workspace", "", {
      platform: "linux",
      fs: fsImpl,
      env: {}
    }),
    "/repo:/workspace:z"
  );
  assert.equal(
    wsl2Paths.volumeArg("native", "/repo/.ssh", "/home/devuser/.ssh", ":ro", {
      platform: "linux",
      fs: fsImpl,
      env: {}
    }),
    "/repo/.ssh:/home/devuser/.ssh:ro,z"
  );
});

test("volumeArg respects selinux label controls", async () => {
  const wsl2Paths = await loadFreshEsm<Wsl2PathsModule>("lib/sandbox/engines/wsl2-paths.js");

  assert.equal(
    wsl2Paths.volumeArg("native", "/repo", "/workspace", "", {
      platform: "linux",
      fs: fakeSelinuxFs("1\n"),
      env: { AGENT_INFRA_SELINUX_DISABLE: "1" }
    }),
    "/repo:/workspace"
  );
  assert.equal(
    wsl2Paths.volumeArg("native", "/repo", "/workspace", "", {
      platform: "linux",
      fs: fakeSelinuxFs("1\n"),
      env: {},
      selinux: "none"
    }),
    "/repo:/workspace"
  );
});

test("volumeArg ignores selinux labels for non-native engines", async () => {
  const wsl2Paths = await loadFreshEsm<Wsl2PathsModule>("lib/sandbox/engines/wsl2-paths.js");
  const fsImpl = fakeSelinuxFs("1\n");

  assert.equal(
    wsl2Paths.volumeArg("wsl2", "F:\\repo", "/workspace", "", {
      platform: "linux",
      fs: fsImpl,
      env: {}
    }),
    "/mnt/f/repo:/workspace"
  );
  assert.equal(
    wsl2Paths.volumeArg("orbstack", "/repo", "/workspace", "", {
      platform: "linux",
      fs: fsImpl,
      env: {}
    }),
    "/repo:/workspace"
  );
  assert.equal(fsImpl.reads, 0);
});

test("rebuild buildArgs converts Docker build paths for WSL2", async () => {
  const sandboxRebuild = await loadFreshEsm<RebuildModule>("lib/sandbox/commands/rebuild.js");

  const args = sandboxRebuild.buildArgs(
    { project: "demo", imageName: "demo-sandbox:latest", repoRoot: "F:\\repo" },
    [{ npmPackage: "@acme/tool" }],
    "F:\\tmp\\Dockerfile",
    "sig-123",
    { engine: "wsl2", runFn: () => "1000" }
  );

  assert.equal(args.at(-3), "-f");
  assert.equal(args.at(-2), "/mnt/f/tmp/Dockerfile");
  assert.equal(args.at(-1), "/mnt/f/repo");
});

test("assertManagedPath rejects paths outside the sandbox root", async () => {
  const sandboxRm = await loadFreshEsm<typeof import("../../lib/sandbox/commands/rm.ts")>("lib/sandbox/commands/rm.js");
  const root = path.join(os.tmpdir(), "agent-infra-worktrees");

  assert.doesNotThrow(() => sandboxRm.assertManagedPath(root, path.join(root, "feature..demo")));
  assert.throws(
    () => sandboxRm.assertManagedPath(root, path.join(os.tmpdir(), "agent-infra-other")),
    /outside managed sandbox root/
  );
});

test("buildImage forwards HOST_UID=0 and HOST_GID=0 unchanged when host runs as root", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const calls: VerboseCall[] = [];

  sandboxCreate.buildImage(
    { project: "demo", imageName: "demo-sandbox:latest", repoRoot: "/repo" },
    [{ npmPackage: "@acme/tool" }],
    "/tmp/Dockerfile",
    "sig-123",
    {
      engine: "native",
      runFn(engine: string, cmd: string, args: string[]) {
        calls.push({ type: "run", engine, cmd, args });
        if (cmd === "id" && args[0] === "-u") {
          return "0";
        }
        if (cmd === "id" && args[0] === "-g") {
          return "0";
        }
        throw new Error(`unexpected quiet command: ${cmd} ${args.join(" ")}`);
      },
      runSafeFn() {
        return "";
      },
      runVerboseFn(engine: string, cmd: string, args: string[], opts?: CommandOptions) {
        calls.push({ type: "verbose", engine, cmd, args, opts });
      }
    }
  );

  assert.deepEqual(calls.slice(0, 2), [
    { type: "run", engine: "native", cmd: "id", args: ["-u"] },
    { type: "run", engine: "native", cmd: "id", args: ["-g"] }
  ]);
  assert.equal(calls.length, 3);
  const buildCall = required(calls[2]);
  assert.equal(buildCall.type, "verbose");
  assert.equal(buildCall.engine, "native");
  assert.equal(buildCall.cmd, "docker");
  assert.equal(buildCall.opts?.cwd, "/repo");
  assert.deepEqual(buildCall.args.slice(0, 7), [
    "build",
    "-t",
    "demo-sandbox:latest",
    "--build-arg",
    "HOST_UID=0",
    "--build-arg",
    "HOST_GID=0"
  ]);
});

test("isRootlessDocker returns true when DOCKER_HOST points at rootless socket", async () => {
  const { isRootlessDocker } = await loadFreshEsm<NativeModule>("lib/sandbox/engines/native.js");

  assert.equal(
    isRootlessDocker({ env: { DOCKER_HOST: "unix:///run/user/1000/docker.sock" } }),
    true
  );
});

test("isRootlessDocker falls back to docker info SecurityOptions", async () => {
  const { isRootlessDocker } = await loadFreshEsm<NativeModule>("lib/sandbox/engines/native.js");

  assert.equal(
    isRootlessDocker({
      env: {},
      runSafe(cmd: string, args: string[]) {
        assert.equal(cmd, "docker");
        assert.deepEqual(args, ["info", "--format", "{{.SecurityOptions}}"]);
        return "[name=rootless,name=seccomp=builtin]";
      }
    }),
    true
  );
});

test("buildImage rewrites HOST_UID and HOST_GID to 0 when Docker is rootless", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const calls: VerboseCall[] = [];

  sandboxCreate.buildImage(
    { project: "demo", imageName: "demo-sandbox:latest", repoRoot: "/repo" },
    [{ npmPackage: "@acme/tool" }],
    "/tmp/Dockerfile",
    "sig-123",
    {
      engine: "native",
      runFn(engine: string, cmd: string, args: string[]) {
        calls.push({ type: "run", engine, cmd, args });
        if (cmd === "id" && args[0] === "-u") {
          return "1000";
        }
        if (cmd === "id" && args[0] === "-g") {
          return "1000";
        }
        throw new Error(`unexpected quiet command: ${cmd} ${args.join(" ")}`);
      },
      runSafeFn() {
        return "";
      },
      runVerboseFn(engine: string, cmd: string, args: string[], opts?: CommandOptions) {
        calls.push({ type: "verbose", engine, cmd, args, opts });
      },
      env: { DOCKER_HOST: "unix:///run/user/1000/docker.sock" }
    }
  );

  assert.equal(calls.length, 1);
  const buildCall = required(calls[0]);
  assert.equal(buildCall.type, "verbose");
  assert.deepEqual(buildCall.args.slice(0, 7), [
    "build",
    "-t",
    "demo-sandbox:latest",
    "--build-arg",
    "HOST_UID=0",
    "--build-arg",
    "HOST_GID=0"
  ]);
});

test("base.dockerfile guards root host uid with useradd -o", () => {
  const content = fs.readFileSync(filePath("lib/sandbox/runtimes/base.dockerfile"), "utf8");

  assert.match(content, /if \[ "\$\{HOST_UID\}" = "0" \]/);
  assert.match(content, /useradd -o -u \$\{HOST_UID\}/);
});

test("commandErrorMessage prefers stderr over the generic execFileSync message", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");

  const message = sandboxCreate.commandErrorMessage({
    message: "Command failed: git worktree add ...",
    stderr: Buffer.from("fatal: invalid reference: missing-branch\n")
  });

  assert.equal(message, "fatal: invalid reference: missing-branch");
});

test("commandErrorMessage redacts tokens from fallback error messages", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");

  const message = sandboxCreate.commandErrorMessage({
    message: "Command failed: docker run -e GH_TOKEN=ghp_123456789012345678901234567890123456"
  });

  assert.doesNotMatch(message, /ghp_123456789012345678901234567890123456/);
  assert.match(message, /\[REDACTED github token\]/);
});

test("runVerbose error messages do not include argv", () => {
  assert.throws(
    () => runVerbose(process.execPath, ["-e", "process.exit(1)", "SECRET_ARG_VALUE"]),
    (error) => {
      const thrown = assertError(error);
      assert.match(thrown.message, /^Command failed with exit code 1:/);
      assert.doesNotMatch(thrown.message, /SECRET_ARG_VALUE/);
      return true;
    }
  );
});

test("runVerbose timeout messages do not include argv", () => {
  assert.throws(
    () => runVerbose(process.execPath, ["-e", "setTimeout(() => {}, 10_000)", "SECRET_TIMEOUT_VALUE"], {
      timeout: 1
    }),
    (error) => {
      const thrown = assertError(error);
      assert.match(thrown.message, /^Command timed out after 1ms:/);
      assert.doesNotMatch(thrown.message, /SECRET_TIMEOUT_VALUE/);
      return true;
    }
  );
});

test("ensureSandboxAliasesFile creates the default aliases once", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-aliases-defaults-"));

  try {
    const created = sandboxCreate.ensureSandboxAliasesFile(tmpDir);
    assert.equal(created.created, true);
    assert.equal(created.path, path.join(tmpDir, ".agent-infra", "aliases", "sandbox.sh"));

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

test("ensureSandboxAliasesFile creates parent directories for the consolidated alias path", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-aliases-nested-"));

  try {
    const { path: aliasesPath } = sandboxCreate.ensureSandboxAliasesFile(tmpDir);

    assert.equal(fs.existsSync(path.dirname(aliasesPath)), true);
    assert.equal(fs.existsSync(aliasesPath), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureSandboxAliasesFile upgrades legacy generated alias files", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-aliases-upgrade-"));
  const aliasesPath = path.join(tmpDir, ".agent-infra", "aliases", "sandbox.sh");
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
    fs.mkdirSync(path.dirname(aliasesPath), { recursive: true });
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
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
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
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-aliases-opencode-upgrade-full-yolo-"));
  const aliasesPath = path.join(tmpDir, ".agent-infra", "aliases", "sandbox.sh");

  try {
    fs.mkdirSync(path.dirname(aliasesPath), { recursive: true });
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

test("ensureDocker uses Colima verbose commands for install and startup", async () => {
  const sandboxEngine = await loadFreshEsm<SandboxEngineModule>("lib/sandbox/engine.js");
  const messages: string[] = [];
  const verboseCalls: string[][] = [];
  const checks: string[][] = [];
  const previousDockerContext = process.env.DOCKER_CONTEXT;

  try {
    delete process.env.DOCKER_CONTEXT;

    await sandboxEngine.ensureDocker(
      { engine: "colima", vm: { cpu: 4, memory: 8, disk: 60 } },
      (message) => messages.push(message),
      {
        platformFn: () => "darwin",
        runOkFn(cmd: string, args: string[]) {
          checks.push([cmd, ...args]);
          assert.equal(process.env.DOCKER_CONTEXT, "colima");
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
        runSafeFn(cmd: string, args: string[]) {
          assert.equal(cmd, "uname");
          assert.deepEqual(args, ["-m"]);
          return "arm64";
        },
        runVerboseFn(cmd: string, args: string[]) {
          verboseCalls.push([cmd, ...args]);
        }
      }
    );

    assert.equal(process.env.DOCKER_CONTEXT, "colima");
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
  } finally {
    restoreDockerContext(previousDockerContext);
  }
});

test("detectEngine honors configured engine across platforms", async () => {
  const sandboxEngine = await loadFreshEsm<SandboxEngineModule>("lib/sandbox/engine.js");
  const cases: Array<[string, string]> = [
    ["linux", "native"],
    ["linux", "docker-desktop"],
    ["darwin", "orbstack"],
    ["darwin", "colima"],
    ["darwin", "docker-desktop"],
    ["win32", "wsl2"],
    ["win32", "native"],
    ["win32", "docker-desktop"]
  ];

  for (const [platformName, engine] of cases) {
    assert.equal(
      sandboxEngine.detectEngine({ engine }, { platformFn: () => platformName }),
      engine,
      `${platformName} should honor ${engine}`
    );
  }
});

test("detectEngine rejects unsupported configured sandbox engines early", async () => {
  const sandboxEngine = await loadFreshEsm<SandboxEngineModule>("lib/sandbox/engine.js");

  assert.throws(
    () => sandboxEngine.detectEngine({ engine: "podman" }, { platformFn: () => "darwin" }),
    /invalid "sandbox\.engine" value "podman".*unknown sandbox engine.*Valid engines:.*colima.*orbstack.*docker-desktop.*native.*wsl2/s
  );
  assert.throws(
    () => sandboxEngine.detectEngine({ engine: "colima" }, { platformFn: () => "linux" }),
    (error) => {
      const thrown = assertError(error);
      assert.match(thrown.message, /"sandbox\.engine" value "colima" is not supported on linux/);
      assert.match(thrown.message, /Supported engines on linux:/);
      assert.match(thrown.message, /native/);
      assert.match(thrown.message, /docker-desktop/);
      return true;
    }
  );
});

test("detectEngine throws an actionable error on unsupported platforms", async () => {
  const sandboxEngine = await loadFreshEsm<SandboxEngineModule>("lib/sandbox/engine.js");

  assert.throws(
    () => sandboxEngine.detectEngine({}, { platformFn: () => "freebsd" }),
    (error) => {
      const thrown = assertError(error);
      assert.match(thrown.message, /freebsd/);
      assert.match(thrown.message, /linux \(native\)/);
      assert.match(thrown.message, /darwin \(colima/);
      assert.match(thrown.message, /win32 \(wsl2\)/);
      assert.match(thrown.message, /agent-infra\/issues\/new/);
      return true;
    }
  );
  assert.throws(
    () => sandboxEngine.detectEngine({ engine: "native" }, { platformFn: () => "freebsd" }),
    /"sandbox\.engine" value "native" is not supported on freebsd.*Supported engines on freebsd: none/s
  );
});

test("isVmManaged returns false on unsupported platforms instead of throwing", async () => {
  const sandboxEngine = await loadFreshEsm<SandboxEngineModule>("lib/sandbox/engine.js");

  assert.equal(sandboxEngine.isVmManaged({}, { platformFn: () => "freebsd" }), false);
  assert.equal(sandboxEngine.isVmManaged({ engine: "native" }, { platformFn: () => "freebsd" }), false);
});

test("isVmManaged keeps invalid sandbox engine config errors actionable", async () => {
  const sandboxEngine = await loadFreshEsm<SandboxEngineModule>("lib/sandbox/engine.js");

  assert.throws(
    () => sandboxEngine.isVmManaged({ engine: "podman" }, { platformFn: () => "darwin" }),
    /invalid "sandbox\.engine" value "podman".*unknown sandbox engine.*Valid engines:.*colima.*orbstack.*docker-desktop.*native.*wsl2/s
  );
});

test("detectEngine returns platform default when no engine is configured", async () => {
  const sandboxEngine = await loadFreshEsm<SandboxEngineModule>("lib/sandbox/engine.js");

  assert.equal(sandboxEngine.detectEngine({ engine: null }, { platformFn: () => "linux" }), "native");
  assert.equal(sandboxEngine.detectEngine({}, { platformFn: () => "linux" }), "native");
  assert.equal(sandboxEngine.detectEngine({ engine: null }, { platformFn: () => "darwin" }), "colima");
  assert.equal(sandboxEngine.detectEngine({}, { platformFn: () => "darwin" }), "colima");
  assert.equal(sandboxEngine.detectEngine({ engine: null }, { platformFn: () => "win32" }), "wsl2");
  assert.equal(sandboxEngine.detectEngine({}, { platformFn: () => "win32" }), "wsl2");
});

test("detectEngine does not apply Docker context", async () => {
  const sandboxEngine = await loadFreshEsm<SandboxEngineModule>("lib/sandbox/engine.js");
  const previousDockerContext = process.env.DOCKER_CONTEXT;

  try {
    process.env.DOCKER_CONTEXT = "existing-context";

    assert.equal(
      sandboxEngine.detectEngine({ engine: null }, { platformFn: () => "linux" }),
      "native"
    );
    assert.equal(process.env.DOCKER_CONTEXT, "existing-context");
  } finally {
    restoreDockerContext(previousDockerContext);
  }
});

test("sandbox engine adapters expose the required shape", async () => {
  const sandboxEngines = await loadFreshEsm<EnginesIndexModule>("lib/sandbox/engines/index.js");
  const knownPlatforms = new Set(["linux", "darwin", "win32"]);

  for (const adapter of Object.values(sandboxEngines.ADAPTERS)) {
    assert.equal(typeof adapter.id, "string");
    assert.equal(typeof adapter.displayName, "string");
    assert.ok(Array.isArray(adapter.supportedPlatforms));
    assert.ok(adapter.supportedPlatforms.length > 0);
    for (const platformName of adapter.supportedPlatforms) {
      assert.equal(typeof platformName, "string");
      assert.ok(knownPlatforms.has(platformName), `${adapter.id} has unexpected platform ${platformName}`);
    }
    assert.ok(adapter.dockerContext === null || typeof adapter.dockerContext === "string");
    assert.equal(typeof adapter.managed, "boolean");
    assert.match(adapter.canApplyResources, /^(hot|on-start|never)$/);
    assert.equal(typeof adapter.defaultResources, "function");
    assert.equal(typeof adapter.ensure, "function");
    assert.equal(typeof adapter.syncResources, "function");
    if (adapter.managed) {
      assert.equal(typeof adapter.startVm, "function");
      assert.equal(typeof adapter.stopVm, "function");
    }
  }
});

test("validateSandboxEngine accepts platform-supported engines", async () => {
  const sandboxEngine = await loadFreshEsm<SandboxEngineModule>("lib/sandbox/engine.js");
  const cases = [
    ["linux", "native"],
    ["linux", "docker-desktop"],
    ["darwin", "colima"],
    ["darwin", "orbstack"],
    ["darwin", "docker-desktop"],
    ["win32", "wsl2"],
    ["win32", "native"],
    ["win32", "docker-desktop"]
  ];

  for (const [platformName, engine] of cases) {
    assert.equal(
      sandboxEngine.validateSandboxEngine(engine, { platformFn: () => platformName }),
      engine,
      `${platformName} should accept ${engine}`
    );
  }
});

test("enginesForPlatform returns correct engine sets per platform", async () => {
  const sandboxEngines = await loadFreshEsm<EnginesIndexModule>("lib/sandbox/engines/index.js");

  assert.deepEqual(sandboxEngines.enginesForPlatform("linux").sort(), ["docker-desktop", "native"]);
  assert.deepEqual(
    sandboxEngines.enginesForPlatform("darwin").sort(),
    ["colima", "docker-desktop", "orbstack"]
  );
  assert.deepEqual(
    sandboxEngines.enginesForPlatform("win32").sort(),
    ["docker-desktop", "native", "wsl2"]
  );
  assert.deepEqual(sandboxEngines.enginesForPlatform("freebsd"), []);
});

test("resolveEffectiveVm merges adapter defaults without changing user values", async () => {
  const sandboxEngine = await loadFreshEsm<SandboxEngineModule>("lib/sandbox/engine.js");
  const colimaAdapter = {
    defaultResources(getHost: () => { cpu: number; memory: number }) {
      const host = getHost();
      return { cpu: host.cpu, memory: host.memory, disk: 60 };
    }
  };
  let detectCalls = 0;
  const orbStackAdapter = {
    defaultResources() {
      return null;
    }
  };
  const host = { cpu: 6, memory: 8 };

  assert.deepEqual(
    sandboxEngine.resolveEffectiveVm(colimaAdapter, {}, { detectHostResourcesFn: () => host }),
    { cpu: 6, memory: 8, disk: 60 }
  );
  assert.deepEqual(
    sandboxEngine.resolveEffectiveVm(colimaAdapter, { cpu: 4 }, { detectHostResourcesFn: () => host }),
    { cpu: 4, memory: 8, disk: 60 }
  );
  assert.deepEqual(
    sandboxEngine.resolveEffectiveVm(orbStackAdapter, {}, {
      detectHostResourcesFn: () => {
        detectCalls += 1;
        return host;
      }
    }),
    { cpu: null, memory: null, disk: null }
  );
  assert.equal(detectCalls, 0);
});

test("hasUserVmConfig recognizes only explicit resource values", async () => {
  const sandboxEngine = await loadFreshEsm<SandboxEngineModule>("lib/sandbox/engine.js");

  assert.equal(sandboxEngine.hasUserVmConfig({}), false);
  assert.equal(sandboxEngine.hasUserVmConfig({ cpu: null }), false);
  assert.equal(sandboxEngine.hasUserVmConfig({ cpu: 4 }), true);
  assert.equal(sandboxEngine.hasUserVmConfig({ memory: 8 }), true);
  assert.equal(sandboxEngine.hasUserVmConfig({ disk: 60 }), true);
});

test("Colima adapter warns when resource values change while VM is already running", async () => {
  const { colimaAdapter } = await loadFreshEsm<AdapterModule<"colima">>("lib/sandbox/engines/colima.js");
  const messages: string[] = [];

  assert.deepEqual(colimaAdapter.defaultResources(() => ({ cpu: 6, memory: 8 })), {
    cpu: 6,
    memory: 8,
    disk: 60
  });

  colimaAdapter.syncResources(
    { userVm: { cpu: 4 }, hasUserVmConfig: (vm) => vm?.cpu != null },
    (message: string) => messages.push(message),
    {},
    { vmJustStarted: true }
  );
  assert.equal(messages.length, 0);

  colimaAdapter.syncResources(
    { userVm: { cpu: 4 }, hasUserVmConfig: (vm) => vm?.cpu != null },
    (message: string) => messages.push(message),
    {},
    { vmJustStarted: false }
  );
  assert.match(messages[0] ?? "", /Colima VM is already running/);
});

test("OrbStack adapter hot-applies CPU and memory and warns about disk", async () => {
  const { orbstackAdapter } = await loadFreshEsm<AdapterModule<"orbstack">>("lib/sandbox/engines/orbstack.js");
  const verboseCalls: string[][] = [];
  const messages: string[] = [];

  assert.equal(orbstackAdapter.defaultResources(), null);
  orbstackAdapter.syncResources(
    { vm: { cpu: 4, memory: 8, disk: 60 } },
    (message: string) => messages.push(message),
    {
      runVerbose(cmd: string, args: string[]) {
        verboseCalls.push([cmd, ...args]);
      }
    }
  );

  assert.deepEqual(verboseCalls, [
    ["orb", "config", "set", "cpu", "4"],
    ["orb", "config", "set", "memory_mib", "8192"]
  ]);
  assert.match(messages[0] ?? "", /does not expose a fixed disk size/);
});

test("OrbStack adapter downgrades config failures to warnings", async () => {
  const { orbstackAdapter } = await loadFreshEsm<AdapterModule<"orbstack">>("lib/sandbox/engines/orbstack.js");
  const messages: string[] = [];

  orbstackAdapter.syncResources(
    { vm: { cpu: 4, memory: null, disk: null } },
    (message) => messages.push(message),
    {
      runVerbose() {
        throw new Error("config failed");
      }
    }
  );

  assert.match(messages[0] ?? "", /failed to apply OrbStack cpu=4/);
});

test("Docker Desktop adapter warns for explicit VM resources only", async () => {
  const { dockerDesktopAdapter } = await loadFreshEsm<AdapterModule<"dockerDesktop">>("lib/sandbox/engines/docker-desktop.js");
  const messages: string[] = [];
  const hasUserVmConfig = (vm: SandboxVmConfigFixture | undefined) => (
    vm?.cpu != null || vm?.memory != null || vm?.disk != null
  );

  dockerDesktopAdapter.syncResources(
    { userVm: { cpu: null }, hasUserVmConfig },
    (message: string) => messages.push(message)
  );
  assert.equal(messages.length, 0);

  dockerDesktopAdapter.syncResources(
    { userVm: { cpu: 4 }, hasUserVmConfig },
    (message: string) => messages.push(message)
  );
  assert.match(messages[0] ?? "", /Docker Desktop manages CPU\/memory\/disk/);
});

test("native adapter warns that VM resources are not applicable", async () => {
  const { nativeAdapter } = await loadFreshEsm<NativeModule>("lib/sandbox/engines/native.js");
  const messages: string[] = [];

  nativeAdapter.syncResources(
    { userVm: { memory: 8 }, hasUserVmConfig: (vm) => vm?.memory != null },
    (message: string) => messages.push(message)
  );

  assert.match(messages[0] ?? "", /Linux native Docker has no managed VM/);
});

test("WSL2 adapter validates Docker Desktop integration and warns on explicit VM resources", async () => {
  const { wsl2Adapter } = await loadFreshEsm<AdapterModule<"wsl2">>("lib/sandbox/engines/wsl2.js");
  const checks: string[][] = [];
  const messages: string[] = [];

  assert.equal(wsl2Adapter.defaultResources(), null);
  await wsl2Adapter.ensure(
    {
      userVm: { cpu: 2, memory: null, disk: null },
      hasUserVmConfig(vm: SandboxVmConfigFixture | undefined) {
        return vm?.cpu != null || vm?.memory != null || vm?.disk != null;
      }
    },
    (message: string) => messages.push(message),
    {
      runOk(cmd: string, args: string[]) {
        checks.push([cmd, ...args]);
        return cmd === "wsl.exe" && (args[0] === "--status" || args[1] === "docker");
      }
    }
  );
  wsl2Adapter.syncResources(
    {
      userVm: { cpu: 2, memory: null, disk: null },
      hasUserVmConfig(vm: SandboxVmConfigFixture | undefined) {
        return vm?.cpu != null || vm?.memory != null || vm?.disk != null;
      }
    },
    (message: string) => messages.push(message)
  );

  assert.deepEqual(checks, [
    ["wsl.exe", "--status"],
    ["wsl.exe", "--", "docker", "info"]
  ]);
  assert.match(messages[0] ?? "", /Checking Docker Desktop from WSL2/);
  assert.match(messages[1] ?? "", /Docker Desktop manages CPU\/memory\/disk/);
  assert.throws(() => wsl2Adapter.stopVm(), /wsl --shutdown/);
});

test("ensureDocker installs OrbStack and starts the Docker daemon", async () => {
  const sandboxEngine = await loadFreshEsm<SandboxEngineModule>("lib/sandbox/engine.js");
  const messages: string[] = [];
  const verboseCalls: string[][] = [];
  const checks: string[][] = [];
  let dockerInfoChecks = 0;
  const previousDockerContext = process.env.DOCKER_CONTEXT;

  try {
    delete process.env.DOCKER_CONTEXT;

    await sandboxEngine.ensureDocker(
      { engine: "orbstack", vm: { cpu: null, memory: null, disk: null } },
      (message) => messages.push(message),
      {
        platformFn: () => "darwin",
        runOkFn(cmd: string, args: string[]) {
          checks.push([cmd, ...args]);
          assert.equal(process.env.DOCKER_CONTEXT, "orbstack");
          if (cmd === "which") {
            return false;
          }
          if (cmd === "docker" && args[0] === "info") {
            dockerInfoChecks += 1;
            return dockerInfoChecks > 1;
          }
          throw new Error(`unexpected check: ${cmd} ${args.join(" ")}`);
        },
        runVerboseFn(cmd: string, args: string[]) {
          verboseCalls.push([cmd, ...args]);
        }
      }
    );

    assert.equal(process.env.DOCKER_CONTEXT, "orbstack");
    assert.deepEqual(messages, [
      "Installing OrbStack via Homebrew...",
      "Starting OrbStack..."
    ]);
    assert.deepEqual(verboseCalls, [
      ["brew", "install", "--cask", "orbstack"],
      ["orb", "start"]
    ]);
    assert.deepEqual(checks, [
      ["which", "orb"],
      ["docker", "info"],
      ["docker", "info"]
    ]);
  } finally {
    restoreDockerContext(previousDockerContext);
  }
});

test("ensureDocker reports when Docker Desktop is not running", async () => {
  const sandboxEngine = await loadFreshEsm<SandboxEngineModule>("lib/sandbox/engine.js");
  const previousDockerContext = process.env.DOCKER_CONTEXT;

  try {
    delete process.env.DOCKER_CONTEXT;

    await assert.rejects(
      () => sandboxEngine.ensureDocker({ engine: "docker-desktop" }, null, {
        platformFn: () => "darwin",
        runOkFn(cmd: string, args: string[]) {
          assert.equal(cmd, "docker");
          assert.deepEqual(args, ["info"]);
          assert.equal(process.env.DOCKER_CONTEXT, "desktop-linux");
          return false;
        }
      }),
      /Docker Desktop is not running/
    );
    assert.equal(process.env.DOCKER_CONTEXT, "desktop-linux");
  } finally {
    restoreDockerContext(previousDockerContext);
  }
});

test("ensureDocker applies OrbStack resource flags after daemon checks", async () => {
  const sandboxEngine = await loadFreshEsm<SandboxEngineModule>("lib/sandbox/engine.js");
  const verboseCalls: string[][] = [];

  await sandboxEngine.ensureDocker(
    { engine: "orbstack", vm: { cpu: 4, memory: null, disk: null } },
    null,
    {
      platformFn: () => "darwin",
      runOkFn(cmd: string, args: string[]) {
        if (cmd === "which" && args[0] === "orb") {
          return true;
        }
        if (cmd === "docker" && args[0] === "info") {
          return true;
        }
        throw new Error(`unexpected check: ${cmd} ${args.join(" ")}`);
      },
      runVerboseFn(cmd: string, args: string[]) {
        verboseCalls.push([cmd, ...args]);
      }
    }
  );

  assert.deepEqual(verboseCalls, [["orb", "config", "set", "cpu", "4"]]);
});

test("ensureDocker warns when Docker Desktop cannot apply explicit VM resources", async () => {
  const sandboxEngine = await loadFreshEsm<SandboxEngineModule>("lib/sandbox/engine.js");
  const messages: string[] = [];

  await sandboxEngine.ensureDocker(
    { engine: "docker-desktop", vm: { cpu: 4, memory: null, disk: null } },
    (message) => messages.push(message),
    {
      platformFn: () => "darwin",
      runOkFn(cmd: string, args: string[]) {
        assert.deepEqual([cmd, ...args], ["docker", "info"]);
        return true;
      }
    }
  );

  assert.match(messages[0] ?? "", /Docker Desktop manages CPU\/memory\/disk/);
});

test("ensureDocker throws native install hint when docker is not installed", async () => {
  const sandboxEngine = await loadFreshEsm<SandboxEngineModule>("lib/sandbox/engine.js");

  await assert.rejects(
    () => sandboxEngine.ensureDocker({}, null, {
      platformFn: () => "linux",
      runOkFn(cmd: string, args: string[]) {
        assert.equal(cmd, "which");
        assert.deepEqual(args, ["docker"]);
        return false;
      },
      runSafeFn() {
        assert.fail("docker version should not run when docker is missing");
      }
    }),
    /not installed[\s\S]*docs\.docker\.com/
  );
});

test("ensureDocker throws native daemon-down hint when docker info fails and version returns nothing", async () => {
  const sandboxEngine = await loadFreshEsm<SandboxEngineModule>("lib/sandbox/engine.js");
  const checks: string[][] = [];

  await assert.rejects(
    () => sandboxEngine.ensureDocker({}, null, {
      platformFn: () => "linux",
      runOkFn(cmd: string, args: string[]) {
        checks.push([cmd, ...args]);
        if (cmd === "which") {
          return true;
        }
        if (cmd === "docker" && args[0] === "info") {
          return false;
        }
        throw new Error(`unexpected check: ${cmd} ${args.join(" ")}`);
      },
      runSafeFn(cmd: string, args: string[]) {
        assert.equal(cmd, "docker");
        if (args[0] === "version") {
          assert.deepEqual(args, ["version", "--format", "{{.Server.Version}}"]);
          return "";
        }
        assert.deepEqual(args, ["info", "--format", "{{.SecurityOptions}}"]);
        return "";
      }
    }),
    /daemon is not running[\s\S]*systemctl start docker[\s\S]*DOCKER_HOST/
  );
  assert.deepEqual(checks, [
    ["which", "docker"],
    ["docker", "info"]
  ]);
});

test("ensureDocker uses rootless-specific hint when rootless daemon is unreachable", async () => {
  const sandboxEngine = await loadFreshEsm<SandboxEngineModule>("lib/sandbox/engine.js");
  const previousDockerHost = process.env.DOCKER_HOST;
  process.env.DOCKER_HOST = "unix:///run/user/1000/docker.sock";

  try {
    await assert.rejects(
      () => sandboxEngine.ensureDocker({}, null, {
        platformFn: () => "linux",
        runOkFn(cmd: string, args: string[]) {
          if (cmd === "which") {
            return true;
          }
          if (cmd === "docker" && args[0] === "info") {
            return false;
          }
          throw new Error(`unexpected check: ${cmd} ${args.join(" ")}`);
        },
        runSafeFn(cmd: string, args: string[]) {
          assert.equal(cmd, "docker");
          assert.deepEqual(args, ["version", "--format", "{{.Server.Version}}"]);
          return "";
        }
      }),
      /rootless daemon[\s\S]*systemctl --user/
    );
  } finally {
    if (previousDockerHost === undefined) {
      delete process.env.DOCKER_HOST;
    } else {
      process.env.DOCKER_HOST = previousDockerHost;
    }
  }
});

test("ensureDocker uses rootless permission hint when version succeeds but info fails", async () => {
  const sandboxEngine = await loadFreshEsm<SandboxEngineModule>("lib/sandbox/engine.js");

  await assert.rejects(
    () => sandboxEngine.ensureDocker({}, null, {
      platformFn: () => "linux",
      runOkFn(cmd: string, args: string[]) {
        if (cmd === "which") {
          return true;
        }
        if (cmd === "docker" && args[0] === "info") {
          return false;
        }
        throw new Error(`unexpected check: ${cmd} ${args.join(" ")}`);
      },
      runSafeFn(cmd: string, args: string[]) {
        assert.equal(cmd, "docker");
        if (args[0] === "version") {
          assert.deepEqual(args, ["version", "--format", "{{.Server.Version}}"]);
          return "25.0.0";
        }
        assert.deepEqual(args, ["info", "--format", "{{.SecurityOptions}}"]);
        return "[name=rootless,name=seccomp=builtin]";
      }
    }),
    /docker info failed[\s\S]*XDG_RUNTIME_DIR/
  );
});

test("ensureDocker throws native permission hint when docker info fails but version succeeds", async () => {
  const sandboxEngine = await loadFreshEsm<SandboxEngineModule>("lib/sandbox/engine.js");

  await assert.rejects(
    () => sandboxEngine.ensureDocker({}, null, {
      platformFn: () => "linux",
      runOkFn(cmd: string, args: string[]) {
        if (cmd === "which") {
          return true;
        }
        if (cmd === "docker" && args[0] === "info") {
          return false;
        }
        throw new Error(`unexpected check: ${cmd} ${args.join(" ")}`);
      },
      runSafeFn(cmd: string, args: string[]) {
        assert.equal(cmd, "docker");
        if (args[0] === "version") {
          assert.deepEqual(args, ["version", "--format", "{{.Server.Version}}"]);
          return "25.0.0";
        }
        assert.deepEqual(args, ["info", "--format", "{{.SecurityOptions}}"]);
        return "";
      }
    }),
    /lack permission[\s\S]*usermod -aG docker/
  );
});

test("ensureManagedVm gives Linux-specific message for native engine", async () => {
  const sandboxVm = await loadFreshEsm<typeof import("../../lib/sandbox/commands/vm.ts")>("lib/sandbox/commands/vm.js");

  assert.throws(
    () => sandboxVm.ensureManagedVm("native"),
    /does not use a managed VM/
  );
});

test("ensureManagedVm points Docker Desktop users to the GUI", async () => {
  const sandboxVm = await loadFreshEsm<typeof import("../../lib/sandbox/commands/vm.ts")>("lib/sandbox/commands/vm.js");

  assert.throws(
    () => sandboxVm.ensureManagedVm("docker-desktop"),
    /VM management is unavailable[\s\S]*Docker Desktop is managed via its GUI/
  );
});

test("startManagedVm uses OrbStack status instead of Docker daemon state", async () => {
  const sandboxEngine = await loadFreshEsm<SandboxEngineModule>("lib/sandbox/engine.js");
  const checks: string[][] = [];
  const verboseCalls: string[][] = [];

  const result = sandboxEngine.startManagedVm(
    { engine: "orbstack" },
    {
      platformFn: () => "darwin",
      runOkFn(cmd: string, args: string[]) {
        checks.push([cmd, ...args]);
        if (cmd === "docker") {
          throw new Error("docker info must not decide explicit OrbStack VM state");
        }
        return false;
      },
      runVerboseFn(cmd: string, args: string[]) {
        verboseCalls.push([cmd, ...args]);
      }
    }
  );

  assert.equal(result, "started");
  assert.deepEqual(checks, [["orb", "status"]]);
  assert.deepEqual(verboseCalls, [["orb", "start"]]);
});

test("startManagedVm applies OrbStack resources while leaving a running VM alone", async () => {
  const sandboxEngine = await loadFreshEsm<SandboxEngineModule>("lib/sandbox/engine.js");
  const verboseCalls: string[][] = [];

  const result = sandboxEngine.startManagedVm(
    { engine: "orbstack", vm: { cpu: 2, memory: null, disk: null } },
    {
      platformFn: () => "darwin",
      runOkFn(cmd: string, args: string[]) {
        assert.deepEqual([cmd, ...args], ["orb", "status"]);
        return true;
      },
      runVerboseFn(cmd: string, args: string[]) {
        verboseCalls.push([cmd, ...args]);
      }
    }
  );

  assert.equal(result, "already-running");
  assert.deepEqual(verboseCalls, [["orb", "config", "set", "cpu", "2"]]);
});

test("stopManagedVm reports unsupported engines instead of silently returning", async () => {
  const sandboxEngine = await loadFreshEsm<SandboxEngineModule>("lib/sandbox/engine.js");

  assert.throws(
    () => sandboxEngine.stopManagedVm(
      { engine: "docker-desktop" },
      { platformFn: () => "darwin", runFn: () => assert.fail("unexpected stop command") }
    ),
    /VM management is unavailable for engine 'Docker Desktop'/
  );
});

test("stopManagedVm does not change the current Docker context", async () => {
  const sandboxEngine = await loadFreshEsm<SandboxEngineModule>("lib/sandbox/engine.js");
  const previousDockerContext = process.env.DOCKER_CONTEXT;

  try {
    process.env.DOCKER_CONTEXT = "existing-context";

    const result = sandboxEngine.stopManagedVm(
      { engine: "orbstack" },
      {
        platformFn: () => "darwin",
        runFn(cmd: string, args: string[]) {
          assert.deepEqual([cmd, ...args], ["orb", "stop"]);
        }
      }
    );

    assert.equal(result, "stopped");
    assert.equal(process.env.DOCKER_CONTEXT, "existing-context");
  } finally {
    restoreDockerContext(previousDockerContext);
  }
});

test("isVmManaged and engineDisplayName describe supported engines", async () => {
  const sandboxEngine = await loadFreshEsm<SandboxEngineModule>("lib/sandbox/engine.js");
  const macDependencies = { platformFn: () => "darwin" };

  assert.equal(sandboxEngine.isVmManaged({ engine: "colima" }, macDependencies), true);
  assert.equal(sandboxEngine.isVmManaged({ engine: "orbstack" }, macDependencies), true);
  assert.equal(sandboxEngine.isVmManaged({ engine: "docker-desktop" }, macDependencies), false);
  assert.equal(sandboxEngine.isVmManaged({}, { platformFn: () => "win32" }), true);
  assert.equal(sandboxEngine.engineDisplayName("orbstack"), "OrbStack");
  assert.equal(sandboxEngine.engineDisplayName("docker-desktop"), "Docker Desktop");
  assert.equal(sandboxEngine.engineDisplayName("wsl2"), "WSL2");
});

test("hostHasGpgKeys reports whether the host keyring is available", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");

  assert.equal(sandboxCreate.hostHasGpgKeys("/Users/demo", () => "sec:u:255:22:ABCDEF:1700000000:0::::::23::0:\n"), true);
  assert.equal(sandboxCreate.hostHasGpgKeys("/Users/demo", () => {
    throw new Error("gpg failed");
  }), false);
});

test("ensureShellConfigSymlinks runs a single docker exec wiring all four $HOME entries", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const calls: Array<{ engine: string; cmd: string; args: string[] }> = [];
  const fakeExec = (engine: string, cmd: string, args: string[]) => {
    calls.push({ engine, cmd, args });
    return "";
  };

  sandboxCreate.ensureShellConfigSymlinks("docker", "agent-infra-dev-demo", fakeExec);

  assert.equal(calls.length, 1, "single docker exec");
  const call = required(calls[0]);
  assert.equal(call.engine, "docker");
  assert.equal(call.cmd, "docker");
  assert.deepEqual(call.args.slice(0, 4), [
    "exec",
    "agent-infra-dev-demo",
    "bash",
    "-lc"
  ]);
  const script = required(call.args[4]);
  for (const file of [".gitconfig", ".gitignore_global", ".stCommitMsg", ".bash_aliases"]) {
    assert.match(
      script,
      new RegExp(`ln -sf \\.host-shell-config/${file.replace(".", "\\.")} /home/devuser/${file.replace(".", "\\.")}`),
      `script wires ${file}`
    );
  }
});

test("prepareHostShellConfig writes sanitized config files and returns read-only mount metadata", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-host-shell-config-"));

  try {
    fs.writeFileSync(path.join(tmpDir, ".gitconfig"), [
      "[commit]",
      "  gpgsign = true",
      "[user]",
      `  signingKey = ${tmpDir}/.gnupg/pubring.kbx`,
      "[gpg]",
      "  program = /opt/homebrew/bin/gpg",
      "[core]",
      `  excludesfile = ${tmpDir}/.gitignore_global`,
      ""
    ].join("\n"), "utf8");
    fs.writeFileSync(path.join(tmpDir, ".gitignore_global"), "node_modules/\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, ".stCommitMsg"), "feat: demo\n", "utf8");
    const aliases = sandboxCreate.ensureSandboxAliasesFile(tmpDir);

    const prepared = sandboxCreate.prepareHostShellConfig({
      home: tmpDir,
      project: "demo",
      branch: "feature/demo",
      repoRoot: "/repo"
    });

    assert.equal(
      prepared.hostDir,
      path.join(tmpDir, ".agent-infra", "config", "demo", "feature..demo")
    );
    assert.deepEqual(prepared.mounts, [
      {
        hostPath: prepared.hostDir,
        containerPath: "/home/devuser/.host-shell-config"
      }
    ]);
    for (const file of [".gitconfig", ".gitignore_global", ".stCommitMsg", ".bash_aliases"]) {
      assert.equal(
        fs.existsSync(path.join(prepared.hostDir, file)),
        true,
        `${file} present in host dir`
      );
    }
    assert.deepEqual(
      fs.readFileSync(path.join(prepared.hostDir, ".gitconfig"), "utf8").split("\n").filter(Boolean),
      [
        "[commit]",
        "[user]",
        "[core]",
        "  excludesfile = /home/devuser/.gitignore_global",
        "[safe]",
        "\tdirectory = /workspace",
        "\tdirectory = /repo"
      ]
    );
    assert.equal(
      fs.readFileSync(path.join(prepared.hostDir, ".bash_aliases"), "utf8"),
      fs.readFileSync(aliases.path, "utf8")
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("prepareHostShellConfig writes a minimal .gitconfig with safe.directory entries when the host has none", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-host-shell-config-no-gitconfig-"));

  try {
    // Intentionally do NOT create tmpDir/.gitconfig — simulate a host without one.
    sandboxCreate.ensureSandboxAliasesFile(tmpDir);

    const prepared = sandboxCreate.prepareHostShellConfig({
      home: tmpDir,
      project: "demo",
      branch: "feature/demo",
      repoRoot: "/repo"
    });

    const gitconfigPath = path.join(prepared.hostDir, ".gitconfig");
    assert.equal(
      fs.existsSync(gitconfigPath),
      true,
      "sandbox .gitconfig is produced even without a host .gitconfig"
    );
    const lines = fs.readFileSync(gitconfigPath, "utf8").split("\n").filter(Boolean);
    assert.deepEqual(lines, [
      "[safe]",
      "\tdirectory = /workspace",
      "\tdirectory = /repo"
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("prepareHostShellConfig removes stale files from the previous host config snapshot", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-host-shell-config-cleanup-"));
  const hostDir = path.join(tmpDir, ".agent-infra", "config", "demo", "feature..demo");

  try {
    fs.mkdirSync(hostDir, { recursive: true });
    fs.writeFileSync(path.join(hostDir, ".stCommitMsg"), "stale\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, ".gitconfig"), "[user]\n  name = Demo User\n", "utf8");
    sandboxCreate.ensureSandboxAliasesFile(tmpDir);

    const prepared = sandboxCreate.prepareHostShellConfig({
      home: tmpDir,
      project: "demo",
      branch: "feature/demo",
      repoRoot: "/repo"
    });

    assert.equal(fs.existsSync(path.join(prepared.hostDir, ".stCommitMsg")), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("detectGpgConfig identifies host gitconfig that requires GPG support", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");

  assert.equal(sandboxCreate.detectGpgConfig("[commit]\n  gpgsign = true\n"), true);
  assert.equal(sandboxCreate.detectGpgConfig("[gpg]\n  program = /opt/homebrew/bin/gpg\n"), true);
  assert.equal(sandboxCreate.detectGpgConfig("[gpg \"ssh\"]\n  program = /opt/homebrew/bin/ssh-keygen\n"), true);
  assert.equal(sandboxCreate.detectGpgConfig("[user]\n  name = Demo User\n"), false);
});

test("sanitizeGitConfig rewrites host paths and appends safe.directory entries", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
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

  const sanitized = sandboxCreate.sanitizeGitConfig(gitconfig, home, { repoRoot: "/repo" });

  assert.deepEqual(sanitized.split("\n").filter(Boolean), [
    "[user]",
    "  name = Demo User",
    "  signingKey = /home/devuser/.gnupg/pubring.kbx",
    "[gpg]",
    "  format = openpgp",
    "[core]",
    "  excludesfile = /home/devuser/.gitignore_global",
    "[safe]",
    "\tdirectory = /workspace",
    "\tdirectory = /repo"
  ]);
});

test("sanitizeGitConfig rewrites Windows backslash and forward-slash host paths", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const home = "C:\\Users\\demo";
  const gitconfig = [
    "[user]",
    "  name = Demo User",
    "  signingKey = C:\\Users\\demo\\.gnupg\\pubring.kbx",
    "[core]",
    "  excludesfile = C:/Users/demo/.gitignore_global",
    ""
  ].join("\n");

  const sanitized = sandboxCreate.sanitizeGitConfig(gitconfig, home, { repoRoot: "C:\\repo" });

  assert.ok(!sanitized.includes("C:\\Users\\demo"), "backslash home path is rewritten");
  assert.ok(!sanitized.includes("C:/Users/demo"), "forward-slash home path is rewritten");
  assert.ok(sanitized.includes("/home/devuser"), "container home is used");
});

test("sanitizeGitConfig rewrites mixed-form Windows home paths", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const home = "C:\\Users\\demo";
  const gitconfig = [
    "[core]",
    "  excludesfile = C:/Users/demo\\.config\\git\\ignore",
    "[user]",
    "  signingKey = C:/Users/demo\\.gnupg\\pubring.kbx",
    ""
  ].join("\n");

  const sanitized = sandboxCreate.sanitizeGitConfig(gitconfig, home, { repoRoot: "C:\\repo" });

  assert.ok(!sanitized.includes("C:/Users/demo"), "mixed-form home path is rewritten");
  assert.ok(!sanitized.includes("C:\\Users\\demo"), "backslash home path is rewritten");
  assert.match(sanitized, /excludesfile = \/home\/devuser\/\.config\/git\/ignore/);
  assert.match(sanitized, /signingKey = \/home\/devuser\/\.gnupg\/pubring\.kbx/);
});

test("sanitizeGitConfig appends missing safe.directory entries to an existing safe section", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const gitconfig = [
    "[core]",
    "  editor = vim",
    "[safe]",
    "  directory = /workspace",
    "[user]",
    "  name = Demo User",
    ""
  ].join("\n");

  const sanitized = sandboxCreate.sanitizeGitConfig(gitconfig, "/Users/demo", { repoRoot: "/repo" });
  const lines = sanitized.split("\n").filter(Boolean);

  assert.equal(lines.filter((line) => line === "[safe]").length, 1);
  assert.deepEqual(lines, [
    "[core]",
    "  editor = vim",
    "[safe]",
    "  directory = /workspace",
    "\tdirectory = /repo",
    "[user]",
    "  name = Demo User"
  ]);
});

test("sanitizeGitConfig strips GPG settings from non-gpg sections when host keys are unavailable", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const gitconfig = [
    "[commit]",
    "  gpgsign = true",
    "[tag]",
    "  gpgsign = true",
    "[gpg]",
    "  program = /opt/homebrew/bin/gpg",
    "[gpg \"ssh\"]",
    "  allowedSignersFile = ~/.ssh/allowed_signers",
    "[user]",
    "  signingKey = /Users/demo/.gnupg/pubring.kbx",
    "  name = Demo User",
    "[core]",
    "  editor = vim",
    ""
  ].join("\n");

  const sanitized = sandboxCreate.sanitizeGitConfig(gitconfig, "/Users/demo", {
    stripGpg: true,
    repoRoot: "/repo"
  });

  assert.deepEqual(sanitized.split("\n").filter(Boolean), [
    "[commit]",
    "[tag]",
    "[user]",
    "  name = Demo User",
    "[core]",
    "  editor = vim",
    "[safe]",
    "\tdirectory = /workspace",
    "\tdirectory = /repo"
  ]);
});

test("writeSanitizedGitconfig rewrites the mounted gitconfig without replacing the inode", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-write-sanitized-gitconfig-"));
  const hostConfigDir = path.join(tmpDir, ".agent-infra", "config", "demo", "feature..demo");

  try {
    fs.writeFileSync(path.join(tmpDir, ".gitconfig"), "[user]\n  name = Demo User\n", "utf8");
    const targetPath = sandboxCreate.writeSanitizedGitconfig({
      home: tmpDir,
      hostConfigDir,
      stripGpg: true,
      repoRoot: "/repo"
    });
    const inodeBefore = fs.statSync(targetPath).ino;

    fs.writeFileSync(path.join(tmpDir, ".gitconfig"), "[user]\n  name = Updated User\n", "utf8");
    const rewrittenPath = sandboxCreate.writeSanitizedGitconfig({
      home: tmpDir,
      hostConfigDir,
      stripGpg: false,
      repoRoot: "/repo"
    });
    const inodeAfter = fs.statSync(rewrittenPath).ino;

    assert.equal(rewrittenPath, targetPath);
    assert.equal(inodeAfter, inodeBefore);
    assert.deepEqual(fs.readFileSync(rewrittenPath, "utf8").split("\n").filter(Boolean), [
      "[user]",
      "  name = Updated User",
      "[safe]",
      "\tdirectory = /workspace",
      "\tdirectory = /repo"
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncGpgKeys returns false when the host has no public keys to import", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-no-public-"));
  const calls: CommandCall[] = [];

  try {
    const synced = sandboxCreate.syncGpgKeys("demo-container", tmpDir, "demo", (cmd: string, args: string[], options: CommandOptions = {}) => {
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
    const gitCall = required(calls[0]);
    const gpgCall = required(calls[1]);
    assert.equal(gitCall[0], "git");
    assert.deepEqual(gitCall[1], ["config", "--global", "user.signingKey"]);
    assert.equal(gitCall[2]?.env?.HOME, tmpDir);
    assert.equal(gpgCall[0], "gpg");
    assert.deepEqual(gpgCall[1], ["--export"]);
    assert.equal(gpgCall[2]?.env?.HOME, tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("currentKeyringFingerprint hashes the current secret keyring", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const output = "sec:u:255:22:ABCDEF1234567890:1700000000:0::::::23::0:\n";

  const fingerprint = sandboxCreate.currentKeyringFingerprint("/Users/demo", (cmd: string, args: string[], options: CommandOptions = {}) => {
    assert.equal(cmd, "gpg");
    assert.deepEqual(args, ["--list-secret-keys", "--with-colons"]);
    assert.equal(options.encoding, "utf8");
    assert.equal(options.env?.HOME, "/Users/demo");
    return output;
  });

  assert.equal(fingerprint, createHash("sha256").update(output).digest("hex"));
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
});

test("currentKeyringFingerprint returns null when gpg listing fails", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");

  const fingerprint = sandboxCreate.currentKeyringFingerprint("/Users/demo", () => {
    throw new Error("gpg failed");
  });

  assert.equal(fingerprint, null);
});

test("currentKeyringFingerprint returns null for an empty keyring listing", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");

  const fingerprint = sandboxCreate.currentKeyringFingerprint("/Users/demo", () => "   \n");

  assert.equal(fingerprint, null);
});

test("getGitSigningKey returns the configured signing key", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");

  const signingKey = sandboxCreate.getGitSigningKey({
    home: "/Users/demo",
    execFn(cmd: string, args: string[], options: CommandOptions = {}) {
      assert.equal(cmd, "git");
      assert.deepEqual(args, ["config", "--global", "user.signingKey"]);
      assert.equal(options.encoding, "utf8");
      assert.equal(options.env?.HOME, "/Users/demo");
      return "8246B1E31A62A1D6\n";
    }
  });

  assert.equal(signingKey, "8246B1E31A62A1D6");
});

test("getGitSigningKey reads repo-local signingKey when a worktree path is provided", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-signing-key-local-"));
  const repoDir = path.join(tmpDir, "repo");
  const homeDir = path.join(tmpDir, "home");

  try {
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    execSync("git init", { cwd: repoDir, env: gitSafeEnv(), stdio: "pipe" });
    execSync("git config user.signingKey LOCAL-KEY-123", {
      cwd: repoDir,
      env: gitSafeEnv(),
      stdio: "pipe"
    });

    const signingKey = withGitSafeProcessEnv(() => (
      sandboxCreate.getGitSigningKey({ repoPath: repoDir, home: homeDir })
    ));

    assert.equal(signingKey, "LOCAL-KEY-123");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("getGitSigningKey returns null when git config lookup fails", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");

  const signingKey = sandboxCreate.getGitSigningKey({
    home: "/Users/demo",
    execFn() {
      throw new Error("git config failed");
    }
  });

  assert.equal(signingKey, null);
});

test("getGitSigningKey returns null for empty output", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");

  const signingKey = sandboxCreate.getGitSigningKey({
    home: "/Users/demo",
    execFn: () => "   \n"
  });

  assert.equal(signingKey, null);
});

test("readGpgCache returns null when the cache does not exist", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
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
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-cache-missing-state-"));
  const cacheDir = path.join(tmpDir, ".agent-infra", "gpg-cache", "demo");

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
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-cache-hit-"));
  const cacheDir = path.join(tmpDir, ".agent-infra", "gpg-cache", "demo");
  const listing = "sec:u:255:22:ABCDEF1234567890:1700000000:0::::::23::0:\n";
  const fingerprint = createHash("sha256").update(listing).digest("hex");

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "public.asc"), "pub");
    fs.writeFileSync(path.join(cacheDir, "secret.asc"), "sec");
    fs.writeFileSync(path.join(cacheDir, "state.json"), `${JSON.stringify({ fingerprint })}\n`, "utf8");

    const cache = sandboxCreate.readGpgCache(tmpDir, "demo", (cmd: string, args: string[]) => {
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
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-cache-stale-"));
  const cacheDir = path.join(tmpDir, ".agent-infra", "gpg-cache", "demo");

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
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-cache-signing-key-stale-"));
  const cacheDir = path.join(tmpDir, ".agent-infra", "gpg-cache", "demo");
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
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-cache-write-"));
  const cacheDir = path.join(tmpDir, ".agent-infra", "gpg-cache", "demo");

  try {
    const written = sandboxCreate.writeGpgCache(
      tmpDir,
      "demo",
      Buffer.from("pub"),
      Buffer.from("sec"),
      "fingerprint-1"
    );

    assert.equal(written, true);
    assertModeBits(cacheDir, 0o700);
    assertModeBits(path.join(cacheDir, "public.asc"), 0o600);
    assertModeBits(path.join(cacheDir, "secret.asc"), 0o600);
    assertModeBits(path.join(cacheDir, "state.json"), 0o600);
    assert.equal(fs.readFileSync(path.join(cacheDir, "state.json"), "utf8"), '{\n  "fingerprint": "fingerprint-1"\n}\n');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("writeGpgCache stores the signingKey used to build the cache", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-cache-write-signing-key-"));
  const cacheDir = path.join(tmpDir, ".agent-infra", "gpg-cache", "demo");

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
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const calls: CommandCall[] = [];
  const providedCache = {
    pub: Buffer.from("pub-from-caller"),
    sec: Buffer.from("sec-from-caller")
  };

  const synced = sandboxCreate.syncGpgKeys(
    "demo-container",
    "/Users/demo",
    "demo",
    (cmd: string, args: string[], options: CommandOptions = {}) => {
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
  assert.deepEqual(required(calls[0])[2], {
    input: Buffer.from("pub-from-caller"),
    stdio: ["pipe", "pipe", "pipe"]
  });
  assert.deepEqual(required(calls[1])[2], {
    input: Buffer.from("sec-from-caller"),
    stdio: ["pipe", "pipe", "pipe"]
  });
});

test("syncGpgKeys invalidates cache when the effective signing key changed", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-sync-signing-key-changed-"));
  const cacheDir = path.join(tmpDir, ".agent-infra", "gpg-cache", "demo");
  const listing = "sec:u:255:22:ABCDEF1234567890:1700000000:0::::::23::0:\n";
  const fingerprint = createHash("sha256").update(listing).digest("hex");
  const calls: CommandCall[] = [];

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
      (cmd: string, args: string[], options: CommandOptions = {}) => {
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
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-sync-cache-hit-"));
  const cacheDir = path.join(tmpDir, ".agent-infra", "gpg-cache", "demo");
  const listing = "sec:u:255:22:ABCDEF1234567890:1700000000:0::::::23::0:\n";
  const fingerprint = createHash("sha256").update(listing).digest("hex");
  const calls: CommandCall[] = [];
  const runSafeCalls: Array<[string, string[]]> = [];

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "public.asc"), "pub");
    fs.writeFileSync(path.join(cacheDir, "secret.asc"), "sec");
    fs.writeFileSync(path.join(cacheDir, "state.json"), `${JSON.stringify({ fingerprint })}\n`, "utf8");

    const synced = sandboxCreate.syncGpgKeys("demo-container", tmpDir, "demo", (cmd: string, args: string[], options: CommandOptions = {}) => {
      calls.push([cmd, args, options]);
      if (cmd === "gpg") {
        assert.deepEqual(args, ["--list-secret-keys", "--with-colons"]);
        return listing;
      }
      if (cmd === "docker" && args.at(-1) === "--import") {
        return Buffer.from("");
      }
      throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
    }, (cmd: string, args: string[]) => {
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
    assert.equal(required(calls[0])[2]?.env?.HOME, tmpDir);
    assert.equal(required(calls[0])[2]?.encoding, "utf8");
    assert.deepEqual(required(calls[2])[2], {
      input: Buffer.from("pub"),
      stdio: ["pipe", "pipe", "pipe"]
    });
    assert.deepEqual(required(calls[3])[2], {
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
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-sync-cache-miss-"));
  const calls: CommandCall[] = [];

  try {
    const synced = sandboxCreate.syncGpgKeys("demo-container", tmpDir, "demo", (cmd: string, args: string[], options: CommandOptions = {}) => {
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
      fs.readFileSync(path.join(tmpDir, ".agent-infra", "gpg-cache", "demo", "public.asc"), "utf8"),
      "pub"
    );
    assert.equal(
      fs.readFileSync(path.join(tmpDir, ".agent-infra", "gpg-cache", "demo", "secret.asc"), "utf8"),
      "sec"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncGpgKeys exports only the configured signing key on a cache miss", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-sync-signing-key-"));
  const calls: CommandCall[] = [];

  try {
    const synced = sandboxCreate.syncGpgKeys("demo-container", tmpDir, "demo", (cmd: string, args: string[], options: CommandOptions = {}) => {
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
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-sync-cache-write-fails-"));
  const cacheDir = path.join(tmpDir, ".agent-infra", "gpg-cache", "demo");
  const calls: CommandCall[] = [];
  const writes: Array<string | Uint8Array> = [];
  const originalWrite = process.stderr.write;

  try {
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
    fs.writeFileSync(cacheDir, "blocking-file");
    process.stderr.write = ((...args: Parameters<typeof process.stderr.write>) => {
      writes.push(args[0]);
      return true;
    }) as typeof process.stderr.write;

    const synced = sandboxCreate.syncGpgKeys("demo-container", tmpDir, "demo", (cmd: string, args: string[], options: CommandOptions = {}) => {
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
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-no-secret-"));
  const calls: CommandCall[] = [];

  try {
    const synced = sandboxCreate.syncGpgKeys("demo-container", tmpDir, "demo", (cmd: string, args: string[], options: CommandOptions = {}) => {
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
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncGpgKeys imports host public and secret keys into the container", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-import-"));
  const calls: CommandCall[] = [];
  const runSafeCalls: Array<[string, string[]]> = [];

  try {
    const synced = sandboxCreate.syncGpgKeys("demo-container", tmpDir, "demo", (cmd: string, args: string[], options: CommandOptions = {}) => {
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
      if (cmd === "gpg" && args[0] === "--list-secret-keys") {
        return "sec:u:255:22:ABCDEF1234567890:1700000000:0::::::23::0:\n";
      }
      if (cmd === "docker" && args.at(-1) === "--import") {
        return Buffer.from("");
      }
      throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
    }, (cmd: string, args: string[]) => {
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
    assert.equal(required(calls[0])[2]?.env?.HOME, tmpDir);
    assert.equal(required(calls[0])[2]?.encoding, "utf8");
    assert.equal(required(calls[1])[2]?.env?.HOME, tmpDir);
    assert.equal(required(calls[3])[2]?.env?.HOME, tmpDir);
    assert.equal(required(calls[3])[2]?.encoding, "utf8");
    assert.deepEqual(required(calls[4])[2], {
      input: Buffer.from("pub"),
      stdio: ["pipe", "pipe", "pipe"]
    });
    assert.deepEqual(required(calls[5])[2], {
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

test("syncGpgKeys can use separate host gpg and engine docker runners", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-engine-docker-"));
  const hostCalls: Array<{ cmd: string; args: string[]; options: CommandOptions }> = [];
  const dockerExecCalls: Array<{ cmd: string; args: string[]; input: string }> = [];
  const dockerSafeCalls: Array<{ cmd: string; args: string[] }> = [];

  try {
    const synced = sandboxCreate.syncGpgKeys(
      "demo-container",
      tmpDir,
      "demo",
      (cmd: string, args: string[], options: CommandOptions = {}) => {
        hostCalls.push({ cmd, args, options });
        if (cmd === "git") {
          return "";
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
        throw new Error(`unexpected host call: ${cmd} ${args.join(" ")}`);
      },
      () => {
        throw new Error("default runSafe should not handle docker calls");
      },
      {
        dockerExecFn(cmd: string, args: string[], options: CommandOptions = {}) {
          dockerExecCalls.push({ cmd, args, input: String(options.input ?? "") });
        },
        dockerRunSafeFn(cmd: string, args: string[]) {
          dockerSafeCalls.push({ cmd, args });
          return "";
        }
      }
    );

    assert.equal(synced, true);
    assert.deepEqual(hostCalls.map((call) => call.cmd), ["git", "gpg", "gpg", "gpg"]);
    assert.deepEqual(dockerExecCalls, [
      { cmd: "docker", args: ["exec", "-i", "demo-container", "gpg", "--import"], input: "pub" },
      { cmd: "docker", args: ["exec", "-i", "demo-container", "gpg", "--batch", "--import"], input: "sec" }
    ]);
    assert.deepEqual(dockerSafeCalls, [
      { cmd: "docker", args: ["exec", "demo-container", "gpgconf", "--launch", "gpg-agent"] }
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("composeDockerfile rejects unknown runtimes", async () => {
  const sandboxDockerfile = await loadFreshEsm<typeof import("../../lib/sandbox/dockerfile.ts")>("lib/sandbox/dockerfile.js");

  assert.throws(() => sandboxDockerfile.composeDockerfile({
    repoRoot: process.cwd(),
    project: "demo",
    runtimes: ["ruby3"],
    dockerfile: null
  }), /Unknown runtime: ruby3/);
});

test("assertValidBranchName rejects invalid branch names", async () => {
  const sandboxConstants = await loadFreshEsm<typeof import("../../lib/sandbox/constants.ts")>("lib/sandbox/constants.js");

  assert.throws(() => sandboxConstants.assertValidBranchName("bad branch name"), /Invalid branch name/);
});

test("share helpers compose project share namespace under shareBase", async () => {
  const sandboxConstants = await loadFreshEsm<typeof import("../../lib/sandbox/constants.ts")>("lib/sandbox/constants.js");
  const config = { shareBase: "/tmp/share/demo" };

  assert.equal(sandboxConstants.shareDir(config), "/tmp/share/demo");
  assert.equal(sandboxConstants.shareCommonDir(config), "/tmp/share/demo/common");
  assert.equal(
    sandboxConstants.shareBranchDir(config, "feat/foo"),
    "/tmp/share/demo/branches/feat..foo"
  );
});

test("resolveTaskBranch returns plain branch names unchanged", async () => {
  const taskResolver = await loadFreshEsm<typeof import("../../lib/sandbox/task-resolver.ts")>("lib/sandbox/task-resolver.js");

  assert.equal(
    taskResolver.resolveTaskBranch("agent-infra-feature-cli-generic-sandbox", process.cwd()),
    "agent-infra-feature-cli-generic-sandbox"
  );
});

test("resolveTaskBranch reads branch from task frontmatter", async () => {
  const taskResolver = await loadFreshEsm<typeof import("../../lib/sandbox/task-resolver.ts")>("lib/sandbox/task-resolver.js");
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

test("resolveTaskBranch strips matching quotes from task branch metadata", async () => {
  const taskResolver = await loadFreshEsm<typeof import("../../lib/sandbox/task-resolver.ts")>("lib/sandbox/task-resolver.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-task-quotes-"));
  const cases: Array<[string, string]> = [
    ["TASK-20260401-180010", "branch: \"agent-infra-feature-cli-generic-sandbox\""],
    ["TASK-20260401-180011", "branch: 'agent-infra-feature-cli-generic-sandbox'"]
  ];

  try {
    for (const [taskId, branchLine] of cases) {
      const taskDir = path.join(tmpDir, ".agents", "workspace", "active", taskId);
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(path.join(taskDir, "task.md"), [
        "---",
        `id: ${taskId}`,
        "type: feature",
        branchLine,
        "---",
        "",
        "# task"
      ].join("\n"));

      assert.equal(
        taskResolver.resolveTaskBranch(taskId, tmpDir),
        "agent-infra-feature-cli-generic-sandbox"
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolveTaskBranch falls back to the context branch for legacy tasks", async () => {
  const taskResolver = await loadFreshEsm<typeof import("../../lib/sandbox/task-resolver.ts")>("lib/sandbox/task-resolver.js");
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

test("resolveTaskBranch strips matching quotes from legacy context branch metadata", async () => {
  const taskResolver = await loadFreshEsm<typeof import("../../lib/sandbox/task-resolver.ts")>("lib/sandbox/task-resolver.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-task-context-quotes-"));
  const taskDir = path.join(tmpDir, ".agents", "workspace", "active", "TASK-20260401-180012");

  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "task.md"), [
      "---",
      "id: TASK-20260401-180012",
      "type: feature",
      "---",
      "",
      "## Context",
      "",
      "- **Branch**：\"feature/quoted-context\""
    ].join("\n"));

    assert.equal(
      taskResolver.resolveTaskBranch("TASK-20260401-180012", tmpDir),
      "feature/quoted-context"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

for (const workspaceDir of ["completed", "blocked", "archive"]) {
  test(`resolveTaskBranch resolves tasks in ${workspaceDir} directory`, async () => {
    const taskResolver = await loadFreshEsm<typeof import("../../lib/sandbox/task-resolver.ts")>("lib/sandbox/task-resolver.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-infra-sandbox-task-${workspaceDir}-`));
    const taskDir = path.join(tmpDir, ".agents", "workspace", workspaceDir, "TASK-20260401-180003");

    try {
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(path.join(taskDir, "task.md"), [
        "---",
        "id: TASK-20260401-180003",
        "type: bugfix",
        "branch: agent-infra-bugfix-some-fix",
        "---",
        "",
        "# task"
      ].join("\n"));

      assert.equal(
        taskResolver.resolveTaskBranch("TASK-20260401-180003", tmpDir),
        "agent-infra-bugfix-some-fix"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
}

test("resolveTaskBranch prefers active over completed when both exist", async () => {
  const taskResolver = await loadFreshEsm<typeof import("../../lib/sandbox/task-resolver.ts")>("lib/sandbox/task-resolver.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-task-priority-"));
  const activeDir = path.join(tmpDir, ".agents", "workspace", "active", "TASK-20260401-180004");
  const completedDir = path.join(tmpDir, ".agents", "workspace", "completed", "TASK-20260401-180004");

  try {
    fs.mkdirSync(activeDir, { recursive: true });
    fs.mkdirSync(completedDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, "task.md"), [
      "---",
      "id: TASK-20260401-180004",
      "branch: agent-infra-bugfix-active-wins",
      "---"
    ].join("\n"));
    fs.writeFileSync(path.join(completedDir, "task.md"), [
      "---",
      "id: TASK-20260401-180004",
      "branch: agent-infra-bugfix-should-be-ignored",
      "---"
    ].join("\n"));

    assert.equal(
      taskResolver.resolveTaskBranch("TASK-20260401-180004", tmpDir),
      "agent-infra-bugfix-active-wins"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolveTaskBranch rejects missing task files and missing branch metadata", async () => {
  const taskResolver = await loadFreshEsm<typeof import("../../lib/sandbox/task-resolver.ts")>("lib/sandbox/task-resolver.js");
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

test("sandbox ls format is engine-neutral and embeds raw Labels", async () => {
  const { containerListFormat } = await loadFreshEsm<typeof import("../../lib/sandbox/commands/ls.ts")>("lib/sandbox/commands/ls.js");

  assert.equal(
    containerListFormat(),
    "{{.Names}}\t{{.Status}}\t{{.Labels}}"
  );
});

test("sandbox ls formatContainerTable aligns header and rows by column width", async () => {
  const { formatContainerTable } = await loadFreshEsm<typeof import("../../lib/sandbox/commands/ls.ts")>("lib/sandbox/commands/ls.js");

  const rows = [
    { name: "demo-dev-feature-x", status: "Up 2 hours", branch: "feature/short" },
    { name: "worker", status: "Exited (0) 20 minutes ago", branch: "bugfix/align-table" },
    { name: "agent-infra-sandbox-long", status: "Created", branch: "main" }
  ];
  const lines = formatContainerTable(rows);
  const statusColumn = lines[0].indexOf("STATUS");
  const branchColumn = lines[0].indexOf("BRANCH");

  assert.equal(lines.length, rows.length + 1);
  assert.ok(statusColumn > 0);
  assert.ok(branchColumn > statusColumn);
  for (let i = 0; i < rows.length; i += 1) {
    assert.equal(lines[i + 1].indexOf(rows[i].status), statusColumn);
    assert.equal(lines[i + 1].indexOf(rows[i].branch), branchColumn);
  }
  for (const line of lines) {
    assert.equal(line.includes("\t"), false);
    assert.doesNotMatch(line, /\s+$/);
  }
});

test("sandbox ls parseLabels parses docker label CSV", async () => {
  const { parseLabels } = await loadFreshEsm<typeof import("../../lib/sandbox/commands/ls.ts")>("lib/sandbox/commands/ls.js");

  assert.deepEqual(parseLabels(""), {});
  assert.deepEqual(parseLabels("k=v"), { k: "v" });
  assert.deepEqual(parseLabels("a=1,b=2"), { a: "1", b: "2" });
  assert.deepEqual(parseLabels("k=a=b"), { k: "a=b" });
  assert.deepEqual(parseLabels("k="), { k: "" });
  assert.deepEqual(parseLabels("k=v,"), { k: "v" });
});

test("runSafe forwards stderr on non-zero exit while preserving stdout return", async () => {
  const { runSafe } = await loadFreshEsm<typeof import("../../lib/sandbox/shell.ts")>("lib/sandbox/shell.js");
  const originalWrite = process.stderr.write;
  const writes: Array<string | Uint8Array> = [];

  try {
    process.stderr.write = ((...args: Parameters<typeof process.stderr.write>) => {
      writes.push(args[0]);
      return true;
    }) as typeof process.stderr.write;

    const output = runSafe(process.execPath, [
      "-e",
      "process.stdout.write(' out '); process.stderr.write('boom'); process.exit(1)"
    ]);

    assert.equal(output, "out");
    assert.deepEqual(writes, ["boom"]);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("runSafe does not forward stderr on zero exit", async () => {
  const { runSafe } = await loadFreshEsm<typeof import("../../lib/sandbox/shell.ts")>("lib/sandbox/shell.js");
  const originalWrite = process.stderr.write;
  const writes: Array<string | Uint8Array> = [];

  try {
    process.stderr.write = ((...args: Parameters<typeof process.stderr.write>) => {
      writes.push(args[0]);
      return true;
    }) as typeof process.stderr.write;

    const output = runSafe(process.execPath, [
      "-e",
      "process.stderr.write('noise'); process.exit(0)"
    ]);

    assert.equal(output, "");
    assert.deepEqual(writes, []);
  } finally {
    process.stderr.write = originalWrite;
  }
});
