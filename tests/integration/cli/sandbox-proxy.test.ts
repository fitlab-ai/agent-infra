import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertModeBits,
  cliArgs,
  envWithPrependedPath,
  gitSafeEnv,
  loadFreshEsm,
  writeSandboxEngineFixture
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
type EngineRunSafeFn = (engine: string, cmd: string, args: string[]) => string;
type SandboxCreateModule = {
  collectHostProxyEntries(env: NodeJS.ProcessEnv): Array<[string, string]>;
  buildContainerEnvFile(
    tools: ResolvedToolFixture[],
    engine: string,
    runSafe?: EngineRunSafeFn,
    options?: CommandOptions & { additionalEntries?: Array<[string, string]> }
  ): EnvFileResult;
};

function required<T>(value: T | undefined, message = "expected value"): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
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
      DOCKER_ENV_FILE_LOG_PATH: fixture.envFileLogPath,
      ...extraEnv
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000
  });
}

function commitFixtureRepo(repoDir: string) {
  fs.writeFileSync(path.join(repoDir, "README.md"), "fixture\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: repoDir, env: gitSafeEnv(), stdio: "ignore" });
  spawnSync("git", [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "init"
  ], { cwd: repoDir, env: gitSafeEnv(), stdio: "ignore" });
}

function proxyEnvLines(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => /^(?:http_proxy|HTTP_PROXY|https_proxy|HTTPS_PROXY|all_proxy|ALL_PROXY|no_proxy|NO_PROXY)=/.test(line));
}

test("collectHostProxyEntries returns only non-empty standard proxy variables in fixed order", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");

  const entries = sandboxCreate.collectHostProxyEntries({
    http_proxy: "http://lower-http.example:8080",
    HTTP_PROXY: "http://upper-http.example:8080",
    https_proxy: "",
    HTTPS_PROXY: "https://upper-https.example:8443",
    all_proxy: "socks5://lower-all.example:1080",
    ALL_PROXY: "socks5://upper-all.example:1080",
    no_proxy: "localhost,127.0.0.1",
    NO_PROXY: "example.test",
    npm_config_proxy: "http://not-forwarded.example:8080"
  });

  assert.deepEqual(entries, [
    ["http_proxy", "http://lower-http.example:8080"],
    ["HTTP_PROXY", "http://upper-http.example:8080"],
    ["HTTPS_PROXY", "https://upper-https.example:8443"],
    ["all_proxy", "socks5://lower-all.example:1080"],
    ["ALL_PROXY", "socks5://upper-all.example:1080"],
    ["no_proxy", "localhost,127.0.0.1"],
    ["NO_PROXY", "example.test"]
  ]);
});

test("collectHostProxyEntries does not duplicate case-insensitive environment keys", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const env = new Proxy<NodeJS.ProcessEnv>({
    HTTP_PROXY: "http://proxy.example:8080",
    NO_PROXY: "localhost"
  }, {
    get(target, property) {
      if (typeof property !== "string") {
        return Reflect.get(target, property);
      }
      const exactKey = Object.keys(target).find((key) => key.toLowerCase() === property.toLowerCase());
      return exactKey === undefined ? undefined : target[exactKey];
    }
  });

  assert.deepEqual(sandboxCreate.collectHostProxyEntries(env), [
    ["HTTP_PROXY", "http://proxy.example:8080"],
    ["NO_PROXY", "localhost"]
  ]);
});

