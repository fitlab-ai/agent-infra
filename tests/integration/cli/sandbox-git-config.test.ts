import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadFreshEsm
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

function required<T>(value: T | undefined, message = "expected value"): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

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
