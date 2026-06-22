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
// an optional SELinux relabel suffix (:z / :Z). Plain string ops, no RegExp from
// the path.
function isMountFor(arg: string, containerPath: string): boolean {
  const target = arg.replace(/:[zZ]$/, "");
  return target.endsWith(`:${containerPath}`);
}

test("sandbox create mounts codex home as tmpfs, drops its host bind, and seeds config over it", onPlatforms("linux", "darwin", "win32"), () => {
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
    fs.mkdirSync(codexSandboxDir, { recursive: true });
    fs.writeFileSync(path.join(codexSandboxDir, "logs_2.sqlite"), "stale\n", "utf8");

    spawnSandboxCli(
      fixture,
      tmpDir,
      ["create", "feature-x", "--cpu", "1", "--memory", "1"],
      { DOCKER_EXIT_FOR_RUN: "1" }
    );

    const runCall = fixture.readDockerCalls().find((call) => call[0] === "run");
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

    // Seeded config (ensureCodexWorkspaceTrust always writes config.toml) is
    // bind-mounted over the tmpfs at run time, so it is present in-container.
    assert.ok(
      runCall.some((arg, index) => runCall[index - 1] === "-v" && isMountFor(arg, "/home/devuser/.codex/config.toml")),
      `expected config.toml to be seeded as a nested bind over the tmpfs, got ${JSON.stringify(runCall)}`
    );

    // A stale logs_2.sqlite left in the host dir must NOT be re-mounted (CD-1):
    // only the declared seed allowlist is bound, not the whole dir.
    assert.equal(
      runCall.some((arg, index) => runCall[index - 1] === "-v" && isMountFor(arg, "/home/devuser/.codex/logs_2.sqlite")),
      false,
      `stale logs_2.sqlite must NOT be bound back over the tmpfs, got ${JSON.stringify(runCall)}`
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
