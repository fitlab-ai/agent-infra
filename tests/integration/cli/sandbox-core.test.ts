import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  cliArgs,
  envWithPrependedPath,
  filePath,
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
type ManagedFsModule = {
  assertManagedPath(root: string, target: string): void;
  removeManagedDir(root: string, dir: string): void;
  removeWorktreeDir(repoRoot: string, worktreeBase: string, dir: string): void;
};
type PruneModule = {
  collectOrphanGroups(config: Record<string, unknown>, tools: Array<Record<string, unknown>>, activeBranches: string[]): Array<{
    kind: string;
    label: string;
    base: string;
    dirs: string[];
  }>;
  removeOrphanGroups(config: Record<string, unknown>, groups: Array<{
    kind: string;
    label: string;
    base: string;
    dirs: string[];
  }>): boolean;
};

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

test("agent-infra sandbox help is wired into the main CLI", () => {
  const output = execFileSync(process.execPath, cliArgs("sandbox", "--help"), {
    encoding: "utf8"
  });

  assert.match(output, /Usage: ai sandbox <command> \[options\]/);
  assert.match(output, /create <branch> \[base\]/);
  assert.match(output, /^\s+refresh\s+Sync host Claude Code credentials/m);
  assert.match(output, /^\s+rebuild \[--quiet\] \[--refresh\]\s+Rebuild the sandbox image/m);
  assert.match(output, /prune \[--dry-run\]/);
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

test("sandbox rm cleans per-branch shell config dir", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-rm-shell-config-"));
  const project = "demo";

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project });
    const shellConfigBase = path.join(tmpDir, ".agent-infra", "config", project);
    const removedBranchDir = path.join(shellConfigBase, "feature..rm-config");
    const keptBranchDir = path.join(shellConfigBase, "feature..keep");
    fs.mkdirSync(removedBranchDir, { recursive: true });
    fs.mkdirSync(keptBranchDir, { recursive: true });
    fs.writeFileSync(path.join(removedBranchDir, ".bash_aliases"), "alias demo=true\n", "utf8");
    fs.writeFileSync(path.join(removedBranchDir, ".gitconfig"), "[user]\n", "utf8");

    const result = spawnSandboxCli(fixture, tmpDir, ["rm", "feature/rm-config"]);

    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(removedBranchDir), false);
    assert.equal(fs.existsSync(keptBranchDir), true);
    assert.equal(fs.existsSync(shellConfigBase), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox rm --all cleans shell config dirs through a single confirm", () => {
  const commandSource = fs.readFileSync(filePath("lib/sandbox/commands/rm.js"), "utf8");

  assert.match(
    commandSource,
    /config\.shellConfigBase[\s\S]*?p\.confirm\(\{[\s\S]*?config\.shellConfigBase[\s\S]*?\}\);[\s\S]*?readdirSync\(config\.shellConfigBase\)[\s\S]*?removeManagedDir\(config\.shellConfigBase, dir\);/
  );
});

