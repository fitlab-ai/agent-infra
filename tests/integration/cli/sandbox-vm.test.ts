import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  envWithPrependedPath,
  gitSafeEnv,
  loadFreshEsm,
  onPlatforms
} from "../../helpers.ts";
import { runVerbose } from "../../../lib/sandbox/shell.ts";

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
type NativeModule = AdapterModule<"native"> & {
  isRootlessDocker(options: Record<string, unknown>): boolean;
};

function restoreDockerContext(previousValue: string | undefined) {
  if (previousValue === undefined) {
    delete process.env.DOCKER_CONTEXT;
  } else {
    process.env.DOCKER_CONTEXT = previousValue;
  }
}

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

    const sandboxVm = await loadFreshEsm<typeof import("../../../lib/sandbox/commands/vm.ts")>("lib/sandbox/commands/vm.js");
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
  const sandboxVm = await loadFreshEsm<typeof import("../../../lib/sandbox/commands/vm.ts")>("lib/sandbox/commands/vm.js");

  assert.throws(
    () => sandboxVm.ensureManagedVm("native"),
    /does not use a managed VM/
  );
});

test("ensureManagedVm points Docker Desktop users to the GUI", async () => {
  const sandboxVm = await loadFreshEsm<typeof import("../../../lib/sandbox/commands/vm.ts")>("lib/sandbox/commands/vm.js");

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
