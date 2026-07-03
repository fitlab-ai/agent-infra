import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertModeBits, loadFreshEsm } from "../../helpers.ts";

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

function validBlob(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: "token",
      refreshToken: "refresh-token",
      scopes: ["user:profile", "user:sessions:claude_code"],
      expiresAt: Date.now() + 7_200_000,
      ...overrides
    }
  }, null, 2);
}

function taintedSecurityError(stderr: string = "") {
  const error = new Error(
    'Command failed: security add-generic-password -w {"claudeAiOauth":{"accessToken":"sk-ant-oat01-123456789012345678901234567890","refreshToken":"sk-ant-ort01-123456789012345678901234567890"}}'
  ) as Error & { stderr?: Buffer };
  error.stderr = Buffer.from(stderr);
  return error;
}

test("redactCommandError strips credential-shaped tokens", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");

  const redacted = credentials.redactCommandError([
    'oauth={"claudeAiOauth":{"accessToken":"sk-ant-oat01-123456789012345678901234567890"}}',
    "github=ghp_123456789012345678901234567890123456",
    "installation=ghs_123456789012345678901234567890123456",
    "header=Bearer abcdefghijklmnopqrstuvwxyz1234567890"
  ].join("\n"));

  assert.doesNotMatch(redacted, /sk-ant-oat01/);
  assert.doesNotMatch(redacted, /claudeAiOauth/);
  assert.doesNotMatch(redacted, /ghp_123456789012345678901234567890123456/);
  assert.doesNotMatch(redacted, /ghs_123456789012345678901234567890123456/);
  assert.match(redacted, /\[REDACTED credentials blob\]/);
  assert.match(redacted, /\[REDACTED github token\]/);
  assert.match(redacted, /Bearer \[REDACTED\]/);
});

test("redactCommandError preserves benign short lookalikes", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");

  assert.equal(
    credentials.redactCommandError("image sha256:abc123 and token-ish ghp_short"),
    "image sha256:abc123 and token-ish ghp_short"
  );
});

test("env override helpers validate absolute credential file paths", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");

  assert.equal(credentials.claudeCredentialsEnvOverride({}), null);
  assert.deepEqual(
    credentials.claudeCredentialsEnvOverride({ AGENT_INFRA_CLAUDE_CREDENTIALS_FILE: "/tmp/creds.json" }),
    { path: "/tmp/creds.json", source: "AGENT_INFRA_CLAUDE_CREDENTIALS_FILE" }
  );
  assert.doesNotThrow(() => credentials.validateClaudeCredentialsEnvOverride({}));
  assert.doesNotThrow(() => credentials.validateClaudeCredentialsEnvOverride({
    AGENT_INFRA_CLAUDE_CREDENTIALS_FILE: "/tmp/creds.json"
  }));
  assert.throws(
    () => credentials.validateClaudeCredentialsEnvOverride({
      AGENT_INFRA_CLAUDE_CREDENTIALS_FILE: "relative/creds.json"
    }),
    /absolute file path/
  );
});

test("buildLockedGuidance includes macOS env override seed instructions", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const guidance = credentials.buildLockedGuidance();

  assert.match(guidance, /security unlock-keychain/);
  assert.match(guidance, /security find-generic-password -s "Claude Code-credentials" -w/);
  assert.match(guidance, /\$HOME\/\.agent-infra\/claude-credentials\.json/);
  assert.match(guidance, /AGENT_INFRA_CLAUDE_CREDENTIALS_FILE/);
  assert.doesNotMatch(guidance, /\$HOME\/\.claude\/\.credentials\.json/);
});

test("extractClaudeCredentialsBlob reads the full Claude Code credentials blob from macOS Keychain", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const rawBlob = validBlob();

  withPlatform("darwin", () => {
    const blob = credentials.extractClaudeCredentialsBlob("/Users/demo", (cmd: string, args: string[], options?: Record<string, unknown>) => {
      assert.equal(cmd, "security");
      assert.deepEqual(args, [
        "find-generic-password",
        "-a",
        "demo",
        "-s",
        "Claude Code-credentials",
        "-w"
      ]);
      assert.deepEqual(options, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
      return `${rawBlob}\n`;
    });

    assert.equal(blob, rawBlob);
  });
});

test("extractClaudeCredentialsBlob returns null when macOS Keychain lookup fails", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");

  withPlatform("darwin", () => {
    assert.equal(credentials.extractClaudeCredentialsBlob("/Users/demo", () => {
      throw new Error("missing keychain item");
    }), null);
  });
});

test("extractClaudeCredentialsBlob returns null for empty macOS Keychain output", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");

  withPlatform("darwin", () => {
    assert.equal(credentials.extractClaudeCredentialsBlob("/Users/demo", () => ""), null);
  });
});

test("extractClaudeCredentialsBlob returns null for invalid macOS Keychain JSON", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");

  withPlatform("darwin", () => {
    assert.equal(credentials.extractClaudeCredentialsBlob("/Users/demo", () => "not-json"), null);
  });
});

