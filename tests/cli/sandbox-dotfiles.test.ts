import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertModeBits,
  loadFreshEsm,
  onPlatforms
} from "../helpers.ts";

type DotfilesModule = {
  dotfilesCacheDir(home: string, project: string): string;
  materializeDotfiles(
    srcDir: string,
    cacheDir: string,
    options?: { writeStderr?: (chunk: string) => void } & Record<string, unknown>
  ): { cacheDir: string; warnings: Array<{ rel: string; reason: string }> } | null;
};
type SymlinkKind = "file" | "dir" | "junction";
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

function required<T>(value: T | undefined, message = "expected value"): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
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
