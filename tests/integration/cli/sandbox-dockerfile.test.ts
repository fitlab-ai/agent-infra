import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  filePath,
  loadFreshEsm,
  onPlatforms
} from "../../helpers.ts";

type CommandOptions = Record<string, unknown> & {
  env?: NodeJS.ProcessEnv;
  input?: Buffer | string;
  encoding?: BufferEncoding;
  stdio?: unknown;
};
type VerboseCall = {
  type: "run" | "verbose";
  engine?: string;
  cmd: string;
  args: string[];
  opts?: CommandOptions;
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
  ensureCodexModelInheritance(toolDir: string, hostHomeDir?: string): void;
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
type NativeModule = AdapterModule<"native"> & {
  isRootlessDocker(options: Record<string, unknown>): boolean;
};

function required<T>(value: T | undefined, message = "expected value"): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

test("composeDockerfile joins runtime fragments in order", async () => {
  const sandboxDockerfile = await loadFreshEsm<typeof import("../../../lib/sandbox/dockerfile.ts")>("lib/sandbox/dockerfile.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-dockerfile-"));

  try {
    const dockerfilePath = sandboxDockerfile.composeDockerfile({
      repoRoot: tmpDir,
      project: "demo",
      runtimes: ["node20", "python3"],
      dockerfile: null
    });
    const content = fs.readFileSync(dockerfilePath, "utf8");

    assert.match(content, /^FROM ubuntu:24\.04/m);
    assert.match(content, /setup_20\.x/);
    assert.match(content, /python3 python3-pip python3-venv/);
    assert.match(content, /ARG AI_TOOL_PACKAGES=/);
    assert.match(content, /ARG AI_TOOLS_SHELL_INSTALL_B64=/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("node runtime setup fails fast on NodeSource download errors", async () => {
  const sandboxDockerfile = await loadFreshEsm<typeof import("../../../lib/sandbox/dockerfile.ts")>("lib/sandbox/dockerfile.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-node-runtime-"));

  try {
    const dockerfilePath = sandboxDockerfile.composeDockerfile({
      repoRoot: tmpDir,
      project: "demo",
      runtimes: ["node22"],
      dockerfile: null
    });
    const content = fs.readFileSync(dockerfilePath, "utf8");

    assert.match(content, /bash -o pipefail -c 'curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors https:\/\/deb\.nodesource\.com\/setup_22\.x \| bash -'/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Intent: each package in AI_TOOL_PACKAGES gets its own `npm install -g <pkg>`
// invocation, so npm's batch-install path (which drops platform-specific
// optionalDependencies for `npm:` aliased packages — Issue #293) is not
// triggered. This is a behavior test: we execute the dockerfile's RUN body
// against a stubbed `npm` and a synthetic 3-package list, then assert each
// package was installed at least once. Form-agnostic — accepts `for` loops,
// `xargs -n1`, or any equivalent rewrite that preserves the semantic.
test("composeDockerfile installs each AI tool package separately", onPlatforms("linux", "darwin"), async () => {
  const sandboxDockerfile = await loadFreshEsm<typeof import("../../../lib/sandbox/dockerfile.ts")>("lib/sandbox/dockerfile.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-ai-tools-loop-"));
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-npm-stub-"));

  try {
    const dockerfilePath = sandboxDockerfile.composeDockerfile({
      repoRoot: tmpDir,
      project: "demo",
      runtimes: ["node20"],
      dockerfile: null
    });
    const content = fs.readFileSync(dockerfilePath, "utf8");

    const runBlock = content
      .split(/^(?=FROM |USER |ENV |ARG |RUN |WORKDIR |CMD |COPY |ADD )/m)
      .find((block) => block.startsWith("RUN ") && block.includes("AI_TOOL_PACKAGES"));
    assert.ok(runBlock, "expected a RUN block consuming AI_TOOL_PACKAGES");

    const shellBody = runBlock.replace(/^RUN\s+/, "").replace(/\\\n\s*/g, " ").trim();

    const logFile = path.join(stubDir, "invocations.log");
    const npmStub = path.join(stubDir, "npm");
    fs.writeFileSync(npmStub, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logFile}"\n`, { mode: 0o755 });

    const packages = ["@acme/tool-a", "@acme/tool-b", "@acme/tool-c"];
    const result = spawnSync("/bin/sh", ["-c", shellBody], {
      env: {
        ...process.env,
        PATH: `${stubDir}:${process.env.PATH}`,
        AI_TOOL_PACKAGES: packages.join(" ")
      },
      encoding: "utf8"
    });

    assert.equal(result.status, 0, `RUN body exited non-zero: ${result.stderr}`);
    const invocations = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean)
      : [];
    const installedPackages = invocations
      .map((line) => line.match(/^install -g (\S+)$/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => required(match[1]));
    for (const pkg of packages) {
      const count = installedPackages.filter((p) => p === pkg).length;
      assert.ok(count >= 1, `expected ${pkg} to be installed by its own 'npm install -g <pkg>' invocation, got ${count} (invocations: ${JSON.stringify(invocations)})`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(stubDir, { recursive: true, force: true });
  }
});

test("composeDockerfile includes gh CLI and bash_aliases sourcing", async () => {
  const sandboxDockerfile = await loadFreshEsm<typeof import("../../../lib/sandbox/dockerfile.ts")>("lib/sandbox/dockerfile.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-gh-"));

  try {
    const dockerfilePath = sandboxDockerfile.composeDockerfile({
      repoRoot: tmpDir,
      project: "demo",
      runtimes: ["node20"],
      dockerfile: null
    });
    const content = fs.readFileSync(dockerfilePath, "utf8");

    assert.match(content, /cli\.github\.com\/packages/);
    assert.match(content, /build-essential ca-certificates gnupg lsb-release/);
    assert.match(content, /curl wget git vim file/);
    assert.match(content, /apt-get install -y gh/);
    assert.match(content, /export GPG_TTY=\$\(tty\)/);
    assert.match(content, /\[ -f ~\/\.bash_aliases \] && \. ~\/\.bash_aliases/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("composeDockerfile installs tmux for in-container session recovery", async () => {
  const sandboxDockerfile = await loadFreshEsm<typeof import("../../../lib/sandbox/dockerfile.ts")>("lib/sandbox/dockerfile.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-tmux-"));

  try {
    const dockerfilePath = sandboxDockerfile.composeDockerfile({
      repoRoot: tmpDir,
      project: "demo",
      runtimes: ["node20"],
      dockerfile: null
    });
    const content = fs.readFileSync(dockerfilePath, "utf8");

    assert.match(content, /\btmux\b/);
    assert.match(content, /TMUX_VERSION=3\.6b/);
    assert.match(content, /apt-get purge -y pkg-config bison libevent-dev libncurses-dev/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("composeDockerfile installs tzdata for runtime TZ resolution", async () => {
  const sandboxDockerfile = await loadFreshEsm<typeof import("../../../lib/sandbox/dockerfile.ts")>("lib/sandbox/dockerfile.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-tzdata-"));

  try {
    const dockerfilePath = sandboxDockerfile.composeDockerfile({
      repoRoot: tmpDir,
      project: "demo",
      runtimes: ["node20"],
      dockerfile: null
    });
    const content = fs.readFileSync(dockerfilePath, "utf8");

    assert.match(content, /\btzdata\b/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("composeDockerfile bakes sandbox-tmux-entry script", async () => {
  const sandboxDockerfile = await loadFreshEsm<typeof import("../../../lib/sandbox/dockerfile.ts")>("lib/sandbox/dockerfile.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-tmux-entry-"));

  try {
    const dockerfilePath = sandboxDockerfile.composeDockerfile({
      repoRoot: tmpDir,
      project: "demo",
      runtimes: ["node20"],
      dockerfile: null
    });
    const content = fs.readFileSync(dockerfilePath, "utf8");

    assert.match(content, /cat > \/usr\/local\/bin\/sandbox-tmux-entry <<'SCRIPT'/);
    assert.match(content, /chmod \+x \/usr\/local\/bin\/sandbox-tmux-entry/);
    assert.match(content, /command -v tmux/);
    assert.match(content, /tmux has-session -t "\$SESSION"/);
    assert.match(content, /tmux list-sessions -F '#\{session_name\}'/);
    assert.match(content, /case "\$name" in\s*"\$SESSION"-\*\)/);
    assert.match(content, /tmux kill-session -t "\$name"/);
    assert.match(content, /tmux\s+set-environment\s+-t\s+"\$SESSION"\s+TZ/);
    assert.match(content, /exec tmux attach -d -t "\$SESSION"/);
    assert.match(content, /exec tmux new-session -s "\$SESSION"/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("composeDockerfile bakes sandbox-dotfiles-link script", async () => {
  const sandboxDockerfile = await loadFreshEsm<typeof import("../../../lib/sandbox/dockerfile.ts")>("lib/sandbox/dockerfile.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-dotfiles-link-"));

  try {
    const dockerfilePath = sandboxDockerfile.composeDockerfile({
      repoRoot: tmpDir,
      project: "demo",
      runtimes: ["node20"],
      dockerfile: null
    });
    const content = fs.readFileSync(dockerfilePath, "utf8");

    assert.match(content, /cat > \/usr\/local\/bin\/sandbox-dotfiles-link <<'SCRIPT'/);
    assert.match(content, /chmod \+x \/usr\/local\/bin\/sandbox-dotfiles-link/);
    assert.match(content, /DOTFILES_SRC=\/dotfiles/);
    assert.match(content, /\[ -d "\$DOTFILES_SRC" \] \|\| exit 0/);
    assert.match(content, /find \. -type f -print/);
    assert.match(content, /\.ssh\|\.ssh\/\*/);
    assert.match(content, /\.gnupg\|\.gnupg\/\*/);
    assert.match(content, /\.config\/opencode\|\.config\/opencode\/\*/);
    assert.match(content, /\.gitconfig\|\.gitignore_global\|\.stCommitMsg\|\.bash_aliases\|README\.md/);
    assert.match(content, /mkdir -p "\$\(dirname "\$target"\)"/);
    assert.match(content, /\[ -d "\$target" \] && \[ ! -L "\$target" \]/);
    assert.match(content, /skipping %s \(existing directory; use nested path like %s\/<file> instead\)/);
    assert.match(content, /ln -sfn "\$DOTFILES_SRC\/\$rel" "\$target"/);
    assert.match(content, /printf 'sandbox-dotfiles-link: failed to link %s\\n' "\$target" >&2/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("composeDockerfile invokes sandbox-dotfiles-link from sandbox-tmux-entry", async () => {
  const sandboxDockerfile = await loadFreshEsm<typeof import("../../../lib/sandbox/dockerfile.ts")>("lib/sandbox/dockerfile.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-dotfiles-entry-"));

  try {
    const dockerfilePath = sandboxDockerfile.composeDockerfile({
      repoRoot: tmpDir,
      project: "demo",
      runtimes: ["node20"],
      dockerfile: null
    });
    const content = fs.readFileSync(dockerfilePath, "utf8");

    assert.match(content, /sandbox-dotfiles-link[^\n]*\|\| true/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("composeDockerfile configures tmux extended keys and terminal env forwarding", async () => {
  const sandboxDockerfile = await loadFreshEsm<typeof import("../../../lib/sandbox/dockerfile.ts")>("lib/sandbox/dockerfile.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-tmux-config-"));

  try {
    const dockerfilePath = sandboxDockerfile.composeDockerfile({
      repoRoot: tmpDir,
      project: "demo",
      runtimes: ["node20"],
      dockerfile: null
    });
    const content = fs.readFileSync(dockerfilePath, "utf8");

    assert.match(content, /set -g extended-keys always/);
    assert.match(content, /set -g extended-keys-format csi-u/);
    assert.match(content, /set -as terminal-features 'xterm\*:extkeys'/);
    assert.match(
      content,
      /set -ga update-environment 'TERM_PROGRAM TERM_PROGRAM_VERSION LC_TERMINAL LC_TERMINAL_VERSION TZ'/
    );
    assert.match(content, /set -g mouse on/);
    assert.match(content, /set -g status-interval 1/);
    assert.match(content, /set -g status-right-length 80/);
    assert.match(content, /\/usr\/local\/bin\/cc-token-status/);
    assert.match(content, /SETTINGS_FILE="\/home\/devuser\/\.claude\/settings\.json"/);
    assert.match(content, /ANTHROPIC_AUTH_TOKEN/);
    assert.match(content, /ANTHROPIC_API_KEY/);
    assert.match(content, /apiKeyHelper/);
    assert.ok(
      content.indexOf('SETTINGS_FILE="/home/devuser/.claude/settings.json"')
        < content.indexOf('CRED_FILE="/home/devuser/.claude/.credentials.json"')
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("buildImage uses verbose docker build output while keeping host UID/GID lookups quiet", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const calls: VerboseCall[] = [];

  sandboxCreate.buildImage(
    { project: "demo", imageName: "demo-sandbox:latest", repoRoot: "/repo" },
    [{ install: { type: "npm", cmd: "@acme/tool" } }],
    "/tmp/Dockerfile",
    "sig-123",
    {
      engine: "native",
      runFn(cmd: string, args: string[]) {
        const [, actualCmd, actualArgs] = arguments;
        calls.push({ type: "run", cmd: actualCmd, args: actualArgs });
        if (actualCmd === "id" && actualArgs[0] === "-u") {
          return "501";
        }
        if (actualCmd === "id" && actualArgs[0] === "-g") {
          return "20";
        }
        throw new Error(`unexpected quiet command: ${actualCmd} ${actualArgs.join(" ")}`);
      },
      runSafeFn() {
        return "";
      },
      runVerboseFn(engine: string, cmd: string, args: string[], opts?: CommandOptions) {
        calls.push({ type: "verbose", engine, cmd, args, opts });
      }
    }
  );

  assert.deepEqual(calls.slice(0, 2), [
    { type: "run", cmd: "id", args: ["-u"] },
    { type: "run", cmd: "id", args: ["-g"] }
  ]);
  const buildCall = required(calls[2]);
  assert.equal(buildCall.type, "verbose");
  assert.equal(buildCall.engine, "native");
  assert.equal(buildCall.cmd, "docker");
  assert.equal(buildCall.opts?.cwd, "/repo");
  assert.deepEqual(buildCall.args, [
    "build",
    "-t",
    "demo-sandbox:latest",
    "--build-arg",
    "HOST_UID=501",
    "--build-arg",
    "HOST_GID=20",
    "--build-arg",
    "AI_TOOL_PACKAGES=@acme/tool",
    "--build-arg",
    "AI_TOOLS_SHELL_INSTALL_B64=",
    "--label",
    "demo.sandbox",
    "--label",
    "demo.sandbox.image-config=sig-123",
    "-f",
    "/tmp/Dockerfile",
    "/repo"
  ]);
});

test("buildImage forwards HOST_UID=0 and HOST_GID=0 unchanged when host runs as root", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const calls: VerboseCall[] = [];

  sandboxCreate.buildImage(
    { project: "demo", imageName: "demo-sandbox:latest", repoRoot: "/repo" },
    [{ install: { type: "npm", cmd: "@acme/tool" } }],
    "/tmp/Dockerfile",
    "sig-123",
    {
      engine: "native",
      runFn(engine: string, cmd: string, args: string[]) {
        calls.push({ type: "run", engine, cmd, args });
        if (cmd === "id" && args[0] === "-u") {
          return "0";
        }
        if (cmd === "id" && args[0] === "-g") {
          return "0";
        }
        throw new Error(`unexpected quiet command: ${cmd} ${args.join(" ")}`);
      },
      runSafeFn() {
        return "";
      },
      runVerboseFn(engine: string, cmd: string, args: string[], opts?: CommandOptions) {
        calls.push({ type: "verbose", engine, cmd, args, opts });
      }
    }
  );

  assert.deepEqual(calls.slice(0, 2), [
    { type: "run", engine: "native", cmd: "id", args: ["-u"] },
    { type: "run", engine: "native", cmd: "id", args: ["-g"] }
  ]);
  assert.equal(calls.length, 3);
  const buildCall = required(calls[2]);
  assert.equal(buildCall.type, "verbose");
  assert.equal(buildCall.engine, "native");
  assert.equal(buildCall.cmd, "docker");
  assert.equal(buildCall.opts?.cwd, "/repo");
  assert.deepEqual(buildCall.args.slice(0, 7), [
    "build",
    "-t",
    "demo-sandbox:latest",
    "--build-arg",
    "HOST_UID=0",
    "--build-arg",
    "HOST_GID=0"
  ]);
});

test("isRootlessDocker returns true when DOCKER_HOST points at rootless socket", async () => {
  const { isRootlessDocker } = await loadFreshEsm<NativeModule>("lib/sandbox/engines/native.js");

  assert.equal(
    isRootlessDocker({ env: { DOCKER_HOST: "unix:///run/user/1000/docker.sock" } }),
    true
  );
});

test("isRootlessDocker falls back to docker info SecurityOptions", async () => {
  const { isRootlessDocker } = await loadFreshEsm<NativeModule>("lib/sandbox/engines/native.js");

  assert.equal(
    isRootlessDocker({
      env: {},
      runSafe(cmd: string, args: string[]) {
        assert.equal(cmd, "docker");
        assert.deepEqual(args, ["info", "--format", "{{.SecurityOptions}}"]);
        return "[name=rootless,name=seccomp=builtin]";
      }
    }),
    true
  );
});

test("buildImage rewrites HOST_UID and HOST_GID to 0 when Docker is rootless", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const calls: VerboseCall[] = [];

  sandboxCreate.buildImage(
    { project: "demo", imageName: "demo-sandbox:latest", repoRoot: "/repo" },
    [{ install: { type: "npm", cmd: "@acme/tool" } }],
    "/tmp/Dockerfile",
    "sig-123",
    {
      engine: "native",
      runFn(engine: string, cmd: string, args: string[]) {
        calls.push({ type: "run", engine, cmd, args });
        if (cmd === "id" && args[0] === "-u") {
          return "1000";
        }
        if (cmd === "id" && args[0] === "-g") {
          return "1000";
        }
        throw new Error(`unexpected quiet command: ${cmd} ${args.join(" ")}`);
      },
      runSafeFn() {
        return "";
      },
      runVerboseFn(engine: string, cmd: string, args: string[], opts?: CommandOptions) {
        calls.push({ type: "verbose", engine, cmd, args, opts });
      },
      env: { DOCKER_HOST: "unix:///run/user/1000/docker.sock" }
    }
  );

  assert.equal(calls.length, 1);
  const buildCall = required(calls[0]);
  assert.equal(buildCall.type, "verbose");
  assert.deepEqual(buildCall.args.slice(0, 7), [
    "build",
    "-t",
    "demo-sandbox:latest",
    "--build-arg",
    "HOST_UID=0",
    "--build-arg",
    "HOST_GID=0"
  ]);
});

test("base.dockerfile guards root host uid with useradd -o", () => {
  const content = fs.readFileSync(filePath("lib/sandbox/runtimes/base.dockerfile"), "utf8");

  assert.match(content, /if \[ "\$\{HOST_UID\}" = "0" \]/);
  assert.match(content, /useradd -o -u \$\{HOST_UID\}/);
});

test("composeDockerfile rejects unknown runtimes", async () => {
  const sandboxDockerfile = await loadFreshEsm<typeof import("../../../lib/sandbox/dockerfile.ts")>("lib/sandbox/dockerfile.js");

  assert.throws(() => sandboxDockerfile.composeDockerfile({
    repoRoot: process.cwd(),
    project: "demo",
    runtimes: ["ruby3"],
    dockerfile: null
  }), /Unknown runtime: ruby3/);
});
