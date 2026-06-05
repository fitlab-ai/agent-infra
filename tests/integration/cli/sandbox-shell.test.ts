import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadFreshEsm,
  onPlatforms
} from "../../helpers.ts";
import { restoreTerminal, runInteractive, runVerbose } from "../../../lib/sandbox/shell.ts";

type WriteCallback = (error?: Error | null) => void;
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
type EnterModule = {
  terminalEnvFlags(env?: NodeJS.ProcessEnv): string[];
  formatCredentialSyncStatus(result: { status: string }): string;
};

function withTTY<T>(value: boolean, fn: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

  try {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
    return fn();
  } finally {
    if (descriptor) {
      Object.defineProperty(process.stdout, "isTTY", descriptor);
    } else {
      delete (process.stdout as Partial<typeof process.stdout>).isTTY;
    }
  }
}

function captureStdoutWrite(fn: () => void): string {
  const originalWrite = process.stdout.write;
  let output = "";

  try {
    process.stdout.write = ((chunk: string | Uint8Array, ...args: Array<string | BufferEncoding | WriteCallback>) => {
      output += String(chunk);
      const callback = args.find((arg): arg is WriteCallback => typeof arg === "function");
      callback?.();
      return true;
    }) as typeof process.stdout.write;
    fn();
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
}

function withFakeStty<T>(exitCode: number, fn: () => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-fake-stty-"));
  const sttyPath = path.join(tmpDir, "stty");
  const previousPath = process.env.PATH;

  try {
    fs.writeFileSync(
      sttyPath,
      `#!/bin/sh\nexit ${exitCode}\n`,
      "utf8"
    );
    fs.chmodSync(sttyPath, 0o755);
    process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ""}`;
    return fn();
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function assertError(error: unknown): Error {
  assert.ok(error instanceof Error);
  return error;
}

test("runInteractive emits terminal reset on normal exit", () => {
  const output = withFakeStty(0, () => withTTY(true, () => captureStdoutWrite(() => {
    const status = runInteractive(process.execPath, ["-e", "process.exit(0)"]);

    assert.equal(status, 0);
  })));

  assert.match(output, /\x1b\[\?1049l/);
  assert.match(output, /\x1b\[\?25h/);
  assert.match(output, /\x1b>/);
  assert.match(output, /\x1b\[\?1006l/);
});

test("runInteractive emits terminal reset on non-zero exit", () => {
  const output = withFakeStty(0, () => withTTY(true, () => captureStdoutWrite(() => {
    const status = runInteractive(process.execPath, ["-e", "process.exit(7)"]);

    assert.equal(status, 7);
  })));

  assert.match(output, /\x1b\[\?1049l/);
});

test("runInteractive emits terminal reset when spawn fails", () => {
  const output = withFakeStty(0, () => withTTY(true, () => captureStdoutWrite(() => {
    const status = runInteractive("agent-infra-missing-command", []);

    assert.notEqual(status, 0);
    assert.equal(status, 1);
  })));

  assert.match(output, /\x1b\[\?1049l/);
});

test("restoreTerminal is a no-op when stdout is not a TTY", () => {
  const output = withTTY(false, () => captureStdoutWrite(() => {
    restoreTerminal();
  }));

  assert.equal(output, "");
});

test("restoreTerminal does not throw when stty is unavailable", onPlatforms("linux", "darwin"), () => {
  const output = withFakeStty(1, () => withTTY(true, () => captureStdoutWrite(() => {
    assert.doesNotThrow(() => restoreTerminal());
  })));

  assert.match(output, /\x1b\[\?1049l/);
});

test("terminalEnvFlags forwards iTerm2 detection variables for Shift+Enter support", async () => {
  const sandboxEnter = await loadFreshEsm<EnterModule>("lib/sandbox/commands/enter.js");

  const flags = sandboxEnter.terminalEnvFlags({
    TERM_PROGRAM: "iTerm.app",
    TERM_PROGRAM_VERSION: "3.6.9",
    LC_TERMINAL: "iTerm2",
    LC_TERMINAL_VERSION: "3.6.9",
    UNRELATED: "ignored"
  });

  assert.deepEqual(flags, [
    "-e", "TERM_PROGRAM=iTerm.app",
    "-e", "TERM_PROGRAM_VERSION=3.6.9",
    "-e", "LC_TERMINAL=iTerm2",
    "-e", "LC_TERMINAL_VERSION=3.6.9"
  ]);
});

test("terminalEnvFlags omits unset variables instead of forwarding empty values", async () => {
  const sandboxEnter = await loadFreshEsm<EnterModule>("lib/sandbox/commands/enter.js");

  const flags = sandboxEnter.terminalEnvFlags({
    TERM_PROGRAM: "iTerm.app",
    TERM_PROGRAM_VERSION: "",
    LC_TERMINAL: undefined
  });

  assert.deepEqual(flags, ["-e", "TERM_PROGRAM=iTerm.app"]);
});

test("commandErrorMessage prefers stderr over the generic execFileSync message", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");

  const message = sandboxCreate.commandErrorMessage({
    message: "Command failed: git worktree add ...",
    stderr: Buffer.from("fatal: invalid reference: missing-branch\n")
  });

  assert.equal(message, "fatal: invalid reference: missing-branch");
});

test("commandErrorMessage redacts tokens from fallback error messages", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");

  const message = sandboxCreate.commandErrorMessage({
    message: "Command failed: docker run -e GH_TOKEN=ghp_123456789012345678901234567890123456"
  });

  assert.doesNotMatch(message, /ghp_123456789012345678901234567890123456/);
  assert.match(message, /\[REDACTED github token\]/);
});

test("runVerbose error messages do not include argv", () => {
  assert.throws(
    () => runVerbose(process.execPath, ["-e", "process.exit(1)", "SECRET_ARG_VALUE"]),
    (error) => {
      const thrown = assertError(error);
      assert.match(thrown.message, /^Command failed with exit code 1:/);
      assert.doesNotMatch(thrown.message, /SECRET_ARG_VALUE/);
      return true;
    }
  );
});

test("runVerbose timeout messages do not include argv", () => {
  assert.throws(
    () => runVerbose(process.execPath, ["-e", "setTimeout(() => {}, 10_000)", "SECRET_TIMEOUT_VALUE"], {
      timeout: 1
    }),
    (error) => {
      const thrown = assertError(error);
      assert.match(thrown.message, /^Command timed out after 1ms:/);
      assert.doesNotMatch(thrown.message, /SECRET_TIMEOUT_VALUE/);
      return true;
    }
  );
});

test("runSafe forwards stderr on non-zero exit while preserving stdout return", async () => {
  const { runSafe } = await loadFreshEsm<typeof import("../../../lib/sandbox/shell.ts")>("lib/sandbox/shell.js");
  const originalWrite = process.stderr.write;
  const writes: Array<string | Uint8Array> = [];

  try {
    process.stderr.write = ((...args: Parameters<typeof process.stderr.write>) => {
      writes.push(args[0]);
      return true;
    }) as typeof process.stderr.write;

    const output = runSafe(process.execPath, [
      "-e",
      "process.stdout.write(' out '); process.stderr.write('boom'); process.exit(1)"
    ]);

    assert.equal(output, "out");
    assert.deepEqual(writes, ["boom"]);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("runSafe does not forward stderr on zero exit", async () => {
  const { runSafe } = await loadFreshEsm<typeof import("../../../lib/sandbox/shell.ts")>("lib/sandbox/shell.js");
  const originalWrite = process.stderr.write;
  const writes: Array<string | Uint8Array> = [];

  try {
    process.stderr.write = ((...args: Parameters<typeof process.stderr.write>) => {
      writes.push(args[0]);
      return true;
    }) as typeof process.stderr.write;

    const output = runSafe(process.execPath, [
      "-e",
      "process.stderr.write('noise'); process.exit(0)"
    ]);

    assert.equal(output, "");
    assert.deepEqual(writes, []);
  } finally {
    process.stderr.write = originalWrite;
  }
});