test("sandbox rm --all prunes project-scoped dangling images before managed-engine branch", () => {
  const commandSource = fs.readFileSync(filePath("lib/sandbox/commands/rm.js"), "utf8");

  const rmAllMatch = commandSource.match(
    /async function rmAll\b[\s\S]*?(?=\n(?:async function|export async function|export function)\b|$)/
  );
  assert.ok(rmAllMatch, "expected to locate rmAll function body in rm.js");
  const rmAllBody = rmAllMatch[0];

  const pruneIndex = rmAllBody.search(/pruneSandboxDanglingImages\(config,\s*engine\)/);
  assert.ok(
    pruneIndex >= 0,
    "expected rmAll to call pruneSandboxDanglingImages(config, engine)"
  );

  const managedIndex = rmAllBody.search(/if\s*\(\s*isManagedEngine\(\s*engine\s*\)/);
  assert.ok(
    managedIndex >= 0,
    "expected rmAll to contain the isManagedEngine branch"
  );

  assert.ok(
    pruneIndex < managedIndex,
    "expected pruneSandboxDanglingImages to run before the isManagedEngine branch (covers WSL2 early return)"
  );

  const removeImageConfirmIndex = rmAllBody.search(/Remove image \$\{config\.imageName\}\?/);
  assert.ok(
    removeImageConfirmIndex >= 0,
    "expected rmAll to keep the 'Remove image?' confirm prompt"
  );
  assert.ok(
    pruneIndex > removeImageConfirmIndex,
    "expected pruneSandboxDanglingImages to run after the 'Remove image?' confirm"
  );
});

test("managed sandbox fs helpers remove only paths under the managed root", async () => {
  const managedFs = await loadFreshEsm<ManagedFsModule>("lib/sandbox/managed-fs.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-managed-fs-"));
  const root = path.join(tmpDir, "root");
  const inside = path.join(root, "feature..demo");

  try {
    fs.mkdirSync(inside, { recursive: true });

    managedFs.removeManagedDir(root, inside);

    assert.equal(fs.existsSync(inside), false);
    assert.throws(
      () => managedFs.removeManagedDir(root, path.join(tmpDir, "outside")),
      /outside managed sandbox root/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("managed sandbox fs worktree removal falls back to managed rm", async () => {
  const managedFs = await loadFreshEsm<ManagedFsModule>("lib/sandbox/managed-fs.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-managed-worktree-"));
  const worktreeBase = path.join(tmpDir, "worktrees");
  const worktree = path.join(worktreeBase, "feature..stale");

  try {
    fs.mkdirSync(worktree, { recursive: true });

    managedFs.removeWorktreeDir(tmpDir, worktreeBase, worktree);

    assert.equal(fs.existsSync(worktree), false);
    assert.equal(fs.existsSync(worktreeBase), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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

test("assertValidBranchName rejects invalid branch names", async () => {
  const sandboxConstants = await loadFreshEsm<typeof import("../../../lib/sandbox/constants.ts")>("lib/sandbox/constants.js");

  assert.throws(() => sandboxConstants.assertValidBranchName("bad branch name"), /Invalid branch name/);
});

test("share helpers compose project share namespace under shareBase", async () => {
  const sandboxConstants = await loadFreshEsm<typeof import("../../../lib/sandbox/constants.ts")>("lib/sandbox/constants.js");
  const config = { shareBase: "/tmp/share/demo" };

  assert.equal(sandboxConstants.shareDir(config), "/tmp/share/demo");
  assert.equal(sandboxConstants.shareCommonDir(config), "/tmp/share/demo/common");
  assert.equal(
    sandboxConstants.shareBranchDir(config, "feat/foo"),
    "/tmp/share/demo/branches/feat..foo"
  );
});

test("shell config helpers compose branch dirs under shellConfigBase", async () => {
  const sandboxConstants = await loadFreshEsm<typeof import("../../../lib/sandbox/constants.ts")>("lib/sandbox/constants.js");
  const config = { shellConfigBase: "/tmp/config/demo" };

  assert.equal(sandboxConstants.shellConfigDir(config, "feat/foo"), "/tmp/config/demo/feat..foo");
  assert.deepEqual(sandboxConstants.shellConfigDirCandidates(config, "feat/foo"), [
    "/tmp/config/demo/feat..foo",
    "/tmp/config/demo/feat-foo"
  ]);
});

test("resolveTaskBranch returns plain branch names unchanged", async () => {
  const taskResolver = await loadFreshEsm<typeof import("../../../lib/sandbox/task-resolver.ts")>("lib/sandbox/task-resolver.js");

  assert.equal(
    taskResolver.resolveTaskBranch("agent-infra-feature-cli-generic-sandbox", process.cwd()),
    "agent-infra-feature-cli-generic-sandbox"
  );
});

test("resolveTaskBranch reads branch from task frontmatter", async () => {
  const taskResolver = await loadFreshEsm<typeof import("../../../lib/sandbox/task-resolver.ts")>("lib/sandbox/task-resolver.js");
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
  const taskResolver = await loadFreshEsm<typeof import("../../../lib/sandbox/task-resolver.ts")>("lib/sandbox/task-resolver.js");
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
  const taskResolver = await loadFreshEsm<typeof import("../../../lib/sandbox/task-resolver.ts")>("lib/sandbox/task-resolver.js");
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
  const taskResolver = await loadFreshEsm<typeof import("../../../lib/sandbox/task-resolver.ts")>("lib/sandbox/task-resolver.js");
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
    const taskResolver = await loadFreshEsm<typeof import("../../../lib/sandbox/task-resolver.ts")>("lib/sandbox/task-resolver.js");
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
  const taskResolver = await loadFreshEsm<typeof import("../../../lib/sandbox/task-resolver.ts")>("lib/sandbox/task-resolver.js");
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
  const taskResolver = await loadFreshEsm<typeof import("../../../lib/sandbox/task-resolver.ts")>("lib/sandbox/task-resolver.js");
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
  const { containerListFormat } = await loadFreshEsm<typeof import("../../../lib/sandbox/commands/ls.ts")>("lib/sandbox/commands/ls.js");

  assert.equal(
    containerListFormat(),
    "{{.Names}}\t{{.Status}}\t{{.Labels}}"
  );
});

test("sandbox ls formatContainerTable aligns header and rows by column width", async () => {
  const { formatContainerTable } = await loadFreshEsm<typeof import("../../../lib/sandbox/commands/ls.ts")>("lib/sandbox/commands/ls.js");

  const rows = [
    { index: "1", name: "demo-dev-feature-x", status: "Up 2 hours", branch: "feature/short" },
    { index: "", name: "worker", status: "Exited (0) 20 minutes ago", branch: "bugfix/align-table" },
    { index: "", name: "agent-infra-sandbox-long", status: "Created", branch: "main" }
  ];
  const lines = formatContainerTable(rows);
  const hashColumn = lines[0]!.indexOf("#");
  const namesColumn = lines[0]!.indexOf("NAMES");
  const statusColumn = lines[0]!.indexOf("STATUS");
  const branchColumn = lines[0]!.indexOf("BRANCH");

  assert.equal(lines.length, rows.length + 1);
  assert.equal(hashColumn, 0);
  assert.ok(namesColumn > hashColumn);
  assert.ok(statusColumn > namesColumn);
  assert.ok(branchColumn > statusColumn);
  for (let i = 0; i < rows.length; i += 1) {
    assert.equal(lines[i + 1]!.indexOf(rows[i]!.name), namesColumn);
    assert.equal(lines[i + 1]!.indexOf(rows[i]!.status), statusColumn);
    assert.equal(lines[i + 1]!.indexOf(rows[i]!.branch), branchColumn);
  }
  assert.equal(lines[1]!.slice(0, namesColumn).trim(), "1");
  assert.equal(lines[2]!.slice(0, namesColumn).trim(), "");
  assert.equal(lines[3]!.slice(0, namesColumn).trim(), "");
  for (const line of lines) {
    assert.equal(line.includes("\t"), false);
    assert.doesNotMatch(line, /\s+$/);
  }
});

test("sandbox list-running parseSandboxRows tags running rows by 'Up ' prefix", async () => {
  const { parseSandboxRows } = await loadFreshEsm<typeof import("../../../lib/sandbox/commands/list-running.ts")>("lib/sandbox/commands/list-running.js");

  assert.deepEqual(parseSandboxRows("", "agent-infra.branch"), []);

  const rows = parseSandboxRows(
    [
      "demo-a\tUp 5 minutes\tagent-infra.branch=feature/a",
      "demo-b\tExited (0) 1 hour ago\tagent-infra.branch=feature/b",
      "demo-c\tCreated\t",
      "demo-d\tUp About a minute\tagent-infra.branch=main"
    ].join("\n"),
    "agent-infra.branch"
  );
  assert.equal(rows.length, 4);
  assert.equal(rows[0]!.running, true);
  assert.equal(rows[0]!.branch, "feature/a");
  assert.equal(rows[1]!.running, false);
  assert.equal(rows[1]!.branch, "feature/b");
  assert.equal(rows[2]!.running, false);
  assert.equal(rows[2]!.branch, "");
  assert.equal(rows[3]!.running, true);
});

test("sandbox list-running sortAndIndexSandboxRows assigns 1-based index to running only", async () => {
  const { sortAndIndexSandboxRows } = await loadFreshEsm<typeof import("../../../lib/sandbox/commands/list-running.ts")>("lib/sandbox/commands/list-running.js");

  const input = [
    { name: "demo-c", status: "Up 1 min", branch: "feature/c", running: true, index: null },
    { name: "demo-a", status: "Exited (0)", branch: "feature/a", running: false, index: null },
    { name: "Demo-A", status: "Up 1 min", branch: "feature/upper", running: true, index: null },
    { name: "demo-a", status: "Up 1 min", branch: "feature/dup", running: true, index: null },
    { name: "demo-z", status: "Created", branch: "feature/z", running: false, index: null }
  ];
  const { running, nonRunning } = sortAndIndexSandboxRows(input);

  assert.deepEqual(running.map((r) => r.name), ["Demo-A", "demo-a", "demo-c"]);
  assert.deepEqual(running.map((r) => r.index), [1, 2, 3]);
  assert.deepEqual(nonRunning.map((r) => r.name), ["demo-a", "demo-z"]);
  for (const r of nonRunning) {
    assert.equal(r.index, null);
  }
});

test("sandbox list-running isTaskShortRef matches only '#<digits>' syntactically", async () => {
  const { isTaskShortRef } = await loadFreshEsm<typeof import("../../../lib/sandbox/commands/list-running.ts")>("lib/sandbox/commands/list-running.js");

  assert.equal(isTaskShortRef("#0"), true);
  assert.equal(isTaskShortRef("#1"), true);
  assert.equal(isTaskShortRef("#10"), true);
  assert.equal(isTaskShortRef("#abc"), false);
  assert.equal(isTaskShortRef("#1a"), false);
  assert.equal(isTaskShortRef("#1.5"), false);
  assert.equal(isTaskShortRef("#-1"), false);
  assert.equal(isTaskShortRef("#"), false);
  assert.equal(isTaskShortRef("1"), false);
  assert.equal(isTaskShortRef("main"), false);
  assert.equal(isTaskShortRef("TASK-20260609-084122"), false);
  assert.equal(isTaskShortRef(""), false);
});

test("sandbox list-running resolveTaskShortRef returns branch for valid index", async () => {
  const { resolveTaskShortRef } = await loadFreshEsm<typeof import("../../../lib/sandbox/commands/list-running.ts")>("lib/sandbox/commands/list-running.js");
  const running = [
    { name: "demo-a", status: "Up 1 min", branch: "feature/a", running: true, index: 1 },
    { name: "demo-b", status: "Up 1 min", branch: "feature/b", running: true, index: 2 },
    { name: "demo-c", status: "Up 1 min", branch: "main", running: true, index: 3 }
  ];

  assert.equal(resolveTaskShortRef("#1", { running }), "feature/a");
  assert.equal(resolveTaskShortRef("#2", { running }), "feature/b");
  assert.equal(resolveTaskShortRef("#3", { running }), "main");
});

test("sandbox list-running resolveTaskShortRef rejects '#0' with 'must be >= 1'", async () => {
  const { resolveTaskShortRef } = await loadFreshEsm<typeof import("../../../lib/sandbox/commands/list-running.ts")>("lib/sandbox/commands/list-running.js");

  assert.throws(
    () => resolveTaskShortRef("#0", { running: [] }),
    /must be >= 1/
  );
});

test("sandbox list-running resolveTaskShortRef rejects out-of-range index with running count", async () => {
  const { resolveTaskShortRef } = await loadFreshEsm<typeof import("../../../lib/sandbox/commands/list-running.ts")>("lib/sandbox/commands/list-running.js");
  const running = [
    { name: "demo-a", status: "Up 1 min", branch: "feature/a", running: true, index: 1 },
    { name: "demo-b", status: "Up 1 min", branch: "feature/b", running: true, index: 2 },
    { name: "demo-c", status: "Up 1 min", branch: "feature/c", running: true, index: 3 }
  ];

  assert.throws(
    () => resolveTaskShortRef("#5", { running }),
    /only 3 running/
  );
});

test("sandbox list-running resolveTaskShortRef rejects when no running sandboxes", async () => {
  const { resolveTaskShortRef } = await loadFreshEsm<typeof import("../../../lib/sandbox/commands/list-running.ts")>("lib/sandbox/commands/list-running.js");

  assert.throws(
    () => resolveTaskShortRef("#1", { running: [] }),
    /No running sandbox to reference/
  );
});

test("sandbox list-running resolveTaskShortRef rejects when running row has empty branch label", async () => {
  const { resolveTaskShortRef } = await loadFreshEsm<typeof import("../../../lib/sandbox/commands/list-running.ts")>("lib/sandbox/commands/list-running.js");
  const running = [
    { name: "orphan", status: "Up 1 min", branch: "", running: true, index: 1 }
  ];

  assert.throws(
    () => resolveTaskShortRef("#1", { running }),
    /missing branch label/
  );
});

test("sandbox ls parseLabels parses docker label CSV", async () => {
  const { parseLabels } = await loadFreshEsm<typeof import("../../../lib/sandbox/commands/ls.ts")>("lib/sandbox/commands/ls.js");

  assert.deepEqual(parseLabels(""), {});
  assert.deepEqual(parseLabels("k=v"), { k: "v" });
  assert.deepEqual(parseLabels("a=1,b=2"), { a: "1", b: "2" });
  assert.deepEqual(parseLabels("k=a=b"), { k: "a=b" });
  assert.deepEqual(parseLabels("k="), { k: "" });
  assert.deepEqual(parseLabels("k=v,"), { k: "v" });
});

test("sandbox prune collects orphaned per-branch dirs while preserving active and shared dirs", async () => {
  const sandboxPrune = await loadFreshEsm<PruneModule>("lib/sandbox/commands/prune.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-prune-collect-"));
  const project = "demo";
  const config = {
    project,
    repoRoot: tmpDir,
    worktreeBase: path.join(tmpDir, ".agent-infra", "worktrees", project),
    shareBase: path.join(tmpDir, ".agent-infra", "share", project),
    shellConfigBase: path.join(tmpDir, ".agent-infra", "config", project)
  };
  const tool = {
    id: "codex",
    name: "Codex",
    install: { type: "npm", cmd: "@openai/codex" },
    sandboxBase: path.join(tmpDir, ".agent-infra", "sandboxes", "codex"),
    containerMount: "/home/devuser/.codex",
    versionCmd: "codex --version",
    setupHint: "fixture"
  };
  const activeShellDir = path.join(config.shellConfigBase, "feature..live");
  const legacyActiveShellDir = path.join(config.shellConfigBase, "release-old");
  const dirtyLabelShellDir = path.join(config.shellConfigBase, "dirty label");
  const orphanShellDir = path.join(config.shellConfigBase, "feature..stale");
  const orphanWorktreeDir = path.join(config.worktreeBase, "feature..old-worktree");
  const shareBranchesBase = path.join(config.shareBase, "branches");
  const activeShareDir = path.join(shareBranchesBase, "feature..live");
  const orphanShareDir = path.join(shareBranchesBase, "feature..stale-share");
  const commonShareDir = path.join(config.shareBase, "common");
  const toolProjectBase = path.join(tool.sandboxBase, project);
  const activeToolDir = path.join(toolProjectBase, "feature..live");
  const orphanToolDir = path.join(toolProjectBase, "feature..stale-tool");
  const otherProjectToolDir = path.join(tool.sandboxBase, "other", "feature..stale-tool");

  try {
    for (const dir of [
      activeShellDir,
      legacyActiveShellDir,
      dirtyLabelShellDir,
      orphanShellDir,
      orphanWorktreeDir,
      activeShareDir,
      orphanShareDir,
      commonShareDir,
      activeToolDir,
      orphanToolDir,
      otherProjectToolDir
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const groups = sandboxPrune.collectOrphanGroups(config, [tool], ["feature/live", "release/old", "dirty label"]);
    const dirs = groups.flatMap((group) => group.dirs).sort();

    assert.deepEqual(dirs, [
      orphanShellDir,
      orphanShareDir,
      orphanToolDir,
      orphanWorktreeDir
    ].sort());

    const removedWorktrees = sandboxPrune.removeOrphanGroups(config, groups);

    assert.equal(removedWorktrees, true);
    assert.equal(fs.existsSync(orphanShellDir), false);
    assert.equal(fs.existsSync(orphanWorktreeDir), false);
    assert.equal(fs.existsSync(orphanShareDir), false);
    assert.equal(fs.existsSync(orphanToolDir), false);
    assert.equal(fs.existsSync(config.shellConfigBase), true);
    assert.equal(fs.existsSync(config.worktreeBase), true);
    assert.equal(fs.existsSync(config.shareBase), true);
    assert.equal(fs.existsSync(commonShareDir), true);
    assert.equal(fs.existsSync(activeShellDir), true);
    assert.equal(fs.existsSync(legacyActiveShellDir), true);
    assert.equal(fs.existsSync(activeShareDir), true);
    assert.equal(fs.existsSync(activeToolDir), true);
    assert.equal(fs.existsSync(otherProjectToolDir), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox prune aborts without deleting when docker ps fails", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-prune-ps-fails-"));
  const project = "demo";

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, {
      project,
      sandbox: { tools: ["codex"] }
    });
    const shellConfigBase = path.join(tmpDir, ".agent-infra", "config", project);
    const branchDir = path.join(shellConfigBase, "feature..live");
    fs.mkdirSync(branchDir, { recursive: true });

    const result = spawnSandboxCli(
      fixture,
      tmpDir,
      ["prune"],
      { DOCKER_EXIT_FOR_PS: "1" }
    );

    assert.equal(result.signal, null);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Unable to determine active sandbox branches/);
    assert.equal(fs.existsSync(branchDir), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox prune --dry-run lists orphans without deleting them", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-prune-dry-run-"));
  const project = "demo";

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, {
      project,
      sandbox: { tools: ["codex"] },
      dockerStdoutForPs: `${project}.sandbox=true,${project}.sandbox.branch=feature/live`
    });
    const shellConfigBase = path.join(tmpDir, ".agent-infra", "config", project);
    const activeShellDir = path.join(shellConfigBase, "feature..live");
    const orphanShellDir = path.join(shellConfigBase, "feature..old");
    fs.mkdirSync(activeShellDir, { recursive: true });
    fs.mkdirSync(orphanShellDir, { recursive: true });

    const result = spawnSandboxCli(fixture, tmpDir, ["prune", "--dry-run"]);

    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.match(`${result.stdout}\n${result.stderr}`, /feature\.\.old/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /feature\.\.live/);
    assert.equal(fs.existsSync(activeShellDir), true);
    assert.equal(fs.existsSync(orphanShellDir), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox prune uses a single confirmation gate for deletion", () => {
  const commandSource = fs.readFileSync(filePath("lib/sandbox/commands/prune.js"), "utf8");

  assert.match(
    commandSource,
    /const shouldRemove = await p\.confirm\(\{[\s\S]*?Remove \$\{count\} orphaned sandbox state[\s\S]*?initialValue: true[\s\S]*?\}\);/
  );
});
