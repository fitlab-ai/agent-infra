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

test("sandbox create injects the detected host timezone into docker run", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-create-tz-"));

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, {
      project: "demo",
      sandbox: { tools: ["codex"] }
    });
    commitInitialFile(fixture.repoDir);

    spawnSandboxCli(
      fixture,
      tmpDir,
      ["create", "feature-x", "--cpu", "1", "--memory", "1"],
      { DOCKER_EXIT_FOR_RUN: "1", TZ: "Europe/Paris" },
      { timeout: 15_000 }
    );

    const runCall = fixture.readDockerCalls().find((call) => call[0] === "run");
    assert.ok(runCall, "expected sandbox create to call docker run");
    assert.ok(
      runCall.some((arg, index) => arg === "-e" && runCall[index + 1] === "TZ=Europe/Paris"),
      `expected docker run to receive TZ=Europe/Paris, got ${JSON.stringify(runCall)}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox exec injects the detected host timezone into docker exec", onPlatforms("linux", "darwin", "win32"), () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-exec-tz-"));

  try {
    const fixture = writeSandboxEngineFixture(tmpDir, {
      project: "demo",
      dockerStdoutForPs: "demo-dev-agent-infra-feature-cli-generic-sandbox"
    });

    const result = spawnSandboxCli(
      fixture,
      tmpDir,
      ["exec", "agent-infra-feature-cli-generic-sandbox", "true"],
      { TZ: "Europe/Paris" }
    );

    assert.equal(result.status, 0, result.stderr);
    const execCall = fixture.readDockerCalls().find((call) => call[0] === "exec");
    assert.ok(execCall, "expected sandbox exec to call docker exec");
    assert.ok(
      execCall.some((arg, index) => arg === "-e" && execCall[index + 1] === "TZ=Europe/Paris"),
      `expected docker exec to receive TZ=Europe/Paris, got ${JSON.stringify(execCall)}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
