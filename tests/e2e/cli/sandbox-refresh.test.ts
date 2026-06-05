import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadFreshEsm } from "../../helpers.ts";

type ProbeResult = {
  status: number | null;
  stderr?: string | Buffer;
  error?: Error;
};
type RefreshDeps = {
  discoverFn?: (home: string) => string[];
  execFn?: (cmd: string, args: string[], options?: Record<string, unknown>) => string | Buffer | void;
  spawnFn?: (cmd: string, args: string[], options?: Record<string, unknown>) => ProbeResult;
  readFn?: (targetPath: string) => string;
  existsFn?: (targetPath: string) => boolean;
  writeFn?: (home: string, project: string, blob: string) => void;
  writeHostFn?: (home: string, blob: string, options?: Record<string, unknown>) => { ok: true } | { ok: false; classification?: string; error: string };
  writeStdout?: (chunk: string) => unknown;
  writeStderr?: (chunk: string) => unknown;
};
type RefreshModule = {
  probeClaudeStatus(spawnFn?: NonNullable<RefreshDeps["spawnFn"]>): { ok: boolean; stderr: string; error: string | null };
  refresh(args: string[], deps?: RefreshDeps): Promise<number>;
};
type ShellModule = {
  runProbe(cmd: string, args: string[], opts?: { spawnFn?: NonNullable<RefreshDeps["spawnFn"]> } & Record<string, unknown>): ProbeResult;
};

function withHome<T>(home: string | undefined, fn: () => T): T {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  if (home === undefined) {
    delete process.env.HOME;
    if (process.platform === 'win32') {
      delete process.env.USERPROFILE;
    }
  } else {
    process.env.HOME = home;
    if (process.platform === 'win32') {
      process.env.USERPROFILE = home;
    }
  }
  try {
    return fn();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (process.platform === 'win32') {
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
    }
  }
}

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  try {
    return fn();
  } finally {
    if (descriptor) {
      Object.defineProperty(process, "platform", descriptor);
    }
  }
}

// Force a fresh empty HOME on a chosen platform so refresh tests never read the
// developer's real ~/.agent-infra state. tmpDir is removed after fn resolves, so
// any filesystem assertion that depends on it must run inside the callback.
async function withTempHomeOn<T>(platform: NodeJS.Platform, fn: (home: string) => T | Promise<T>): Promise<T> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-refresh-"));
  try {
    return await withHome(tmpDir, () => withPlatform(platform, () => fn(tmpDir)));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function validBlob(expiresAt: number = Date.now() + 3_600_000) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: "token",
      refreshToken: "refresh-token",
      scopes: ["user:profile", "user:sessions:claude_code"],
      expiresAt
    }
  });
}

test("probeClaudeStatus maps claude status process results", async () => {
  const { probeClaudeStatus } = await loadFreshEsm<RefreshModule>("lib/sandbox/commands/refresh.js");

  assert.deepEqual(probeClaudeStatus((cmd, args, options = {}) => {
    assert.equal(cmd, "claude");
    assert.deepEqual(args, ["/status"]);
    assert.equal(options.timeout, 30_000);
    return { status: 0, stderr: "" };
  }), { ok: true, stderr: "", error: null });

  assert.deepEqual(probeClaudeStatus(() => ({
    status: 1,
    stderr: "auth failed",
    error: new Error("failed")
  })), { ok: false, stderr: "auth failed", error: "failed" });
});

