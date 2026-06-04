import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  gitSafeEnv,
  loadFreshEsm,
  onPlatforms,
  withGitSafeProcessEnv
} from "../helpers.ts";

test("loadConfig derives sandbox defaults from .agents/.airc.json", async () => {
  const sandboxConfig = await loadFreshEsm<typeof import("../../lib/sandbox/config.ts")>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-config-"));
  const previousCwd = process.cwd();

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    fs.mkdirSync(path.join(tmpDir, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".agents", ".airc.json"),
      JSON.stringify({ project: "demo", org: "fitlab-ai" }, null, 2) + "\n",
      "utf8"
    );

    process.chdir(tmpDir);
    const config = withGitSafeProcessEnv(() => sandboxConfig.loadConfig());

    assert.equal(config.project, "demo");
    assert.equal(config.org, "fitlab-ai");
    assert.equal(config.containerPrefix, "demo-dev");
    assert.equal(config.imageName, "demo-sandbox:latest");
    assert.deepEqual(config.runtimes, ["node22"]);
    assert.deepEqual(config.tools, ["claude-code", "codex", "gemini-cli", "opencode"]);
    assert.equal(config.engine, null);
    assert.deepEqual(config.vm, { cpu: null, memory: null, disk: null });
    assert.equal(config.worktreeBase, path.join(process.env.HOME ?? "", ".agent-infra", "worktrees", "demo"));
    assert.equal(config.shareBase, path.join(process.env.HOME ?? "", ".agent-infra", "share", "demo"));
    assert.equal(config.shellConfigBase, path.join(process.env.HOME ?? "", ".agent-infra", "config", "demo"));
    assert.equal(config.dotfilesDir, path.join(process.env.HOME ?? "", ".agent-infra", "dotfiles"));
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("dotfilesCacheDir returns project-scoped cache path under .agent-infra cache", async () => {
  const sandboxDotfiles = await loadFreshEsm<typeof import("../../lib/sandbox/dotfiles.ts")>("lib/sandbox/dotfiles.js");

  assert.equal(
    sandboxDotfiles.dotfilesCacheDir("/home/u", "demo"),
    "/home/u/.agent-infra/.cache/dotfiles-resolved/demo"
  );
});

test("loadConfig preserves configured sandbox engine", async () => {
  const sandboxConfig = await loadFreshEsm<typeof import("../../lib/sandbox/config.ts")>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-engine-config-"));
  const previousCwd = process.cwd();

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    fs.mkdirSync(path.join(tmpDir, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".agents", ".airc.json"),
      JSON.stringify({
        project: "demo",
        org: "fitlab-ai",
        sandbox: { engine: "docker-desktop" }
      }, null, 2) + "\n",
      "utf8"
    );

    process.chdir(tmpDir);
    const config = withGitSafeProcessEnv(() => sandboxConfig.loadConfig());

    assert.equal(config.engine, "docker-desktop");
    assert.deepEqual(config.runtimes, ["node22"]);
    assert.deepEqual(config.vm, { cpu: null, memory: null, disk: null });
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig preserves configured darwin-only sandbox engine with platform context", async () => {
  const sandboxConfig = await loadFreshEsm<typeof import("../../lib/sandbox/config.ts")>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-engine-darwin-"));
  const previousCwd = process.cwd();

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    fs.mkdirSync(path.join(tmpDir, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".agents", ".airc.json"),
      JSON.stringify({
        project: "demo",
        org: "fitlab-ai",
        sandbox: { engine: "orbstack" }
      }, null, 2) + "\n",
      "utf8"
    );

    process.chdir(tmpDir);
    const config = withGitSafeProcessEnv(() => sandboxConfig.loadConfig({ platformFn: () => "darwin" }));

    assert.equal(config.engine, "orbstack");
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects unsupported sandbox engine values", async () => {
  const sandboxConfig = await loadFreshEsm<typeof import("../../lib/sandbox/config.ts")>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-engine-invalid-"));
  const previousCwd = process.cwd();

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    fs.mkdirSync(path.join(tmpDir, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".agents", ".airc.json"),
      JSON.stringify({
        project: "demo",
        sandbox: { engine: "podman" }
      }, null, 2) + "\n",
      "utf8"
    );

    process.chdir(tmpDir);

    assert.throws(
      () => withGitSafeProcessEnv(() => sandboxConfig.loadConfig()),
      /invalid "sandbox\.engine" value "podman".*unknown sandbox engine.*Valid engines:.*colima.*orbstack.*docker-desktop.*native.*wsl2/s
    );
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig fails when .agents/.airc.json is missing", async () => {
  const sandboxConfig = await loadFreshEsm<typeof import("../../lib/sandbox/config.ts")>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-missing-config-"));
  const previousCwd = process.cwd();

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    process.chdir(tmpDir);
    assert.throws(
      () => withGitSafeProcessEnv(() => sandboxConfig.loadConfig()),
      /No \.agents\/\.airc\.json found/
    );
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("findRuntimeEngineMismatches reports node runtime engine conflicts", async () => {
  const runtimeEngines = await loadFreshEsm<typeof import("../../lib/sandbox/runtime-engines.ts")>("lib/sandbox/runtime-engines.js");

  assert.deepEqual(runtimeEngines.findRuntimeEngineMismatches(["node20"], ">=22"), [
    { runtimes: ["node20"], enginesNode: ">=22" }
  ]);
  assert.deepEqual(runtimeEngines.findRuntimeEngineMismatches(["node22"], ">=22"), []);
  assert.deepEqual(runtimeEngines.findRuntimeEngineMismatches(["node20", "node22"], ">=22"), []);
  assert.deepEqual(runtimeEngines.findRuntimeEngineMismatches(["node18", "node20"], ">=22"), [
    { runtimes: ["node18", "node20"], enginesNode: ">=22" }
  ]);
  assert.deepEqual(runtimeEngines.findRuntimeEngineMismatches(["node20"], ">=20"), []);
  assert.deepEqual(runtimeEngines.findRuntimeEngineMismatches(["node20"], "20 || 22"), []);
  assert.deepEqual(runtimeEngines.findRuntimeEngineMismatches(["node20"], undefined), []);
  assert.deepEqual(runtimeEngines.findRuntimeEngineMismatches(["node20"], "not-a-range"), []);
  assert.deepEqual(runtimeEngines.findRuntimeEngineMismatches(["java21", "python3"], ">=22"), []);
});

test("loadConfig warns when sandbox node runtime does not satisfy package engines", async () => {
  const sandboxConfig = await loadFreshEsm<typeof import("../../lib/sandbox/config.ts")>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-engine-mismatch-"));
  const previousCwd = process.cwd();
  const stderr: string[] = [];

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ engines: { node: ">=22" } }, null, 2) + "\n",
      "utf8"
    );
    fs.mkdirSync(path.join(tmpDir, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".agents", ".airc.json"),
      JSON.stringify({
        project: "demo",
        org: "fitlab-ai",
        sandbox: { runtimes: ["node20"] }
      }, null, 2) + "\n",
      "utf8"
    );

    process.chdir(tmpDir);
    const config = withGitSafeProcessEnv(() => sandboxConfig.loadConfig({
      writeStderr: (chunk) => stderr.push(chunk)
    }));

    assert.deepEqual(config.runtimes, ["node20"]);
    assert.match(stderr.join(""), /sandbox runtimes "node20" do not satisfy this project's package\.json "engines\.node" \(">=22"\)/);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig does not warn when sandbox node runtime satisfies package engines", async () => {
  const sandboxConfig = await loadFreshEsm<typeof import("../../lib/sandbox/config.ts")>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-engine-match-"));
  const previousCwd = process.cwd();
  const stderr: string[] = [];

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ engines: { node: ">=22" } }, null, 2) + "\n",
      "utf8"
    );
    fs.mkdirSync(path.join(tmpDir, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".agents", ".airc.json"),
      JSON.stringify({
        project: "demo",
        sandbox: { runtimes: ["node22"] }
      }, null, 2) + "\n",
      "utf8"
    );

    process.chdir(tmpDir);
    const config = withGitSafeProcessEnv(() => sandboxConfig.loadConfig({
      writeStderr: (chunk) => stderr.push(chunk)
    }));

    assert.deepEqual(config.runtimes, ["node22"]);
    assert.equal(stderr.join(""), "");
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig skips runtime engine warnings for invalid package json", async () => {
  const sandboxConfig = await loadFreshEsm<typeof import("../../lib/sandbox/config.ts")>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-invalid-package-"));
  const previousCwd = process.cwd();
  const stderr: string[] = [];

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{ not json", "utf8");
    fs.mkdirSync(path.join(tmpDir, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".agents", ".airc.json"),
      JSON.stringify({
        project: "demo",
        sandbox: { runtimes: ["node20"] }
      }, null, 2) + "\n",
      "utf8"
    );

    process.chdir(tmpDir);
    const config = withGitSafeProcessEnv(() => sandboxConfig.loadConfig({
      writeStderr: (chunk) => stderr.push(chunk)
    }));

    assert.deepEqual(config.runtimes, ["node20"]);
    assert.equal(stderr.join(""), "");
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig skips runtime engine warnings when a custom Dockerfile is configured", async () => {
  const sandboxConfig = await loadFreshEsm<typeof import("../../lib/sandbox/config.ts")>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-custom-dockerfile-"));
  const previousCwd = process.cwd();
  const stderr: string[] = [];

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ engines: { node: ">=22" } }, null, 2) + "\n",
      "utf8"
    );
    fs.writeFileSync(path.join(tmpDir, "Dockerfile"), "FROM node:20\n", "utf8");
    fs.mkdirSync(path.join(tmpDir, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".agents", ".airc.json"),
      JSON.stringify({
        project: "demo",
        sandbox: {
          dockerfile: "Dockerfile",
          runtimes: ["node20"]
        }
      }, null, 2) + "\n",
      "utf8"
    );

    process.chdir(tmpDir);
    const config = withGitSafeProcessEnv(() => sandboxConfig.loadConfig({
      writeStderr: (chunk) => stderr.push(chunk)
    }));

    assert.equal(config.dockerfile, "Dockerfile");
    assert.deepEqual(config.runtimes, ["node20"]);
    assert.equal(stderr.join(""), "");
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig uses os.homedir on Windows when HOME is unset", onPlatforms("win32"), async () => {
  const sandboxConfig = await loadFreshEsm<typeof import("../../lib/sandbox/config.ts")>("lib/sandbox/config.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-userprofile-"));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;

  try {
    execSync("git init", { cwd: tmpDir, env: gitSafeEnv(), stdio: "pipe" });
    fs.mkdirSync(path.join(tmpDir, '.agents'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.agents', '.airc.json'),
      JSON.stringify({ project: 'test-project' }),
      'utf8'
    );
    process.chdir(tmpDir);
    delete process.env.HOME;
    process.env.USERPROFILE = tmpDir;

    const config = withGitSafeProcessEnv(() => sandboxConfig.loadConfig());
    assert.equal(config.home, tmpDir);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
