import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as toml from "smol-toml";

import {
  filePath,
  loadFreshEsm,
  onPlatforms,
  supportsPosixModeBits
} from "../../helpers.ts";

type CommandOptions = Record<string, unknown> & {
  env?: NodeJS.ProcessEnv;
  input?: Buffer | string;
  encoding?: BufferEncoding;
  stdio?: unknown;
};
type ResolvedToolFixture = {
  tool: {
    envVars?: Record<string, string>;
    id?: string;
  };
};
type EnvFileResult = {
  dockerArgs: string[];
  cleanup(): void;
};
type GpgCache = {
  pub: Buffer;
  sec: Buffer;
};
type ExecFn = (cmd: string, args: string[], options?: CommandOptions) => string | Buffer | void;
type EngineExecFn = (engine: string, cmd: string, args: string[], options?: CommandOptions) => string | Buffer | void;
type RunSafeFn = (cmd: string, args: string[]) => string;
type EngineRunSafeFn = (engine: string, cmd: string, args: string[]) => string;
type SandboxCreateModule = {
  create(args: string[]): Promise<void>;
  buildContainerEnvFile(tools: ResolvedToolFixture[], engine: string, runSafe?: EngineRunSafeFn, options?: CommandOptions): EnvFileResult;
  buildDotfilesVolumeArgs(engine: string, snapshotDir: string | null | undefined, existsFn?: (targetPath: string) => boolean): string[];
  assertBranchAvailable(repoRoot: string, branch: string, options?: { allowedWorktrees?: string[]; runFn?: RunSafeFn }): void;
  ensureClaudeOnboarding(toolDir: string, hostHomeDir?: string): void;
  ensureClaudeSettings(toolDir: string, hostHomeDir?: string): void;
  ensureCodexModelInheritance(toolDir: string, hostHomeDir?: string, containerCodexDir?: string): void;
  ensureCodexWorkspaceTrust(toolDir: string): void;
  ensureOpenCodeModelInheritance(toolDir: string, hostHomeDir?: string): void;
  ensureGeminiWorkspaceTrust(toolDir: string): void;
  buildImage(config: Record<string, unknown>, tools: Array<Record<string, unknown>>, dockerfilePath: string, imageSignature: string, deps?: Record<string, unknown>): void;
  commandErrorMessage(error: unknown): string;
  hostHasGpgKeys(home: string, execFn?: ExecFn): boolean;
  ensureShellConfigSymlinks(engine: string, container: string, execFn?: EngineExecFn): void;
  ensureSandboxAliasesFile(home: string): { created: boolean; path: string };
  buildClipboardVolumeArgs(engine: string, home: string): string[];
  prepareHostShellConfig(config: Record<string, unknown>): {
    hostDir: string;
    mounts: Array<{ hostPath: string; containerPath: string; options?: string }>;
  };
  detectGpgConfig(content: string): boolean;
  sanitizeGitConfig(content: string, home: string, options?: Record<string, unknown>): string;
  writeSanitizedGitconfig(config: Record<string, unknown>): string;
  syncGpgKeys(container: string, home: string, project: string, execFn: ExecFn, runSafeFn: RunSafeFn, options?: Record<string, unknown>): boolean;
  currentKeyringFingerprint(home: string, execFn: ExecFn): string | null;
  getGitSigningKey(options: Record<string, unknown>): string | null;
  readGpgCache(home: string, project: string, fingerprintFn: ExecFn, signingKey?: string): GpgCache | null;
  writeGpgCache(home: string, project: string, pub: Buffer, sec: Buffer, fingerprint: string, signingKey?: string): boolean;
};