test("extractClaudeCredentialsBlob returns null when macOS credentials lack required scopes", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");

  withPlatform("darwin", () => {
    assert.equal(credentials.extractClaudeCredentialsBlob("/Users/demo", () => JSON.stringify({
      claudeAiOauth: {
        accessToken: "token",
        refreshToken: "refresh-token",
        scopes: ["user:inference"]
      }
    })), null);
  });
});

test("extractClaudeCredentialsBlob returns null when Linux credentials file is missing", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-token-missing-"));

  try {
    withPlatform("linux", () => {
      assert.equal(credentials.extractClaudeCredentialsBlob(tmpDir), null);
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("extractClaudeCredentialsBlob returns null for invalid Linux credentials JSON", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-token-invalid-"));
  const claudeDir = path.join(tmpDir, ".claude");

  try {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, ".credentials.json"), "garbage", "utf8");
    withPlatform("linux", () => {
      assert.equal(credentials.extractClaudeCredentialsBlob(tmpDir), null);
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("extractClaudeCredentialsBlob returns null when Linux credentials lack required scopes", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-token-scopes-"));
  const claudeDir = path.join(tmpDir, ".claude");

  try {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "token",
        refreshToken: "refresh-token",
        scopes: ["user:inference"]
      }
    }), "utf8");
    withPlatform("linux", () => {
      assert.equal(credentials.extractClaudeCredentialsBlob(tmpDir), null);
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("extractClaudeCredentialsBlob reads Linux credentials from the Claude config directory", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-token-"));
  const claudeDir = path.join(tmpDir, ".claude");
  const rawBlob = validBlob();

  try {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, ".credentials.json"), rawBlob, "utf8");
    withPlatform("linux", () => {
      assert.equal(credentials.extractClaudeCredentialsBlob(tmpDir), rawBlob);
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("credential path helpers and writer manage the shared credential file", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-credentials-write-"));
  const credentialsDir = path.join(tmpDir, ".agent-infra", "credentials", "demo", "claude-code");
  const credentialsPath = path.join(credentialsDir, ".credentials.json");

  try {
    assert.equal(
      credentials.claudeCredentialsDir("/home/demo", "agent-infra"),
      "/home/demo/.agent-infra/credentials/agent-infra/claude-code"
    );
    assert.equal(
      credentials.claudeCredentialsPath("/home/demo", "agent-infra"),
      "/home/demo/.agent-infra/credentials/agent-infra/claude-code/.credentials.json"
    );

    credentials.writeClaudeCredentialsFile(tmpDir, "demo", "blob-1");
    credentials.writeClaudeCredentialsFile(tmpDir, "demo", "blob-2");
    assertModeBits(credentialsDir, 0o700);
    assertModeBits(credentialsPath, 0o600);
    assert.equal(fs.readFileSync(credentialsPath, "utf8"), "blob-2");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Claude provider auth detection accepts settings env tokens and apiKeyHelper", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");

  assert.equal(credentials.hasClaudeProviderAuthInSettings({
    env: { ANTHROPIC_AUTH_TOKEN: "  token-value  " }
  }), true);
  assert.equal(credentials.hasClaudeProviderAuthInSettings({
    env: { ANTHROPIC_API_KEY: "  api-key  " }
  }), true);
  assert.equal(credentials.hasClaudeProviderAuthInSettings({
    apiKeyHelper: "  op read item  "
  }), true);
  assert.equal(credentials.hasClaudeProviderAuthInSettings({
    env: { ANTHROPIC_AUTH_TOKEN: "  ", ANTHROPIC_API_KEY: "" },
    apiKeyHelper: " "
  }), false);
  assert.equal(credentials.hasClaudeProviderAuthInSettings({
    env: { ANTHROPIC_AUTH_TOKEN: 123 },
    apiKeyHelper: ["helper"]
  }), false);
  assert.equal(credentials.hasClaudeProviderAuthInSettings("not-json-object"), false);
});

test("Claude provider auth detection reads settings.json conservatively", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-provider-auth-"));
  const settingsPath = path.join(tmpDir, ".claude", "settings.json");

  try {
    assert.equal(credentials.hasClaudeProviderAuth(tmpDir), false);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, "{", "utf8");
    assert.equal(credentials.hasClaudeProviderAuth(tmpDir), false);
    fs.writeFileSync(settingsPath, JSON.stringify({
      env: { ANTHROPIC_API_KEY: "sk-ant-api-key" }
    }), "utf8");
    assert.equal(credentials.hasClaudeProviderAuth(tmpDir), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("prepareClaudeCredentials writes credentials only when claude-code is enabled", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const writes: Array<[string, string, string]> = [];

  const outcome = credentials.prepareClaudeCredentials(
    "/Users/demo",
    "agent-infra",
    [{ tool: { id: "claude-code" } }],
    () => "valid-blob",
    (home: string, project: string, blob: string) => writes.push([home, project, blob])
  );
  assert.deepEqual(outcome, { status: "OK" });
  assert.deepEqual(writes, [["/Users/demo", "agent-infra", "valid-blob"]]);

  let extractCalled = false;
  const missingToolOutcome = credentials.prepareClaudeCredentials(
    "/Users/demo",
    "agent-infra",
    [{ tool: { id: "codex" } }],
    () => {
      extractCalled = true;
      return "blob";
    },
    () => {}
  );
  assert.deepEqual(missingToolOutcome, { status: "NOT_APPLICABLE" });
  assert.equal(extractCalled, false);
});

test("prepareClaudeCredentials returns SKIPPED and writes nothing when credentials are missing", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  let writeCalled = false;

  const outcome = credentials.prepareClaudeCredentials(
    "/Users/demo",
    "agent-infra",
    [{ tool: { id: "claude-code" } }],
    () => null,
    () => {
      writeCalled = true;
    },
    () => ({ status: "MISSING" })
  );

  assert.deepEqual(outcome, { status: "SKIPPED" });
  assert.equal(writeCalled, false);
});

test("prepareClaudeCredentials accepts provider auth when OAuth credentials are missing or stale", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");

  for (const inspection of [
    { status: "MISSING" as const },
    { status: "STALE_ACCESS" as const }
  ]) {
    let writeCalled = false;
    const outcome = credentials.prepareClaudeCredentials(
      "/Users/demo",
      "agent-infra",
      [{ tool: { id: "claude-code" } }],
      () => null,
      () => {
        writeCalled = true;
      },
      () => inspection,
      () => true
    );

    assert.deepEqual(outcome, { status: "OK" });
    assert.equal(writeCalled, false);
  }
});

test("prepareClaudeCredentials accepts provider auth when keychain extraction is empty", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  let writeCalled = false;

  const outcome = credentials.prepareClaudeCredentials(
    "/Users/demo",
    "agent-infra",
    [{ tool: { id: "claude-code" } }],
    () => null,
    () => {
      writeCalled = true;
    },
    credentials.inspectClaudeKeychainStatus,
    () => true
  );

  assert.deepEqual(outcome, { status: "OK" });
  assert.equal(writeCalled, false);
});

test("prepareClaudeCredentials rejects stale and keychain error states", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");

  for (const inspection of [
    { status: "STALE_ACCESS" as const },
    { status: "KEYCHAIN_ERROR" as const, detail: "security failed" }
  ]) {
    let writeCalled = false;
    assert.throws(() => credentials.prepareClaudeCredentials(
      "/Users/demo",
      "agent-infra",
      [{ tool: { id: "claude-code" } }],
      () => null,
      () => {
        writeCalled = true;
      },
      () => inspection
    ), /Claude Code credentials/);
    assert.equal(writeCalled, false);
  }
});

test("prepareClaudeCredentials reports keychain locked guidance", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");

  assert.throws(() => credentials.prepareClaudeCredentials(
    "/Users/demo",
    "agent-infra",
    [{ tool: { id: "claude-code" } }],
    () => null,
    () => {},
    () => ({ status: "KEYCHAIN_LOCKED", detail: "security: User interaction is not allowed." })
  ), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /keychain is locked/);
    assert.match(error.message, /security unlock-keychain/);
    assert.match(error.message, /AGENT_INFRA_CLAUDE_CREDENTIALS_FILE/);
    return true;
  });
});

test("inspectClaudeKeychainStatus reports macOS credential states", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");

  withPlatform("darwin", () => {
    assert.equal(credentials.inspectClaudeKeychainStatus("/Users/demo", () => validBlob()).status, "OK");
    assert.equal(credentials.inspectClaudeKeychainStatus("/Users/demo", () => {
      throw Object.assign(new Error("missing"), {
        stderr: Buffer.from("security: SecKeychainSearchCopyNext: The specified item could not be found.")
      });
    }).status, "MISSING");
    assert.equal(credentials.inspectClaudeKeychainStatus("/Users/demo", () => {
      throw taintedSecurityError("security: errSecInteractionNotAllowed: User interaction is not allowed.");
    }).status, "KEYCHAIN_LOCKED");
    assert.equal(credentials.inspectClaudeKeychainStatus("/Users/demo", () => {
      throw taintedSecurityError("security: arbitrary failure");
    }).status, "KEYCHAIN_ERROR");
    assert.equal(credentials.inspectClaudeKeychainStatus("/Users/demo", () => "not-json").status, "STALE_ACCESS");
    assert.equal(credentials.inspectClaudeKeychainStatus("/Users/demo", () => JSON.stringify({
      claudeAiOauth: { accessToken: "token" }
    })).status, "STALE_ACCESS");
  });
});

