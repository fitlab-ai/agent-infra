import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SandboxConfig } from "../../../lib/sandbox/config.ts";
import { containerNameCandidates } from "../../../lib/sandbox/constants.ts";
import { sandboxControlPaths } from "../../../lib/sandbox/workspace-view.ts";
import { captureSandboxAuthority } from "../../../lib/sandbox/engines/authority.ts";
import {
  clearSandboxRemovalJournalRecord,
  listSandboxRemovalJournals,
  removeSandboxControlRoot
} from "../../../lib/sandbox/control/lifecycle.ts";
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
type RmModule = typeof import("../../../lib/sandbox/removal.ts");
type PruneModule = typeof import("../../../lib/sandbox/commands/prune.ts");

const FIXTURE_CONTAINER_ID = "f".repeat(64);
const FIXTURE_LOCK_DOMAIN = createHash("sha256").update("sandbox-worktree-safety").digest("hex");

function fixtureAuthorityEvidence() {
  return captureSandboxAuthority("docker-desktop", {
    lockDomain: FIXTURE_LOCK_DOMAIN,
    probe: (_cmd, args) => ({
      status: 0, signal: null, stdout: JSON.stringify(args.at(-1) === '{{json .ID}}' ? "fixture-daemon-id" : { ApiVersion: "1.50" }), stderr: "", pid: 1, output: []
    })
  });
}

function statusTaskView(taskId: string | null) {
  return taskId
    ? { state: "unknown", taskId, observedSource: "unknown", receipt: null, reasonCode: "SANDBOX_TASK_VIEW_EVIDENCE_UNAVAILABLE" }
    : { state: "not-applicable", taskId: null, observedSource: null, receipt: null, reasonCode: null };
}

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
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
  input?: string
) {
  const env: NodeJS.ProcessEnv = {
    ...envWithPrependedPath(gitSafeEnv(), fixture.binDir),
    HOME: tmpDir,
    USERPROFILE: tmpDir,
    DOCKER_LOG_PATH: fixture.logPath,
    ...extraEnv
  };
  if (extraEnv.AGENT_INFRA_TASK_ID === "") {
    for (const key of [
      "AGENT_INFRA_CONTROL_DIR",
      "AGENT_INFRA_CONTROL_GENERATION",
      "AGENT_INFRA_CONTROL_STATUS_DIR",
      "AGENT_INFRA_CONTROL_TOKEN",
      "AGENT_INFRA_RUNTIME_DIR",
      "AGENT_INFRA_TASK_ID"
    ]) delete env[key];
  }
  return spawnSync(process.execPath, cliArgs("sandbox", ...args), {
    cwd: fixture.repoDir,
    env,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    input,
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
    refreshIntervalDays: 7,
    dockerfile: null,
    vm: { cpu: null, memory: null, disk: null }
  };
}

function writeTaskBoundCleanupEvidence(
  config: SandboxConfig,
  taskId: string,
  branch: string
): { controlRoot: string; intentPath: string; target: {
  branch: string;
  effectiveBranch: string;
  engine: "docker-desktop";
  matchedContainers: never[];
  existingWorktrees: never[];
  toolCandidates: never[];
  workspace: { mode: "task-bound"; taskId: string };
  controlRoots: string[];
  workspaceViewRoots: never[];
} } {
  const taskDir = path.join(config.repoRoot, ".agents", "workspace", "completed", taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, "task.md"),
    `---\nid: ${taskId}\nstatus: completed\nbranch: ${branch}\n---\n`,
    "utf8"
  );
  const finalizationDir = path.join(config.repoRoot, ".agents", "workspace", ".task-finalization");
  fs.mkdirSync(finalizationDir, { recursive: true });
  const generation = "task-bound-generation";
  const requestId = "a".repeat(16);
  fs.writeFileSync(
    path.join(finalizationDir, `${taskId}.json`),
    `${JSON.stringify({
      version: 4,
      taskId,
      intent: "complete",
      receiptId: "receipt-1",
      revision: 1,
      lifecycle: "done",
      taskComment: "done",
      verification: "done",
      summary: "done",
      warningProjection: "done",
      warnings: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastError: null,
      controlBinding: { generation, requestId }
    })}\n`,
    "utf8"
  );

  const intentDir = path.join(config.repoRoot, ".agents", "workspace", ".task-commit-intents");
  fs.mkdirSync(intentDir, { recursive: true });
  const intentPath = path.join(intentDir, `${taskId}.json`);
  fs.writeFileSync(intentPath, "{\"version\":1}\n", "utf8");

  const container = `${config.containerPrefix}-${branch.replaceAll("/", "..")}`;
  const controlRoot = sandboxControlPaths({
    base: config.controlBase,
    project: config.project,
    container,
    identity: { mode: "task-bound", taskId }
  }).root;
  const channelDir = path.join(controlRoot, "channel");
  const publicStatusDir = path.join(controlRoot, "public");
  const processingDir = path.join(controlRoot, "processing");
  fs.mkdirSync(path.join(channelDir, "responses"), { recursive: true });
  fs.mkdirSync(publicStatusDir, { recursive: true });
  fs.mkdirSync(processingDir, { recursive: true });
  fs.mkdirSync(path.join(controlRoot, "runtime"), { recursive: true });
  fs.writeFileSync(path.join(controlRoot, "manifest.json"), `${JSON.stringify({
    engine: "docker-desktop",
    repoRoot: config.repoRoot,
    worktreeRoot: config.repoRoot,
    project: config.project,
    container,
    containerIdentity: { id: FIXTURE_CONTAINER_ID, labels: {} },
    authorityEvidence: fixtureAuthorityEvidence(),
    branch,
    mode: "task-bound",
    taskId,
    token: "task-bound-token",
    generation,
    controlRootId: "a".repeat(96),
    channelDir,
    publicStatusDir,
    processingDir,
    runtimeDir: path.join(controlRoot, "runtime")
  })}\n`, "utf8");
  fs.writeFileSync(path.join(publicStatusDir, "status.json"), `${JSON.stringify({
    version: 3,
    generation,
    broker: { pid: 999_999_999, startTime: 0, brokerId: "stale-broker" },
    state: "healthy",
    reasonCode: null,
    activeRequestId: null,
    updatedAt: Date.now(),
    taskView: {
      state: "current",
      taskId,
      observedSource: "completed",
      receipt: { receiptId: "receipt-1", revision: 1, generation, requestId },
      reasonCode: null
    }
  })}\n`, "utf8");
  const result = {
    status: "completed",
    changed: false,
    taskId,
    lifecycle: { status: "no-op", changed: false, error: null },
    taskComment: { status: "no-op", changed: false, error: null },
    verification: { status: "no-op", changed: false, error: null },
    completedSteps: ["lifecycle", "task-comment", "verification"],
    pendingSteps: [],
    result: "completed",
    warnings: [],
    error: null
  };
  fs.writeFileSync(path.join(channelDir, "responses", `${requestId}.json`), `${JSON.stringify({
    version: 2,
    id: requestId,
    phase: "completed",
    exitCode: 0,
    stdout: `${JSON.stringify({ version: 1, status: "completed", changed: false, accepted: true, result, error: null })}\n`,
    stderr: "",
    error: null
  })}\n`, "utf8");

  return {
    controlRoot,
    intentPath,
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
  };
}