test("ensureClaudeOnboarding creates .claude.json with onboarding and workspace trust", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-onboarding-"));

  try {
    sandboxCreate.ensureClaudeOnboarding(tmpDir);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude.json"), "utf8"));
    assert.equal(data.hasCompletedOnboarding, true);
    assert.equal(data.projects["/workspace"].hasTrustDialogAccepted, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureClaudeOnboarding preserves existing fields", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-onboarding-existing-"));

  try {
    fs.writeFileSync(path.join(tmpDir, ".claude.json"), JSON.stringify({ theme: "dark", userID: "abc" }), "utf8");
    sandboxCreate.ensureClaudeOnboarding(tmpDir);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude.json"), "utf8"));
    assert.equal(data.hasCompletedOnboarding, true);
    assert.equal(data.theme, "dark");
    assert.equal(data.userID, "abc");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureClaudeOnboarding populates workspace trust when only hasCompletedOnboarding is set", async () => {
  // Regression guard for the dirty-flag refactor: a prior CC session may have
  // written `hasCompletedOnboarding: true` without ever touching the projects
  // map (e.g. if no project was opened). We must still preseed the workspace
  // trust entry and persist it to disk.
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-onboarding-partial-"));

  try {
    fs.writeFileSync(
      path.join(tmpDir, ".claude.json"),
      JSON.stringify({ hasCompletedOnboarding: true }),
      "utf8"
    );
    sandboxCreate.ensureClaudeOnboarding(tmpDir);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude.json"), "utf8"));
    assert.equal(data.hasCompletedOnboarding, true);
    assert.equal(data.projects["/workspace"].hasTrustDialogAccepted, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureClaudeOnboarding skips write when flag already set", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-onboarding-noop-"));
  const filePath = path.join(tmpDir, ".claude.json");

  try {
    fs.writeFileSync(filePath, JSON.stringify({
      hasCompletedOnboarding: true,
      projects: { "/workspace": { hasTrustDialogAccepted: true } }
    }), "utf8");
    const mtimeBefore = fs.statSync(filePath).mtimeMs;
    sandboxCreate.ensureClaudeOnboarding(tmpDir);
    const mtimeAfter = fs.statSync(filePath).mtimeMs;
    assert.equal(mtimeBefore, mtimeAfter);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureClaudeOnboarding inherits host model when sandbox model is absent", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-onboarding-model-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-host-model-"));

  try {
    fs.writeFileSync(path.join(hostHome, ".claude.json"), JSON.stringify({ model: "claude-opus-4-7" }), "utf8");
    sandboxCreate.ensureClaudeOnboarding(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude.json"), "utf8"));
    assert.equal(data.model, "claude-opus-4-7");
    assert.equal(data.hasCompletedOnboarding, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureClaudeOnboarding preserves existing sandbox model", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-onboarding-keep-model-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-host-keep-model-"));

  try {
    fs.writeFileSync(path.join(hostHome, ".claude.json"), JSON.stringify({ model: "claude-opus-4-7" }), "utf8");
    fs.writeFileSync(path.join(tmpDir, ".claude.json"), JSON.stringify({ model: "claude-sonnet-4-5" }), "utf8");
    sandboxCreate.ensureClaudeOnboarding(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude.json"), "utf8"));
    assert.equal(data.model, "claude-sonnet-4-5");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureClaudeOnboarding skips host model when it is missing", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-onboarding-missing-model-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-host-missing-model-"));

  try {
    fs.writeFileSync(path.join(hostHome, ".claude.json"), JSON.stringify({ theme: "dark" }), "utf8");
    sandboxCreate.ensureClaudeOnboarding(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude.json"), "utf8"));
    assert.equal(Object.hasOwn(data, "model"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureClaudeOnboarding skips empty host model", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-onboarding-empty-model-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-host-empty-model-"));

  try {
    fs.writeFileSync(path.join(hostHome, ".claude.json"), JSON.stringify({ model: "" }), "utf8");
    sandboxCreate.ensureClaudeOnboarding(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude.json"), "utf8"));
    assert.equal(Object.hasOwn(data, "model"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureClaudeOnboarding ignores malformed host json", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-onboarding-malformed-host-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-host-malformed-"));

  try {
    fs.writeFileSync(path.join(hostHome, ".claude.json"), "{", "utf8");
    assert.doesNotThrow(() => sandboxCreate.ensureClaudeOnboarding(tmpDir, hostHome));
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude.json"), "utf8"));
    assert.equal(Object.hasOwn(data, "model"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureClaudeOnboarding inherits host launch-pin flag when sandbox is absent", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-launchpin-inherit-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-launchpin-host-"));

  try {
    fs.writeFileSync(
      path.join(hostHome, ".claude.json"),
      JSON.stringify({ unpinOpus47LaunchEffort: true }),
      "utf8"
    );
    sandboxCreate.ensureClaudeOnboarding(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude.json"), "utf8"));
    assert.equal(data.unpinOpus47LaunchEffort, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureClaudeOnboarding preserves existing sandbox launch-pin flag value", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-launchpin-preserve-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-launchpin-host-preserve-"));

  try {
    fs.writeFileSync(
      path.join(hostHome, ".claude.json"),
      JSON.stringify({ unpinOpus47LaunchEffort: true }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(tmpDir, ".claude.json"),
      JSON.stringify({ unpinOpus47LaunchEffort: false }),
      "utf8"
    );
    sandboxCreate.ensureClaudeOnboarding(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude.json"), "utf8"));
    assert.equal(data.unpinOpus47LaunchEffort, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureClaudeOnboarding skips launch-pin flag when host omits it", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-launchpin-omit-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-launchpin-host-omit-"));

  try {
    fs.writeFileSync(path.join(hostHome, ".claude.json"), JSON.stringify({ theme: "dark" }), "utf8");
    sandboxCreate.ensureClaudeOnboarding(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude.json"), "utf8"));
    assert.equal(Object.hasOwn(data, "unpinOpus47LaunchEffort"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureClaudeOnboarding inherits all matching launch-pin flags for future models", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-launchpin-future-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-launchpin-host-future-"));

  try {
    fs.writeFileSync(
      path.join(hostHome, ".claude.json"),
      JSON.stringify({
        unpinOpus47LaunchEffort: true,
        unpinOpus48LaunchEffort: true
      }),
      "utf8"
    );
    sandboxCreate.ensureClaudeOnboarding(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude.json"), "utf8"));
    assert.equal(data.unpinOpus47LaunchEffort, true);
    assert.equal(data.unpinOpus48LaunchEffort, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureClaudeOnboarding skips launch-pin flag values that are not strictly true", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-launchpin-nonboolean-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-launchpin-host-nonboolean-"));

  try {
    fs.writeFileSync(
      path.join(hostHome, ".claude.json"),
      JSON.stringify({
        unpinOpus47LaunchEffort: "true",
        unpinOpus48LaunchEffort: 1,
        unpinOpus49LaunchEffort: false
      }),
      "utf8"
    );
    sandboxCreate.ensureClaudeOnboarding(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude.json"), "utf8"));
    assert.equal(Object.hasOwn(data, "unpinOpus47LaunchEffort"), false);
    assert.equal(Object.hasOwn(data, "unpinOpus48LaunchEffort"), false);
    assert.equal(Object.hasOwn(data, "unpinOpus49LaunchEffort"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureClaudeSettings creates settings.json with skipDangerousModePermissionPrompt", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-settings-"));

  try {
    sandboxCreate.ensureClaudeSettings(tmpDir);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, "settings.json"), "utf8"));
    assert.equal(data.skipDangerousModePermissionPrompt, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureClaudeSettings skips write when skipDangerousModePermissionPrompt is already set", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-settings-noop-"));
  const settingsPath = path.join(tmpDir, "settings.json");

  try {
    fs.writeFileSync(settingsPath, JSON.stringify({
      skipDangerousModePermissionPrompt: true
    }), "utf8");
    const mtimeBefore = fs.statSync(settingsPath).mtimeMs;
    sandboxCreate.ensureClaudeSettings(tmpDir);
    const mtimeAfter = fs.statSync(settingsPath).mtimeMs;
    assert.equal(mtimeBefore, mtimeAfter);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureClaudeSettings inherits host effort level when sandbox field is absent", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-settings-effort-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-host-effort-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".claude", "settings.json"),
      JSON.stringify({ effortLevel: "high" }),
      "utf8"
    );
    sandboxCreate.ensureClaudeSettings(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, "settings.json"), "utf8"));
    assert.equal(data.effortLevel, "high");
    assert.equal(data.skipDangerousModePermissionPrompt, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureClaudeSettings preserves existing sandbox effort level", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-settings-keep-effort-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-host-keep-effort-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".claude", "settings.json"),
      JSON.stringify({ effortLevel: "xhigh" }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(tmpDir, "settings.json"),
      JSON.stringify({ skipDangerousModePermissionPrompt: true, effortLevel: "low" }),
      "utf8"
    );
    sandboxCreate.ensureClaudeSettings(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, "settings.json"), "utf8"));
    assert.equal(data.effortLevel, "low");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureClaudeSettings skips missing host effort level", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-settings-missing-effort-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-host-missing-effort-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(hostHome, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }), "utf8");
    sandboxCreate.ensureClaudeSettings(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, "settings.json"), "utf8"));
    assert.equal(Object.hasOwn(data, "effortLevel"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureClaudeSettings skips empty host effort level", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-settings-empty-effort-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-host-empty-effort-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(hostHome, ".claude", "settings.json"), JSON.stringify({ effortLevel: "" }), "utf8");
    sandboxCreate.ensureClaudeSettings(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, "settings.json"), "utf8"));
    assert.equal(Object.hasOwn(data, "effortLevel"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexModelInheritance creates config with host model fields", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-model-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-host-model-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".codex", "config.toml"),
      'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n',
      "utf8"
    );
    sandboxCreate.ensureCodexModelInheritance(tmpDir, hostHome);
    const data = toml.parse(fs.readFileSync(path.join(tmpDir, "config.toml"), "utf8"));
    assert.equal(data.model, "gpt-5.5");
    assert.equal(data.model_reasoning_effort, "high");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexModelInheritance keeps model fields before workspace trust section", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-model-order-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-host-order-"));
  const configPath = path.join(tmpDir, "config.toml");

  try {
    fs.mkdirSync(path.join(hostHome, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".codex", "config.toml"),
      'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n',
      "utf8"
    );
    fs.writeFileSync(configPath, '[projects."/workspace"]\ntrust_level = "trusted"\n', "utf8");
    sandboxCreate.ensureCodexModelInheritance(tmpDir, hostHome);
    const content = fs.readFileSync(configPath, "utf8");
    const data = toml.parse(content) as {
      model?: string;
      model_reasoning_effort?: string;
      projects: Record<string, { trust_level?: string }>;
    };
    assert.equal(data.model, "gpt-5.5");
    assert.equal(data.model_reasoning_effort, "high");
    assert.equal(data.projects["/workspace"]?.trust_level, "trusted");
    const lines = content.split(/\r?\n/);
    const modelLine = lines.findIndex((line) => line.startsWith("model = "));
    const sectionLine = lines.findIndex((line) => line.startsWith("[projects."));
    assert.ok(modelLine >= 0);
    assert.ok(sectionLine > modelLine);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexModelInheritance inherits model_auto_compact_token_limit", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-compact-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-host-compact-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".codex", "config.toml"),
      'model = "gpt-5.5"\nmodel_auto_compact_token_limit = 206720\n',
      "utf8"
    );
    sandboxCreate.ensureCodexModelInheritance(tmpDir, hostHome);
    const data = toml.parse(fs.readFileSync(path.join(tmpDir, "config.toml"), "utf8")) as {
      model?: string;
      model_auto_compact_token_limit?: number;
    };
    assert.equal(data.model, "gpt-5.5");
    assert.equal(data.model_auto_compact_token_limit, 206720);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexModelInheritance skips invalid numeric inherits", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-compact-invalid-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-host-compact-invalid-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".codex", "config.toml"),
      'model = "gpt-5.5"\nmodel_auto_compact_token_limit = 0\n',
      "utf8"
    );
    sandboxCreate.ensureCodexModelInheritance(tmpDir, hostHome);
    const data = toml.parse(fs.readFileSync(path.join(tmpDir, "config.toml"), "utf8")) as {
      model?: string;
      model_auto_compact_token_limit?: number;
    };
    assert.equal(data.model, "gpt-5.5");
    assert.equal(data.model_auto_compact_token_limit, undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexModelInheritance preserves existing sandbox model_auto_compact_token_limit", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-compact-keep-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-host-compact-keep-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".codex", "config.toml"),
      'model_auto_compact_token_limit = 206720\n',
      "utf8"
    );
    fs.writeFileSync(path.join(tmpDir, "config.toml"), "model_auto_compact_token_limit = 150000\n", "utf8");
    sandboxCreate.ensureCodexModelInheritance(tmpDir, hostHome);
    const data = toml.parse(fs.readFileSync(path.join(tmpDir, "config.toml"), "utf8")) as {
      model_auto_compact_token_limit?: number;
    };
    assert.equal(data.model_auto_compact_token_limit, 150000);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexModelInheritance ignores model fields outside the root table", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-model-section-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-host-section-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".codex", "config.toml"),
      '[profiles.default]\nmodel = "gpt-5.5"\nmodel_reasoning_effort = "high"\n',
      "utf8"
    );
    sandboxCreate.ensureCodexModelInheritance(tmpDir, hostHome);
    assert.equal(fs.existsSync(path.join(tmpDir, "config.toml")), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexModelInheritance preserves existing sandbox model field", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-model-keep-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-host-keep-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".codex", "config.toml"),
      'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n',
      "utf8"
    );
    fs.writeFileSync(path.join(tmpDir, "config.toml"), 'model = "gpt-5.4"\n', "utf8");
    sandboxCreate.ensureCodexModelInheritance(tmpDir, hostHome);
    const data = toml.parse(fs.readFileSync(path.join(tmpDir, "config.toml"), "utf8"));
    assert.equal(data.model, "gpt-5.4");
    assert.equal(data.model_reasoning_effort, "high");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexModelInheritance ignores malformed host config", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-model-malformed-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-host-malformed-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(hostHome, ".codex", "config.toml"), "=", "utf8");
    assert.doesNotThrow(() => sandboxCreate.ensureCodexModelInheritance(tmpDir, hostHome));
    assert.equal(fs.existsSync(path.join(tmpDir, "config.toml")), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexModelInheritance leaves malformed sandbox config alone", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-model-malformed-sandbox-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-host-valid-for-malformed-sandbox-"));
  const configPath = path.join(tmpDir, "config.toml");

  try {
    fs.mkdirSync(path.join(hostHome, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".codex", "config.toml"),
      'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n',
      "utf8"
    );
    fs.writeFileSync(configPath, "=", "utf8");
    assert.doesNotThrow(() => sandboxCreate.ensureCodexModelInheritance(tmpDir, hostHome));
    assert.equal(fs.readFileSync(configPath, "utf8"), "=");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexModelInheritance copies a relative host catalog and rewrites to the container path", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-catalog-rel-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-host-catalog-rel-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".codex", "catalogs"), { recursive: true });
    fs.writeFileSync(path.join(hostHome, ".codex", "catalogs", "gpt.json"), '{"models":[]}', "utf8");
    fs.writeFileSync(
      path.join(hostHome, ".codex", "config.toml"),
      'model = "gpt-5.5"\nmodel_catalog_json = "catalogs/gpt.json"\n',
      "utf8"
    );
    sandboxCreate.ensureCodexModelInheritance(tmpDir, hostHome);
    const data = toml.parse(fs.readFileSync(path.join(tmpDir, "config.toml"), "utf8")) as {
      model?: string;
      model_catalog_json?: string;
    };
    assert.equal(data.model, "gpt-5.5");
    assert.equal(data.model_catalog_json, "/home/devuser/.codex/model-catalogs/gpt.json");
    assert.equal(
      fs.readFileSync(path.join(tmpDir, "model-catalogs", "gpt.json"), "utf8"),
      '{"models":[]}'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexModelInheritance copies an absolute host catalog", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-catalog-abs-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-host-catalog-abs-"));
  const catalogFile = path.join(hostHome, "elsewhere", "custom.json");

  try {
    fs.mkdirSync(path.join(hostHome, ".codex"), { recursive: true });
    fs.mkdirSync(path.dirname(catalogFile), { recursive: true });
    fs.writeFileSync(catalogFile, '{"k":1}', "utf8");
    fs.writeFileSync(
      path.join(hostHome, ".codex", "config.toml"),
      `model_catalog_json = ${JSON.stringify(catalogFile)}\n`,
      "utf8"
    );
    sandboxCreate.ensureCodexModelInheritance(tmpDir, hostHome);
    const data = toml.parse(fs.readFileSync(path.join(tmpDir, "config.toml"), "utf8")) as {
      model_catalog_json?: string;
    };
    assert.equal(data.model_catalog_json, "/home/devuser/.codex/model-catalogs/custom.json");
    assert.equal(fs.readFileSync(path.join(tmpDir, "model-catalogs", "custom.json"), "utf8"), '{"k":1}');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexModelInheritance expands a tilde host catalog path", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-catalog-tilde-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-host-catalog-tilde-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".codex", "catalogs"), { recursive: true });
    fs.writeFileSync(path.join(hostHome, ".codex", "catalogs", "gpt.json"), "{}", "utf8");
    fs.writeFileSync(
      path.join(hostHome, ".codex", "config.toml"),
      'model_catalog_json = "~/.codex/catalogs/gpt.json"\n',
      "utf8"
    );
    sandboxCreate.ensureCodexModelInheritance(tmpDir, hostHome);
    const data = toml.parse(fs.readFileSync(path.join(tmpDir, "config.toml"), "utf8")) as {
      model_catalog_json?: string;
    };
    assert.equal(data.model_catalog_json, "/home/devuser/.codex/model-catalogs/gpt.json");
    assert.equal(fs.existsSync(path.join(tmpDir, "model-catalogs", "gpt.json")), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexModelInheritance preserves an existing sandbox model_catalog_json", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-catalog-keep-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-host-catalog-keep-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".codex", "catalogs"), { recursive: true });
    fs.writeFileSync(path.join(hostHome, ".codex", "catalogs", "gpt.json"), "{}", "utf8");
    fs.writeFileSync(
      path.join(hostHome, ".codex", "config.toml"),
      'model_catalog_json = "catalogs/gpt.json"\n',
      "utf8"
    );
    fs.writeFileSync(path.join(tmpDir, "config.toml"), 'model_catalog_json = "/custom/path.json"\n', "utf8");
    sandboxCreate.ensureCodexModelInheritance(tmpDir, hostHome);
    const data = toml.parse(fs.readFileSync(path.join(tmpDir, "config.toml"), "utf8")) as {
      model_catalog_json?: string;
    };
    assert.equal(data.model_catalog_json, "/custom/path.json");
    assert.equal(fs.existsSync(path.join(tmpDir, "model-catalogs")), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexModelInheritance skips a missing host catalog file", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-catalog-missing-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-host-catalog-missing-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".codex", "config.toml"),
      'model = "gpt-5.5"\nmodel_catalog_json = "/nonexistent/x.json"\n',
      "utf8"
    );
    sandboxCreate.ensureCodexModelInheritance(tmpDir, hostHome);
    const data = toml.parse(fs.readFileSync(path.join(tmpDir, "config.toml"), "utf8")) as {
      model?: string;
      model_catalog_json?: string;
    };
    assert.equal(data.model, "gpt-5.5");
    assert.equal(data.model_catalog_json, undefined);
    assert.equal(fs.existsSync(path.join(tmpDir, "model-catalogs")), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexModelInheritance skips a host catalog path that is a directory", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-catalog-dir-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-host-catalog-dir-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".codex", "catalogs"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".codex", "config.toml"),
      'model_catalog_json = "catalogs"\n',
      "utf8"
    );
    sandboxCreate.ensureCodexModelInheritance(tmpDir, hostHome);
    assert.equal(fs.existsSync(path.join(tmpDir, "config.toml")), false);
    assert.equal(fs.existsSync(path.join(tmpDir, "model-catalogs")), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexModelInheritance keeps catalog and model before the workspace trust section", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-catalog-order-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-host-catalog-order-"));
  const configPath = path.join(tmpDir, "config.toml");

  try {
    fs.mkdirSync(path.join(hostHome, ".codex", "catalogs"), { recursive: true });
    fs.writeFileSync(path.join(hostHome, ".codex", "catalogs", "gpt.json"), "{}", "utf8");
    fs.writeFileSync(
      path.join(hostHome, ".codex", "config.toml"),
      'model = "gpt-5.5"\nmodel_catalog_json = "catalogs/gpt.json"\n',
      "utf8"
    );
    fs.writeFileSync(configPath, '[projects."/workspace"]\ntrust_level = "trusted"\n', "utf8");
    sandboxCreate.ensureCodexModelInheritance(tmpDir, hostHome);
    const content = fs.readFileSync(configPath, "utf8");
    const lines = content.split(/\r?\n/);
    const catalogLine = lines.findIndex((line) => line.startsWith("model_catalog_json = "));
    const sectionLine = lines.findIndex((line) => line.startsWith("[projects."));
    assert.ok(catalogLine >= 0);
    assert.ok(sectionLine > catalogLine);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexModelInheritance honors a non-default container codex dir", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-catalog-customdir-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-host-catalog-customdir-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".codex", "catalogs"), { recursive: true });
    fs.writeFileSync(path.join(hostHome, ".codex", "catalogs", "gpt.json"), "{}", "utf8");
    fs.writeFileSync(
      path.join(hostHome, ".codex", "config.toml"),
      'model_catalog_json = "catalogs/gpt.json"\n',
      "utf8"
    );
    sandboxCreate.ensureCodexModelInheritance(tmpDir, hostHome, "/custom/codex");
    const data = toml.parse(fs.readFileSync(path.join(tmpDir, "config.toml"), "utf8")) as {
      model_catalog_json?: string;
    };
    assert.equal(data.model_catalog_json, "/custom/codex/model-catalogs/gpt.json");
    assert.equal(fs.existsSync(path.join(tmpDir, "model-catalogs", "gpt.json")), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexModelInheritance skips a non-string model_catalog_json", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-catalog-nonstring-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-host-catalog-nonstring-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".codex", "config.toml"),
      'model = "gpt-5.5"\nmodel_catalog_json = ["a", "b"]\n',
      "utf8"
    );
    sandboxCreate.ensureCodexModelInheritance(tmpDir, hostHome);
    const data = toml.parse(fs.readFileSync(path.join(tmpDir, "config.toml"), "utf8")) as {
      model?: string;
      model_catalog_json?: unknown;
    };
    assert.equal(data.model, "gpt-5.5");
    assert.equal(data.model_catalog_json, undefined);
    assert.equal(fs.existsSync(path.join(tmpDir, "model-catalogs")), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexModelInheritance skips an empty model_catalog_json", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-catalog-empty-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-host-catalog-empty-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".codex", "config.toml"),
      'model_catalog_json = ""\n',
      "utf8"
    );
    sandboxCreate.ensureCodexModelInheritance(tmpDir, hostHome);
    assert.equal(fs.existsSync(path.join(tmpDir, "config.toml")), false);
    assert.equal(fs.existsSync(path.join(tmpDir, "model-catalogs")), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexModelInheritance skips an unreadable host catalog file", onPlatforms("linux", "darwin"), async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-catalog-unreadable-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-host-catalog-unreadable-"));
  const catalogFile = path.join(hostHome, ".codex", "catalogs", "gpt.json");

  try {
    if (!supportsPosixModeBits()) {
      return;
    }
    fs.mkdirSync(path.dirname(catalogFile), { recursive: true });
    fs.writeFileSync(catalogFile, "{}", "utf8");
    fs.chmodSync(catalogFile, 0o000);
    // Running as root bypasses the read bit; the unreadable scenario cannot be reproduced there.
    try {
      fs.accessSync(catalogFile, fs.constants.R_OK);
      return;
    } catch {
      // Genuinely unreadable: proceed to assert safe-skip.
    }
    fs.writeFileSync(
      path.join(hostHome, ".codex", "config.toml"),
      'model_catalog_json = "catalogs/gpt.json"\n',
      "utf8"
    );
    sandboxCreate.ensureCodexModelInheritance(tmpDir, hostHome);
    assert.equal(fs.existsSync(path.join(tmpDir, "config.toml")), false);
    assert.equal(fs.existsSync(path.join(tmpDir, "model-catalogs")), false);
  } finally {
    try {
      fs.chmodSync(catalogFile, 0o600);
    } catch {
      // best-effort restore so cleanup can remove the file
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureOpenCodeModelInheritance creates config with host model fields", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-model-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-host-model-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".config", "opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".config", "opencode", "opencode.json"),
      JSON.stringify({
        model: "anthropic/claude-opus-4-7",
        small_model: "openai/gpt-5.5-mini"
      }),
      "utf8"
    );
    sandboxCreate.ensureOpenCodeModelInheritance(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, "opencode.json"), "utf8"));
    assert.equal(data.model, "anthropic/claude-opus-4-7");
    assert.equal(data.small_model, "openai/gpt-5.5-mini");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureOpenCodeModelInheritance preserves existing sandbox model fields", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-model-keep-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-host-keep-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".config", "opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".config", "opencode", "opencode.json"),
      JSON.stringify({
        model: "anthropic/claude-opus-4-7",
        small_model: "openai/gpt-5.5-mini"
      }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(tmpDir, "opencode.json"),
      JSON.stringify({
        model: "openai/gpt-5.5",
        small_model: "anthropic/claude-sonnet-4-5"
      }),
      "utf8"
    );
    sandboxCreate.ensureOpenCodeModelInheritance(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, "opencode.json"), "utf8"));
    assert.equal(data.model, "openai/gpt-5.5");
    assert.equal(data.small_model, "anthropic/claude-sonnet-4-5");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureOpenCodeModelInheritance inherits small model when host model is missing", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-small-model-only-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-host-small-model-only-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".config", "opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".config", "opencode", "opencode.json"),
      JSON.stringify({ small_model: "openai/gpt-5.5-mini" }),
      "utf8"
    );
    sandboxCreate.ensureOpenCodeModelInheritance(tmpDir, hostHome);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, "opencode.json"), "utf8"));
    assert.equal(Object.hasOwn(data, "model"), false);
    assert.equal(data.small_model, "openai/gpt-5.5-mini");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureOpenCodeModelInheritance skips missing host model fields", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-model-missing-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-host-missing-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".config", "opencode"), { recursive: true });
    fs.writeFileSync(path.join(hostHome, ".config", "opencode", "opencode.json"), JSON.stringify({ theme: "dark" }), "utf8");
    sandboxCreate.ensureOpenCodeModelInheritance(tmpDir, hostHome);
    assert.equal(fs.existsSync(path.join(tmpDir, "opencode.json")), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureOpenCodeModelInheritance skips empty host model fields", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-model-empty-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-host-empty-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".config", "opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".config", "opencode", "opencode.json"),
      JSON.stringify({ model: "", small_model: "" }),
      "utf8"
    );
    sandboxCreate.ensureOpenCodeModelInheritance(tmpDir, hostHome);
    assert.equal(fs.existsSync(path.join(tmpDir, "opencode.json")), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureOpenCodeModelInheritance ignores malformed host json", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-model-malformed-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-host-malformed-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".config", "opencode"), { recursive: true });
    fs.writeFileSync(path.join(hostHome, ".config", "opencode", "opencode.json"), "{", "utf8");
    assert.doesNotThrow(() => sandboxCreate.ensureOpenCodeModelInheritance(tmpDir, hostHome));
    assert.equal(fs.existsSync(path.join(tmpDir, "opencode.json")), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureOpenCodeModelInheritance leaves malformed sandbox config alone", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-model-malformed-sandbox-"));
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-opencode-host-valid-for-malformed-sandbox-"));

  try {
    fs.mkdirSync(path.join(hostHome, ".config", "opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(hostHome, ".config", "opencode", "opencode.json"),
      JSON.stringify({ model: "anthropic/claude-opus-4-7" }),
      "utf8"
    );
    const configPath = path.join(tmpDir, "opencode.json");
    fs.writeFileSync(configPath, "{", "utf8");
    assert.doesNotThrow(() => sandboxCreate.ensureOpenCodeModelInheritance(tmpDir, hostHome));
    assert.equal(fs.readFileSync(configPath, "utf8"), "{");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
});

