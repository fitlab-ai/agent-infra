import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  filePath,
  loadFreshEsm
} from "../../helpers.ts";
import { runInteractive } from "../../../lib/sandbox/shell.ts";

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
  const sandboxShell = await loadFreshEsm<typeof import("../../../lib/sandbox/shell.ts")>("lib/sandbox/shell.js");

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
  const sandboxShell = await loadFreshEsm<typeof import("../../../lib/sandbox/shell.ts")>("lib/sandbox/shell.js");
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
  const sandboxVm = await loadFreshEsm<typeof import("../../../lib/sandbox/commands/vm.ts")>("lib/sandbox/commands/vm.js");
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
  const sandboxRm = await loadFreshEsm<typeof import("../../../lib/sandbox/commands/rm.ts")>("lib/sandbox/commands/rm.js");
  const root = path.join(os.tmpdir(), "agent-infra-worktrees");

  assert.doesNotThrow(() => sandboxRm.assertManagedPath(root, path.join(root, "feature..demo")));
  assert.throws(
    () => sandboxRm.assertManagedPath(root, path.join(os.tmpdir(), "agent-infra-other")),
    /outside managed sandbox root/
  );
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