function makeCompletedUnboundDigestMismatch(config: SandboxConfig, taskId: string): void {
  const receiptPath = path.join(config.repoRoot, ".agents", "workspace", ".task-finalization", `${taskId}.json`);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
  delete receipt.controlBinding;
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");
  fs.writeFileSync(
    path.join(config.repoRoot, ".agents", "workspace", "completed", taskId, "plan.md"),
    "# Plan changed\n",
    "utf8"
  );
}

function addControlRootVariant(
  sourceRoot: string,
  config: SandboxConfig,
  taskId: string,
  container: string,
  containerId: string
): string {
  const root = sandboxControlPaths({
    base: config.controlBase,
    project: config.project,
    container,
    identity: { mode: "task-bound", taskId }
  }).root;
  fs.cpSync(sourceRoot, root, { recursive: true });
  const manifestPath = path.join(root, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, any>;
  manifest.container = container;
  manifest.containerIdentity = { ...manifest.containerIdentity, id: containerId };
  for (const field of ["channelDir", "publicStatusDir", "processingDir", "runtimeDir"]) {
    manifest[field] = path.join(root, path.basename(manifest[field]));
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
  return root;
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
      engine: "docker-desktop", repoRoot: fixture.repoDir, worktreeRoot: fixture.repoDir,
      project: "demo", container, containerIdentity: { id: FIXTURE_CONTAINER_ID, labels: {} }, authorityEvidence: fixtureAuthorityEvidence(), branch,
      mode: "branch-only", taskId: null, token: "partial-secret", generation: "partial-generation", controlRootId: "a".repeat(96),
      channelDir, publicStatusDir: path.join(controlRoot, "public"), processingDir,
      runtimeDir: path.join(controlRoot, "runtime")
    })}\n`);
    fs.writeFileSync(path.join(controlRoot, "public", "status.json"), `${JSON.stringify({
      version: 3,
      generation: "partial-generation",
      broker: { pid: 999_999_999, startTime: 0, brokerId: "stale-broker" },
      state: "healthy",
      reasonCode: null,
      activeRequestId: null,
      updatedAt: Date.now(),
      taskView: statusTaskView(null)
    })}\n`);
    const rm = await loadFreshEsm<RmModule>("lib/sandbox/removal.js");

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
      engine: "docker-desktop", repoRoot: fixture.repoDir, worktreeRoot: fixture.repoDir,
      project: "demo", container, containerIdentity: { id: FIXTURE_CONTAINER_ID, labels: {} }, authorityEvidence: fixtureAuthorityEvidence(), branch,
      mode: "branch-only", taskId: null, token: "empty-parent-secret", generation: "empty-parent-generation", controlRootId: "a".repeat(96),
      channelDir, publicStatusDir: path.join(controlRoot, "public"), processingDir,
      runtimeDir: path.join(controlRoot, "runtime")
    })}\n`);
    fs.writeFileSync(path.join(controlRoot, "public", "status.json"), `${JSON.stringify({
      version: 3,
      generation: "empty-parent-generation",
      broker: { pid: 999_999_999, startTime: 0, brokerId: "stale-broker" },
      state: "healthy",
      reasonCode: null,
      activeRequestId: null,
      updatedAt: Date.now(),
      taskView: statusTaskView(null)
    })}\n`);
    const previousPath = process.env.PATH;
    const previousDockerLog = process.env.DOCKER_LOG_PATH;
    const previousNotFound = process.env.DOCKER_INSPECT_NOT_FOUND;
    process.env.PATH = envWithPrependedPath(process.env, fixture.binDir).PATH;
    process.env.DOCKER_LOG_PATH = fixture.logPath;
    process.env.DOCKER_INSPECT_NOT_FOUND = "1";
    try {
      const rm = await loadFreshEsm<RmModule>("lib/sandbox/removal.js");
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

test("explicit discard permits later content changes but rejects another branch", onPlatforms("linux", "darwin", "win32"), async () => {
  const safety = await loadFreshEsm<SafetyModule>("lib/sandbox/worktree-safety.js");
  const fixture = createLinkedWorktree();
  try {
    fs.writeFileSync(path.join(fixture.worktree, "tracked.txt"), "authorized content\n", "utf8");
    const inspected = safety.inspectWorktree(fixture.worktree);
    assert.equal(inspected.status, "dirty");
    const permit = safety.createDiscardPermit(inspected.snapshot);

    fs.writeFileSync(path.join(fixture.worktree, "tracked.txt"), "changed after authorization\n", "utf8");

    assert.equal(safety.verifyWorktreePermit(permit).branch, inspected.snapshot.branch);
    execFileSync("git", ["-C", fixture.worktree, "switch", "-c", "feature/other-target"]);
    assert.throws(() => safety.verifyWorktreePermit(permit), /changed after authorization/);
    assert.equal(fs.existsSync(fixture.worktree), true);
  } finally {
    fixture.cleanup();
  }
});

test("interactive single-worktree authorization uses a separate default-no discard confirmation", onPlatforms("linux", "darwin", "win32"), async () => {
  const rm = await loadFreshEsm<RmModule>("lib/sandbox/removal.js");
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
          assert.match(options.message, /Discard this worktree/);
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
  const rm = await loadFreshEsm<RmModule>("lib/sandbox/removal.js");
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

test("sandbox rm releases a stale short id after task-bound cleanup", onPlatforms("linux", "darwin", "win32"), async () => {
  const rm = await loadFreshEsm<RmModule>("lib/sandbox/removal.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-rm-stale-short-id-"));
  const branch = "feature/stale-short-id";
  const taskId = "TASK-20260824-000015";
  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo" });
    const config = rmOneConfig(fixture, tmpDir);
    const evidence = writeTaskBoundCleanupEvidence(config, taskId, branch);
    const registryPath = path.join(config.repoRoot, ".agents", "workspace", "active", ".short-ids.json");
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(
      registryPath,
      `${JSON.stringify({ version: 1, ids: { "07": taskId, "08": "TASK-20260824-000016" } })}\n`,
      "utf8"
    );

    await withFixtureDocker(fixture, () => rm.rmOne(config, [], branch, {
      assumeYes: true,
      cleanupTarget: {
        requestedRef: taskId,
        branch,
        workspace: { mode: "task-bound", taskId },
        taskState: "unknown"
      },
      target: evidence.target
    }));

    assert.deepEqual(JSON.parse(fs.readFileSync(registryPath, "utf8")).ids, {
      "08": "TASK-20260824-000016"
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox rm preserves a stale short id when container removal cannot be confirmed", onPlatforms("linux", "darwin", "win32"), async () => {
  const rm = await loadFreshEsm<RmModule>("lib/sandbox/removal.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-rm-unconfirmed-short-id-"));
  const branch = "feature/unconfirmed-short-id";
  const taskId = "TASK-20260824-000017";
  const container = `demo-dev-${branch.replaceAll("/", "..")}`;
  const previousRmId = process.env.DOCKER_EXIT_FOR_RM_ID;
  try {
    process.env.DOCKER_EXIT_FOR_RM_ID = container;
    const fixture = writeSandboxEngineFixture(tmpDir, {
      project: "demo",
      dockerStdoutForPs: `${container}\tUp 1 minute\tdemo.sandbox=true\n`
    });
    const config = rmOneConfig(fixture, tmpDir);
    const evidence = writeTaskBoundCleanupEvidence(config, taskId, branch);
    const registryPath = path.join(config.repoRoot, ".agents", "workspace", "active", ".short-ids.json");
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, `${JSON.stringify({ version: 1, ids: { "07": taskId } })}\n`, "utf8");

    await assert.rejects(
      withFixtureDocker(fixture, () => rm.rmOne(config, [], branch, {
        assumeYes: true,
        cleanupTarget: {
          requestedRef: taskId,
          branch,
          workspace: { mode: "task-bound", taskId },
          taskState: "unknown"
        },
        target: { ...evidence.target, matchedContainers: [container] }
      })),
      /SANDBOX_REMOVAL_CONTAINER_STILL_PRESENT/
    );

    assert.deepEqual(JSON.parse(fs.readFileSync(registryPath, "utf8")).ids, { "07": taskId });
  } finally {
    if (previousRmId === undefined) delete process.env.DOCKER_EXIT_FOR_RM_ID;
    else process.env.DOCKER_EXIT_FOR_RM_ID = previousRmId;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox rm deletes an active task sandbox without auxiliary preflight", onPlatforms("linux", "darwin", "win32"), async () => {
  const rm = await loadFreshEsm<RmModule>("lib/sandbox/removal.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-rm-auxiliary-preflight-active-"));
  const branch = "feature/auxiliary-preflight-active";
  const taskId = "TASK-20260824-000014";
  const previousRemovalUpdates = process.env.DOCKER_REMOVAL_UPDATES_INSPECT;
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  try {
    process.env.DOCKER_REMOVAL_UPDATES_INSPECT = "1";
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo" });
    const config = rmOneConfig(fixture, tmpDir);
    const evidence = writeTaskBoundCleanupEvidence(config, taskId, branch);
    const completedDir = path.join(config.repoRoot, ".agents", "workspace", "completed", taskId);
    const activeDir = path.join(config.repoRoot, ".agents", "workspace", "active", taskId);
    fs.mkdirSync(path.dirname(activeDir), { recursive: true });
    fs.renameSync(completedDir, activeDir);
    addActiveTask(config.repoRoot, taskId, branch, "07");

    const intentBytes = fs.readFileSync(evidence.intentPath);
    const taskBytes = fs.readFileSync(path.join(activeDir, "task.md"));
    await withFixtureDocker(fixture, () => rm.rmOne(config, [], branch, {
      assumeYes: true,
      cleanupTarget: {
        requestedRef: taskId,
        branch,
        workspace: { mode: "task-bound", taskId },
        taskState: "active"
      },
      target: evidence.target
    }));
    assert.equal(fs.existsSync(evidence.controlRoot), false);
    assert.deepEqual(fs.readFileSync(evidence.intentPath), intentBytes);
    assert.deepEqual(fs.readFileSync(path.join(activeDir, "task.md")), taskBytes);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(config.repoRoot, ".agents", "workspace", "active", ".short-ids.json"), "utf8")).ids,
      { "07": taskId }
    );
    assert.deepEqual(fixture.readDockerCalls().filter((call) => call[0] === "rm"), []);
  } finally {
    if (previousRemovalUpdates === undefined) delete process.env.DOCKER_REMOVAL_UPDATES_INSPECT;
    else process.env.DOCKER_REMOVAL_UPDATES_INSPECT = previousRemovalUpdates;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox purge deletes despite malformed auxiliary evidence", onPlatforms("linux", "darwin", "win32"), async () => {
  const rm = await loadFreshEsm<RmModule>("lib/sandbox/removal.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-rm-auxiliary-preflight-purge-"));
  const branch = "feature/auxiliary-preflight-purge";
  const taskId = "TASK-20260824-000013";
  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: "demo" });
    const config = rmOneConfig(fixture, tmpDir);
    const evidence = writeTaskBoundCleanupEvidence(config, taskId, branch);
    fs.writeFileSync(evidence.intentPath, "{\"version\":1}\n", "utf8");

    await withFixtureDocker(fixture, () => rm.rmPurge(config, [], {
      confirm: async () => true,
      isCancel: (value): value is typeof import("@clack/prompts").CANCEL_SYMBOL => false
    }));

    assert.equal(fs.existsSync(evidence.controlRoot), false);
    assert.equal(fs.existsSync(evidence.intentPath), true);
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