test("buildContainerEnvFile appends proxy entries after tool env and before GH_TOKEN", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-proxy-env-file-"));

  try {
    const envFile = sandboxCreate.buildContainerEnvFile([
      { tool: { envVars: { HTTP_PROXY: "http://tool.example:8080", FOO: "bar" } } }
    ], "native", () => "ghp_123456789012345678901234567890123456", {
      tmpDir,
      additionalEntries: [
        ["HTTP_PROXY", "http://host.example:8080"],
        ["NO_PROXY", "localhost"]
      ]
    });
    const envPath = required(envFile.dockerArgs[1]);

    assert.equal(fs.readFileSync(envPath, "utf8"), [
      "HTTP_PROXY=http://tool.example:8080",
      "FOO=bar",
      "HTTP_PROXY=http://host.example:8080",
      "NO_PROXY=localhost",
      "GH_TOKEN=ghp_123456789012345678901234567890123456",
      ""
    ].join("\n"));
    assert.ok(!envFile.dockerArgs.some((arg) => arg.includes("host.example")));
    assertModeBits(path.dirname(envPath), 0o700);
    assertModeBits(envPath, 0o600);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("buildContainerEnvFile rejects newlines in additional proxy entries and cleans up", async () => {
  const sandboxCreate = await loadFreshEsm<SandboxCreateModule>("lib/sandbox/commands/create.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-proxy-env-file-newline-"));

  try {
    assert.throws(() => sandboxCreate.buildContainerEnvFile([], "native", () => "", {
      tmpDir,
      additionalEntries: [["HTTP_PROXY", "http://proxy.example:8080\nSECRET"]]
    }), /HTTP_PROXY must not contain newlines/);
    assert.deepEqual(fs.readdirSync(tmpDir), []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sandbox create inherits host proxy variables only when explicitly requested", { timeout: 30_000 }, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-sandbox-proxy-cli-"));

  try {
    const defaultFixture = writeSandboxEngineFixture(path.join(tmpDir, "default"), { project: "demo" });
    commitFixtureRepo(defaultFixture.repoDir);
    const defaultResult = spawnSandboxCli(defaultFixture, tmpDir, ["create", "feature/default-proxy"], {
      HTTP_PROXY: "http://proxy.example:8080",
      HTTPS_PROXY: "https://secure-proxy.example:8443"
    });
    assert.equal(defaultResult.status, 0, defaultResult.stderr);
    assert.deepEqual(defaultFixture.readCapturedEnvFiles().flatMap(proxyEnvLines), []);

    const inheritFixture = writeSandboxEngineFixture(path.join(tmpDir, "inherit"), { project: "demo" });
    commitFixtureRepo(inheritFixture.repoDir);
    const inheritResult = spawnSandboxCli(inheritFixture, tmpDir, ["create", "feature/inherit-proxy", "--inherit-proxy"], {
      HTTP_PROXY: "http://user:pass@proxy.example:8080",
      HTTPS_PROXY: "https://secure-proxy.example:8443",
      NO_PROXY: "localhost,127.0.0.1",
      npm_config_proxy: "http://not-forwarded.example:8080"
    });
    assert.equal(inheritResult.status, 0, inheritResult.stderr);
    assert.deepEqual(inheritFixture.readCapturedEnvFiles().flatMap(proxyEnvLines), [
      "HTTP_PROXY=http://user:pass@proxy.example:8080",
      "HTTPS_PROXY=https://secure-proxy.example:8443",
      "NO_PROXY=localhost,127.0.0.1"
    ]);
    const runCall = inheritFixture.readDockerCalls().find((call) => call[0] === "run") ?? [];
    assert.ok(!runCall.some((arg) => arg.includes("user:pass")));
    assert.equal(runCall.includes("--env-file"), true);

    const shortFixture = writeSandboxEngineFixture(path.join(tmpDir, "short"), { project: "demo" });
    commitFixtureRepo(shortFixture.repoDir);
    const shortResult = spawnSandboxCli(shortFixture, tmpDir, ["create", "feature/short-proxy", "-P"], {
      http_proxy: "http://lower-proxy.example:8080"
    });
    assert.equal(shortResult.status, 0, shortResult.stderr);
    assert.deepEqual(shortFixture.readCapturedEnvFiles().flatMap(proxyEnvLines), [
      "http_proxy=http://lower-proxy.example:8080"
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