test("ensureCodexWorkspaceTrust appends workspace trust to config.toml", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-trust-"));

  try {
    fs.writeFileSync(path.join(tmpDir, "config.toml"), 'model = "o3"\n', "utf8");
    sandboxCreate.ensureCodexWorkspaceTrust(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, "config.toml"), "utf8");
    assert.match(content, /model = "o3"/);
    assert.match(content, /\[projects\."\/workspace"\]/);
    assert.match(content, /trust_level = "trusted"/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureCodexWorkspaceTrust skips when workspace trust already exists", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-codex-trust-noop-"));
  const configPath = path.join(tmpDir, "config.toml");

  try {
    const original = '[projects."/workspace"]\ntrust_level = "trusted"\n';
    fs.writeFileSync(configPath, original, "utf8");
    sandboxCreate.ensureCodexWorkspaceTrust(tmpDir);
    assert.equal(fs.readFileSync(configPath, "utf8"), original);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureGeminiWorkspaceTrust creates trustedFolders.json with workspace trust", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gemini-trust-"));

  try {
    sandboxCreate.ensureGeminiWorkspaceTrust(tmpDir);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, "trustedFolders.json"), "utf8"));
    assert.deepEqual(data, { "/workspace": "TRUST_FOLDER" });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureGeminiWorkspaceTrust skips write when workspace trust already exists", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gemini-trust-noop-"));
  const trustPath = path.join(tmpDir, "trustedFolders.json");

  try {
    fs.writeFileSync(trustPath, JSON.stringify({ "/workspace": "TRUST_FOLDER" }, null, 2), "utf8");
    const mtimeBefore = fs.statSync(trustPath).mtimeMs;
    sandboxCreate.ensureGeminiWorkspaceTrust(tmpDir);
    const mtimeAfter = fs.statSync(trustPath).mtimeMs;
    assert.equal(mtimeBefore, mtimeAfter);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
