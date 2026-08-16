import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SandboxConfig } from "../../../lib/sandbox/config.ts";
import {
  cliArgs,
  envWithPrependedPath,
  gitSafeEnv,
  loadFreshEsm,
  onPlatforms,
  writeSandboxEngineFixture
} from "../../helpers.ts";

type SafetyModule = typeof import("../../../lib/sandbox/worktree-safety.ts");
type ManagedFsModule = typeof import("../../../lib/sandbox/managed-fs.ts");
type RmModule = typeof import("../../../lib/sandbox/commands/rm.ts");
type PruneModule = typeof import("../../../lib/sandbox/commands/prune.ts");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: gitSafeEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function createLinkedWorktree(): {
  root: string;
  repo: string;
  base: string;
  worktree: string;
  cleanup(): void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-worktree-safety-"));
  const repo = path.join(root, "repo");
  const base = path.join(root, "worktrees");
  const worktree = path.join(base, "feature..safe-delete");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(base, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "initial\n", "utf8");
  git(repo, "add", "tracked.txt");
  git(repo, "-c", "user.name=Sandbox Test", "-c", "user.email=sandbox@example.com", "commit", "-q", "-m", "initial");
  git(repo, "worktree", "add", "-q", "-b", "feature/safe-delete", worktree, "HEAD");
  return {
    root,
    repo,
    base,
    worktree,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function addFixtureWorktree(
  fixture: ReturnType<typeof writeSandboxEngineFixture>,
  tmpDir: string,
  branch: string,
  project = "demo"
): string {
  try {
    git(fixture.repoDir, "rev-parse", "--verify", "HEAD");
  } catch {
    fs.writeFileSync(path.join(fixture.repoDir, "tracked.txt"), "initial\n", "utf8");
    git(fixture.repoDir, "add", "tracked.txt");
    git(fixture.repoDir, "-c", "user.name=Sandbox Test", "-c", "user.email=sandbox@example.com", "commit", "-q", "-m", "initial");
  }
  const worktree = path.join(tmpDir, ".agent-infra", "worktrees", project, branch.replaceAll("/", ".."));
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(fixture.repoDir, "worktree", "add", "-q", "-b", branch, worktree, "HEAD");
  return worktree;
}

function spawnSandboxCli(
  fixture: ReturnType<typeof writeSandboxEngineFixture>,
  tmpDir: string,
  args: string[]
) {
  return spawnSync(process.execPath, cliArgs("sandbox", ...args), {
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
  });
}

function rmOneConfig(fixture: ReturnType<typeof writeSandboxEngineFixture>, tmpDir: string): SandboxConfig {
  return {
    repoRoot: fixture.repoDir,
    configPath: path.join(fixture.repoDir, ".agents", ".airc.json"),
    project: "demo",
    org: "fitlab-ai",
    home: tmpDir,
    containerPrefix: "demo-dev",
    imageName: "demo-sandbox:latest",
    worktreeBase: path.join(tmpDir, ".agent-infra", "worktrees", "demo"),
    shareBase: path.join(tmpDir, ".agent-infra", "share", "demo"),
    shellConfigBase: path.join(tmpDir, ".agent-infra", "config", "demo"),
    workspaceViewBase: path.join(tmpDir, ".agent-infra", "workspace-views"),
    controlBase: path.join(tmpDir, ".agent-infra", "sandbox-control"),
    dotfilesDir: path.join(tmpDir, ".agent-infra", "dotfiles"),
    engine: "docker-desktop",
    runtimes: ["node22"],
    tools: [],
    customTools: [],
    agentClientState: {
      "antigravity-cli": { enabled: false, installInSandbox: false },
      "claude-code": { enabled: false, installInSandbox: false },
      codex: { enabled: false, installInSandbox: false },
      opencode: { enabled: false, installInSandbox: false }
    },
    agentClientSource: "canonical",
    refreshIntervalDays: 7,
    dockerfile: null,
    vm: { cpu: null, memory: null, disk: null }
  };
}

async function cleanRmOneFixture(
  rm: RmModule,
  safety: SafetyModule,
  fixture: ReturnType<typeof writeSandboxEngineFixture>,
  tmpDir: string,
  branch: string,
  prompt: NonNullable<Parameters<RmModule["rmOne"]>[3]>["prompt"]
): Promise<{ worktree: string; share: string }> {
  const worktree = addFixtureWorktree(fixture, tmpDir, branch);
  const share = path.join(tmpDir, ".agent-infra", "share", "demo", "branches", branch.replaceAll("/", ".."));
  fs.mkdirSync(share, { recursive: true });
  const inspected = safety.inspectWorktree(worktree);
  assert.equal(inspected.status, "clean");
  const permit = safety.createCleanPermit(inspected.snapshot);
  await rm.rmOne(rmOneConfig(fixture, tmpDir), [], branch, {
    target: {
      branch,
      effectiveBranch: branch,
      engine: "docker-desktop",
      matchedContainers: [],
      existingWorktrees: [worktree],
      toolCandidates: []
    },
    permits: new Map([[path.resolve(worktree), permit]]),
    prompt
  });
  return { worktree, share };
}

test("worktree safety snapshot binds staged, unstaged, and unusual untracked content", onPlatforms("linux", "darwin", "win32"), async () => {
  const safety = await loadFreshEsm<SafetyModule>("lib/sandbox/worktree-safety.js");
  const fixture = createLinkedWorktree();
  try {
    const clean = safety.inspectWorktree(fixture.worktree);
    assert.equal(clean.status, "clean");
    assert.equal(clean.snapshot.branch, "feature/safe-delete");

    fs.writeFileSync(path.join(fixture.worktree, "tracked.txt"), "first change\n", "utf8");
    const first = safety.inspectWorktree(fixture.worktree);
    assert.equal(first.status, "dirty");
    assert.ok(first.snapshot.changes.some((change) => change.path === "tracked.txt" && change.worktreeStatus === "M"));

    fs.writeFileSync(path.join(fixture.worktree, "tracked.txt"), "second change\n", "utf8");
    const second = safety.inspectWorktree(fixture.worktree);
    assert.equal(second.status, "dirty");
    assert.notEqual(second.snapshot.identity, first.snapshot.identity);

    git(fixture.worktree, "add", "tracked.txt");
    const staged = safety.inspectWorktree(fixture.worktree);
    assert.equal(staged.status, "dirty");
    assert.ok(staged.snapshot.changes.some((change) => change.path === "tracked.txt" && change.indexStatus === "M"));

    const unusualPath = "line\nbreak.txt";
    fs.writeFileSync(path.join(fixture.worktree, unusualPath), "untracked\n", "utf8");
    fs.appendFileSync(path.join(fixture.repo, ".git", "info", "exclude"), "ignored.txt\n", "utf8");
    fs.writeFileSync(path.join(fixture.worktree, "ignored.txt"), "ignored\n", "utf8");
    const untracked = safety.inspectWorktree(fixture.worktree);
    assert.equal(untracked.status, "dirty");
    assert.ok(untracked.snapshot.changes.some((change) => change.path === unusualPath && change.indexStatus === "?"));
    assert.equal(untracked.snapshot.changes.some((change) => change.path === "ignored.txt"), false);
  } finally {
    fixture.cleanup();
  }
});

test("worktree removal permit fails closed when content changes after authorization", onPlatforms("linux", "darwin", "win32"), async () => {
  const safety = await loadFreshEsm<SafetyModule>("lib/sandbox/worktree-safety.js");
  const fixture = createLinkedWorktree();
  try {
    fs.writeFileSync(path.join(fixture.worktree, "tracked.txt"), "authorized content\n", "utf8");
    const inspected = safety.inspectWorktree(fixture.worktree);
    assert.equal(inspected.status, "dirty");
    const permit = safety.createDiscardPermit(inspected.snapshot);

    fs.writeFileSync(path.join(fixture.worktree, "tracked.txt"), "changed after authorization\n", "utf8");

    assert.throws(
      () => safety.verifyWorktreePermit(permit),
      /changed after authorization/
    );
    assert.equal(fs.existsSync(fixture.worktree), true);
  } finally {
    fixture.cleanup();
  }
});

test("interactive single-worktree authorization uses a separate default-no discard confirmation", onPlatforms("linux", "darwin", "win32"), async () => {
  const rm = await loadFreshEsm<RmModule>("lib/sandbox/commands/rm.js");
  const fixture = createLinkedWorktree();
  try {
    fs.writeFileSync(path.join(fixture.worktree, "tracked.txt"), "explicitly discarded\n", "utf8");
    let confirmationCount = 0;
    const permits = await rm.authorizeWorktrees(
      [fixture.worktree],
      { allowDirtyDiscard: true, assumeYes: false },
      {
        interactive: true,
        confirm: async (options) => {
          confirmationCount += 1;
          assert.equal(options.initialValue, false);
          assert.match(options.message, /Discard these exact uncommitted changes/);
          return true;
        }
      }
    );

    assert.equal(confirmationCount, 1);
    assert.equal(permits.get(path.resolve(fixture.worktree))?.mode, "discard");
    assert.equal(fs.existsSync(fixture.worktree), true);
  } finally {
    fixture.cleanup();
  }
});

test("worktree safety snapshot parses rename, delete, and conflict records", onPlatforms("linux", "darwin", "win32"), async () => {
  const safety = await loadFreshEsm<SafetyModule>("lib/sandbox/worktree-safety.js");
  const fixture = createLinkedWorktree();
  try {
    git(fixture.worktree, "mv", "tracked.txt", "renamed.txt");
    const renamed = safety.inspectWorktree(fixture.worktree);
    assert.equal(renamed.status, "dirty");
    assert.ok(renamed.snapshot.changes.some((change) => (
      change.indexStatus === "R" && change.path === "renamed.txt" && change.originalPath === "tracked.txt"
    )));

    git(fixture.worktree, "reset", "--hard", "HEAD");
    fs.rmSync(path.join(fixture.worktree, "tracked.txt"));
    const deleted = safety.inspectWorktree(fixture.worktree);
    assert.equal(deleted.status, "dirty");
    assert.ok(deleted.snapshot.changes.some((change) => change.path === "tracked.txt" && change.worktreeStatus === "D"));

    git(fixture.worktree, "reset", "--hard", "HEAD");
    fs.writeFileSync(path.join(fixture.worktree, "tracked.txt"), "feature version\n", "utf8");
    git(fixture.worktree, "add", "tracked.txt");
    git(fixture.worktree, "-c", "user.name=Sandbox Test", "-c", "user.email=sandbox@example.com", "commit", "-q", "-m", "feature");
    fs.writeFileSync(path.join(fixture.repo, "tracked.txt"), "main version\n", "utf8");
    git(fixture.repo, "add", "tracked.txt");
    git(fixture.repo, "-c", "user.name=Sandbox Test", "-c", "user.email=sandbox@example.com", "commit", "-q", "-m", "main");
    assert.throws(() => git(
      fixture.worktree,
      "-c", "user.name=Sandbox Test",
      "-c", "user.email=sandbox@example.com",
      "merge", "main"
    ));

    const conflicted = safety.inspectWorktree(fixture.worktree);
    assert.equal(conflicted.status, "dirty");
    assert.ok(conflicted.snapshot.changes.some((change) => change.path === "tracked.txt" && change.indexStatus === "U"));
  } finally {
    fixture.cleanup();
  }
});

test("managed worktree removal requires a matching clean permit", onPlatforms("linux", "darwin", "win32"), async () => {
  const safety = await loadFreshEsm<SafetyModule>("lib/sandbox/worktree-safety.js");
  const managedFs = await loadFreshEsm<ManagedFsModule>("lib/sandbox/managed-fs.js");
  const fixture = createLinkedWorktree();
  try {
    const inspected = safety.inspectWorktree(fixture.worktree);
    assert.equal(inspected.status, "clean");
    const permit = safety.createCleanPermit(inspected.snapshot);

    managedFs.removeWorktreeDir(fixture.repo, fixture.base, fixture.worktree, permit);

    assert.equal(fs.existsSync(fixture.worktree), false);
    assert.equal(git(fixture.repo, "branch", "--list", "feature/safe-delete"), "feature/safe-delete");
  } finally {
    fixture.cleanup();
  }
});

test("managed worktree removal preserves a dirty target authorized as clean", onPlatforms("linux", "darwin", "win32"), async () => {
  const safety = await loadFreshEsm<SafetyModule>("lib/sandbox/worktree-safety.js");
  const managedFs = await loadFreshEsm<ManagedFsModule>("lib/sandbox/managed-fs.js");
  const fixture = createLinkedWorktree();
  try {
    const inspected = safety.inspectWorktree(fixture.worktree);
    assert.equal(inspected.status, "clean");
    const permit = safety.createCleanPermit(inspected.snapshot);
    fs.writeFileSync(path.join(fixture.worktree, "tracked.txt"), "do not delete\n", "utf8");

    assert.throws(
      () => managedFs.removeWorktreeDir(fixture.repo, fixture.base, fixture.worktree, permit),
      /changed after authorization/
    );
    assert.equal(fs.readFileSync(path.join(fixture.worktree, "tracked.txt"), "utf8"), "do not delete\n");
  } finally {
    fixture.cleanup();
  }
});

test("managed worktree removal only uses the registered-path fallback when explicitly allowed", onPlatforms("linux", "darwin", "win32"), async () => {
  const safety = await loadFreshEsm<SafetyModule>("lib/sandbox/worktree-safety.js");
  const managedFs = await loadFreshEsm<ManagedFsModule>("lib/sandbox/managed-fs.js");
  const fixture = createLinkedWorktree();
  const calls: string[][] = [];
  try {
    const inspected = safety.inspectWorktree(fixture.worktree);
    assert.equal(inspected.status, "clean");
    const permit = safety.createCleanPermit(inspected.snapshot);

    managedFs.removeWorktreeDir(fixture.repo, fixture.base, fixture.worktree, permit, {
      allowRegisteredPathFallback: true,
      runFn: (cmd, args) => {
        calls.push([cmd, ...args]);
        throw new Error("fatal: is not a working tree");
      },
      runSafeFn: (cmd, args) => {
        calls.push([cmd, ...args]);
        return "";
      }
    });

    assert.equal(fs.existsSync(fixture.worktree), false);
    assert.deepEqual(calls.at(-1), ["git", "-C", fixture.repo, "worktree", "prune"]);
  } finally {
    fixture.cleanup();
  }
});

test("sandbox rm clean path uses injectable default-yes confirmations and removes selected state", onPlatforms("linux", "darwin", "win32"), async () => {
  const rm = await loadFreshEsm<RmModule>("lib/sandbox/commands/rm.js");
  const safety = await loadFreshEsm<SafetyModule>("lib/sandbox/worktree-safety.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-rm-clean-confirm-"));
  const branch = "feature/clean-confirm";
  const prompts: string[] = [];
  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo" });
    const { worktree, share } = await cleanRmOneFixture(rm, safety, fixture, tmpDir, branch, {
      confirm: async (options) => {
        assert.equal(options.initialValue, true);
        prompts.push(options.message);
        return true;
      }
    });

    assert.deepEqual(prompts.map((message) => message.split(" ")[0]), ["Remove", "Also", "Remove"]);
    assert.equal(fs.existsSync(worktree), false);
    assert.equal(git(fixture.repoDir, "branch", "--list", branch), "");
    assert.equal(fs.existsSync(share), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox rm negative confirmations preserve clean worktree, branch, and share", onPlatforms("linux", "darwin", "win32"), async () => {
  const rm = await loadFreshEsm<RmModule>("lib/sandbox/commands/rm.js");
  const safety = await loadFreshEsm<SafetyModule>("lib/sandbox/worktree-safety.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-rm-clean-negative-"));
  const branch = "feature/clean-negative";
  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo" });
    const { worktree, share } = await cleanRmOneFixture(rm, safety, fixture, tmpDir, branch, {
      confirm: async () => false
    });

    assert.equal(fs.existsSync(worktree), true);
    assert.match(git(fixture.repoDir, "show-ref", "--verify", `refs/heads/${branch}`), new RegExp(`refs/heads/${branch}$`));
    assert.equal(fs.existsSync(share), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox rm cancellation at the worktree confirmation stops before every cleanup", onPlatforms("linux", "darwin", "win32"), async () => {
  const rm = await loadFreshEsm<RmModule>("lib/sandbox/commands/rm.js");
  const safety = await loadFreshEsm<SafetyModule>("lib/sandbox/worktree-safety.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-rm-clean-cancel-"));
  const branch = "feature/clean-cancel";
  const cancel = Symbol("cancel");
  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo" });
    const { worktree, share } = await cleanRmOneFixture(rm, safety, fixture, tmpDir, branch, {
      confirm: async () => cancel,
      isCancel: (value): value is symbol => value === cancel
    });

    assert.equal(fs.existsSync(worktree), true);
    assert.match(git(fixture.repoDir, "show-ref", "--verify", `refs/heads/${branch}`), new RegExp(`refs/heads/${branch}$`));
    assert.equal(fs.existsSync(share), true);
    assert.equal(fixture.readDockerCalls().some((call) => call[0] === "stop" || call[0] === "rm"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox rm --unbound --yes removes a real clean linked worktree and branch", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-rm-unbound-clean-"));
  const branch = "feature/clean-unbound";
  const row = `demo-dev-${branch.replaceAll("/", "..")}\tUp 1 minute\tdemo.sandbox.branch=${branch},demo.sandbox=true`;
  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo", dockerStdoutForPs: row });
    const worktree = addFixtureWorktree(fixture, tmpDir, branch);

    const result = spawnSandboxCli(fixture, tmpDir, ["rm", "--unbound", "--yes"]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(worktree), false);
    assert.equal(git(fixture.repoDir, "branch", "--list", branch), "");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox purge removes real clean linked worktrees after confirmation", onPlatforms("linux", "darwin", "win32"), async () => {
  const rm = await loadFreshEsm<RmModule>("lib/sandbox/commands/rm.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-rm-purge-clean-"));
  const branch = "feature/clean-purge-success";
  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo" });
    const config = rmOneConfig(fixture, tmpDir);
    const worktree = addFixtureWorktree(fixture, tmpDir, branch);
    const shellConfig = path.join(config.shellConfigBase, branch.replaceAll("/", ".."));
    fs.mkdirSync(shellConfig, { recursive: true });
    const confirmations: boolean[] = [];

    await rm.rmPurge(config, [], {
      confirm: async (options) => {
        confirmations.push(Boolean(options.initialValue));
        return Boolean(options.initialValue);
      }
    });

    assert.deepEqual(confirmations, [true, true, false]);
    assert.equal(fs.existsSync(worktree), false);
    assert.match(git(fixture.repoDir, "show-ref", "--verify", `refs/heads/${branch}`), new RegExp(`refs/heads/${branch}$`));
    assert.equal(fs.existsSync(shellConfig), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox prune removes a real clean orphan worktree after confirmation", onPlatforms("linux", "darwin", "win32"), async () => {
  const prune = await loadFreshEsm<PruneModule>("lib/sandbox/commands/prune.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-prune-clean-"));
  const branch = "feature/clean-prune-success";
  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo" });
    const config = rmOneConfig(fixture, tmpDir);
    const worktree = addFixtureWorktree(fixture, tmpDir, branch);
    let confirmationCount = 0;

    await prune.prune([], {
      config,
      tools: [],
      engine: "docker-desktop",
      labelsOutput: "",
      confirm: async (options) => {
        confirmationCount += 1;
        assert.equal(options.initialValue, true);
        return true;
      }
    });

    assert.equal(confirmationCount, 1);
    assert.equal(fs.existsSync(worktree), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox rm fails closed when the managed worktree path is not a Git worktree", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-rm-probe-failed-"));
  const branch = "feature/probe-failed";
  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo" });
    const worktree = path.join(tmpDir, ".agent-infra", "worktrees", "demo", branch.replaceAll("/", ".."));
    const managedDir = path.join(tmpDir, ".agent-infra", "config", "demo", branch.replaceAll("/", ".."));
    fs.mkdirSync(worktree, { recursive: true });
    fs.mkdirSync(managedDir, { recursive: true });

    const result = spawnSandboxCli(fixture, tmpDir, ["rm", branch]);

    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /Unable to inspect worktree/);
    assert.equal(fs.existsSync(worktree), true);
    assert.equal(fs.existsSync(managedDir), true);
    assert.equal(fixture.readDockerCalls().some((call) => call[0] === "stop" || call[0] === "rm"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox rm refuses a dirty linked worktree before container cleanup", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-rm-dirty-"));
  const branch = "feature/dirty-single";
  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo" });
    const worktree = addFixtureWorktree(fixture, tmpDir, branch);
    const managedDir = path.join(tmpDir, ".agent-infra", "shell-config", "demo", branch.replaceAll("/", ".."));
    fs.mkdirSync(managedDir, { recursive: true });
    fs.writeFileSync(path.join(worktree, "tracked.txt"), "keep this change\n", "utf8");

    const result = spawnSandboxCli(fixture, tmpDir, ["rm", branch]);

    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /Refusing to remove dirty worktree/);
    assert.equal(fs.readFileSync(path.join(worktree, "tracked.txt"), "utf8"), "keep this change\n");
    assert.match(git(fixture.repoDir, "show-ref", "--verify", `refs/heads/${branch}`), new RegExp(`refs/heads/${branch}$`));
    assert.equal(fs.existsSync(managedDir), true);
    assert.equal(fixture.readDockerCalls().some((call) => call[0] === "stop" || call[0] === "rm"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox rm --unbound preflights all worktrees before deleting any sandbox", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-rm-unbound-dirty-"));
  const cleanBranch = "feature/clean-batch";
  const dirtyBranch = "feature/dirty-batch";
  const rows = [cleanBranch, dirtyBranch].map((branch) => (
    `demo-dev-${branch.replaceAll("/", "..")}\tUp 1 minute\tdemo.sandbox.branch=${branch},demo.sandbox=true`
  )).join("\n");
  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo", dockerStdoutForPs: rows });
    const cleanWorktree = addFixtureWorktree(fixture, tmpDir, cleanBranch);
    const dirtyWorktree = addFixtureWorktree(fixture, tmpDir, dirtyBranch);
    fs.writeFileSync(path.join(dirtyWorktree, "untracked.txt"), "keep this untracked file\n", "utf8");

    const result = spawnSandboxCli(fixture, tmpDir, ["rm", "--unbound", "--yes"]);

    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /worktree preflight found blocker/);
    assert.equal(fs.existsSync(cleanWorktree), true);
    assert.equal(fs.existsSync(path.join(dirtyWorktree, "untracked.txt")), true);
    assert.equal(fixture.readDockerCalls().some((call) => call[0] === "stop" || call[0] === "rm"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox rm --purge refuses dirty worktrees before stopping project containers", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-rm-purge-dirty-"));
  const cleanBranch = "feature/clean-purge";
  const dirtyBranch = "feature/dirty-purge";
  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo" });
    const cleanWorktree = addFixtureWorktree(fixture, tmpDir, cleanBranch);
    const dirtyWorktree = addFixtureWorktree(fixture, tmpDir, dirtyBranch);
    fs.writeFileSync(path.join(dirtyWorktree, "tracked.txt"), "purge must preserve this\n", "utf8");

    const result = spawnSandboxCli(fixture, tmpDir, ["rm", "--purge"]);

    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /worktree preflight found blocker/);
    assert.equal(fs.existsSync(cleanWorktree), true);
    assert.equal(fs.existsSync(dirtyWorktree), true);
    assert.equal(fixture.readDockerCalls().some((call) => call[0] === "stop" || call[0] === "rm"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox prune preserves every orphan group when an orphan worktree is dirty", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-prune-dirty-"));
  const cleanBranch = "feature/clean-prune";
  const dirtyBranch = "feature/dirty-prune";
  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo", dockerStdoutForPs: "" });
    const cleanWorktree = addFixtureWorktree(fixture, tmpDir, cleanBranch);
    const dirtyWorktree = addFixtureWorktree(fixture, tmpDir, dirtyBranch);
    const shellDir = path.join(tmpDir, ".agent-infra", "config", "demo", "orphan-shell");
    fs.mkdirSync(shellDir, { recursive: true });
    fs.writeFileSync(path.join(dirtyWorktree, "tracked.txt"), "prune must preserve this\n", "utf8");

    const result = spawnSandboxCli(fixture, tmpDir, ["prune"]);

    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /worktree preflight found blocker/);
    assert.equal(fs.existsSync(cleanWorktree), true);
    assert.equal(fs.existsSync(dirtyWorktree), true);
    assert.equal(fs.existsSync(shellDir), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