test("runProbe resolves Windows command shims through the shell wrapper", async () => {
  const { runProbe } = await loadFreshEsm<ShellModule>("lib/sandbox/shell.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-refresh-win32-"));
  const claudePath = path.join(tmpDir, "claude.cmd");
  const previousPath = process.env.PATH;
  const previousPathext = process.env.PATHEXT;

  try {
    fs.writeFileSync(claudePath, "#!/bin/sh\nexit 0\n", "utf8");
    fs.chmodSync(claudePath, 0o755);
    process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ""}`;
    process.env.PATHEXT = ".CMD";

    withPlatform("win32", () => {
      const result = runProbe("claude", ["/status"], {
        spawnFn: (cmd: string, args: string[], options?: Record<string, unknown>) => {
          assert.equal(cmd, claudePath);
          assert.deepEqual(args, ["/status"]);
          assert.equal(options?.shell, true);
          return { status: 0, stderr: "" };
        }
      });
      assert.deepEqual(result, { status: 0, stderr: "" });
    });
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    if (previousPathext === undefined) {
      delete process.env.PATHEXT;
    } else {
      process.env.PATHEXT = previousPathext;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("refresh batch mode lists discovered projects and syncs each one", async () => {
  const { refresh } = await loadFreshEsm<RefreshModule>("lib/sandbox/commands/refresh.js");
  const stdout: string[] = [];

  await withTempHomeOn("darwin", async (home) => {
    const code = await refresh([], {
      discoverFn: () => ["alpha", "beta"],
      execFn: () => validBlob(Date.now() + 3_600_000),
      writeStdout: (chunk) => stdout.push(chunk),
      writeStderr: () => {}
    });

    assert.equal(code, 0);
    assert.equal(stdout.filter((line) => line.startsWith("[")).length, 2);
    assert.ok(fs.existsSync(path.join(home, ".agent-infra", "credentials", "alpha", "claude-code", ".credentials.json")));
    assert.ok(fs.existsSync(path.join(home, ".agent-infra", "credentials", "beta", "claude-code", ".credentials.json")));
  });
});

test("refresh batch mode writes nothing when no projects exist", async () => {
  const { refresh } = await loadFreshEsm<RefreshModule>("lib/sandbox/commands/refresh.js");
  const stdout: string[] = [];

  const code = await refresh([], {
    discoverFn: () => [],
    writeStdout: (chunk) => stdout.push(chunk)
  });

  assert.equal(code, 0);
  assert.equal(stdout.join(""), "No project credentials to refresh.\n");
});

test("refresh prints usage for help flags", async () => {
  const { refresh } = await loadFreshEsm<RefreshModule>("lib/sandbox/commands/refresh.js");
  const stdout: string[] = [];

  assert.equal(await refresh(["--help"], {
    writeStdout: (chunk) => stdout.push(chunk)
  }), 0);
  assert.equal(stdout.join(""), "Usage: ai sandbox refresh\n");
});

test("refresh uses the system home directory in batch mode", async () => {
  const { refresh } = await loadFreshEsm<RefreshModule>("lib/sandbox/commands/refresh.js");
  let seenHome = "";

  const code = await withHome(undefined, () => refresh([], {
    discoverFn: (home) => {
      seenHome = home;
      return [];
    },
    writeStdout: () => {}
  }));

  assert.equal(code, 0);
  assert.equal(typeof seenHome, "string");
  assert.ok(seenHome.length > 0);
});

test("refresh rejects positional arguments", async () => {
  const { refresh } = await loadFreshEsm<RefreshModule>("lib/sandbox/commands/refresh.js");

  await assert.rejects(
    withHome(os.tmpdir(), () => refresh(["unexpected-arg"], {
      writeStdout: () => {},
      writeStderr: () => {}
    })),
    /Usage: ai sandbox refresh/
  );
});

test("refresh exits 1 with login prompt when host credentials are missing", async () => {
  const { refresh } = await loadFreshEsm<RefreshModule>("lib/sandbox/commands/refresh.js");
  const stderr: string[] = [];

  const code = await withTempHomeOn("darwin", () => refresh([], {
    discoverFn: () => ["agent-infra"],
    execFn: () => {
      throw Object.assign(new Error("missing"), {
        stderr: Buffer.from("security: SecKeychainSearchCopyNext: The specified item could not be found.")
      });
    },
    writeStdout: () => {},
    writeStderr: (chunk) => stderr.push(chunk)
  }));

  assert.equal(code, 1);
  assert.match(stderr.join(""), /claude \/login/);
});

test("refresh exits 1 when probe fails after stale host credentials", async () => {
  const { refresh } = await loadFreshEsm<RefreshModule>("lib/sandbox/commands/refresh.js");
  const stderr: string[] = [];

  const code = await withTempHomeOn("darwin", () => refresh([], {
    discoverFn: () => ["agent-infra"],
    execFn: () => "not-json",
    spawnFn: () => ({ status: 1, stderr: "stale" }),
    writeStdout: () => {},
    writeStderr: (chunk) => stderr.push(chunk)
  }));

  assert.equal(code, 1);
  assert.match(stderr.join(""), /claude \/login/);
});

test("refresh redacts tokens from failed probe stderr", async () => {
  const { refresh } = await loadFreshEsm<RefreshModule>("lib/sandbox/commands/refresh.js");
  const stderr: string[] = [];

  const code = await withTempHomeOn("darwin", () => refresh([], {
    discoverFn: () => ["agent-infra"],
    execFn: () => "not-json",
    spawnFn: () => ({
      status: 1,
      stderr: "Authentication failed: ghp_123456789012345678901234567890123456"
    }),
    writeStdout: () => {},
    writeStderr: (chunk) => stderr.push(chunk)
  }));

  assert.equal(code, 1);
  assert.match(stderr.join(""), /\[REDACTED github token\]/);
  assert.doesNotMatch(stderr.join(""), /ghp_123456789012345678901234567890123456/);
});

test("refresh succeeds after stale host credentials when probe restores valid credentials", async () => {
  const { refresh } = await loadFreshEsm<RefreshModule>("lib/sandbox/commands/refresh.js");
  let inspected = 0;

  const code = await withTempHomeOn("darwin", () => refresh([], {
    discoverFn: () => ["agent-infra"],
    execFn: () => {
      inspected += 1;
      return inspected === 1 ? "not-json" : validBlob();
    },
    spawnFn: () => ({ status: 0, stderr: "" }),
    writeStdout: () => {},
    writeStderr: () => {}
  }));

  assert.equal(code, 0);
  assert.equal(inspected, 2);
});

test("refresh reports unchanged status when destination matches blob", async () => {
  const { refresh } = await loadFreshEsm<RefreshModule>("lib/sandbox/commands/refresh.js");
  const blob = validBlob();
  const stdout: string[] = [];

  await withTempHomeOn("darwin", async (home) => {
    const targetDir = path.join(home, ".agent-infra", "credentials", "agent-infra", "claude-code");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, ".credentials.json"), blob, "utf8");
    const code = await refresh([], {
      discoverFn: () => ["agent-infra"],
      execFn: () => blob,
      writeStdout: (chunk) => stdout.push(chunk),
      writeStderr: () => {}
    });

    assert.equal(code, 0);
    assert.match(stdout.join(""), /\[agent-infra\] unchanged;/);
  });
});

test("refresh reconciles from a newer project file without probing claude status", async () => {
  const { refresh } = await loadFreshEsm<RefreshModule>("lib/sandbox/commands/refresh.js");
  const hostBlob = validBlob(100);
  const fileBlob = validBlob(200);
  const stdout: string[] = [];
  let probeCalled = false;

  await withTempHomeOn("linux", async (home) => {
    const hostPath = path.join(home, ".claude", ".credentials.json");
    const filePath = path.join(home, ".agent-infra", "credentials", "agent-infra", "claude-code", ".credentials.json");
    fs.mkdirSync(path.dirname(hostPath), { recursive: true });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(hostPath, hostBlob, "utf8");
    fs.writeFileSync(filePath, fileBlob, "utf8");

    const code = await refresh([], {
      discoverFn: () => ["agent-infra"],
      spawnFn: () => {
        probeCalled = true;
        return { status: 0, stderr: "" };
      },
      writeStdout: (chunk) => stdout.push(chunk),
      writeStderr: () => {}
    });

    assert.equal(code, 0);
    assert.equal(probeCalled, false);
    assert.match(stdout.join(""), /\[host\] reconciled from file:agent-infra/);
    assert.match(stdout.join(""), /\[agent-infra\] unchanged;/);
    assert.equal(fs.readFileSync(hostPath, "utf8"), fileBlob);
  });
});

test("refresh exits 1 when newer sandbox credentials cannot be written to host", async () => {
  const { refresh } = await loadFreshEsm<RefreshModule>("lib/sandbox/commands/refresh.js");
  const stderr: string[] = [];

  const code = await withTempHomeOn("darwin", () => refresh([], {
    discoverFn: () => ["agent-infra"],
    execFn: () => {
      throw Object.assign(new Error("missing"), {
        stderr: Buffer.from("security: SecKeychainSearchCopyNext: The specified item could not be found.")
      });
    },
    readFn: () => validBlob(200),
    existsFn: () => true,
    writeHostFn: () => ({ ok: false, error: "keychain locked" }),
    writeStdout: () => {},
    writeStderr: (chunk) => stderr.push(chunk)
  }));

  assert.equal(code, 1);
  assert.match(stderr.join(""), /keychain write failed: keychain locked/);
});

test("refresh emits keychain guidance when host keychain is locked", async () => {
  const { refresh } = await loadFreshEsm<RefreshModule>("lib/sandbox/commands/refresh.js");
  const stderr: string[] = [];

  const code = await withTempHomeOn("darwin", () => refresh([], {
    discoverFn: () => ["agent-infra"],
    execFn: () => {
      const error = new Error(
        'Command failed: security find-generic-password {"claudeAiOauth":{"accessToken":"sk-ant-oat01-123456789012345678901234567890"}}'
      ) as Error & { stderr?: Buffer };
      error.stderr = Buffer.from("security: errSecInteractionNotAllowed: User interaction is not allowed.");
      throw error;
    },
    writeStdout: () => {},
    writeStderr: (chunk) => stderr.push(chunk)
  }));

  assert.equal(code, 1);
  assert.match(stderr.join(""), /security unlock-keychain/);
  assert.match(stderr.join(""), /AGENT_INFRA_CLAUDE_CREDENTIALS_FILE/);
  assert.doesNotMatch(stderr.join(""), /sk-ant-oat01/);
  assert.doesNotMatch(stderr.join(""), /claudeAiOauth/);
});

test("refresh emits keychain error detail and guidance for non-locked failures", async () => {
  const { refresh } = await loadFreshEsm<RefreshModule>("lib/sandbox/commands/refresh.js");
  const stderr: string[] = [];

  const code = await withTempHomeOn("darwin", () => refresh([], {
    discoverFn: () => ["agent-infra"],
    execFn: () => {
      const error = new Error(
        'Command failed: security find-generic-password {"claudeAiOauth":{"accessToken":"sk-ant-oat01-123456789012345678901234567890"}}'
      ) as Error & { stderr?: Buffer };
      error.stderr = Buffer.from("security: errSecAuthFailed: Authorization failed.");
      throw error;
    },
    writeStdout: () => {},
    writeStderr: (chunk) => stderr.push(chunk)
  }));

  assert.equal(code, 1);
  assert.match(stderr.join(""), /Host keychain error: security: errSecAuthFailed/);
  assert.match(stderr.join(""), /security unlock-keychain/);
  assert.match(stderr.join(""), /AGENT_INFRA_CLAUDE_CREDENTIALS_FILE/);
  assert.doesNotMatch(stderr.join(""), /sk-ant-oat01/);
  assert.doesNotMatch(stderr.join(""), /claudeAiOauth/);
  assert.doesNotMatch(stderr.join(""), /Command failed/);
});

test("refresh uses env override credentials without touching keychain", async () => {
  const { refresh } = await loadFreshEsm<RefreshModule>("lib/sandbox/commands/refresh.js");
  const previousOverride = process.env.AGENT_INFRA_CLAUDE_CREDENTIALS_FILE;

  try {
    await withTempHomeOn("darwin", async (home) => {
      const overridePath = path.join(home, "credentials.json");
      const targetDir = path.join(home, ".agent-infra", "credentials", "agent-infra", "claude-code");
      fs.writeFileSync(overridePath, validBlob(), "utf8");
      fs.mkdirSync(targetDir, { recursive: true });
      process.env.AGENT_INFRA_CLAUDE_CREDENTIALS_FILE = overridePath;

      const code = await refresh([], {
        discoverFn: () => ["agent-infra"],
        execFn: () => {
          assert.fail("security should not be called when env override is set");
        },
        writeStdout: () => {},
        writeStderr: () => {}
      });

      assert.equal(code, 0);
      assert.ok(fs.existsSync(path.join(targetDir, ".credentials.json")));
    });
  } finally {
    if (previousOverride === undefined) {
      delete process.env.AGENT_INFRA_CLAUDE_CREDENTIALS_FILE;
    } else {
      process.env.AGENT_INFRA_CLAUDE_CREDENTIALS_FILE = previousOverride;
    }
  }
});

test("refresh continues on per-project sync failure and exits 1 at end", async () => {
  const { refresh } = await loadFreshEsm<RefreshModule>("lib/sandbox/commands/refresh.js");
  const stderr: string[] = [];

  await withTempHomeOn("darwin", async (home) => {
    fs.writeFileSync(path.join(home, ".agent-infra"), "x", "utf8");
    const code = await refresh([], {
      discoverFn: () => ["agent-infra"],
      execFn: () => validBlob(),
      writeStdout: () => {},
      writeStderr: (chunk) => stderr.push(chunk)
    });

    assert.equal(code, 1);
    assert.match(stderr.join(""), /\[agent-infra\] sync failed:/);
  });
});