test("inspectClaudeKeychainStatus reads env override without touching keychain", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-env-inspect-"));
  const overridePath = path.join(tmpDir, "credentials.json");

  try {
    fs.writeFileSync(overridePath, validBlob({ expiresAt: 123456 }), "utf8");
    withPlatform("darwin", () => {
      assert.deepEqual(credentials.inspectClaudeKeychainStatus("/Users/demo", () => {
        assert.fail("security should not be called when env override is set");
      }, {
        envFn: () => ({ AGENT_INFRA_CLAUDE_CREDENTIALS_FILE: overridePath })
      }), {
        status: "OK",
        blob: validBlob({ expiresAt: 123456 }),
        expiresAt: 123456
      });
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("inspectClaudeKeychainStatus reports Linux credential states", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-inspect-"));
  const credentialsPath = path.join(tmpDir, ".claude", ".credentials.json");
  const rawBlob = validBlob({ expiresAt: 123456 });

  try {
    withPlatform("linux", () => {
      assert.equal(credentials.inspectClaudeKeychainStatus(tmpDir).status, "MISSING");
    });
    fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
    fs.writeFileSync(credentialsPath, "not-json", "utf8");
    withPlatform("linux", () => {
      assert.equal(credentials.inspectClaudeKeychainStatus(tmpDir).status, "STALE_ACCESS");
    });
    fs.writeFileSync(credentialsPath, rawBlob, "utf8");
    withPlatform("linux", () => {
      assert.deepEqual(credentials.inspectClaudeKeychainStatus(tmpDir), {
        status: "OK",
        blob: rawBlob,
        expiresAt: 123456
      });
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("inspectClaudeMountFile reports mounted credential states", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-mount-inspect-"));
  const targetPath = path.join(tmpDir, ".agent-infra", "credentials", "demo", "claude-code", ".credentials.json");
  const rawBlob = validBlob({ expiresAt: 987654 });

  try {
    assert.equal(credentials.inspectClaudeMountFile(tmpDir, "demo").status, "MISSING");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "not-json", "utf8");
    assert.equal(credentials.inspectClaudeMountFile(tmpDir, "demo").status, "STALE_ACCESS");
    fs.writeFileSync(targetPath, rawBlob, "utf8");
    assert.deepEqual(credentials.inspectClaudeMountFile(tmpDir, "demo"), {
      status: "OK",
      blob: rawBlob,
      expiresAt: 987654
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("discoverProjects lists project credential copies only", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-discover-"));

  try {
    fs.mkdirSync(path.join(tmpDir, ".agent-infra", "credentials", "alpha", "claude-code"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".agent-infra", "credentials", "beta", "claude-code"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".agent-infra", "credentials", "alpha", "claude-code", ".credentials.json"),
      validBlob(),
      "utf8"
    );

    assert.deepEqual(credentials.discoverProjects(tmpDir), ["alpha"]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("writeClaudeCredentialsToHost updates macOS Keychain credentials", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const rawBlob = validBlob();

  withPlatform("darwin", () => {
    assert.deepEqual(credentials.writeClaudeCredentialsToHost("/Users/demo", rawBlob, {
      execFn: (cmd: string, args: string[], options?: Record<string, unknown>) => {
        assert.equal(cmd, "security");
        assert.deepEqual(args, [
          "add-generic-password",
          "-U",
          "-a",
          "demo",
          "-s",
          "Claude Code-credentials",
          "-w",
          rawBlob
        ]);
        assert.deepEqual(options, {
          encoding: "utf8",
          stdio: ["ignore", "ignore", "pipe"]
        });
      }
    }), { ok: true });
  });
});

test("writeClaudeCredentialsToHost returns a soft failure when macOS Keychain write fails", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");

  withPlatform("darwin", () => {
    const result = credentials.writeClaudeCredentialsToHost("/Users/demo", validBlob(), {
      execFn: () => {
        throw taintedSecurityError("security: arbitrary failure");
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.classification, "OTHER");
    assert.match(result.error, /^security command failed:/);
    assert.doesNotMatch(result.error, /sk-ant-oat01/);
    assert.doesNotMatch(result.error, /claudeAiOauth/);
  });
});

test("writeClaudeCredentialsToHost returns locked guidance without leaking OAuth data", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");

  withPlatform("darwin", () => {
    const result = credentials.writeClaudeCredentialsToHost("/Users/demo", validBlob(), {
      execFn: () => {
        throw taintedSecurityError("security: errSecInteractionNotAllowed: User interaction is not allowed.");
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.classification, "LOCKED");
    assert.match(result.error, /security unlock-keychain/);
    assert.match(result.error, /AGENT_INFRA_CLAUDE_CREDENTIALS_FILE/);
    assert.doesNotMatch(result.error, /sk-ant-oat01/);
    assert.doesNotMatch(result.error, /claudeAiOauth/);
    assert.doesNotMatch(result.error, /Command failed/);
  });
});

test("writeClaudeCredentialsToHost writes env override file without touching keychain", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-env-write-"));
  const overridePath = path.join(tmpDir, "credentials.json");
  const rawBlob = validBlob();

  try {
    withPlatform("darwin", () => {
      assert.deepEqual(credentials.writeClaudeCredentialsToHost("/Users/demo", rawBlob, {
        envFn: () => ({ AGENT_INFRA_CLAUDE_CREDENTIALS_FILE: overridePath }),
        execFn: () => {
          assert.fail("security should not be called when env override is set");
        },
        randomFn: () => "fixed"
      }), { ok: true });
    });
    assert.equal(fs.readFileSync(overridePath, "utf8"), rawBlob);
    assertModeBits(overridePath, 0o600);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("writeClaudeCredentialsToHost atomically replaces Linux host credentials", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-host-write-"));
  const targetPath = path.join(tmpDir, ".claude", ".credentials.json");
  const rawBlob = validBlob();

  try {
    withPlatform("linux", () => {
      assert.deepEqual(credentials.writeClaudeCredentialsToHost(tmpDir, rawBlob, {
        randomFn: () => "fixed"
      }), { ok: true });
    });

    assertModeBits(path.dirname(targetPath), 0o700);
    assertModeBits(targetPath, 0o600);
    assert.equal(fs.readFileSync(targetPath, "utf8"), rawBlob);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("writeClaudeCredentialsToHost preserves Linux host credentials when rename fails", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-claude-host-rename-fail-"));
  const targetDir = path.join(tmpDir, ".claude");
  const targetPath = path.join(targetDir, ".credentials.json");

  try {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(targetPath, "original", "utf8");

    withPlatform("linux", () => {
      const result = credentials.writeClaudeCredentialsToHost(tmpDir, validBlob(), {
        randomFn: () => "fixed",
        renameFn: () => {
          throw new Error("rename failed");
        }
      });

      assert.deepEqual(result, { ok: false, classification: "OTHER", error: "rename failed" });
    });

    assert.equal(fs.readFileSync(targetPath, "utf8"), "original");
    assert.equal(fs.existsSync(`${targetPath}.tmp.${process.pid}.fixed`), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncClaudeCredentialsFromKeychain writes only when destination bytes differ", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const rawBlob = validBlob({ expiresAt: 123456 });
  const writes: Array<[string, string, string]> = [];

  withPlatform("darwin", () => {
    assert.deepEqual(credentials.syncClaudeCredentialsFromKeychain("/Users/demo", "agent-infra", {
      execFn: () => rawBlob,
      existsFn: () => false,
      writeFn: (home: string, project: string, blob: string) => writes.push([home, project, blob])
    }), { status: "OK", written: true, expiresAt: 123456 });

    assert.deepEqual(credentials.syncClaudeCredentialsFromKeychain("/Users/demo", "agent-infra", {
      execFn: () => rawBlob,
      existsFn: () => true,
      readFn: () => rawBlob,
      writeFn: (home: string, project: string, blob: string) => writes.push([home, project, blob])
    }), { status: "OK", written: false, expiresAt: 123456 });

    assert.deepEqual(credentials.syncClaudeCredentialsFromKeychain("/Users/demo", "agent-infra", {
      execFn: () => rawBlob,
      existsFn: () => true,
      readFn: () => "old",
      writeFn: (home: string, project: string, blob: string) => writes.push([home, project, blob])
    }), { status: "OK", written: true, expiresAt: 123456 });

    assert.equal(writes.length, 2);
  });
});

test("syncClaudeCredentialsFromKeychain and formatRemaining handle unavailable or coarse states", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const now = 1_700_000_000_000;
  const originalNow = Date.now;
  let writeCalled = false;

  try {
    Date.now = () => now;
    withPlatform("darwin", () => {
      assert.deepEqual(credentials.syncClaudeCredentialsFromKeychain("/Users/demo", "agent-infra", {
        execFn: () => {
          throw Object.assign(new Error("missing"), {
            stderr: Buffer.from("security: SecKeychainSearchCopyNext: The specified item could not be found.")
          });
        },
        writeFn: () => {
          writeCalled = true;
        }
      }), { status: "MISSING", written: false });
      assert.equal(writeCalled, false);
    });

    assert.equal(credentials.formatRemaining(null), "unknown");
    assert.equal(credentials.formatRemaining(now - 1), "EXPIRED");
    assert.equal(credentials.formatRemaining(now + 47 * 60_000), "47m");
    assert.equal(credentials.formatRemaining(now + 5 * 60 * 60_000 + 47 * 60_000), "5h 47m");
  } finally {
    Date.now = originalNow;
  }
});

test("reconcileClaudeCredentials writes project files when host credentials are newer", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-reconcile-host-newer-"));
  const hostBlob = validBlob({ accessToken: "host", expiresAt: 200 });
  const fileBlob = validBlob({ accessToken: "file", expiresAt: 100 });
  const hostPath = path.join(tmpDir, ".claude", ".credentials.json");
  const filePath = path.join(tmpDir, ".agent-infra", "credentials", "demo", "claude-code", ".credentials.json");

  try {
    fs.mkdirSync(path.dirname(hostPath), { recursive: true });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(hostPath, hostBlob, "utf8");
    fs.writeFileSync(filePath, fileBlob, "utf8");

    const result = withPlatform("linux", () => credentials.reconcileClaudeCredentials(tmpDir, {
      projects: ["demo"]
    }));

    assert.equal(result.status, "OK");
    assert.equal(result.authoritative, "host");
    assert.deepEqual(result.filesWritten, ["demo"]);
    assert.equal(fs.readFileSync(filePath, "utf8"), hostBlob);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("reconcileClaudeCredentials writes host credentials when a project file is newer", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-reconcile-file-newer-"));
  const hostBlob = validBlob({ accessToken: "host", expiresAt: 100 });
  const fileBlob = validBlob({ accessToken: "file", expiresAt: 200 });
  const hostPath = path.join(tmpDir, ".claude", ".credentials.json");
  const filePath = path.join(tmpDir, ".agent-infra", "credentials", "demo", "claude-code", ".credentials.json");

  try {
    fs.mkdirSync(path.dirname(hostPath), { recursive: true });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(hostPath, hostBlob, "utf8");
    fs.writeFileSync(filePath, fileBlob, "utf8");

    const result = withPlatform("linux", () => credentials.reconcileClaudeCredentials(tmpDir, {
      projects: ["demo"],
      writeHostFn: (home: string, blob: string) => credentials.writeClaudeCredentialsToHost(home, blob, { randomFn: () => "fixed" })
    }));

    assert.equal(result.status, "OK");
    assert.equal(result.authoritative, "file:demo");
    assert.equal(result.hostWritten, true);
    assert.equal(fs.readFileSync(hostPath, "utf8"), fileBlob);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("reconcileClaudeCredentials picks the freshest credentials across multiple project files", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-reconcile-multi-"));
  const hostBlob = validBlob({ accessToken: "host", expiresAt: 100 });
  const alphaBlob = validBlob({ accessToken: "alpha", expiresAt: 200 });
  const betaBlob = validBlob({ accessToken: "beta", expiresAt: 300 });
  const hostPath = path.join(tmpDir, ".claude", ".credentials.json");
  const alphaPath = path.join(tmpDir, ".agent-infra", "credentials", "alpha", "claude-code", ".credentials.json");
  const betaPath = path.join(tmpDir, ".agent-infra", "credentials", "beta", "claude-code", ".credentials.json");

  try {
    fs.mkdirSync(path.dirname(hostPath), { recursive: true });
    fs.mkdirSync(path.dirname(alphaPath), { recursive: true });
    fs.mkdirSync(path.dirname(betaPath), { recursive: true });
    fs.writeFileSync(hostPath, hostBlob, "utf8");
    fs.writeFileSync(alphaPath, alphaBlob, "utf8");
    fs.writeFileSync(betaPath, betaBlob, "utf8");

    const result = withPlatform("linux", () => credentials.reconcileClaudeCredentials(tmpDir, {
      projects: ["alpha", "beta"]
    }));

    assert.equal(result.authoritative, "file:beta");
    assert.equal(result.hostWritten, true);
    assert.deepEqual(result.filesWritten, ["alpha"]);
    assert.equal(fs.readFileSync(hostPath, "utf8"), betaBlob);
    assert.equal(fs.readFileSync(alphaPath, "utf8"), betaBlob);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("reconcileClaudeCredentials keeps host authoritative but does not overwrite mount when host expiresAt is unknown", async () => {
  // Host is selected as authoritative (chooseAuthoritativeEndpoint early-returns
  // host when its expiresAt is non-numeric) but shouldWriteEndpoint stays
  // conservative: it refuses to overwrite a mount that is already OK with a
  // numeric expiresAt, because the host blob may be leaner (missing fields like
  // subscriptionType). A real rotation will produce a strictly larger expiresAt
  // and let the right side win cleanly next time.
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-reconcile-host-unknown-expiry-"));
  const hostBlob = validBlob({ accessToken: "host", expiresAt: undefined });
  const fileBlob = validBlob({ accessToken: "file", expiresAt: 300 });
  const hostPath = path.join(tmpDir, ".claude", ".credentials.json");
  const filePath = path.join(tmpDir, ".agent-infra", "credentials", "demo", "claude-code", ".credentials.json");

  try {
    fs.mkdirSync(path.dirname(hostPath), { recursive: true });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(hostPath, hostBlob, "utf8");
    fs.writeFileSync(filePath, fileBlob, "utf8");

    const result = withPlatform("linux", () => credentials.reconcileClaudeCredentials(tmpDir, {
      projects: ["demo"]
    }));

    assert.equal(result.status, "OK");
    assert.equal(result.authoritative, "host");
    assert.deepEqual(result.filesWritten, []);
    assert.equal(fs.readFileSync(filePath, "utf8"), fileBlob);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("reconcileClaudeCredentials reports KEYCHAIN_WRITE_FAILED when host write fails", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const fileBlob = validBlob({ expiresAt: 200 });

  withPlatform("darwin", () => {
    const result = credentials.reconcileClaudeCredentials("/Users/demo", {
      projects: ["demo"],
      execFn: () => {
        throw Object.assign(new Error("missing"), {
          stderr: Buffer.from("security: SecKeychainSearchCopyNext: The specified item could not be found.")
        });
      },
      readFn: () => fileBlob,
      existsFn: () => true,
      writeHostFn: () => ({ ok: false, classification: "OTHER", error: "keychain locked" })
    });

    assert.equal(result.status, "KEYCHAIN_WRITE_FAILED");
    assert.equal(result.authoritative, "file:demo");
    assert.deepEqual(result.warnings, [{
      source: "host-keychain",
      classification: "OTHER",
      message: "keychain locked"
    }]);
  });
});

test("reconcileClaudeCredentials reports KEYCHAIN_LOCKED when host is locked and no file is usable", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");

  withPlatform("darwin", () => {
    const result = credentials.reconcileClaudeCredentials("/Users/demo", {
      projects: [],
      inspection: {
        status: "KEYCHAIN_LOCKED",
        detail: "security: User interaction is not allowed."
      }
    });

    assert.equal(result.status, "KEYCHAIN_LOCKED");
    assert.equal(result.detail, "security: User interaction is not allowed.");
  });
});

test("reconcileClaudeCredentials skips writes when expiresAt values are equal", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-reconcile-equal-"));
  const hostBlob = validBlob({ accessToken: "host", expiresAt: 100 });
  const fileBlob = validBlob({ accessToken: "file", expiresAt: 100 });
  const hostPath = path.join(tmpDir, ".claude", ".credentials.json");
  const filePath = path.join(tmpDir, ".agent-infra", "credentials", "demo", "claude-code", ".credentials.json");

  try {
    fs.mkdirSync(path.dirname(hostPath), { recursive: true });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(hostPath, hostBlob, "utf8");
    fs.writeFileSync(filePath, fileBlob, "utf8");

    const result = withPlatform("linux", () => credentials.reconcileClaudeCredentials(tmpDir, {
      projects: ["demo"]
    }));

    assert.equal(result.authoritative, "host");
    assert.equal(result.hostWritten, false);
    assert.deepEqual(result.filesWritten, []);
    assert.equal(fs.readFileSync(filePath, "utf8"), fileBlob);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("reconcileClaudeCredentials restores missing host credentials from a project file", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-reconcile-host-missing-"));
  const fileBlob = validBlob({ expiresAt: 200 });
  const hostPath = path.join(tmpDir, ".claude", ".credentials.json");
  const filePath = path.join(tmpDir, ".agent-infra", "credentials", "demo", "claude-code", ".credentials.json");

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, fileBlob, "utf8");

    const result = withPlatform("linux", () => credentials.reconcileClaudeCredentials(tmpDir, {
      projects: ["demo"]
    }));

    assert.equal(result.status, "OK");
    assert.equal(result.authoritative, "file:demo");
    assert.equal(result.hostWritten, true);
    assert.equal(fs.readFileSync(hostPath, "utf8"), fileBlob);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("reconcileClaudeCredentials falls back to host one-way sync when files are stale", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-reconcile-file-stale-"));
  const hostBlob = validBlob({ expiresAt: 200 });
  const hostPath = path.join(tmpDir, ".claude", ".credentials.json");
  const filePath = path.join(tmpDir, ".agent-infra", "credentials", "demo", "claude-code", ".credentials.json");

  try {
    fs.mkdirSync(path.dirname(hostPath), { recursive: true });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(hostPath, hostBlob, "utf8");
    fs.writeFileSync(filePath, "not-json", "utf8");

    const result = withPlatform("linux", () => credentials.reconcileClaudeCredentials(tmpDir, {
      projects: ["demo"]
    }));

    assert.equal(result.status, "OK");
    assert.equal(result.authoritative, "host");
    assert.deepEqual(result.filesWritten, ["demo"]);
    assert.equal(fs.readFileSync(filePath, "utf8"), hostBlob);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("reconcileClaudeCredentials reports stale when no endpoint has valid credentials", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-reconcile-stale-"));
  const hostPath = path.join(tmpDir, ".claude", ".credentials.json");
  const filePath = path.join(tmpDir, ".agent-infra", "credentials", "demo", "claude-code", ".credentials.json");

  try {
    fs.mkdirSync(path.dirname(hostPath), { recursive: true });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(hostPath, "not-json", "utf8");
    fs.writeFileSync(filePath, "not-json", "utf8");

    const result = withPlatform("linux", () => credentials.reconcileClaudeCredentials(tmpDir, {
      projects: ["demo"]
    }));

    assert.equal(result.status, "STALE_ACCESS");
    assert.equal(result.authoritative, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("reconcileClaudeCredentials reports missing when no endpoint exists", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-reconcile-missing-"));

  try {
    const result = withPlatform("linux", () => credentials.reconcileClaudeCredentials(tmpDir, {
      projects: ["demo"]
    }));

    assert.equal(result.status, "MISSING");
    assert.equal(result.authoritative, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("reconcileClaudeCredentials does not overwrite mount when host expiresAt is missing", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-reconcile-host-no-expires-"));
  const hostBlob = JSON.stringify({
    claudeAiOauth: {
      accessToken: "host-access",
      refreshToken: "host-refresh",
      scopes: ["user:profile", "user:sessions:claude_code"]
    }
  });
  const fileBlob = validBlob({ accessToken: "file-access", expiresAt: 999_999_999_999 });
  const hostPath = path.join(tmpDir, ".claude", ".credentials.json");
  const filePath = path.join(tmpDir, ".agent-infra", "credentials", "demo", "claude-code", ".credentials.json");

  try {
    fs.mkdirSync(path.dirname(hostPath), { recursive: true });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(hostPath, hostBlob, "utf8");
    fs.writeFileSync(filePath, fileBlob, "utf8");

    const result = withPlatform("linux", () => credentials.reconcileClaudeCredentials(tmpDir, {
      projects: ["demo"]
    }));

    assert.equal(result.status, "OK");
    assert.deepEqual(result.filesWritten, []);
    assert.equal(result.hostWritten, false);
    assert.equal(fs.readFileSync(filePath, "utf8"), fileBlob);
    assert.equal(fs.readFileSync(hostPath, "utf8"), hostBlob);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("reconcileClaudeCredentials does not overwrite mount when host expiresAt is a non-numeric value", async () => {
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-reconcile-host-string-expires-"));
  const hostBlob = JSON.stringify({
    claudeAiOauth: {
      accessToken: "host-access",
      refreshToken: "host-refresh",
      scopes: ["user:profile", "user:sessions:claude_code"],
      expiresAt: "1778233047257"
    }
  });
  const fileBlob = validBlob({ accessToken: "file-access", expiresAt: 1778233047257 });
  const hostPath = path.join(tmpDir, ".claude", ".credentials.json");
  const filePath = path.join(tmpDir, ".agent-infra", "credentials", "demo", "claude-code", ".credentials.json");

  try {
    fs.mkdirSync(path.dirname(hostPath), { recursive: true });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(hostPath, hostBlob, "utf8");
    fs.writeFileSync(filePath, fileBlob, "utf8");

    const result = withPlatform("linux", () => credentials.reconcileClaudeCredentials(tmpDir, {
      projects: ["demo"]
    }));

    assert.equal(result.status, "OK");
    assert.deepEqual(result.filesWritten, []);
    assert.equal(result.hostWritten, false);
    assert.equal(fs.readFileSync(filePath, "utf8"), fileBlob);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("reconcileClaudeCredentials preserves mount subscriptionType when host blob is leaner (production incident regression)", async () => {
  // Regression for the manual verification incident: host Keychain held a blob
  // missing subscriptionType, the mount file held the full blob with
  // subscriptionType=max, and reconcile was overwriting the mount with the
  // leaner host blob — silently downgrading the user from max tier.
  const credentials = await loadFreshEsm<typeof import("../../../lib/sandbox/credentials.ts")>("lib/sandbox/credentials.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-reconcile-prod-incident-"));
  const hostBlob = JSON.stringify({
    claudeAiOauth: {
      accessToken: "shared-access",
      refreshToken: "shared-refresh",
      scopes: ["user:profile", "user:sessions:claude_code"],
      expiresAt: "1778233047257"
    }
  });
  const fileBlob = JSON.stringify({
    claudeAiOauth: {
      accessToken: "shared-access",
      refreshToken: "shared-refresh",
      scopes: ["user:profile", "user:sessions:claude_code"],
      expiresAt: 1778233047257,
      subscriptionType: "max",
      rateLimitTier: "tier-3"
    }
  });
  const hostPath = path.join(tmpDir, ".claude", ".credentials.json");
  const filePath = path.join(tmpDir, ".agent-infra", "credentials", "agent-infra", "claude-code", ".credentials.json");

  try {
    fs.mkdirSync(path.dirname(hostPath), { recursive: true });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(hostPath, hostBlob, "utf8");
    fs.writeFileSync(filePath, fileBlob, "utf8");

    const result = withPlatform("linux", () => credentials.reconcileClaudeCredentials(tmpDir, {
      projects: ["agent-infra"]
    }));

    assert.equal(result.status, "OK");
    assert.deepEqual(result.filesWritten, []);
    const mountAfter = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(mountAfter.claudeAiOauth.subscriptionType, "max");
    assert.equal(mountAfter.claudeAiOauth.rateLimitTier, "tier-3");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
