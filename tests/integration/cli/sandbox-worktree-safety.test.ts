import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SandboxConfig } from "../../../lib/sandbox/config.ts";
import { sandboxControlPaths } from "../../../lib/sandbox/workspace-view.ts";
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

function removeWorktreeMetadata(worktree: string): void {
  const dotGit = fs.readFileSync(path.join(worktree, ".git"), "utf8").trim();
  const match = /^gitdir:\s*(.+)$/i.exec(dotGit);
  assert.ok(match?.[1]);
  fs.rmSync(path.resolve(path.dirname(path.join(worktree, ".git")), match[1]), { recursive: true, force: true });
}

function addActiveTask(
  repoDir: string,
  taskId: string,
  branch: string,
  shortId = "7"
): void {
  const activeRoot = path.join(repoDir, ".agents", "workspace", "active");
  fs.mkdirSync(path.join(activeRoot, taskId), { recursive: true });
  fs.writeFileSync(
    path.join(activeRoot, taskId, "task.md"),
    `---\nid: ${taskId}\nbranch: ${branch}\n---\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(activeRoot, ".short-ids.json"),
    `${JSON.stringify({ version: 1, ids: { [shortId]: taskId } })}\n`,
    "utf8"
  );
}

async function withFixtureDocker<T>(
  fixture: ReturnType<typeof writeSandboxEngineFixture>,
  callback: () => Promise<T>
): Promise<T> {
  const originalPath = process.env.PATH;
  const originalDockerLogPath = process.env.DOCKER_LOG_PATH;
  process.env.PATH = envWithPrependedPath(process.env, fixture.binDir).PATH;
  process.env.DOCKER_LOG_PATH = fixture.logPath;
  try {
    return await callback();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalDockerLogPath === undefined) delete process.env.DOCKER_LOG_PATH;
    else process.env.DOCKER_LOG_PATH = originalDockerLogPath;
  }
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
      opencode: { enabled: false, installInSandbox: false },
      traecli: { enabled: false, installInSandbox: false }
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
      toolCandidates: [],
      workspace: { mode: "branch-only" },
      controlRoots: [],
      workspaceViewRoots: []
    },
    permits: new Map([[path.resolve(worktree), permit]]),
    prompt
  });
  return { worktree, share };
}

test("sandbox rm retries control and workspace cleanup after the container is already gone", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-rm-partial-retry-"));
  const branch = "feature/partial-retry";
  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo" });
    const config = rmOneConfig(fixture, tmpDir);
    const container = "demo-dev-feature..partial-retry";
    const controlRoot = path.join(config.controlBase, config.project, container, "branch-only");
    const siblingControlRoot = path.join(path.dirname(controlRoot), "another-task");
    const workspaceViewRoot = path.join(config.workspaceViewBase, config.project, container, "branch-only");
    const channelDir = path.join(controlRoot, "channel");
    const processingDir = path.join(controlRoot, "processing");
    fs.mkdirSync(channelDir, { recursive: true });
    fs.mkdirSync(path.join(controlRoot, "public"), { recursive: true });
    fs.mkdirSync(processingDir, { recursive: true });
    fs.mkdirSync(siblingControlRoot, { recursive: true });
    fs.writeFileSync(path.join(siblingControlRoot, "keep"), "sibling\n");
    fs.mkdirSync(workspaceViewRoot, { recursive: true });
    fs.writeFileSync(path.join(controlRoot, "manifest.json"), `${JSON.stringify({
      version: 5, engine: "docker-desktop", repoRoot: fixture.repoDir, worktreeRoot: fixture.repoDir,
      project: "demo", container, containerIdentity: { id: "fixture-container-id", labels: {} }, branch,
      mode: "branch-only", taskId: null, token: "partial-secret", generation: "partial-generation",
      channelDir, publicStatusDir: path.join(controlRoot, "public"), processingDir,
      runtimeDir: path.join(controlRoot, "runtime")
    })}\n`);
    fs.writeFileSync(path.join(controlRoot, "public", "status.json"), `${JSON.stringify({
      version: 2,
      generation: "partial-generation",
      broker: { pid: 999_999_999, startTime: 0, brokerId: "stale-broker" },
      state: "healthy",
      reasonCode: null,
      activeRequestId: null,
      updatedAt: Date.now()
    })}\n`);
    const rm = await loadFreshEsm<RmModule>("lib/sandbox/commands/rm.js");

    const previousNotFound = process.env.DOCKER_INSPECT_NOT_FOUND;
    const previousPath = process.env.PATH;
    const previousDockerLog = process.env.DOCKER_LOG_PATH;
    process.env.PATH = `${fixture.binDir}${path.delimiter}${previousPath ?? ""}`;
    process.env.DOCKER_LOG_PATH = fixture.logPath;
    process.env.DOCKER_INSPECT_NOT_FOUND = "1";
    try {
      await rm.rmOne(config, [], branch, {
      assumeYes: true,
      target: {
        branch,
        effectiveBranch: branch,
        engine: "docker-desktop",
        matchedContainers: [],
        existingWorktrees: [],
        toolCandidates: [],
        workspace: { mode: "branch-only" },
        controlRoots: [controlRoot],
        workspaceViewRoots: [workspaceViewRoot]
      }
      });
    } finally {
      if (previousNotFound === undefined) delete process.env.DOCKER_INSPECT_NOT_FOUND;
      else process.env.DOCKER_INSPECT_NOT_FOUND = previousNotFound;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousDockerLog === undefined) delete process.env.DOCKER_LOG_PATH;
      else process.env.DOCKER_LOG_PATH = previousDockerLog;
    }

    assert.equal(fs.existsSync(controlRoot), false);
    assert.equal(fs.existsSync(workspaceViewRoot), false);
    assert.equal(fs.existsSync(siblingControlRoot), true);
    assert.equal(fs.existsSync(path.dirname(controlRoot)), true);
    assert.equal(fs.existsSync(path.dirname(workspaceViewRoot)), false);
    assert.equal(fixture.readDockerCalls().some((call) => call[0] === "stop" || call[0] === "rm"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox rm removes an empty control container parent after control cleanup", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-rm-empty-control-parent-"));
  const branch = "feature/empty-control-parent";
  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo" });
    const config = rmOneConfig(fixture, tmpDir);
    const container = "demo-dev-feature..empty-control-parent";
    const controlRoot = path.join(config.controlBase, config.project, container, "branch-only");
    const channelDir = path.join(controlRoot, "channel");
    const processingDir = path.join(controlRoot, "processing");
    fs.mkdirSync(channelDir, { recursive: true });
    fs.mkdirSync(path.join(controlRoot, "public"), { recursive: true });
    fs.mkdirSync(processingDir, { recursive: true });
    fs.writeFileSync(path.join(controlRoot, "manifest.json"), `${JSON.stringify({
      version: 5, engine: "docker-desktop", repoRoot: fixture.repoDir, worktreeRoot: fixture.repoDir,
      project: "demo", container, containerIdentity: { id: "empty-parent-container", labels: {} }, branch,
      mode: "branch-only", taskId: null, token: "empty-parent-secret", generation: "empty-parent-generation",
      channelDir, publicStatusDir: path.join(controlRoot, "public"), processingDir,
      runtimeDir: path.join(controlRoot, "runtime")
    })}\n`);
    fs.writeFileSync(path.join(controlRoot, "public", "status.json"), `${JSON.stringify({
      version: 2,
      generation: "empty-parent-generation",
      broker: { pid: 999_999_999, startTime: 0, brokerId: "stale-broker" },
      state: "healthy",
      reasonCode: null,
      activeRequestId: null,
      updatedAt: Date.now()
    })}\n`);
    const previousPath = process.env.PATH;
    const previousDockerLog = process.env.DOCKER_LOG_PATH;
    const previousNotFound = process.env.DOCKER_INSPECT_NOT_FOUND;
    process.env.PATH = envWithPrependedPath(process.env, fixture.binDir).PATH;
    process.env.DOCKER_LOG_PATH = fixture.logPath;
    process.env.DOCKER_INSPECT_NOT_FOUND = "1";
    try {
      const rm = await loadFreshEsm<RmModule>("lib/sandbox/commands/rm.js");
      await rm.rmOne(config, [], branch, {
        assumeYes: true,
        target: {
          branch,
          effectiveBranch: branch,
          engine: "docker-desktop",
          matchedContainers: [],
          existingWorktrees: [],
          toolCandidates: [],
          workspace: { mode: "branch-only" },
          controlRoots: [controlRoot],
          workspaceViewRoots: []
        }
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousDockerLog === undefined) delete process.env.DOCKER_LOG_PATH;
      else process.env.DOCKER_LOG_PATH = previousDockerLog;
      if (previousNotFound === undefined) delete process.env.DOCKER_INSPECT_NOT_FOUND;
      else process.env.DOCKER_INSPECT_NOT_FOUND = previousNotFound;
    }

    assert.equal(fs.existsSync(controlRoot), false);
    assert.equal(fs.existsSync(path.dirname(controlRoot)), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

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

test("recovered worktree safety uses an isolated branch snapshot after metadata loss", onPlatforms("linux", "darwin", "win32"), async () => {
  const safety = await loadFreshEsm<SafetyModule>("lib/sandbox/worktree-safety.js");
  const fixture = createLinkedWorktree();
  try {
    removeWorktreeMetadata(fixture.worktree);
    const recovery = {
      repoRoot: fixture.repo,
      worktreeBase: fixture.base,
      branch: "feature/safe-delete",
      identitySource: "branch-only" as const,
      taskId: null
    };

    assert.equal(safety.inspectWorktree(fixture.worktree).status, "failed");
    const clean = safety.inspectRecoveredWorktree(fixture.worktree, recovery);
    assert.equal(clean.status, "clean");
    assert.equal(clean.snapshot.source, "recovered");

    fs.writeFileSync(path.join(fixture.worktree, "tracked.txt"), "recovered dirty\n", "utf8");
    const dirty = safety.inspectRecoveredWorktree(fixture.worktree, recovery);
    assert.equal(dirty.status, "dirty");
    assert.ok(dirty.snapshot.changes.some((change) => change.path === "tracked.txt"));
  } finally {
    fixture.cleanup();
  }
});

test("recovered worktree safety accepts clearly partial admin metadata", onPlatforms("linux", "darwin", "win32"), async () => {
  const safety = await loadFreshEsm<SafetyModule>("lib/sandbox/worktree-safety.js");
  const fixture = createLinkedWorktree();
  try {
    const dotGit = fs.readFileSync(path.join(fixture.worktree, ".git"), "utf8").trim();
    const match = /^gitdir:\s*(.+)$/i.exec(dotGit);
    assert.ok(match?.[1]);
    const adminPath = path.resolve(path.dirname(path.join(fixture.worktree, ".git")), match[1]);
    fs.rmSync(path.join(adminPath, "commondir"), { force: true });

    const recovered = safety.inspectRecoveredWorktree(fixture.worktree, {
      repoRoot: fixture.repo,
      worktreeBase: fixture.base,
      branch: "feature/safe-delete",
      identitySource: "branch-only",
      taskId: null
    });

    assert.equal(recovered.status, "clean", JSON.stringify(recovered));
  } finally {
    fixture.cleanup();
  }
});

test("recovered worktree safety resolves the common Git directory from a linked repo root", onPlatforms("linux", "darwin", "win32"), async () => {
  const safety = await loadFreshEsm<SafetyModule>("lib/sandbox/worktree-safety.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-worktree-linked-root-"));
  const mainRepo = path.join(root, "main");
  const repoRoot = path.join(root, "management");
  const worktreeBase = path.join(root, "sandboxes");
  const worktree = path.join(worktreeBase, "feature..safe-delete");
  try {
    fs.mkdirSync(mainRepo, { recursive: true });
    fs.mkdirSync(worktreeBase, { recursive: true });
    git(mainRepo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(mainRepo, "tracked.txt"), "initial\n", "utf8");
    git(mainRepo, "add", "tracked.txt");
    git(mainRepo, "-c", "user.name=Sandbox Test", "-c", "user.email=sandbox@example.com", "commit", "-q", "-m", "initial");
    git(mainRepo, "worktree", "add", "-q", "-b", "management", repoRoot, "HEAD");
    git(mainRepo, "worktree", "add", "-q", "-b", "feature/safe-delete", worktree, "HEAD");
    removeWorktreeMetadata(worktree);

    const recovered = safety.inspectRecoveredWorktree(worktree, {
      repoRoot,
      worktreeBase,
      branch: "feature/safe-delete",
      identitySource: "branch-only",
      taskId: null
    });

    assert.equal(recovered.status, "clean", JSON.stringify(recovered));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recovered worktree safety accepts clearly damaged HEAD or index metadata", onPlatforms("linux", "darwin", "win32"), async () => {
  const safety = await loadFreshEsm<SafetyModule>("lib/sandbox/worktree-safety.js");
  for (const damagedFile of ["HEAD", "index"]) {
    const fixture = createLinkedWorktree();
    try {
      const dotGit = fs.readFileSync(path.join(fixture.worktree, ".git"), "utf8").trim();
      const match = /^gitdir:\s*(.+)$/i.exec(dotGit);
      assert.ok(match?.[1]);
      const adminPath = path.resolve(path.dirname(path.join(fixture.worktree, ".git")), match[1]);
      fs.writeFileSync(
        path.join(adminPath, damagedFile),
        damagedFile === "HEAD"
          ? "not a valid HEAD\n"
          : Buffer.from([0x44, 0x49, 0x52, 0x43, 0, 0, 0, 2, 0, 0, 0, 0])
      );

      const recovered = safety.inspectRecoveredWorktree(fixture.worktree, {
        repoRoot: fixture.repo,
        worktreeBase: fixture.base,
        branch: "feature/safe-delete",
        identitySource: "branch-only",
        taskId: null
      });

      assert.equal(recovered.status, "clean", `${damagedFile}: ${JSON.stringify(recovered)}`);
    } finally {
      fixture.cleanup();
    }
  }
});

test("recovered worktree safety rejects damaged content with inconsistent admin pointers", onPlatforms("linux", "darwin", "win32"), async () => {
  const safety = await loadFreshEsm<SafetyModule>("lib/sandbox/worktree-safety.js");
  const cases = [
    { damagedFile: "HEAD", pointerFile: "gitdir" },
    { damagedFile: "index", pointerFile: "commondir" }
  ] as const;

  for (const { damagedFile, pointerFile } of cases) {
    const fixture = createLinkedWorktree();
    try {
      const dotGit = fs.readFileSync(path.join(fixture.worktree, ".git"), "utf8").trim();
      const match = /^gitdir:\s*(.+)$/i.exec(dotGit);
      assert.ok(match?.[1]);
      const adminPath = path.resolve(path.dirname(path.join(fixture.worktree, ".git")), match[1]);
      fs.writeFileSync(
        path.join(adminPath, damagedFile),
        damagedFile === "HEAD"
          ? "not a valid HEAD\n"
          : Buffer.from([0x44, 0x49, 0x52, 0x43, 0, 0, 0, 2, 0, 0, 0, 0])
      );
      const wrongPointer = path.join(path.dirname(adminPath), `wrong-${pointerFile}`);
      fs.mkdirSync(wrongPointer, { recursive: true });
      fs.writeFileSync(path.join(adminPath, pointerFile), `${wrongPointer}\n`, "utf8");

      const recovered = safety.inspectRecoveredWorktree(fixture.worktree, {
        repoRoot: fixture.repo,
        worktreeBase: fixture.base,
        branch: "feature/safe-delete",
        identitySource: "branch-only",
        taskId: null
      });

      assert.equal(recovered.status, "failed", `${damagedFile}/${pointerFile}: ${JSON.stringify(recovered)}`);
      assert.match(recovered.message ?? "", /WORKTREE_RECOVERY_METADATA_INVALID/);
    } finally {
      fixture.cleanup();
    }
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

test("sandbox rm recovers and removes a clean worktree with missing metadata", onPlatforms("linux", "darwin", "win32"), async () => {
  const rm = await loadFreshEsm<RmModule>("lib/sandbox/commands/rm.js");
  const fixture = writeSandboxEngineFixture(fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-rm-recovered-clean-")), { project: "demo" });
  const tmpDir = path.dirname(fixture.repoDir);
  const branch = "feature/recovered-clean";
  try {
    const worktree = addFixtureWorktree(fixture, tmpDir, branch);
    removeWorktreeMetadata(worktree);
    const prompts: string[] = [];
    await withFixtureDocker(fixture, () => rm.rmOne(rmOneConfig(fixture, tmpDir), [], branch, {
      interactive: true,
      prompt: {
        confirm: async (options) => {
          prompts.push(options.message);
          return true;
        },
        isCancel: (value): value is symbol => false
      }
    }));

    assert.equal(fs.existsSync(worktree), false);
    assert.equal(git(fixture.repoDir, "branch", "--list", branch), "");
    assert.equal(prompts.filter((message) => message.startsWith("Remove worktree")).length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox rm refuses a container with conflicting workspace identity before destructive calls", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-rm-container-conflict-"));
  const branch = "feature/container-conflict";
  const container = `demo-dev-${branch.replaceAll("/", "..")}`;
  const row = `${container}\tUp 1 minute\tdemo.sandbox.branch=${branch},demo.sandbox.workspace-mode=task-bound,demo.sandbox.task-id=TASK-20260824-999999`;
  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo", dockerStdoutForPs: row });
    const worktree = addFixtureWorktree(fixture, tmpDir, branch);
    removeWorktreeMetadata(worktree);

    const result = spawnSandboxCli(fixture, tmpDir, ["rm", branch]);

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /SANDBOX_WORKSPACE_IDENTITY_CONFLICT/);
    assert.equal(fs.existsSync(worktree), true);
    assert.match(git(fixture.repoDir, "branch", "--list", branch), new RegExp(branch));
    assert.equal(fixture.readDockerCalls().some((call) => call[0] === "stop" || call[0] === "rm"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox rm refuses a container whose branch label conflicts with the requested branch", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-rm-container-branch-conflict-"));
  const requestedBranch = "feature/container-requested";
  const labelledBranch = "feature/container-labelled";
  const container = `demo-dev-${requestedBranch.replaceAll("/", "..")}`;
  const row = `${container}\tUp 1 minute\tdemo.sandbox.branch=${labelledBranch},demo.sandbox=true`;
  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo", dockerStdoutForPs: row });
    const labelledWorktree = addFixtureWorktree(fixture, tmpDir, labelledBranch);
    removeWorktreeMetadata(labelledWorktree);

    const result = spawnSandboxCli(fixture, tmpDir, ["rm", requestedBranch]);

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /SANDBOX_WORKSPACE_IDENTITY_CONFLICT/);
    assert.equal(fs.existsSync(labelledWorktree), true);
    assert.match(git(fixture.repoDir, "branch", "--list", labelledBranch), new RegExp(labelledBranch));
    assert.equal(fixture.readDockerCalls().some((call) => call[0] === "stop" || call[0] === "rm"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox rm rejects a control manifest whose container does not match its control-root path", onPlatforms("linux", "darwin", "win32"), async () => {
  const rm = await loadFreshEsm<RmModule>("lib/sandbox/commands/rm.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-rm-control-manifest-mismatch-"));
  const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo" });
  const branch = "feature/control-manifest-mismatch";
  const taskId = "TASK-20260824-000002";
  const container = `demo-dev-${branch.replaceAll("/", "..")}`;
  const config = rmOneConfig(fixture, tmpDir);
  const controlRoot = sandboxControlPaths({
    base: config.controlBase,
    project: config.project,
    container,
    identity: { mode: "task-bound", taskId }
  }).root;
  try {
    const channelDir = path.join(controlRoot, "channel");
    const publicStatusDir = path.join(controlRoot, "public");
    const processingDir = path.join(controlRoot, "processing");
    fs.mkdirSync(channelDir, { recursive: true });
    fs.mkdirSync(publicStatusDir, { recursive: true });
    fs.mkdirSync(processingDir, { recursive: true });
    fs.writeFileSync(path.join(controlRoot, "manifest.json"), `${JSON.stringify({
      version: 5,
      engine: "docker-desktop",
      repoRoot: fixture.repoDir,
      worktreeRoot: fixture.repoDir,
      project: "demo",
      container: "different-container",
      containerIdentity: { id: "fixture-container-id", labels: {} },
      branch,
      mode: "task-bound",
      taskId,
      token: "manifest-mismatch-token",
      generation: "manifest-mismatch-generation",
      channelDir,
      publicStatusDir,
      processingDir,
      runtimeDir: path.join(controlRoot, "runtime")
    })}\n`);
    fs.writeFileSync(path.join(publicStatusDir, "status.json"), `${JSON.stringify({
      version: 2,
      generation: "manifest-mismatch-generation",
      broker: { pid: 999_999_999, startTime: 0, brokerId: "stale-broker" },
      state: "healthy",
      reasonCode: null,
      activeRequestId: null,
      updatedAt: Date.now()
    })}\n`);

    const previousNotFound = process.env.DOCKER_INSPECT_NOT_FOUND;
    process.env.DOCKER_INSPECT_NOT_FOUND = "1";
    try {
      await assert.rejects(
        () => withFixtureDocker(fixture, () => rm.rmOne(config, [], branch, {
          assumeYes: true,
          cleanupTarget: {
            requestedRef: taskId,
            branch,
            workspace: { mode: "task-bound", taskId },
            taskState: "completed"
          },
          target: {
            branch,
            effectiveBranch: branch,
            engine: "docker-desktop",
            matchedContainers: [],
            existingWorktrees: [],
            toolCandidates: [],
            workspace: { mode: "task-bound", taskId },
            controlRoots: [controlRoot],
            workspaceViewRoots: []
          }
        })),
        /SANDBOX_CONTROL_TARGET_MISMATCH/
      );
    } finally {
      if (previousNotFound === undefined) delete process.env.DOCKER_INSPECT_NOT_FOUND;
      else process.env.DOCKER_INSPECT_NOT_FOUND = previousNotFound;
    }
    assert.equal(fs.existsSync(controlRoot), true);
    assert.equal(fixture.readDockerCalls().some((call) => call[0] === "stop" || call[0] === "rm"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox rm cleans a completed task-bound sandbox only with matching control evidence", onPlatforms("linux", "darwin", "win32"), async () => {
  const rm = await loadFreshEsm<RmModule>("lib/sandbox/commands/rm.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-rm-completed-task-control-"));
  const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo" });
  const branch = "feature/completed-task-control";
  const taskId = "TASK-20260824-000003";
  const container = `demo-dev-${branch.replaceAll("/", "..")}`;
  const config = rmOneConfig(fixture, tmpDir);
  const controlRoot = sandboxControlPaths({
    base: config.controlBase,
    project: config.project,
    container,
    identity: { mode: "task-bound", taskId }
  }).root;
  try {
    const taskDir = path.join(fixture.repoDir, ".agents", "workspace", "completed", taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "task.md"), `---\nid: ${taskId}\nbranch: ${branch}\n---\n`, "utf8");
    const channelDir = path.join(controlRoot, "channel");
    const publicStatusDir = path.join(controlRoot, "public");
    const processingDir = path.join(controlRoot, "processing");
    fs.mkdirSync(channelDir, { recursive: true });
    fs.mkdirSync(publicStatusDir, { recursive: true });
    fs.mkdirSync(processingDir, { recursive: true });
    fs.writeFileSync(path.join(controlRoot, "manifest.json"), `${JSON.stringify({
      version: 5,
      engine: "docker-desktop",
      repoRoot: fixture.repoDir,
      worktreeRoot: fixture.repoDir,
      project: "demo",
      container,
      containerIdentity: { id: "fixture-container-id", labels: {} },
      branch,
      mode: "task-bound",
      taskId,
      token: "completed-task-token",
      generation: "completed-task-generation",
      channelDir,
      publicStatusDir,
      processingDir,
      runtimeDir: path.join(controlRoot, "runtime")
    })}\n`);
    fs.writeFileSync(path.join(publicStatusDir, "status.json"), `${JSON.stringify({
      version: 2,
      generation: "completed-task-generation",
      broker: { pid: 999_999_999, startTime: 0, brokerId: "stale-broker" },
      state: "healthy",
      reasonCode: null,
      activeRequestId: null,
      updatedAt: Date.now()
    })}\n`);
    const shellConfig = path.join(config.shellConfigBase, branch.replaceAll("/", ".."));
    fs.mkdirSync(shellConfig, { recursive: true });

    const previousNotFound = process.env.DOCKER_INSPECT_NOT_FOUND;
    process.env.DOCKER_INSPECT_NOT_FOUND = "1";
    try {
      await withFixtureDocker(fixture, () => rm.rmOne(config, [], branch, {
        assumeYes: true,
        cleanupTarget: {
          requestedRef: taskId,
          branch,
          workspace: { mode: "task-bound", taskId },
          taskState: "completed"
        },
        target: {
          branch,
          effectiveBranch: branch,
          engine: "docker-desktop",
          matchedContainers: [],
          existingWorktrees: [],
          toolCandidates: [],
          workspace: { mode: "task-bound", taskId },
          controlRoots: [controlRoot],
          workspaceViewRoots: []
        }
      }));
    } finally {
      if (previousNotFound === undefined) delete process.env.DOCKER_INSPECT_NOT_FOUND;
      else process.env.DOCKER_INSPECT_NOT_FOUND = previousNotFound;
    }

    assert.equal(fs.existsSync(controlRoot), false);
    assert.equal(fs.existsSync(shellConfig), false);
    assert.equal(fixture.readDockerCalls().some((call) => call[0] === "stop" || call[0] === "rm"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox rm allows explicit discard of a stable recovered dirty snapshot", onPlatforms("linux", "darwin", "win32"), async () => {
  const rm = await loadFreshEsm<RmModule>("lib/sandbox/commands/rm.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-rm-recovered-dirty-"));
  const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo" });
  const branch = "feature/recovered-dirty";
  try {
    const worktree = addFixtureWorktree(fixture, tmpDir, branch);
    removeWorktreeMetadata(worktree);
    fs.writeFileSync(path.join(worktree, "tracked.txt"), "discard recovered change\n", "utf8");
    const prompts: Array<{ message: string; initialValue: boolean }> = [];
    await withFixtureDocker(fixture, () => rm.rmOne(rmOneConfig(fixture, tmpDir), [], branch, {
      interactive: true,
      prompt: {
        confirm: async (options) => {
          prompts.push({ message: options.message, initialValue: Boolean(options.initialValue) });
          return true;
        },
        isCancel: (value): value is symbol => false
      }
    }));

    assert.equal(fs.existsSync(worktree), false);
    assert.equal(git(fixture.repoDir, "branch", "--list", branch), "");
    assert.equal(prompts.some(({ message, initialValue }) => (
      message === "Discard these exact uncommitted changes?" && initialValue === false
    )), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox rm accepts a task-bound resolver identity when container and control roots are gone", onPlatforms("linux", "darwin", "win32"), async () => {
  const rm = await loadFreshEsm<RmModule>("lib/sandbox/commands/rm.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-rm-recovered-task-bound-"));
  const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo" });
  const branch = "agent-infra-feature-recovered-task";
  try {
    addActiveTask(fixture.repoDir, "TASK-20260824-000001", branch);
    const worktree = addFixtureWorktree(fixture, tmpDir, branch);
    removeWorktreeMetadata(worktree);
    await withFixtureDocker(fixture, () => rm.rmOne(rmOneConfig(fixture, tmpDir), [], branch, {
      interactive: true,
      prompt: { confirm: async () => true, isCancel: (value): value is symbol => false }
    }));

    assert.equal(fs.existsSync(worktree), false);
    assert.equal(git(fixture.repoDir, "branch", "--list", branch), "");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox rm keeps malformed recovery metadata fail-closed", onPlatforms("linux", "darwin", "win32"), async () => {
  const rm = await loadFreshEsm<RmModule>("lib/sandbox/commands/rm.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-rm-recovered-invalid-"));
  const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo" });
  const branch = "feature/recovered-invalid";
  try {
    const worktree = addFixtureWorktree(fixture, tmpDir, branch);
    fs.writeFileSync(path.join(worktree, ".git"), "gitdir: /outside/recovery\n", "utf8");

    await assert.rejects(
      () => withFixtureDocker(fixture, () => rm.rmOne(rmOneConfig(fixture, tmpDir), [], branch, {
        interactive: true,
        prompt: { confirm: async () => true, isCancel: (value): value is symbol => false }
      })),
      /WORKTREE_RECOVERY_METADATA_INVALID/
    );
    assert.equal(fs.existsSync(worktree), true);
    assert.match(git(fixture.repoDir, "branch", "--list", branch), new RegExp(branch));
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
  const row = `demo-dev-${branch.replaceAll("/", "..")}\tUp 1 minute\tdemo.sandbox.branch=${branch},demo.sandbox=true,demo.sandbox.workspace-mode=branch-only`;
  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo", dockerStdoutForPs: row });
    const worktree = addFixtureWorktree(fixture, tmpDir, branch);

    const result = spawnSandboxCli(fixture, tmpDir, ["rm", "--unbound", "--yes"]);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
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
    const originalPath = process.env.PATH;
    const originalDockerLogPath = process.env.DOCKER_LOG_PATH;
    process.env.PATH = envWithPrependedPath(process.env, fixture.binDir).PATH;
    process.env.DOCKER_LOG_PATH = fixture.logPath;

    try {
      await rm.rmPurge(config, [], {
        confirm: async (options) => {
          confirmations.push(Boolean(options.initialValue));
          return Boolean(options.initialValue);
        }
      });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalDockerLogPath === undefined) delete process.env.DOCKER_LOG_PATH;
      else process.env.DOCKER_LOG_PATH = originalDockerLogPath;
    }

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
    `demo-dev-${branch.replaceAll("/", "..")}\tUp 1 minute\tdemo.sandbox.branch=${branch},demo.sandbox=true,demo.sandbox.workspace-mode=branch-only`
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

test("sandbox rm --unbound does not use recovered worktree deletion", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-rm-unbound-recovered-"));
  const branch = "feature/recovered-batch";
  const row = `demo-dev-${branch.replaceAll("/", "..")}	Up 1 minute	demo.sandbox.branch=${branch},demo.sandbox=true,demo.sandbox.workspace-mode=branch-only`;
  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo", dockerStdoutForPs: row });
    const worktree = addFixtureWorktree(fixture, tmpDir, branch);
    removeWorktreeMetadata(worktree);

    const result = spawnSandboxCli(fixture, tmpDir, ["rm", "--unbound", "--yes"]);

    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /worktree preflight found blocker/);
    assert.equal(fs.existsSync(worktree), true);
    assert.match(git(fixture.repoDir, "branch", "--list", branch), new RegExp(branch));
    assert.equal(fixture.readDockerCalls().some((call) => call[0] === "stop" || call[0] === "rm"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox rm refuses a recovered worktree whose path does not match the requested branch", onPlatforms("linux", "darwin", "win32"), async () => {
  const rm = await loadFreshEsm<RmModule>("lib/sandbox/commands/rm.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-rm-recovered-path-conflict-"));
  const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo" });
  const actualBranch = "feature/recovered-actual";
  const requestedBranch = "feature/recovered-requested";
  try {
    const worktree = addFixtureWorktree(fixture, tmpDir, actualBranch);
    removeWorktreeMetadata(worktree);
    await assert.rejects(
      () => withFixtureDocker(fixture, () => rm.rmOne(rmOneConfig(fixture, tmpDir), [], requestedBranch, {
        target: {
          branch: requestedBranch,
          effectiveBranch: requestedBranch,
          engine: "docker-desktop",
          matchedContainers: [],
          existingWorktrees: [worktree],
          toolCandidates: [],
          workspace: { mode: "branch-only" },
          controlRoots: [],
          workspaceViewRoots: []
        },
        interactive: true,
        prompt: {
          confirm: async () => true,
          isCancel: (value): value is symbol => false
        }
      })),
      /Unable to inspect worktree/
    );
    assert.equal(fs.existsSync(worktree), true);
    assert.match(git(fixture.repoDir, "branch", "--list", actualBranch), new RegExp(actualBranch));
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
