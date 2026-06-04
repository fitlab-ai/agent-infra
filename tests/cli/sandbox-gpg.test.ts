import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertModeBits,
  gitSafeEnv,
  loadFreshEsm,
  withGitSafeProcessEnv
} from "../helpers.ts";

type CommandOptions = Record<string, unknown> & {
  env?: NodeJS.ProcessEnv;
  input?: Buffer | string;
  encoding?: BufferEncoding;
  stdio?: unknown;
};
type CommandCall = [cmd: string, args: string[], options?: CommandOptions];
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

function required<T>(value: T | undefined, message = "expected value"): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

test("syncGpgKeys returns false when the host has no public keys to import", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-no-public-"));
  const calls: CommandCall[] = [];

  try {
    const synced = sandboxCreate.syncGpgKeys("demo-container", tmpDir, "demo", (cmd: string, args: string[], options: CommandOptions = {}) => {
      calls.push([cmd, args, options]);
      if (cmd === "git") {
        return "";
      }
      if (cmd === "gpg" && args[0] === "--export") {
        return Buffer.alloc(0);
      }
      throw new Error("unexpected call");
    }, () => {
      throw new Error("runSafe should not be called");
    });

    assert.equal(synced, false);
    assert.equal(calls.length, 2);
    const gitCall = required(calls[0]);
    const gpgCall = required(calls[1]);
    assert.equal(gitCall[0], "git");
    assert.deepEqual(gitCall[1], ["config", "--global", "user.signingKey"]);
    assert.equal(gitCall[2]?.env?.HOME, tmpDir);
    assert.equal(gpgCall[0], "gpg");
    assert.deepEqual(gpgCall[1], ["--export"]);
    assert.equal(gpgCall[2]?.env?.HOME, tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("currentKeyringFingerprint hashes the current secret keyring", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const output = "sec:u:255:22:ABCDEF1234567890:1700000000:0::::::23::0:\n";

  const fingerprint = sandboxCreate.currentKeyringFingerprint("/Users/demo", (cmd: string, args: string[], options: CommandOptions = {}) => {
    assert.equal(cmd, "gpg");
    assert.deepEqual(args, ["--list-secret-keys", "--with-colons"]);
    assert.equal(options.encoding, "utf8");
    assert.equal(options.env?.HOME, "/Users/demo");
    return output;
  });

  assert.equal(fingerprint, createHash("sha256").update(output).digest("hex"));
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
});

test("currentKeyringFingerprint returns null when gpg listing fails", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");

  const fingerprint = sandboxCreate.currentKeyringFingerprint("/Users/demo", () => {
    throw new Error("gpg failed");
  });

  assert.equal(fingerprint, null);
});

test("currentKeyringFingerprint returns null for an empty keyring listing", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");

  const fingerprint = sandboxCreate.currentKeyringFingerprint("/Users/demo", () => "   \n");

  assert.equal(fingerprint, null);
});

test("getGitSigningKey returns the configured signing key", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");

  const signingKey = sandboxCreate.getGitSigningKey({
    home: "/Users/demo",
    execFn(cmd: string, args: string[], options: CommandOptions = {}) {
      assert.equal(cmd, "git");
      assert.deepEqual(args, ["config", "--global", "user.signingKey"]);
      assert.equal(options.encoding, "utf8");
      assert.equal(options.env?.HOME, "/Users/demo");
      return "8246B1E31A62A1D6\n";
    }
  });

  assert.equal(signingKey, "8246B1E31A62A1D6");
});

