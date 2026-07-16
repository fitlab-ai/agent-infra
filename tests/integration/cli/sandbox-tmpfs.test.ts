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
  classifySandboxRecovery,
  collectSandboxRecoverySnapshot,
  ensureSandboxReady,
  type SandboxRecoverySnapshot
} from "../../../lib/sandbox/recovery.ts";
import type { SandboxConfig } from "../../../lib/sandbox/config.ts";
import { tmpfsSeedTargetPath } from "../../../lib/sandbox/tools.ts";

function healthyRecoverySnapshot(): SandboxRecoverySnapshot {
  return {
    identityOk: true,
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
    codex: {
      commandAvailable: true,
      stateWritable: true,
      promptsSourceExists: true,
      promptsValid: true
    }
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
    tools: ["codex"],
    customTools: []
  } as unknown as SandboxConfig;

  for (const directory of [
    config.repoRoot,
    path.join(config.repoRoot, ".agents", "workspace"),
    path.join(config.worktreeBase, branchDir),
    path.join(config.shareBase, "common"),
    path.join(config.shareBase, "branches", branchDir),
    path.join(config.shellConfigBase, branchDir),
    path.join(config.home, ".agent-infra", "sandboxes", "codex", project, branchDir, "model-catalogs")
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(
    path.join(config.home, ".agent-infra", "sandboxes", "codex", project, branchDir, "config.toml"),
    "model = 'runtime-drift-must-survive'\n",
    "utf8"
  );
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
  return [
    { Type: "bind", Source: path.join(config.worktreeBase, branchDir), Destination: "/workspace", RW: true },
    { Type: "bind", Source: path.join(config.repoRoot, ".agents", "workspace"), Destination: "/workspace/.agents/workspace", RW: true },
    { Type: "bind", Source: path.join(config.shareBase, "common"), Destination: "/share/common", RW: true },
    { Type: "bind", Source: path.join(config.shareBase, "branches", branchDir), Destination: "/share/branch", RW: true },
    { Type: "bind", Source: path.join(config.shellConfigBase, branchDir), Destination: "/home/devuser/.host-shell-config", RW: false },
    { Type: "tmpfs", Source: "", Destination: "/home/devuser/.codex", RW: true },
    { Type: "bind", Source: path.join(seedDir, "config.toml"), Destination: "/run/agent-infra/tmpfs-seeds/codex/0", RW: false },
    { Type: "bind", Source: path.join(seedDir, "model-catalogs"), Destination: "/run/agent-infra/tmpfs-seeds/codex/1", RW: false }
  ];
}

test("recovery classification preserves healthy running seed content drift", () => {
  const snapshot = healthyRecoverySnapshot();

  assert.deepEqual(classifySandboxRecovery(snapshot), []);
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
  prompts.codex!.promptsValid = false;
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
          Config: { Labels: { "demo.sandbox.branch": "feature/demo" } },
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
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("running permission repair re-assesses seed targets before hydration", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-recovery-permissions-"));
  const config = recoveryFixtureConfig(tmpDir);
  let permissionsRepaired = false;
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
        run: () => JSON.stringify([{
          Id: "fixture-container-id",
          Config: { Labels: { "demo.sandbox.branch": "feature/demo" } },
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
      labels: { "demo.sandbox.branch": "feature/demo" },
      mounts: baseMounts.map((mount) => mount.Destination === "/workspace"
        ? { ...mount, Source: wrongWorktreeSource }
        : mount)
    },
    {
      name: "read-only worktree",
      labels: { "demo.sandbox.branch": "feature/demo" },
      mounts: baseMounts.map((mount) => mount.Destination === "/workspace"
        ? { ...mount, RW: false }
        : mount)
    },
    {
      name: "inaccessible worktree source",
      labels: { "demo.sandbox.branch": "feature/demo" },
      mounts: baseMounts,
      unavailableSource: worktreeSource
    },
    {
      name: "inaccessible live mount source",
      labels: { "demo.sandbox.branch": "feature/demo" },
      mounts: baseMounts,
      unavailableSource: liveSource
    },
    {
      name: "missing live mount",
      labels: { "demo.sandbox.branch": "feature/demo" },
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
          /Re-run with --recreate/,
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
  const config = recoveryFixtureConfig(tmpDir);
  const inspect = () => JSON.stringify([{
    Id: "fixture-container-id",
    Config: { Labels: { "demo.sandbox.branch": "feature/demo" } },
    Mounts: recoveryFixtureMounts(config).map((mount) =>
      mount.Destination === "/home/devuser/.codex"
        ? { ...mount, Type: recreated ? "tmpfs" : "bind" }
        : mount
    )
  }]);
  const deps = {
    run: () => inspect(),
    runOk: () => true,
    runVerbose: () => { writes += 1; },
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
      /Re-run with --recreate/
    );
    assert.equal(writes, 0, "hard mount failures must not mutate the running container");

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
    assert.equal(result.path, "recreated");
    assert.equal(result.container, "demo-dev-feature..demo");
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
    timeout: 20_000
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
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
