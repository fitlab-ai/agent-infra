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

function hasArgs(call: string[], expected: string[]): boolean {
  return call.length === expected.length && call.every((arg, index) => arg === expected[index]);
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
    const configCopyIndex = dockerCalls.findIndex((call) => hasArgs(
      call.slice(2),
      ["cp", "-R", "--", "/run/agent-infra/tmpfs-seeds/codex/0", "/home/devuser/.codex/config.toml"]
    ));
    const catalogCopyIndex = dockerCalls.findIndex((call) => hasArgs(
      call.slice(2),
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
