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
  onPlatforms,
  writeSandboxEngineFixture
} from "../../helpers.ts";
import {
  assertFreshSandboxReady,
  classifySandboxRecovery,
  collectSandboxRecoverySnapshot,
  ensureSandboxReady,
  prepareTmpfsMounts,
  worktreeProbeForEngine,
  type SandboxRecoverySnapshot
} from "../../../lib/sandbox/recovery.ts";
import type { SandboxConfig } from "../../../lib/sandbox/config.ts";
import { tmpfsSeedTargetPath } from "../../../lib/sandbox/tools.ts";
import {
  materializeSandboxControl,
  materializeSandboxWorkspaceView
} from "../../../lib/sandbox/workspace-view.ts";

const BRANCH_ONLY_LABELS = {
  "demo.sandbox.branch": "feature/demo",
  "demo.sandbox.workspace-mode": "branch-only"
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: gitSafeEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function healthyRecoverySnapshot(): SandboxRecoverySnapshot {
  return {
    identityOk: true,
    containerIdValid: true,
    expectedBranch: "feature/demo",
    actualBranch: "feature/demo",
    expectedWorkspace: { mode: "branch-only" },
    actualWorkspace: { mode: "branch-only" },
    mounts: [
      {
        path: "/home/devuser/.codex",
        expectedType: "tmpfs",
        actualType: "tmpfs",
        expectedSource: null,
        actualSource: "",
        sourceMatches: true,
        expectedRW: true,
        actualRW: true,
        sourceAccessible: true
      }
    ],
    tmpfs: [
      { path: "/home/devuser/.codex", permissionsOk: true, writable: true }
    ],
    seeds: [
      {
        toolId: "codex",
        containerMount: "/home/devuser/.codex",
        stagingPath: "/run/agent-infra/tmpfs-seeds/codex/0",
        targetPath: "/home/devuser/.codex/config.toml",
        mounted: true,
        targetState: "ok"
      }
    ],
    aliasesReadable: true,
    agentClientChecks: [{
      adapterId: 'codex',
      checkId: 'prompts-link',
      applicable: true,
      healthy: true,
      finding: {
        repairKind: 'builtin-link',
        message: 'Codex prompts link does not point to the workspace commands directory.',
        path: '/home/devuser/.codex/prompts'
      },
      repair: {
        user: 'devuser',
        command: 'ln',
        args: [
          '-sfn',
          '/workspace/.codex/commands',
          '/home/devuser/.codex/prompts'
        ]
      }
    }]
  };
}

function recoveryFixtureConfig(tmpDir: string): SandboxConfig {
  const project = "demo";
  const branchDir = "feature..demo";
  const config = {
    project,
    containerPrefix: `${project}-dev`,
    repoRoot: path.join(tmpDir, "repo"),
    home: path.join(tmpDir, "home"),
    worktreeBase: path.join(tmpDir, "worktrees", project),
    shareBase: path.join(tmpDir, "share", project),
    shellConfigBase: path.join(tmpDir, "config", project),
    workspaceViewBase: path.join(tmpDir, "home", ".agent-infra", "workspace-views"),
    controlBase: path.join(tmpDir, "home", ".agent-infra", "sandbox-control"),
    tools: ["codex"],
    customTools: []
  } as unknown as SandboxConfig;

  for (const directory of [
    config.repoRoot,
    path.join(config.repoRoot, ".agents", "workspace"),
    path.join(config.shareBase, "common"),
    path.join(config.shareBase, "branches", branchDir),
    path.join(config.shellConfigBase, branchDir),
    path.join(config.home, ".agent-infra", "sandboxes", "codex", project, branchDir, "model-catalogs")
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  git(config.repoRoot, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(config.repoRoot, "tracked.txt"), "initial\n", "utf8");
  git(config.repoRoot, "add", "tracked.txt");
  git(config.repoRoot, "-c", "user.name=Sandbox Test", "-c", "user.email=sandbox@example.com", "commit", "-q", "-m", "initial");
  fs.mkdirSync(config.worktreeBase, { recursive: true });
  git(config.repoRoot, "worktree", "add", "-q", "-b", "feature/demo", path.join(config.worktreeBase, branchDir), "HEAD");
  fs.writeFileSync(
    path.join(config.home, ".agent-infra", "sandboxes", "codex", project, branchDir, "config.toml"),
    "model = 'runtime-drift-must-survive'\n",
    "utf8"
  );
  materializeSandboxWorkspaceView({
    base: config.workspaceViewBase,
    project,
    container: "demo-dev-feature..demo",
    identity: { mode: "branch-only" }
  });
  materializeSandboxControl({
    base: config.controlBase,
    repoRoot: config.repoRoot,
    worktreeRoot: path.join(config.worktreeBase, branchDir),
    project,
    container: "demo-dev-feature..demo",
    branch: "feature/demo",
    identity: { mode: "branch-only" }
  });
  return config;
}

function recoveryFixtureMounts(config: SandboxConfig): Array<Record<string, unknown>> {
  const branchDir = "feature..demo";
  const seedDir = path.join(
    config.home,
    ".agent-infra",
    "sandboxes",
    "codex",
    config.project,
    branchDir
  );
  const view = fs.readdirSync(path.join(config.workspaceViewBase, config.project, "demo-dev-feature..demo"))[0]!;
  const viewRoot = path.join(config.workspaceViewBase, config.project, "demo-dev-feature..demo", view);
  const control = fs.readdirSync(path.join(config.controlBase, config.project, "demo-dev-feature..demo"))[0]!;
  return [
    { Type: "bind", Source: path.join(config.worktreeBase, branchDir), Destination: "/workspace", RW: true },
    ...["active", "completed", "blocked", "archive"].map((state) => ({
      Type: "bind",
      Source: path.join(viewRoot, state),
      Destination: path.posix.join("/workspace/.agents/workspace", state),
      RW: false
    })),
    { Type: "bind", Source: path.join(config.controlBase, config.project, "demo-dev-feature..demo", control, "channel"), Destination: "/run/agent-infra/control", RW: true },
    { Type: "bind", Source: path.join(config.controlBase, config.project, "demo-dev-feature..demo", control, "public"), Destination: "/run/agent-infra/control-status", RW: false },
    { Type: "bind", Source: path.join(config.shareBase, "common"), Destination: "/share/common", RW: true },
    { Type: "bind", Source: path.join(config.shareBase, "branches", branchDir), Destination: "/share/branch", RW: true },
    { Type: "bind", Source: path.join(config.shellConfigBase, branchDir), Destination: "/home/devuser/.host-shell-config", RW: false },
    { Type: "tmpfs", Source: "", Destination: "/home/devuser/.codex", RW: true },
    { Type: "bind", Source: path.join(seedDir, "config.toml"), Destination: "/run/agent-infra/tmpfs-seeds/codex/0", RW: false },
    { Type: "bind", Source: path.join(seedDir, "model-catalogs"), Destination: "/run/agent-infra/tmpfs-seeds/codex/1", RW: false }
  ];
}

function taskBoundRecoveryFixture(config: SandboxConfig, taskId: string): {
  labels: Record<string, string>;
  mounts: Array<Record<string, unknown>>;
} {
  const branchDir = "feature..demo";
  const taskSource = path.join(config.repoRoot, ".agents", "workspace", "active", taskId);
  fs.mkdirSync(taskSource, { recursive: true });
  fs.writeFileSync(
    path.join(taskSource, "task.md"),
    `---\nid: ${taskId}\nbranch: feature/demo\n---\n`,
    "utf8"
  );
  const identity = { mode: "task-bound" as const, taskId, shortId: "7" };
  const view = materializeSandboxWorkspaceView({
    base: config.workspaceViewBase,
    project: config.project,
    container: "demo-dev-feature..demo",
    identity
  });
  const control = materializeSandboxControl({
    base: config.controlBase,
    repoRoot: config.repoRoot,
    worktreeRoot: path.join(config.worktreeBase, branchDir),
    project: config.project,
    container: "demo-dev-feature..demo",
    branch: "feature/demo",
    identity
  });
  const seedDir = path.join(
    config.home,
    ".agent-infra",
    "sandboxes",
    "codex",
    config.project,
    branchDir
  );
  const mounts = [
    { Type: "bind", Source: path.join(config.worktreeBase, branchDir), Destination: "/workspace", RW: true },
    { Type: "bind", Source: path.join(view.root, "active", ".short-ids.json"), Destination: "/workspace/.agents/workspace/active/.short-ids.json", RW: false },
    ...["completed", "blocked", "archive"].map((state) => ({
      Type: "bind",
      Source: path.join(view.root, state),
      Destination: path.posix.join("/workspace/.agents/workspace", state),
      RW: false
    })),
    { Type: "bind", Source: taskSource, Destination: `/workspace/.agents/workspace/active/${taskId}`, RW: true },
    { Type: "bind", Source: control.channelDir, Destination: "/run/agent-infra/control", RW: true },
    { Type: "bind", Source: control.statusDir, Destination: "/run/agent-infra/control-status", RW: false },
    { Type: "bind", Source: control.runtimeDir, Destination: "/run/agent-infra/runtime", RW: true },
    { Type: "bind", Source: path.join(config.shareBase, "common"), Destination: "/share/common", RW: true },
    { Type: "bind", Source: path.join(config.shareBase, "branches", branchDir), Destination: "/share/branch", RW: true },
    { Type: "bind", Source: path.join(config.shellConfigBase, branchDir), Destination: "/home/devuser/.host-shell-config", RW: false },
    { Type: "tmpfs", Source: "", Destination: "/home/devuser/.codex", RW: true },
    { Type: "bind", Source: path.join(seedDir, "config.toml"), Destination: "/run/agent-infra/tmpfs-seeds/codex/0", RW: false },
    { Type: "bind", Source: path.join(seedDir, "model-catalogs"), Destination: "/run/agent-infra/tmpfs-seeds/codex/1", RW: false }
  ];
  return {
    labels: {
      "demo.sandbox.branch": "feature/demo",
      "demo.sandbox.workspace-mode": "task-bound",
      "demo.sandbox.task-id": taskId
    },
    mounts
  };
}

function legacyTaskBoundMounts(fixture: { mounts: Array<Record<string, unknown>> }): Array<Record<string, unknown>> {
  const stateDestinations = new Set([
    "/workspace/.agents/workspace/active/.short-ids.json",
    "/workspace/.agents/workspace/completed",
    "/workspace/.agents/workspace/blocked",
    "/workspace/.agents/workspace/archive"
  ]);
  const stateMounts = fixture.mounts.filter((mount) => stateDestinations.has(String(mount.Destination)));
  const registry = stateMounts.find((mount) => mount.Destination === "/workspace/.agents/workspace/active/.short-ids.json");
  return fixture.mounts
    .filter((mount) => !stateMounts.includes(mount))
    .concat({
      Type: "bind",
      Source: path.dirname(String(registry?.Source)),
      Destination: "/workspace/.agents/workspace",
      RW: false
    });
}

function moveTaskToCompleted(config: SandboxConfig, taskId: string): void {
  const activePath = path.join(config.repoRoot, '.agents', 'workspace', 'active', taskId);
  const completedRoot = path.join(config.repoRoot, '.agents', 'workspace', 'completed');
  fs.mkdirSync(completedRoot, { recursive: true });
  fs.renameSync(activePath, path.join(completedRoot, taskId));
}

test("recovery classification preserves healthy running seed content drift", () => {
  const snapshot = healthyRecoverySnapshot();

  assert.deepEqual(classifySandboxRecovery(snapshot), []);
});

test("recovery classification exposes stable workspace identity error codes", () => {
  const branchOnly = healthyRecoverySnapshot();
  branchOnly.identityOk = false;
  branchOnly.expectedWorkspace = { mode: "task-bound", taskId: "TASK-20260814-223553", shortId: "7" };
  assert.equal(classifySandboxRecovery(branchOnly)[0]?.code, "SANDBOX_CONTROL_BRANCH_ONLY");

  const taskMismatch = healthyRecoverySnapshot();
  taskMismatch.identityOk = false;
  taskMismatch.expectedWorkspace = { mode: "task-bound", taskId: "TASK-20260814-223553", shortId: "7" };
  taskMismatch.actualWorkspace = { mode: "task-bound", taskId: "TASK-20260814-000000" };
  assert.equal(classifySandboxRecovery(taskMismatch)[0]?.code, "SANDBOX_WORKSPACE_IDENTITY_CONFLICT");

  const legacy = healthyRecoverySnapshot();
  legacy.identityOk = false;
  legacy.actualWorkspace = { mode: "legacy-invalid" };
  assert.equal(classifySandboxRecovery(legacy)[0]?.code, "SANDBOX_WORKSPACE_IDENTITY_CONFLICT");
});

test("recovery classification exposes stable workspace topology and task view error codes", () => {
  const legacy = healthyRecoverySnapshot();
  legacy.workspaceTopology = "legacy-parent";
  assert.equal(classifySandboxRecovery(legacy)[0]?.code, "SANDBOX_WORKSPACE_TOPOLOGY_MISMATCH");

  const taskView = healthyRecoverySnapshot();
  taskView.taskView = {
    path: "/workspace/.agents/workspace/active/TASK-20260814-223553/task.md",
    readable: false
  };
  assert.equal(classifySandboxRecovery(taskView)[0]?.code, "SANDBOX_TASK_VIEW_UNREADABLE");
});

test("tmpfs seed targets cannot escape the configured tool mount", () => {
  assert.equal(
    tmpfsSeedTargetPath("/home/devuser/.codex", "model-catalogs/models.json"),
    "/home/devuser/.codex/model-catalogs/models.json"
  );
  assert.throws(
    () => tmpfsSeedTargetPath("/home/devuser/.codex", "../../workspace"),
    /must stay within/
  );
});

test("recovery classification maps faults to the smallest repair kind", () => {
  const permissions = healthyRecoverySnapshot();
  permissions.tmpfs[0]!.permissionsOk = false;
  assert.deepEqual(
    classifySandboxRecovery(permissions).map((finding) => finding.repairKind),
    ["permissions"]
  );

  const missingSeed = healthyRecoverySnapshot();
  missingSeed.seeds[0]!.targetState = "missing";
  assert.deepEqual(
    classifySandboxRecovery(missingSeed).map((finding) => finding.repairKind),
    ["missing-seed"]
  );

  const prompts = healthyRecoverySnapshot();
  prompts.agentClientChecks[0]!.healthy = false;
  assert.deepEqual(
    classifySandboxRecovery(prompts).map((finding) => finding.repairKind),
    ["builtin-link"]
  );

  const topology = healthyRecoverySnapshot();
  topology.mounts[0]!.actualType = "bind";
  assert.deepEqual(
    classifySandboxRecovery(topology).map((finding) => finding.repairKind),
    ["hard-failure"]
  );
});

test("recovery accepts bind sources that resolve to the same filesystem object", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-recovery-source-identity-"));
  const config = recoveryFixtureConfig(tmpDir);
  const expectedSource = path.join(
    config.home,
    ".agent-infra",
    "sandboxes",
    "codex",
    config.project,
    "feature..demo",
    "config.toml"
  );
  const sourceAlias = path.join(tmpDir, "config-alias.toml");

  try {
    fs.linkSync(expectedSource, sourceAlias);
    const mounts = recoveryFixtureMounts(config).map((mount) =>
      mount.Destination === "/run/agent-infra/tmpfs-seeds/codex/0"
        ? { ...mount, Source: sourceAlias }
        : mount
    );
    const snapshot = collectSandboxRecoverySnapshot({
      config,
      engine: "native",
      branch: "feature/demo",
      container: "demo-dev-feature..demo",
      deps: {
        run: () => JSON.stringify([{
          Id: "fixture-container-id",
          Config: { Labels: BRANCH_ONLY_LABELS },
          Mounts: mounts
        }]),
        runOk: () => true
      }
    });

    const seedMount = snapshot.mounts.find((mount) =>
      mount.path === "/run/agent-infra/tmpfs-seeds/codex/0"
    );
    assert.equal(seedMount?.sourceMatches, true);
    assert.equal(seedMount?.sourceAccessible, true);
    assert.deepEqual(
      snapshot.agentClientChecks.map(({ adapterId, checkId, applicable, healthy }) => ({
        adapterId,
        checkId,
        applicable,
        healthy
      })),
      [
        { adapterId: 'codex', checkId: 'command-available', applicable: true, healthy: true },
        { adapterId: 'codex', checkId: 'state-writable', applicable: true, healthy: true },
        { adapterId: 'codex', checkId: 'prompts-link', applicable: true, healthy: true }
      ]
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("task-bound recovery probes the real task.md view instead of mount declarations", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-recovery-task-view-"));
  const config = recoveryFixtureConfig(tmpDir);
  const taskId = "TASK-20260814-223553";
  const taskSource = path.join(config.repoRoot, ".agents", "workspace", "active", taskId);
  fs.mkdirSync(taskSource, { recursive: true });
  fs.writeFileSync(path.join(taskSource, "task.md"), `---\nid: ${taskId}\n---\n`, "utf8");
  const labels = {
    ...BRANCH_ONLY_LABELS,
    "demo.sandbox.workspace-mode": "task-bound",
    "demo.sandbox.task-id": taskId
  };
  const mounts = recoveryFixtureMounts(config).concat({
    Type: "bind",
    Source: taskSource,
    Destination: `/workspace/.agents/workspace/active/${taskId}`,
    RW: true
  }, {
    Type: "bind",
    Source: path.join(config.controlBase, config.project, "demo-dev-feature..demo", fs.readdirSync(path.join(config.controlBase, config.project, "demo-dev-feature..demo"))[0]!, "runtime"),
    Destination: "/run/agent-infra/runtime",
    RW: true
  });
  let taskReadable = false;
  const snapshot = () => collectSandboxRecoverySnapshot({
    config,
    engine: "native",
    branch: "feature/demo",
    workspace: { mode: "task-bound", taskId, shortId: "7" },
    container: "demo-dev-feature..demo",
    deps: {
      run: () => JSON.stringify([{
        Id: "fixture-container-id",
        Config: { Labels: labels },
        Mounts: mounts
      }]),
      runOk: (_engine, _cmd, args) => {
        const script = args[6] ?? "";
        const target = args.at(-1);
        return !(script === 'test -r "$1"' && target?.endsWith("/task.md")) || taskReadable;
      }
    }
  });

  try {
    const missing = snapshot();
    assert.equal(missing.taskView?.readable, false);
    assert.equal(classifySandboxRecovery(missing).find(
      (finding) => finding.code === "SANDBOX_TASK_VIEW_UNREADABLE"
    )?.path, `/workspace/.agents/workspace/active/${taskId}/task.md`);

    taskReadable = true;
    const recovered = snapshot();
    assert.equal(recovered.taskView?.readable, true);
    assert.equal(classifySandboxRecovery(recovered).some(
      (finding) => finding.code === "SANDBOX_TASK_VIEW_UNREADABLE"
    ), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("completed task-bound recovery accepts the moved task source and historical active mount", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-completed-task-source-"));
  const config = recoveryFixtureConfig(tmpDir);
  const taskId = "TASK-20260814-223554";
  const fixture = taskBoundRecoveryFixture(config, taskId);
  moveTaskToCompleted(config, taskId);

  try {
    const snapshot = collectSandboxRecoverySnapshot({
      config,
      engine: "native",
      branch: "feature/demo",
      workspace: { mode: "task-bound", taskId },
      container: "demo-dev-feature..demo",
      deps: {
        run: () => JSON.stringify([{
          Id: "fixture-container-id",
          Config: { Labels: fixture.labels },
          Mounts: fixture.mounts
        }]),
        runOk: () => true
      }
    });
    const taskMount = snapshot.mounts.find((mount) =>
      mount.path === `/workspace/.agents/workspace/active/${taskId}`
    );

    assert.equal(snapshot.identityOk, true);
    assert.equal(taskMount?.sourceMatches, true);
    assert.equal(taskMount?.sourceAccessible, true);
    assert.deepEqual(classifySandboxRecovery(snapshot), []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("completed readiness failures never invoke replacement and provide manual disposal commands", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-completed-reentry-failure-"));
  const config = recoveryFixtureConfig(tmpDir);
  const taskId = "TASK-20260814-223555";
  const fixture = taskBoundRecoveryFixture(config, taskId);
  moveTaskToCompleted(config, taskId);
  let recreated = false;
  let writes = 0;
  const row = {
    name: "demo-dev-feature..demo",
    status: "Up",
    branch: "feature/demo",
    running: true,
    index: 1
  };
  const deps = {
    ensureControlBroker: async () => {},
    run: () => JSON.stringify([{
      Id: "fixture-container-id",
      Config: { Labels: fixture.labels },
      Mounts: fixture.mounts
    }]),
    runOk: (_engine: string, _cmd: string, args: string[]) => {
      const script = args[6] ?? "";
      const target = args.at(-1);
      return !(script === 'test -r "$1"' && target?.endsWith("/task.md"));
    },
    runVerbose: () => { writes += 1; }
  };

  try {
    await assert.rejects(
      () => ensureSandboxReady({
        config,
        engine: "native",
        branch: "feature/demo",
        workspace: { mode: "task-bound", taskId },
        reentry: "completed",
        row,
        deps,
        recreate: async () => { recreated = true; }
      }),
      (error: unknown) => error instanceof Error
        && error.message.includes("SANDBOX_COMPLETED_REENTRY_FAILED")
        && error.message.includes(`container: ${row.name}`)
        && error.message.includes(`docker exec -it ${row.name} bash /usr/local/bin/sandbox-tmux-entry`)
        && error.message.includes('full interactive sandbox cleanup')
        && error.message.includes('worktree, local branch, tool/shell state, and branch share')
        && error.message.includes(`ai sandbox rm ${taskId}`)
        && error.message.includes("ai sandbox create feature/demo")
    );

    await assert.rejects(
      () => ensureSandboxReady({
        config,
        engine: "native",
        branch: "feature/demo",
        workspace: { mode: "task-bound", taskId },
        reentry: "completed",
        row,
        allowRecreate: true,
        recreate: async () => { recreated = true; },
        deps
      }),
      /SANDBOX_COMPLETED_RECREATE_UNSUPPORTED/
    );
    assert.equal(recreated, false);
    assert.equal(writes, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("healthy completed re-entry rejects an explicit recreate request", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-completed-recreate-healthy-"));
  const config = recoveryFixtureConfig(tmpDir);
  const taskId = "TASK-20260814-223556";
  const fixture = taskBoundRecoveryFixture(config, taskId);
  moveTaskToCompleted(config, taskId);
  let recreated = false;

  try {
    await assert.rejects(
      () => ensureSandboxReady({
        config,
        engine: "native",
        branch: "feature/demo",
        workspace: { mode: "task-bound", taskId },
        reentry: "completed",
        row: {
          name: "demo-dev-feature..demo",
          status: "Up",
          branch: "feature/demo",
          running: true,
          index: 1
        },
        allowRecreate: true,
        recreate: async () => { recreated = true; },
        deps: {
          ensureControlBroker: async () => {},
          run: () => JSON.stringify([{
            Id: "fixture-container-id",
            Config: { Labels: fixture.labels },
            Mounts: fixture.mounts
          }]),
          runOk: () => true,
          runVerbose: () => {}
        }
      }),
      /SANDBOX_COMPLETED_RECREATE_UNSUPPORTED/
    );
    assert.equal(recreated, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("stopped completed re-entry restores the historical task source only while starting", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-completed-stopped-source-"));
  const config = recoveryFixtureConfig(tmpDir);
  const taskId = "TASK-20260814-223557";
  const fixture = taskBoundRecoveryFixture(config, taskId);
  moveTaskToCompleted(config, taskId);
  const activePath = path.join(config.repoRoot, ".agents", "workspace", "active", taskId);
  const completedPath = path.join(config.repoRoot, ".agents", "workspace", "completed", taskId);
  let startedWithSource = false;

  try {
    const result = await ensureSandboxReady({
      config,
      engine: "native",
      branch: "feature/demo",
      workspace: { mode: "task-bound", taskId },
      reentry: "completed",
      row: {
        name: "demo-dev-feature..demo",
        status: "Exited",
        branch: "feature/demo",
        running: false,
        index: 1
      },
      deps: {
        ensureControlBroker: async () => {},
        start: () => {
          startedWithSource = fs.lstatSync(activePath).isSymbolicLink()
            && fs.realpathSync.native(activePath) === fs.realpathSync.native(completedPath);
        },
        run: () => JSON.stringify([{
          Id: "fixture-container-id",
          Config: { Labels: fixture.labels },
          Mounts: fixture.mounts
        }]),
        runOk: (_engine, _cmd, args) => {
          const script = args[6] ?? "";
          const target = args.at(-1);
          if (script === 'test -r "$1"' && target?.endsWith("/task.md")) {
            return startedWithSource;
          }
          return true;
        },
        runVerbose: () => {}
      }
    });

    assert.equal(result.path, "recovered");
    assert.equal(startedWithSource, true);
    assert.equal(fs.existsSync(activePath), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("fresh task-bound readiness succeeds without restart when task.md is readable", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-fresh-task-bound-healthy-"));
  const config = recoveryFixtureConfig(tmpDir);
  const taskId = "TASK-20260814-223553";
  const fixture = taskBoundRecoveryFixture(config, taskId);
  const writes: string[][] = [];

  try {
    await assert.doesNotReject(() => assertFreshSandboxReady({
      config,
      engine: "native",
      branch: "feature/demo",
      workspace: { mode: "task-bound", taskId, shortId: "7" },
      container: "demo-dev-feature..demo",
      copiedEntries: [],
      deps: {
        run: () => JSON.stringify([{ Id: "fixture-container-id", Config: { Labels: fixture.labels }, Mounts: fixture.mounts }]),
        runOk: () => true,
        runVerbose: (_engine, _cmd, args) => { writes.push(args); }
      }
    }));

    assert.equal(writes.some((args) => args[0] === "restart"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("fresh task-bound readiness restarts once when task.md becomes readable", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-fresh-task-bound-retry-"));
  const config = recoveryFixtureConfig(tmpDir);
  const taskId = "TASK-20260814-223553";
  const fixture = taskBoundRecoveryFixture(config, taskId);
  let restarted = false;
  const writes: string[][] = [];

  try {
    await assert.doesNotReject(() => assertFreshSandboxReady({
      config,
      engine: "native",
      branch: "feature/demo",
      workspace: { mode: "task-bound", taskId, shortId: "7" },
      container: "demo-dev-feature..demo",
      copiedEntries: [],
      deps: {
        run: () => JSON.stringify([{ Id: "fixture-container-id", Config: { Labels: fixture.labels }, Mounts: fixture.mounts }]),
        runOk: (_engine, _cmd, args) => {
          const script = args[6];
          const target = args.at(-1);
          return !(script === 'test -r "$1"' && target?.endsWith("/task.md")) || restarted;
        },
        runVerbose: (_engine, _cmd, args) => {
          writes.push(args);
          if (args[0] === "restart") restarted = true;
        }
      }
    }));

    assert.equal(writes.filter((args) => args[0] === "restart").length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("fresh task-bound readiness remains fail-closed after one unreadable task.md retry", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-fresh-task-bound-failed-"));
  const config = recoveryFixtureConfig(tmpDir);
  const taskId = "TASK-20260814-223553";
  const fixture = taskBoundRecoveryFixture(config, taskId);
  let restarts = 0;

  try {
    await assert.rejects(() => assertFreshSandboxReady({
      config,
      engine: "native",
      branch: "feature/demo",
      workspace: { mode: "task-bound", taskId, shortId: "7" },
      container: "demo-dev-feature..demo",
      copiedEntries: [],
      deps: {
        run: () => JSON.stringify([{ Id: "fixture-container-id", Config: { Labels: fixture.labels }, Mounts: fixture.mounts }]),
        runOk: (_engine, _cmd, args) => {
          const script = args[6];
          const target = args.at(-1);
          return !(script === 'test -r "$1"' && target?.endsWith("/task.md"));
        },
        runVerbose: (_engine, _cmd, args) => {
          if (args[0] === "restart") restarts += 1;
        }
      }
    }), /Fresh sandbox readiness check failed:.*SANDBOX_TASK_VIEW_UNREADABLE/);

    assert.equal(restarts, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("fresh task-bound readiness does not restart a legacy parent topology", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-fresh-task-bound-legacy-"));
  const config = recoveryFixtureConfig(tmpDir);
  const taskId = "TASK-20260814-223553";
  const fixture = taskBoundRecoveryFixture(config, taskId);
  const writes: string[][] = [];

  try {
    await assert.rejects(() => assertFreshSandboxReady({
      config,
      engine: "native",
      branch: "feature/demo",
      workspace: { mode: "task-bound", taskId, shortId: "7" },
      container: "demo-dev-feature..demo",
      copiedEntries: [],
      deps: {
        run: () => JSON.stringify([{ Id: "fixture-container-id", Config: { Labels: fixture.labels }, Mounts: legacyTaskBoundMounts(fixture) }]),
        runOk: () => true,
        runVerbose: (_engine, _cmd, args) => { writes.push(args); }
      }
    }), /Fresh sandbox readiness check failed:.*SANDBOX_WORKSPACE_TOPOLOGY_MISMATCH/);

    assert.equal(writes.some((args) => args[0] === "restart"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("running task-bound readiness fails closed without restart when task.md is unreadable", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-running-task-bound-unreadable-"));
  const config = recoveryFixtureConfig(tmpDir);
  const taskId = "TASK-20260814-223553";
  const fixture = taskBoundRecoveryFixture(config, taskId);
  const writes: string[][] = [];

  try {
    await assert.rejects(() => ensureSandboxReady({
      config,
      engine: "native",
      branch: "feature/demo",
      workspace: { mode: "task-bound", taskId, shortId: "7" },
      row: { name: "demo-dev-feature..demo", status: "Up", branch: "feature/demo", running: true, index: 1 },
      deps: {
        ensureControlBroker: async () => {},
        run: () => JSON.stringify([{ Id: "fixture-container-id", Config: { Labels: fixture.labels }, Mounts: fixture.mounts }]),
        runOk: (_engine, _cmd, args) => {
          const script = args[6];
          const target = args.at(-1);
          return !(script === 'test -r "$1"' && target?.endsWith("/task.md"));
        },
        runVerbose: (_engine, _cmd, args) => { writes.push(args); }
      }
    }), /SANDBOX_TASK_VIEW_UNREADABLE/);

    assert.deepEqual(writes, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("recovery recognizes tmpfs declared only through HostConfig on OrbStack", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-recovery-orbstack-tmpfs-"));
  const config = recoveryFixtureConfig(tmpDir);
  const mounts = recoveryFixtureMounts(config).filter(
    (mount) => mount.Destination !== "/home/devuser/.codex"
  );
  const snapshotFor = (options: string) => collectSandboxRecoverySnapshot({
    config,
    engine: "native",
    branch: "feature/demo",
    container: "demo-dev-feature..demo",
    deps: {
      run: () => JSON.stringify([{
        Id: "fixture-container-id",
        Config: { Labels: BRANCH_ONLY_LABELS },
        HostConfig: { Tmpfs: { "/home/devuser/.codex": options } },
        Mounts: mounts
      }]),
      runOk: () => true
    }
  });

  try {
    const writable = snapshotFor("rw,size=512m");
    assert.deepEqual(
      writable.mounts.find((mount) => mount.path === "/home/devuser/.codex"),
      {
        path: "/home/devuser/.codex",
        expectedType: "tmpfs",
        actualType: "tmpfs",
        expectedSource: null,
        actualSource: "",
        sourceMatches: true,
        expectedRW: true,
        actualRW: true,
        sourceAccessible: true
      }
    );
    assert.deepEqual(classifySandboxRecovery(writable), []);

    const readOnly = snapshotFor("ro,size=512m");
    assert.equal(
      readOnly.mounts.find((mount) => mount.path === "/home/devuser/.codex")?.actualRW,
      false
    );
    assert.deepEqual(
      classifySandboxRecovery(readOnly).map((finding) => finding.repairKind),
      ["hard-failure"]
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("tmpfs permission probe compares numeric owner, primary group, and mode", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-recovery-primary-group-"));
  const config = recoveryFixtureConfig(tmpDir);
  let permissionProbe: string[] | undefined;

  try {
    const snapshot = collectSandboxRecoverySnapshot({
      config,
      engine: "native",
      branch: "feature/demo",
      container: "demo-dev-feature..demo",
      deps: {
        run: () => JSON.stringify([{
          Id: "fixture-container-id",
          Config: { Labels: BRANCH_ONLY_LABELS },
          Mounts: recoveryFixtureMounts(config)
        }]),
        runOk: (_engine, _cmd, args) => {
          const script = args[6] ?? "";
          if (script.includes("stat -c")) permissionProbe = args;
          return true;
        }
      }
    });

    assert.equal(snapshot.tmpfs[0]?.permissionsOk, true);
    assert.deepEqual(permissionProbe, [
      "exec", "--user", "devuser", "demo-dev-feature..demo", "sh", "-c",
      'test "$(stat -c %u:%g:%a -- "$1")" = "$(id -u devuser):$(id -g devuser):700"',
      "agent-infra-recovery", "/home/devuser/.codex"
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("tmpfs permission repair uses devuser's configured primary group", () => {
  const writes: string[][] = [];

  prepareTmpfsMounts({
    engine: "native",
    container: "demo-dev-feature..demo",
    mountPaths: ["/home/devuser/.codex"],
    deps: {
      runVerbose: (_engine, _cmd, args) => { writes.push(args); }
    }
  });

  assert.deepEqual(writes[0], [
    "exec", "--user", "root", "demo-dev-feature..demo",
    "chown", "devuser:", "--", "/home/devuser/.codex"
  ]);
});

test("running permission repair re-assesses seed targets before hydration", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-recovery-permissions-"));
  const config = recoveryFixtureConfig(tmpDir);
  let permissionsRepaired = false;
  let brokerChecks = 0;
  const writes: string[][] = [];

  try {
    const result = await ensureSandboxReady({
      config,
      engine: "native",
      branch: "feature/demo",
      row: {
        name: "demo-dev-feature..demo",
        status: "Up",
        branch: "feature/demo",
        running: true,
        index: 1
      },
      deps: {
        ensureControlBroker: async () => { brokerChecks += 1; },
        run: () => JSON.stringify([{
          Id: "fixture-container-id",
          Config: { Labels: BRANCH_ONLY_LABELS },
          Mounts: recoveryFixtureMounts(config)
        }]),
        runOk: (_engine, _cmd, args) => {
          const script = args[6] ?? "";
          if (script.includes("stat -c") || script.includes(".agent-infra-ready-") || script.includes(".agent-infra-codex-state-")) {
            return permissionsRepaired;
          }
          if (script.includes("test -e") || script.includes("test -L")) {
            return permissionsRepaired;
          }
          return true;
        },
        runVerbose: (_engine, _cmd, args) => {
          writes.push(args);
          if (args.includes("chmod")) permissionsRepaired = true;
        }
      }
    });

    assert.equal(result.path, "recovered");
    assert.equal(brokerChecks, 1);
    assert.equal(
      writes.some((args) => args.includes("rm") || args.includes("cp")),
      false,
      `permission-only recovery must preserve existing runtime seeds, got ${JSON.stringify(writes)}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("recovery rejects mount and identity hard failures before writes", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-recovery-topology-"));
  const config = recoveryFixtureConfig(tmpDir);
  const worktreeSource = path.join(config.worktreeBase, "feature..demo");
  const wrongWorktreeSource = path.join(tmpDir, "wrong-worktree");
  fs.mkdirSync(wrongWorktreeSource, { recursive: true });
  const liveSource = path.join(config.home, ".codex", "auth.json");
  fs.mkdirSync(path.dirname(liveSource), { recursive: true });
  fs.writeFileSync(liveSource, "{}\n", "utf8");
  const baseMounts = recoveryFixtureMounts(config);
  baseMounts.push({
    Type: "bind",
    Source: liveSource,
    Destination: "/home/devuser/.codex/auth.json",
    RW: true
  });

  const cases: Array<{
    name: string;
    labels: Record<string, string>;
    mounts: Array<Record<string, unknown>>;
    unavailableSource?: string;
  }> = [
    {
      name: "wrong worktree source",
      labels: BRANCH_ONLY_LABELS,
      mounts: baseMounts.map((mount) => mount.Destination === "/workspace"
        ? { ...mount, Source: wrongWorktreeSource }
        : mount)
    },
    {
      name: "read-only worktree",
      labels: BRANCH_ONLY_LABELS,
      mounts: baseMounts.map((mount) => mount.Destination === "/workspace"
        ? { ...mount, RW: false }
        : mount)
    },
    {
      name: "inaccessible worktree source",
      labels: BRANCH_ONLY_LABELS,
      mounts: baseMounts,
      unavailableSource: worktreeSource
    },
    {
      name: "inaccessible live mount source",
      labels: BRANCH_ONLY_LABELS,
      mounts: baseMounts,
      unavailableSource: liveSource
    },
    {
      name: "missing live mount",
      labels: BRANCH_ONLY_LABELS,
      mounts: baseMounts.filter((mount) => mount.Destination !== "/home/devuser/.codex/auth.json")
    },
    {
      name: "missing branch label",
      labels: {},
      mounts: baseMounts
    }
  ];

  try {
    for (const running of [true, false]) {
      for (const scenario of cases) {
        if (scenario.unavailableSource) {
          fs.rmSync(scenario.unavailableSource, { recursive: true, force: true });
        }
        let writes = 0;
        const state = running ? "running" : "stopped";
        await assert.rejects(
          () => ensureSandboxReady({
            config,
            engine: "native",
            branch: "feature/demo",
            row: {
              name: "demo-dev-feature..demo",
              status: running ? "Up" : "Exited",
              branch: "feature/demo",
              running,
              index: 1
            },
            deps: {
              ensureControlBroker: async () => {},
              start: () => {},
              run: () => JSON.stringify([{
                Id: "fixture-container-id",
                Config: { Labels: scenario.labels },
                Mounts: scenario.mounts
              }]),
              runOk: () => true,
              runVerbose: () => { writes += 1; }
            }
          }),
          /ai sandbox start --recreate feature\/demo/,
          `${state}: ${scenario.name}`
        );
        assert.equal(writes, 0, `${state}: ${scenario.name} must fail before runtime repair writes`);
        fs.mkdirSync(worktreeSource, { recursive: true });
        fs.mkdirSync(path.dirname(liveSource), { recursive: true });
        fs.writeFileSync(liveSource, "{}\n", "utf8");
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("hard recovery failure requires explicit container replacement authorization", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-recovery-recreate-"));
  let recreated = false;
  let writes = 0;
  const replacementCommands: string[][] = [];
  const config = recoveryFixtureConfig(tmpDir);
  const currentMounts = recoveryFixtureMounts(config);
  const workspaceMounts = currentMounts.filter((mount) =>
    typeof mount.Destination === "string"
      && mount.Destination.startsWith("/workspace/.agents/workspace/")
  );
  const viewRoot = path.dirname(String(workspaceMounts[0]!.Source));
  const legacyMounts = currentMounts
    .filter((mount) => !workspaceMounts.includes(mount))
    .concat({
      Type: "bind",
      Source: viewRoot,
      Destination: "/workspace/.agents/workspace",
      RW: false
    });
  const inspect = () => JSON.stringify([{
    Id: "fixture-container-id",
    Config: { Labels: BRANCH_ONLY_LABELS },
    Mounts: recreated ? currentMounts : legacyMounts
  }]);
  const deps = {
    ensureControlBroker: async () => {},
    run: () => inspect(),
    runOk: () => true,
    runVerbose: (_engine: string, _cmd: string, args: string[]) => {
      writes += 1;
      replacementCommands.push(args);
    },
    fetchRows: () => ({
      running: [{ name: "demo-dev-feature..demo", status: "Up", branch: "feature/demo", running: true, index: 1 }],
      nonRunning: []
    })
  };
  const row = {
    name: "demo-dev-feature..demo",
    status: "Up",
    branch: "feature/demo",
    running: true,
    index: 1
  };

  try {
    const worktree = path.join(config.worktreeBase, "feature..demo");
    const beforeHead = git(worktree, "rev-parse", "HEAD");
    const beforeStatus = git(worktree, "status", "--porcelain=v2", "--untracked-files=all");
    await assert.rejects(
      () => ensureSandboxReady({ config, engine: "native", branch: "feature/demo", row, deps }),
      /ai sandbox start --recreate feature\/demo/
    );
    assert.equal(writes, 0, "hard mount failures must not mutate the running container");

    const result = await ensureSandboxReady({
      config,
      engine: "native",
      branch: "feature/demo",
      row,
      allowRecreate: true,
      recreate: async () => {
        assert.deepEqual(replacementCommands, []);
        recreated = true;
      },
      writeWarning: () => {},
      deps
    });
    assert.equal(result.path, "recreated");
    assert.equal(result.container, "demo-dev-feature..demo");
    assert.equal(writes, 0);
    assert.equal(git(worktree, "rev-parse", "HEAD"), beforeHead);
    assert.equal(git(worktree, "status", "--porcelain=v2", "--untracked-files=all"), beforeStatus);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("WSL2 worktree probes run Git inside WSL with an engine path", () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const probe = worktreeProbeForEngine("wsl2", (cmd, args, opts) => {
    calls.push({ cmd, args });
    return spawnSync(process.execPath, ["--version"], opts);
  });

  probe("git", ["-C", "C:\\repo\\feature", "status"], { encoding: "utf8" });

  assert.deepEqual(calls, [{
    cmd: "wsl.exe",
    args: ["--exec", "git", "-C", "/mnt/c/repo/feature", "status"]
  }]);
});

test("task-bound recovery keeps the branch-only code and recommends the full task id", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-recovery-task-bound-hint-"));
  const config = recoveryFixtureConfig(tmpDir);
  let writes = 0;
  const taskId = "TASK-20260814-223553";
  const activeDir = path.join(config.repoRoot, ".agents", "workspace", "active");
  fs.mkdirSync(path.join(activeDir, taskId), { recursive: true });
  fs.writeFileSync(path.join(activeDir, ".short-ids.json"), `${JSON.stringify({ version: 1, ids: { "7": taskId } })}\n`, "utf8");
  fs.writeFileSync(path.join(activeDir, taskId, "task.md"), `---\nid: ${taskId}\nbranch: feature/demo\n---\n`, "utf8");

  try {
    await assert.rejects(
      () => ensureSandboxReady({
        config,
        engine: "native",
        branch: "feature/demo",
        workspace: { mode: "task-bound", taskId, shortId: "7" },
        row: { name: "demo-dev-feature..demo", status: "Up", branch: "feature/demo", running: true, index: 1 },
        deps: {
          ensureControlBroker: async () => {},
          run: () => JSON.stringify([{
            Id: "fixture-container-id",
            Config: { Labels: BRANCH_ONLY_LABELS },
            Mounts: recoveryFixtureMounts(config)
          }]),
          runOk: () => true,
          runVerbose: () => { writes += 1; }
        }
      }),
      (error: unknown) => error instanceof Error
        && error.message.includes("SANDBOX_CONTROL_BRANCH_ONLY")
        && error.message.includes(`ai sandbox start --recreate ${taskId}`)
    );
    assert.equal(writes, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("unauthorized recovery leads with the recreate command and demotes the finding detail", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-recovery-lead-command-"));
  const config = recoveryFixtureConfig(tmpDir);
  let writes = 0;

  try {
    await assert.rejects(
      () => ensureSandboxReady({
        config,
        engine: "native",
        branch: "feature/demo",
        row: { name: "demo-dev-feature..demo", status: "Up", branch: "feature/demo", running: true, index: 1 },
        deps: {
          ensureControlBroker: async () => {},
          run: () => JSON.stringify([{
            Id: "fixture-container-id",
            Config: { Labels: BRANCH_ONLY_LABELS },
            Mounts: []
          }]),
          runOk: () => true,
          runVerbose: () => { writes += 1; }
        }
      }),
      (error: unknown) => {
        if (!(error instanceof Error)) return false;
        const [lead, ...rest] = error.message.split("\n");
        return lead!.includes("ai sandbox start --recreate feature/demo")
          && !lead!.includes("Expected bind mount")
          && rest.some((line) => line.startsWith("Details: "));
      }
    );
    assert.equal(writes, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("container replacement snapshots the worktree before the callback and rejects drift", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-recovery-worktree-drift-"));
  const config = recoveryFixtureConfig(tmpDir);
  const worktree = path.join(config.worktreeBase, "feature..demo");
  const replacementCommands: string[][] = [];
  let recreated = false;
  const inspect = () => JSON.stringify([{
    Id: "fixture-container-id",
    Config: { Labels: BRANCH_ONLY_LABELS },
    Mounts: recoveryFixtureMounts(config).map((mount) =>
      mount.Destination === "/home/devuser/.codex"
        ? { ...mount, Type: recreated ? "tmpfs" : "bind" }
        : mount
    )
  }]);
  const row = { name: "demo-dev-feature..demo", status: "Up", branch: "feature/demo", running: true, index: 1 };

  try {
    fs.writeFileSync(path.join(worktree, "dirty.txt"), "before\n", "utf8");
    await assert.rejects(
      () => ensureSandboxReady({
        config,
        engine: "native",
        branch: "feature/demo",
        row,
        allowRecreate: true,
        recreate: async () => {
          recreated = true;
          fs.writeFileSync(path.join(worktree, "dirty.txt"), "after\n", "utf8");
        },
        writeWarning: () => {},
        deps: {
          ensureControlBroker: async () => {},
          run: () => inspect(),
          runOk: () => true,
          runVerbose: (_engine, _cmd, args) => { replacementCommands.push(args); },
          fetchRows: () => ({ running: [row], nonRunning: [] })
        }
      }),
      /SANDBOX_RECOVERY_WORKTREE_CHANGED/
    );
    assert.deepEqual(replacementCommands, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("explicit recreation replaces a healthy running container", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-recovery-explicit-recreate-"));
  const config = recoveryFixtureConfig(tmpDir);
  const replacementCommands: string[][] = [];
  let recreated = false;
  const row = { name: "demo-dev-feature..demo", status: "Up", branch: "feature/demo", running: true, index: 1 };

  try {
    const result = await ensureSandboxReady({
      config,
      engine: "native",
      branch: "feature/demo",
      row,
      allowRecreate: true,
      forceRecreate: true,
      recreate: async () => { recreated = true; },
      writeWarning: () => {},
      deps: {
        ensureControlBroker: async () => {},
        run: () => JSON.stringify([{
          Id: "fixture-container-id",
          Config: { Labels: BRANCH_ONLY_LABELS },
          Mounts: recoveryFixtureMounts(config)
        }]),
        runOk: () => true,
        runVerbose: (_engine, _cmd, args) => { replacementCommands.push(args); },
        fetchRows: () => ({ running: [row], nonRunning: [] })
      }
    });

    assert.equal(recreated, true);
    assert.deepEqual(replacementCommands, []);
    assert.equal(result.path, "recreated");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("recreation rejected by a live replacement lease preserves the running container", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-recovery-replacement-busy-"));
  const config = recoveryFixtureConfig(tmpDir);
  const replacementCommands: string[][] = [];
  const replacementBusy = new Error("SANDBOX_CONTROL_REPLACEMENT_BUSY: fixture lease is active");
  const row = { name: "demo-dev-feature..demo", status: "Up", branch: "feature/demo", running: true, index: 1 };

  try {
    await assert.rejects(
      () => ensureSandboxReady({
        config,
        engine: "native",
        branch: "feature/demo",
        row,
        allowRecreate: true,
        forceRecreate: true,
        recreate: async () => { throw replacementBusy; },
        writeWarning: () => {},
        deps: {
          ensureControlBroker: async () => {},
          runVerbose: (_engine, _cmd, args) => { replacementCommands.push(args); }
        }
      }),
      (error: unknown) => error === replacementBusy
    );
    assert.deepEqual(replacementCommands, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("container replacement preserves the original failure when the worktree is unchanged", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-recovery-original-failure-"));
  const config = recoveryFixtureConfig(tmpDir);
  const worktree = path.join(config.worktreeBase, "feature..demo");
  const before = git(worktree, "status", "--short", "--branch");
  const replacementCommands: string[][] = [];
  const originalFailure = new Error("fixture replacement failed");
  const row = { name: "demo-dev-feature..demo", status: "Up", branch: "feature/demo", running: true, index: 1 };

  try {
    await assert.rejects(
      () => ensureSandboxReady({
        config,
        engine: "native",
        branch: "feature/demo",
        row,
        allowRecreate: true,
        recreate: async () => { throw originalFailure; },
        writeWarning: () => {},
        deps: {
          ensureControlBroker: async () => {},
          run: () => JSON.stringify([{
            Id: "fixture-container-id",
            Config: { Labels: BRANCH_ONLY_LABELS },
            Mounts: recoveryFixtureMounts(config).map((mount) =>
              mount.Destination === "/home/devuser/.codex" ? { ...mount, Type: "bind" } : mount
            )
          }]),
          runOk: () => true,
          runVerbose: (_engine, _cmd, args) => { replacementCommands.push(args); }
        }
      }),
      (error: unknown) => error === originalFailure
    );
    assert.deepEqual(replacementCommands, []);
    assert.equal(git(worktree, "status", "--short", "--branch"), before);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("container replacement fails before Docker writes when the worktree snapshot is invalid", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-recovery-worktree-invalid-"));
  const config = recoveryFixtureConfig(tmpDir);
  const worktree = path.join(config.worktreeBase, "feature..demo");
  const replacementCommands: string[][] = [];
  const row = { name: "demo-dev-feature..demo", status: "Up", branch: "feature/demo", running: true, index: 1 };
  fs.rmSync(worktree, { recursive: true, force: true });

  try {
    await assert.rejects(
      () => ensureSandboxReady({
        config,
        engine: "native",
        branch: "feature/demo",
        row,
        allowRecreate: true,
        recreate: async () => {},
        writeWarning: () => {},
        deps: {
          ensureControlBroker: async () => { throw new Error("SANDBOX_CONTROL_MANIFEST_VERSION_INVALID"); },
          runVerbose: (_engine, _cmd, args) => { replacementCommands.push(args); }
        }
      }),
      /SANDBOX_RECOVERY_WORKTREE_SNAPSHOT_INVALID/
    );
    assert.deepEqual(replacementCommands, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("container replacement reports how to restore a detached worktree branch", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-recovery-detached-"));
  const config = recoveryFixtureConfig(tmpDir);
  const worktree = path.join(config.worktreeBase, "feature..demo");
  const replacementCommands: string[][] = [];
  const row = { name: "demo-dev-feature..demo", status: "Up", branch: "feature/demo", running: true, index: 1 };
  git(worktree, "checkout", "-q", "--detach");

  try {
    await assert.rejects(
      () => ensureSandboxReady({
        config,
        engine: "native",
        branch: "feature/demo",
        row,
        allowRecreate: true,
        recreate: async () => {},
        writeWarning: () => {},
        deps: {
          ensureControlBroker: async () => { throw new Error("SANDBOX_CONTROL_MANIFEST_VERSION_INVALID"); },
          runVerbose: (_engine, _cmd, args) => { replacementCommands.push(args); }
        }
      }),
      (error: unknown) => error instanceof Error
        && error.message.includes("SANDBOX_RECOVERY_WORKTREE_SNAPSHOT_INVALID")
        && error.message.includes("checkout feature/demo")
        && error.message.includes(JSON.stringify(worktree))
    );
    assert.deepEqual(replacementCommands, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("container replacement names both candidate dirs when the worktree is ambiguous", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-recovery-ambiguous-"));
  const config = recoveryFixtureConfig(tmpDir);
  const worktree = path.join(config.worktreeBase, "feature..demo");
  const legacyWorktree = path.join(config.worktreeBase, "feature-demo");
  const replacementCommands: string[][] = [];
  const row = { name: "demo-dev-feature..demo", status: "Up", branch: "feature/demo", running: true, index: 1 };
  fs.mkdirSync(legacyWorktree, { recursive: true });

  try {
    await assert.rejects(
      () => ensureSandboxReady({
        config,
        engine: "native",
        branch: "feature/demo",
        row,
        allowRecreate: true,
        recreate: async () => {},
        writeWarning: () => {},
        deps: {
          ensureControlBroker: async () => { throw new Error("SANDBOX_CONTROL_MANIFEST_VERSION_INVALID"); },
          runVerbose: (_engine, _cmd, args) => { replacementCommands.push(args); }
        }
      }),
      (error: unknown) => error instanceof Error
        && error.message.includes("SANDBOX_RECOVERY_WORKTREE_SNAPSHOT_INVALID")
        && error.message.includes(JSON.stringify(worktree))
        && error.message.includes(JSON.stringify(legacyWorktree))
    );
    assert.deepEqual(replacementCommands, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("control broker readiness failure enters the explicit container replacement boundary", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-broker-recreate-"));
  let recreated = false;
  const replacementCommands: string[][] = [];
  const config = recoveryFixtureConfig(tmpDir);
  const inspect = () => JSON.stringify([{
    Id: "fixture-container-id",
    Config: { Labels: BRANCH_ONLY_LABELS },
    Mounts: recoveryFixtureMounts(config)
  }]);
  const deps = {
    ensureControlBroker: async () => {
      throw new Error("SANDBOX_CONTROL_MANIFEST_VERSION_INVALID: expected version 3; container-only recreation is required");
    },
    run: () => inspect(),
    runOk: () => true,
    runVerbose: (_engine: string, _cmd: string, args: string[]) => {
      replacementCommands.push(args);
    },
    fetchRows: () => ({
      running: [{ name: "demo-dev-feature..demo", status: "Up", branch: "feature/demo", running: true, index: 1 }],
      nonRunning: []
    })
  };
  const row = {
    name: "demo-dev-feature..demo",
    status: "Up",
    branch: "feature/demo",
    running: true,
    index: 1
  };

  try {
    await assert.rejects(
      () => ensureSandboxReady({ config, engine: "native", branch: "feature/demo", row, deps }),
      /ai sandbox start --recreate feature\/demo/
    );
    assert.deepEqual(replacementCommands, []);

    const result = await ensureSandboxReady({
      config,
      engine: "native",
      branch: "feature/demo",
      row,
      allowRecreate: true,
      recreate: async () => { recreated = true; },
      writeWarning: () => {},
      deps
    });
    assert.equal(recreated, true);
    assert.deepEqual(replacementCommands, []);
    assert.equal(result.path, "recreated");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("fresh readiness restarts once when OrbStack workspace mounts are still settling", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-fresh-readiness-orbstack-"));
  const config = recoveryFixtureConfig(tmpDir);
  const container = "demo-dev-feature..demo";
  let restarted = false;
  const writes: string[][] = [];
  const settlingDestination = "/workspace/.agents/workspace/completed";

  try {
    await assert.doesNotReject(() => assertFreshSandboxReady({
      config,
      engine: "native",
      branch: "feature/demo",
      workspace: { mode: "branch-only" },
      container,
      copiedEntries: [],
      deps: {
        run: () => JSON.stringify([{
          Id: "fixture-container-id",
          Config: { Labels: BRANCH_ONLY_LABELS },
          Mounts: recoveryFixtureMounts(config).filter((mount) =>
            restarted || mount.Destination !== settlingDestination
          )
        }]),
        runOk: () => true,
        runVerbose: (_engine, _cmd, args) => {
          writes.push(args);
          if (args[0] === "restart") restarted = true;
        }
      }
    }));

    assert.equal(restarted, true);
    assert.deepEqual(writes[0], ["restart", container]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("fresh readiness remains fail-closed after one workspace mount restart", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-fresh-readiness-failed-"));
  const config = recoveryFixtureConfig(tmpDir);
  let restarts = 0;
  const settlingDestination = "/workspace/.agents/workspace/completed";

  try {
    await assert.rejects(() => assertFreshSandboxReady({
      config,
      engine: "native",
      branch: "feature/demo",
      workspace: { mode: "branch-only" },
      container: "demo-dev-feature..demo",
      copiedEntries: [],
      deps: {
        run: () => JSON.stringify([{
          Id: "fixture-container-id",
          Config: { Labels: BRANCH_ONLY_LABELS },
          Mounts: recoveryFixtureMounts(config).filter((mount) =>
            mount.Destination !== settlingDestination
          )
        }]),
        runOk: () => true,
        runVerbose: (_engine, _cmd, args) => {
          if (args[0] === "restart") restarts += 1;
        }
      }
    }), /Fresh sandbox readiness check failed/);

    assert.equal(restarts, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function commitInitialFile(repoDir: string): void {
  fs.writeFileSync(path.join(repoDir, "README.md"), "# demo\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir, env: gitSafeEnv(), stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "initial"],
    { cwd: repoDir, env: gitSafeEnv(), stdio: "ignore" }
  );
}

function spawnSandboxCli(
  fixture: ReturnType<typeof writeSandboxEngineFixture>,
  tmpDir: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {}
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
    timeout: 30_000
  });
}

// Treat an arg as a mount whose container target equals containerPath, ignoring
// read-only and SELinux mount options. Plain string ops, no RegExp from the path.
function isMountFor(arg: string, containerPath: string): boolean {
  const separator = arg.lastIndexOf(":");
  const options = separator >= 0 ? arg.slice(separator + 1).split(",") : [];
  const hasOnlyMountOptions = options.length > 0 && options.every((option) => ["ro", "rw", "z", "Z"].includes(option));
  const target = hasOnlyMountOptions ? arg.slice(0, separator) : arg;
  return target.endsWith(`:${containerPath}`);
}

function isReadOnlyMountFor(arg: string, containerPath: string): boolean {
  return isMountFor(arg, containerPath) && arg.slice(arg.lastIndexOf(":") + 1).split(",").includes("ro");
}

function hasSequence(call: string[], expected: string[]): boolean {
  return call.some((_, start) => expected.every((arg, index) => call[start + index] === arg));
}

test("sandbox create copies codex seeds into tmpfs without binding their runtime targets", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-tmpfs-run-"));

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, {
      project: "demo",
      sandbox: { tools: ["codex", "opencode"] }
    });
    commitInitialFile(fixture.repoDir);
    // Host auth.json makes the codex live-mount eligible so we can assert it is
    // still overlaid on top of the tmpfs.
    fs.mkdirSync(path.join(tmpDir, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".codex", "auth.json"), "{}\n", "utf8");
    // A stale runtime file left in the codex sandbox dir (e.g. from the previous
    // bind-mount era) must NOT be bound back over the tmpfs — otherwise the
    // high-churn writes would hit the host SSD again (CD-1).
    const codexSandboxDir = path.join(tmpDir, ".agent-infra", "sandboxes", "codex", "demo", "feature-x");
    fs.mkdirSync(path.join(codexSandboxDir, "mcp"), { recursive: true });
    fs.mkdirSync(path.join(codexSandboxDir, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(codexSandboxDir, "model-catalogs"), { recursive: true });
    fs.writeFileSync(path.join(codexSandboxDir, "logs_2.sqlite"), "stale\n", "utf8");
    fs.writeFileSync(path.join(codexSandboxDir, "mcp.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(codexSandboxDir, "mcp", "server.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(codexSandboxDir, "sessions", "session.jsonl"), "{}\n", "utf8");
    fs.writeFileSync(path.join(codexSandboxDir, "model-catalogs", "models.json"), "{}\n", "utf8");

    const result = spawnSandboxCli(
      fixture,
      tmpDir,
      ["create", "feature-x", "--cpu", "1", "--memory", "1"]
    );
    assert.equal(result.status, 0, result.stderr);

    const dockerCalls = fixture.readDockerCalls();
    const runCall = dockerCalls.find((call) => call[0] === "run");
    assert.ok(runCall, "expected sandbox create to call docker run");

    // codex home is a tmpfs, not a host bind mount.
    assert.ok(
      runCall.some((arg, index) => arg === "--tmpfs" && runCall[index + 1] === "/home/devuser/.codex:rw,size=512m"),
      `expected docker run to receive --tmpfs for codex, got ${JSON.stringify(runCall)}`
    );
    assert.equal(
      runCall.some((arg, index) => runCall[index - 1] === "-v" && isMountFor(arg, "/home/devuser/.codex")),
      false,
      `expected NO host bind for /home/devuser/.codex, got ${JSON.stringify(runCall)}`
    );

    // Seed sources are mounted read-only outside codex home, then copied into
    // tmpfs after the container starts. Their runtime targets are regular files
    // and directories rather than mount points, so Codex can atomically replace
    // config.toml without writing back to the host seed.
    assert.equal(
      runCall.some((arg, index) => runCall[index - 1] === "-v" && isMountFor(arg, "/home/devuser/.codex/config.toml")),
      false,
      `expected config.toml runtime target to NOT be bind-mounted, got ${JSON.stringify(runCall)}`
    );
    assert.equal(
      runCall.some((arg, index) => runCall[index - 1] === "-v" && isMountFor(arg, "/home/devuser/.codex/model-catalogs")),
      false,
      `expected model-catalogs runtime target to NOT be bind-mounted, got ${JSON.stringify(runCall)}`
    );
    assert.ok(
      runCall.some((arg, index) => runCall[index - 1] === "-v" && isReadOnlyMountFor(arg, "/run/agent-infra/tmpfs-seeds/codex/0")),
      `expected config.toml to have a read-only staging mount, got ${JSON.stringify(runCall)}`
    );
    assert.ok(
      runCall.some((arg, index) => runCall[index - 1] === "-v" && isReadOnlyMountFor(arg, "/run/agent-infra/tmpfs-seeds/codex/1")),
      `expected model-catalogs to have a read-only staging mount, got ${JSON.stringify(runCall)}`
    );
    const configCopyIndex = dockerCalls.findIndex((call) => hasSequence(
      call,
      ["cp", "-R", "--", "/run/agent-infra/tmpfs-seeds/codex/0", "/home/devuser/.codex/config.toml"]
    ));
    const catalogCopyIndex = dockerCalls.findIndex((call) => hasSequence(
      call,
      ["cp", "-R", "--", "/run/agent-infra/tmpfs-seeds/codex/1", "/home/devuser/.codex/model-catalogs"]
    ));
    assert.ok(
      configCopyIndex > dockerCalls.indexOf(runCall),
      `expected config.toml to be copied into tmpfs, got ${JSON.stringify(dockerCalls)}`
    );
    assert.ok(
      catalogCopyIndex > configCopyIndex,
      `expected model-catalogs to be copied into tmpfs, got ${JSON.stringify(dockerCalls)}`
    );
    const permissionRepairIndex = dockerCalls.findIndex((call) =>
      call.includes("chown") && call.includes("/home/devuser/.codex")
    );
    const contentVerifyIndex = dockerCalls.findIndex((call) =>
      call.includes("diff") && call.includes("/run/agent-infra/tmpfs-seeds/codex/0")
    );
    assert.ok(
      permissionRepairIndex >= 0 && permissionRepairIndex < configCopyIndex,
      `expected tmpfs ownership to be repaired before seed copy, got ${JSON.stringify(dockerCalls)}`
    );
    assert.ok(
      contentVerifyIndex > configCopyIndex,
      `expected copied seed content to be verified, got ${JSON.stringify(dockerCalls)}`
    );

    // A stale logs_2.sqlite left in the host dir must NOT be re-mounted (CD-1):
    // only the declared seed allowlist is bound, not the whole dir.
    assert.equal(
      runCall.some((arg, index) => runCall[index - 1] === "-v" && isMountFor(arg, "/home/devuser/.codex/logs_2.sqlite")),
      false,
      `stale logs_2.sqlite must NOT be bound back over the tmpfs, got ${JSON.stringify(runCall)}`
    );
    assert.equal(
      runCall.some((arg, index) => runCall[index - 1] === "-v" && isMountFor(arg, "/home/devuser/.codex/mcp.json")),
      false,
      `stale mcp.json must NOT be bound back over the tmpfs, got ${JSON.stringify(runCall)}`
    );
    assert.equal(
      runCall.some((arg, index) => runCall[index - 1] === "-v" && isMountFor(arg, "/home/devuser/.codex/mcp")),
      false,
      `stale mcp directory must NOT be bound back over the tmpfs, got ${JSON.stringify(runCall)}`
    );
    assert.equal(
      runCall.some((arg, index) => runCall[index - 1] === "-v" && isMountFor(arg, "/home/devuser/.codex/sessions")),
      false,
      `stale sessions directory must NOT be bound back over the tmpfs, got ${JSON.stringify(runCall)}`
    );

    // auth.json is still overlaid on top of the tmpfs.
    assert.ok(
      runCall.some((arg, index) => runCall[index - 1] === "-v" && isMountFor(arg, "/home/devuser/.codex/auth.json")),
      `expected auth.json live-mount to remain, got ${JSON.stringify(runCall)}`
    );

    // A non-tmpfs tool keeps its regular host bind mount and gets no --tmpfs.
    assert.ok(
      runCall.some((arg, index) => runCall[index - 1] === "-v" && isMountFor(arg, "/home/devuser/.local/share/opencode")),
      `expected opencode to keep its host bind, got ${JSON.stringify(runCall)}`
    );
    assert.equal(
      runCall.some((arg, index) => arg === "--tmpfs" && String(runCall[index + 1]).startsWith("/home/devuser/.local/share/opencode")),
      false,
      `expected opencode to NOT be tmpfs, got ${JSON.stringify(runCall)}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox create skips missing tmpfs seed entries", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-tmpfs-missing-seed-"));

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, {
      project: "demo",
      sandbox: { tools: ["codex"] }
    });
    commitInitialFile(fixture.repoDir);

    const result = spawnSandboxCli(
      fixture,
      tmpDir,
      ["create", "feature-x", "--cpu", "1", "--memory", "1"]
    );
    assert.equal(result.status, 0, result.stderr);

    const dockerCalls = fixture.readDockerCalls();
    const runCall = dockerCalls.find((call) => call[0] === "run");
    assert.ok(runCall, "expected sandbox create to call docker run");
    assert.ok(
      runCall.some((arg, index) => runCall[index - 1] === "-v" && isReadOnlyMountFor(arg, "/run/agent-infra/tmpfs-seeds/codex/0")),
      `expected generated config.toml to have a staging mount, got ${JSON.stringify(runCall)}`
    );
    assert.equal(
      runCall.some((arg, index) => runCall[index - 1] === "-v" && isMountFor(arg, "/run/agent-infra/tmpfs-seeds/codex/1")),
      false,
      `missing model-catalogs must not have a staging mount, got ${JSON.stringify(runCall)}`
    );
    assert.equal(
      dockerCalls.some((call) => call.includes("/run/agent-infra/tmpfs-seeds/codex/1")),
      false,
      `missing model-catalogs must not have a copy command, got ${JSON.stringify(dockerCalls)}`
    );
    assert.equal(
      runCall.some((arg, index) =>
        runCall[index - 1] === "-v" && isMountFor(arg, "/home/devuser/.codex/auth.json")
      ),
      false,
      `missing host auth must not block create or add an auth mount, got ${JSON.stringify(runCall)}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