test("getGitSigningKey reads repo-local signingKey when a worktree path is provided", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-signing-key-local-"));
  const repoDir = path.join(tmpDir, "repo");
  const homeDir = path.join(tmpDir, "home");

  try {
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    execSync("git init", { cwd: repoDir, env: gitSafeEnv(), stdio: "pipe" });
    execSync("git config user.signingKey LOCAL-KEY-123", {
      cwd: repoDir,
      env: gitSafeEnv(),
      stdio: "pipe"
    });

    const signingKey = withGitSafeProcessEnv(() => (
      sandboxCreate.getGitSigningKey({ repoPath: repoDir, home: homeDir })
    ));

    assert.equal(signingKey, "LOCAL-KEY-123");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("getGitSigningKey returns null when git config lookup fails", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");

  const signingKey = sandboxCreate.getGitSigningKey({
    home: "/Users/demo",
    execFn() {
      throw new Error("git config failed");
    }
  });

  assert.equal(signingKey, null);
});

test("getGitSigningKey returns null for empty output", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");

  const signingKey = sandboxCreate.getGitSigningKey({
    home: "/Users/demo",
    execFn: () => "   \n"
  });

  assert.equal(signingKey, null);
});

test("readGpgCache returns null when the cache does not exist", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-cache-missing-"));

  try {
    const cache = sandboxCreate.readGpgCache(tmpDir, "demo", () => {
      throw new Error("fingerprint should not be queried without state");
    });

    assert.equal(cache, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("readGpgCache returns null when the cache is missing state metadata", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-cache-missing-state-"));
  const cacheDir = path.join(tmpDir, ".agent-infra", "gpg-cache", "demo");

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "public.asc"), "pub");
    fs.writeFileSync(path.join(cacheDir, "secret.asc"), "sec");

    const cache = sandboxCreate.readGpgCache(tmpDir, "demo", () => {
      throw new Error("fingerprint should not be queried without state");
    });

    assert.equal(cache, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("readGpgCache returns cached key material when the keyring fingerprint matches", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-cache-hit-"));
  const cacheDir = path.join(tmpDir, ".agent-infra", "gpg-cache", "demo");
  const listing = "sec:u:255:22:ABCDEF1234567890:1700000000:0::::::23::0:\n";
  const fingerprint = createHash("sha256").update(listing).digest("hex");

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "public.asc"), "pub");
    fs.writeFileSync(path.join(cacheDir, "secret.asc"), "sec");
    fs.writeFileSync(path.join(cacheDir, "state.json"), `${JSON.stringify({ fingerprint })}\n`, "utf8");

    const cache = sandboxCreate.readGpgCache(tmpDir, "demo", (cmd: string, args: string[]) => {
      assert.equal(cmd, "gpg");
      assert.deepEqual(args, ["--list-secret-keys", "--with-colons"]);
      return listing;
    });

    assert.deepEqual(cache, {
      pub: Buffer.from("pub"),
      sec: Buffer.from("sec")
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("readGpgCache returns null when the keyring fingerprint changed", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-cache-stale-"));
  const cacheDir = path.join(tmpDir, ".agent-infra", "gpg-cache", "demo");

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "public.asc"), "pub");
    fs.writeFileSync(path.join(cacheDir, "secret.asc"), "sec");
    fs.writeFileSync(path.join(cacheDir, "state.json"), `${JSON.stringify({ fingerprint: "stale" })}\n`, "utf8");

    const cache = sandboxCreate.readGpgCache(tmpDir, "demo", () => "sec:u:255:22:NEW:1700000000:0::::::23::0:\n");

    assert.equal(cache, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("readGpgCache returns null when the cached signingKey no longer matches", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-cache-signing-key-stale-"));
  const cacheDir = path.join(tmpDir, ".agent-infra", "gpg-cache", "demo");
  const listing = "sec:u:255:22:ABCDEF1234567890:1700000000:0::::::23::0:\n";
  const fingerprint = createHash("sha256").update(listing).digest("hex");

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "public.asc"), "pub");
    fs.writeFileSync(path.join(cacheDir, "secret.asc"), "sec");
    fs.writeFileSync(
      path.join(cacheDir, "state.json"),
      `${JSON.stringify({ fingerprint, signingKey: "OLD-KEY" })}\n`,
      "utf8"
    );

    const cache = sandboxCreate.readGpgCache(tmpDir, "demo", () => listing, "NEW-KEY");

    assert.equal(cache, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("writeGpgCache creates cache files with secure permissions", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-cache-write-"));
  const cacheDir = path.join(tmpDir, ".agent-infra", "gpg-cache", "demo");

  try {
    const written = sandboxCreate.writeGpgCache(
      tmpDir,
      "demo",
      Buffer.from("pub"),
      Buffer.from("sec"),
      "fingerprint-1"
    );

    assert.equal(written, true);
    assertModeBits(cacheDir, 0o700);
    assertModeBits(path.join(cacheDir, "public.asc"), 0o600);
    assertModeBits(path.join(cacheDir, "secret.asc"), 0o600);
    assertModeBits(path.join(cacheDir, "state.json"), 0o600);
    assert.equal(fs.readFileSync(path.join(cacheDir, "state.json"), "utf8"), '{\n  "fingerprint": "fingerprint-1"\n}\n');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("writeGpgCache stores the signingKey used to build the cache", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-cache-write-signing-key-"));
  const cacheDir = path.join(tmpDir, ".agent-infra", "gpg-cache", "demo");

  try {
    const written = sandboxCreate.writeGpgCache(
      tmpDir,
      "demo",
      Buffer.from("pub"),
      Buffer.from("sec"),
      "fingerprint-1",
      "KEY-123"
    );

    assert.equal(written, true);
    assert.equal(
      fs.readFileSync(path.join(cacheDir, "state.json"), "utf8"),
      '{\n  "fingerprint": "fingerprint-1",\n  "signingKey": "KEY-123"\n}\n'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncGpgKeys reuses a caller-provided cache without re-reading from disk or git config", async () => {
  // Regression guard for the latest create() path: once the caller has already
  // resolved the cache hit and signingKey, syncGpgKeys should import the
  // provided key material directly without spawning another `git config` or
  // `gpg --list-secret-keys` subprocess.
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const calls: CommandCall[] = [];
  const providedCache = {
    pub: Buffer.from("pub-from-caller"),
    sec: Buffer.from("sec-from-caller")
  };

  const synced = sandboxCreate.syncGpgKeys(
    "demo-container",
    "/Users/demo",
    "demo",
    (cmd: string, args: string[], options: CommandOptions = {}) => {
      calls.push([cmd, args, options]);
      if (cmd === "docker" && args.at(-1) === "--import") {
        return Buffer.from("");
      }
      throw new Error(`unexpected execFn call: ${cmd} ${args.join(" ")}`);
    },
    () => "",
    {
      cachedOverride: providedCache,
      signingKey: "KEY-123"
    }
  );

  assert.equal(synced, true);
  assert.deepEqual(calls.map(([cmd, args]) => [cmd, args]), [
    ["docker", ["exec", "-i", "demo-container", "gpg", "--import"]],
    ["docker", ["exec", "-i", "demo-container", "gpg", "--batch", "--import"]]
  ]);
  assert.deepEqual(required(calls[0])[2], {
    input: Buffer.from("pub-from-caller"),
    stdio: ["pipe", "pipe", "pipe"]
  });
  assert.deepEqual(required(calls[1])[2], {
    input: Buffer.from("sec-from-caller"),
    stdio: ["pipe", "pipe", "pipe"]
  });
});

test("syncGpgKeys invalidates cache when the effective signing key changed", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-sync-signing-key-changed-"));
  const cacheDir = path.join(tmpDir, ".agent-infra", "gpg-cache", "demo");
  const listing = "sec:u:255:22:ABCDEF1234567890:1700000000:0::::::23::0:\n";
  const fingerprint = createHash("sha256").update(listing).digest("hex");
  const calls: CommandCall[] = [];

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "public.asc"), "pub-old");
    fs.writeFileSync(path.join(cacheDir, "secret.asc"), "sec-old");
    fs.writeFileSync(
      path.join(cacheDir, "state.json"),
      `${JSON.stringify({ fingerprint, signingKey: "OLD-KEY" })}\n`,
      "utf8"
    );

    const synced = sandboxCreate.syncGpgKeys(
      "demo-container",
      tmpDir,
      "demo",
      (cmd: string, args: string[], options: CommandOptions = {}) => {
        calls.push([cmd, args, options]);
        if (cmd === "git") {
          return "NEW-KEY\n";
        }
        if (cmd === "gpg" && args[0] === "--list-secret-keys") {
          return listing;
        }
        if (cmd === "gpg" && args[0] === "--export") {
          assert.deepEqual(args, ["--export", "NEW-KEY"]);
          return Buffer.from("pub-new");
        }
        if (cmd === "gpg" && args[0] === "--export-secret-keys") {
          assert.deepEqual(args, ["--export-secret-keys", "NEW-KEY"]);
          return Buffer.from("sec-new");
        }
        if (cmd === "docker" && args.at(-1) === "--import") {
          return Buffer.from("");
        }
        throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
      },
      () => "",
      {
        repoPath: "/repo/worktrees/demo"
      }
    );

    assert.equal(synced, true);
    assert.deepEqual(calls.map(([cmd, args]) => [cmd, args]), [
      ["git", ["-C", "/repo/worktrees/demo", "config", "user.signingKey"]],
      ["gpg", ["--export", "NEW-KEY"]],
      ["gpg", ["--export-secret-keys", "NEW-KEY"]],
      ["gpg", ["--list-secret-keys", "--with-colons"]],
      ["docker", ["exec", "-i", "demo-container", "gpg", "--import"]],
      ["docker", ["exec", "-i", "demo-container", "gpg", "--batch", "--import"]]
    ]);
    assert.equal(fs.readFileSync(path.join(cacheDir, "public.asc"), "utf8"), "pub-new");
    assert.equal(fs.readFileSync(path.join(cacheDir, "secret.asc"), "utf8"), "sec-new");
    assert.equal(
      fs.readFileSync(path.join(cacheDir, "state.json"), "utf8"),
      '{\n  "fingerprint": "'
        + fingerprint
        + '",\n  "signingKey": "NEW-KEY"\n}\n'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncGpgKeys uses the cache when the keyring fingerprint matches", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-sync-cache-hit-"));
  const cacheDir = path.join(tmpDir, ".agent-infra", "gpg-cache", "demo");
  const listing = "sec:u:255:22:ABCDEF1234567890:1700000000:0::::::23::0:\n";
  const fingerprint = createHash("sha256").update(listing).digest("hex");
  const calls: CommandCall[] = [];
  const runSafeCalls: Array<[string, string[]]> = [];

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "public.asc"), "pub");
    fs.writeFileSync(path.join(cacheDir, "secret.asc"), "sec");
    fs.writeFileSync(path.join(cacheDir, "state.json"), `${JSON.stringify({ fingerprint })}\n`, "utf8");

    const synced = sandboxCreate.syncGpgKeys("demo-container", tmpDir, "demo", (cmd: string, args: string[], options: CommandOptions = {}) => {
      calls.push([cmd, args, options]);
      if (cmd === "gpg") {
        assert.deepEqual(args, ["--list-secret-keys", "--with-colons"]);
        return listing;
      }
      if (cmd === "docker" && args.at(-1) === "--import") {
        return Buffer.from("");
      }
      throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
    }, (cmd: string, args: string[]) => {
      runSafeCalls.push([cmd, args]);
      return "";
    });

    assert.equal(synced, true);
    assert.deepEqual(calls.map(([cmd, args]) => [cmd, args]), [
      ["git", ["config", "--global", "user.signingKey"]],
      ["gpg", ["--list-secret-keys", "--with-colons"]],
      ["docker", ["exec", "-i", "demo-container", "gpg", "--import"]],
      ["docker", ["exec", "-i", "demo-container", "gpg", "--batch", "--import"]]
    ]);
    assert.equal(required(calls[0])[2]?.env?.HOME, tmpDir);
    assert.equal(required(calls[0])[2]?.encoding, "utf8");
    assert.deepEqual(required(calls[2])[2], {
      input: Buffer.from("pub"),
      stdio: ["pipe", "pipe", "pipe"]
    });
    assert.deepEqual(required(calls[3])[2], {
      input: Buffer.from("sec"),
      stdio: ["pipe", "pipe", "pipe"]
    });
    assert.deepEqual(runSafeCalls, [
      ["docker", ["exec", "demo-container", "gpgconf", "--launch", "gpg-agent"]]
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncGpgKeys exports host keys and writes the cache on a cache miss", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-sync-cache-miss-"));
  const calls: CommandCall[] = [];

  try {
    const synced = sandboxCreate.syncGpgKeys("demo-container", tmpDir, "demo", (cmd: string, args: string[], options: CommandOptions = {}) => {
      calls.push([cmd, args, options]);
      if (cmd === "gpg" && args[0] === "--export") {
        return Buffer.from("pub");
      }
      if (cmd === "gpg" && args[0] === "--export-secret-keys") {
        return Buffer.from("sec");
      }
      if (cmd === "git") {
        return "";
      }
      if (cmd === "gpg" && args[0] === "--list-secret-keys") {
        return "sec:u:255:22:ABCDEF1234567890:1700000000:0::::::23::0:\n";
      }
      if (cmd === "docker" && args.at(-1) === "--import") {
        return Buffer.from("");
      }
      throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
    }, () => "");

    assert.equal(synced, true);
    assert.deepEqual(calls.map(([cmd, args]) => [cmd, args]), [
      ["git", ["config", "--global", "user.signingKey"]],
      ["gpg", ["--export"]],
      ["gpg", ["--export-secret-keys"]],
      ["gpg", ["--list-secret-keys", "--with-colons"]],
      ["docker", ["exec", "-i", "demo-container", "gpg", "--import"]],
      ["docker", ["exec", "-i", "demo-container", "gpg", "--batch", "--import"]]
    ]);
    assert.equal(
      fs.readFileSync(path.join(tmpDir, ".agent-infra", "gpg-cache", "demo", "public.asc"), "utf8"),
      "pub"
    );
    assert.equal(
      fs.readFileSync(path.join(tmpDir, ".agent-infra", "gpg-cache", "demo", "secret.asc"), "utf8"),
      "sec"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncGpgKeys exports only the configured signing key on a cache miss", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-sync-signing-key-"));
  const calls: CommandCall[] = [];

  try {
    const synced = sandboxCreate.syncGpgKeys("demo-container", tmpDir, "demo", (cmd: string, args: string[], options: CommandOptions = {}) => {
      calls.push([cmd, args, options]);
      if (cmd === "git") {
        return "8246B1E31A62A1D6\n";
      }
      if (cmd === "gpg" && args[0] === "--export") {
        return Buffer.from("pub");
      }
      if (cmd === "gpg" && args[0] === "--export-secret-keys") {
        return Buffer.from("sec");
      }
      if (cmd === "gpg" && args[0] === "--list-secret-keys") {
        return "sec:u:255:22:ABCDEF1234567890:1700000000:0::::::23::0:\n";
      }
      if (cmd === "docker" && args.at(-1) === "--import") {
        return Buffer.from("");
      }
      throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
    }, () => "");

    assert.equal(synced, true);
    assert.deepEqual(calls.map(([cmd, args]) => [cmd, args]), [
      ["git", ["config", "--global", "user.signingKey"]],
      ["gpg", ["--export", "8246B1E31A62A1D6"]],
      ["gpg", ["--export-secret-keys", "8246B1E31A62A1D6"]],
      ["gpg", ["--list-secret-keys", "--with-colons"]],
      ["docker", ["exec", "-i", "demo-container", "gpg", "--import"]],
      ["docker", ["exec", "-i", "demo-container", "gpg", "--batch", "--import"]]
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncGpgKeys still succeeds when writing the cache fails", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-sync-cache-write-fails-"));
  const cacheDir = path.join(tmpDir, ".agent-infra", "gpg-cache", "demo");
  const calls: CommandCall[] = [];
  const writes: Array<string | Uint8Array> = [];
  const originalWrite = process.stderr.write;

  try {
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
    fs.writeFileSync(cacheDir, "blocking-file");
    process.stderr.write = ((...args: Parameters<typeof process.stderr.write>) => {
      writes.push(args[0]);
      return true;
    }) as typeof process.stderr.write;

    const synced = sandboxCreate.syncGpgKeys("demo-container", tmpDir, "demo", (cmd: string, args: string[], options: CommandOptions = {}) => {
      calls.push([cmd, args, options]);
      if (cmd === "git") {
        return "";
      }
      if (cmd === "gpg" && args[0] === "--list-secret-keys") {
        return "sec:u:255:22:ABCDEF1234567890:1700000000:0::::::23::0:\n";
      }
      if (cmd === "gpg" && args[0] === "--export") {
        return Buffer.from("pub");
      }
      if (cmd === "gpg" && args[0] === "--export-secret-keys") {
        return Buffer.from("sec");
      }
      if (cmd === "docker" && args.at(-1) === "--import") {
        return Buffer.from("");
      }
      throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
    }, () => "");

    assert.equal(synced, true);
    assert.deepEqual(calls.map(([cmd, args]) => [cmd, args]), [
      ["git", ["config", "--global", "user.signingKey"]],
      ["gpg", ["--export"]],
      ["gpg", ["--export-secret-keys"]],
      ["gpg", ["--list-secret-keys", "--with-colons"]],
      ["docker", ["exec", "-i", "demo-container", "gpg", "--import"]],
      ["docker", ["exec", "-i", "demo-container", "gpg", "--batch", "--import"]]
    ]);
    assert.deepEqual(writes, [
      "Warning: failed to cache GPG keys; next sandbox create may prompt again.\n"
    ]);
  } finally {
    process.stderr.write = originalWrite;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncGpgKeys returns false when the host has no secret keys to import", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-no-secret-"));
  const calls: CommandCall[] = [];

  try {
    const synced = sandboxCreate.syncGpgKeys("demo-container", tmpDir, "demo", (cmd: string, args: string[], options: CommandOptions = {}) => {
      calls.push([cmd, args, options]);
      if (cmd === "git") {
        return "";
      }
      if (cmd !== "gpg") {
        throw new Error("unexpected command");
      }
      if (args[0] === "--export") {
        return Buffer.from("pub");
      }
      if (args[0] === "--export-secret-keys") {
        return Buffer.alloc(0);
      }
      throw new Error("unexpected gpg args");
    }, () => {
      throw new Error("runSafe should not be called");
    });

    assert.equal(synced, false);
    assert.deepEqual(calls.map(([cmd, args]) => [cmd, args]), [
      ["git", ["config", "--global", "user.signingKey"]],
      ["gpg", ["--export"]],
      ["gpg", ["--export-secret-keys"]]
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncGpgKeys imports host public and secret keys into the container", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-import-"));
  const calls: CommandCall[] = [];
  const runSafeCalls: Array<[string, string[]]> = [];

  try {
    const synced = sandboxCreate.syncGpgKeys("demo-container", tmpDir, "demo", (cmd: string, args: string[], options: CommandOptions = {}) => {
      calls.push([cmd, args, options]);
      if (cmd === "git") {
        return "";
      }
      if (cmd === "gpg" && args[0] === "--export") {
        return Buffer.from("pub");
      }
      if (cmd === "gpg" && args[0] === "--export-secret-keys") {
        return Buffer.from("sec");
      }
      if (cmd === "gpg" && args[0] === "--list-secret-keys") {
        return "sec:u:255:22:ABCDEF1234567890:1700000000:0::::::23::0:\n";
      }
      if (cmd === "docker" && args.at(-1) === "--import") {
        return Buffer.from("");
      }
      throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
    }, (cmd: string, args: string[]) => {
      runSafeCalls.push([cmd, args]);
      return "";
    });

    assert.equal(synced, true);
    assert.deepEqual(calls.map(([cmd, args]) => [cmd, args]), [
      ["git", ["config", "--global", "user.signingKey"]],
      ["gpg", ["--export"]],
      ["gpg", ["--export-secret-keys"]],
      ["gpg", ["--list-secret-keys", "--with-colons"]],
      ["docker", ["exec", "-i", "demo-container", "gpg", "--import"]],
      ["docker", ["exec", "-i", "demo-container", "gpg", "--batch", "--import"]]
    ]);
    assert.equal(required(calls[0])[2]?.env?.HOME, tmpDir);
    assert.equal(required(calls[0])[2]?.encoding, "utf8");
    assert.equal(required(calls[1])[2]?.env?.HOME, tmpDir);
    assert.equal(required(calls[3])[2]?.env?.HOME, tmpDir);
    assert.equal(required(calls[3])[2]?.encoding, "utf8");
    assert.deepEqual(required(calls[4])[2], {
      input: Buffer.from("pub"),
      stdio: ["pipe", "pipe", "pipe"]
    });
    assert.deepEqual(required(calls[5])[2], {
      input: Buffer.from("sec"),
      stdio: ["pipe", "pipe", "pipe"]
    });
    assert.deepEqual(runSafeCalls, [
      ["docker", ["exec", "demo-container", "gpgconf", "--launch", "gpg-agent"]]
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncGpgKeys can use separate host gpg and engine docker runners", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-gpg-engine-docker-"));
  const hostCalls: Array<{ cmd: string; args: string[]; options: CommandOptions }> = [];
  const dockerExecCalls: Array<{ cmd: string; args: string[]; input: string }> = [];
  const dockerSafeCalls: Array<{ cmd: string; args: string[] }> = [];

  try {
    const synced = sandboxCreate.syncGpgKeys(
      "demo-container",
      tmpDir,
      "demo",
      (cmd: string, args: string[], options: CommandOptions = {}) => {
        hostCalls.push({ cmd, args, options });
        if (cmd === "git") {
          return "";
        }
        if (cmd === "gpg" && args[0] === "--export") {
          return Buffer.from("pub");
        }
        if (cmd === "gpg" && args[0] === "--export-secret-keys") {
          return Buffer.from("sec");
        }
        if (cmd === "gpg" && args[0] === "--list-secret-keys") {
          return "sec:u:255:22:ABCDEF1234567890:1700000000:0::::::23::0:\n";
        }
        throw new Error(`unexpected host call: ${cmd} ${args.join(" ")}`);
      },
      () => {
        throw new Error("default runSafe should not handle docker calls");
      },
      {
        dockerExecFn(cmd: string, args: string[], options: CommandOptions = {}) {
          dockerExecCalls.push({ cmd, args, input: String(options.input ?? "") });
        },
        dockerRunSafeFn(cmd: string, args: string[]) {
          dockerSafeCalls.push({ cmd, args });
          return "";
        }
      }
    );

    assert.equal(synced, true);
    assert.deepEqual(hostCalls.map((call) => call.cmd), ["git", "gpg", "gpg", "gpg"]);
    assert.deepEqual(dockerExecCalls, [
      { cmd: "docker", args: ["exec", "-i", "demo-container", "gpg", "--import"], input: "pub" },
      { cmd: "docker", args: ["exec", "-i", "demo-container", "gpg", "--batch", "--import"], input: "sec" }
    ]);
    assert.deepEqual(dockerSafeCalls, [
      { cmd: "docker", args: ["exec", "demo-container", "gpgconf", "--launch", "gpg-agent"] }
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
