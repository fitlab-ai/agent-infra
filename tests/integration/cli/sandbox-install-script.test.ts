import test from "node:test";
import assert from "node:assert/strict";

import { loadFreshEsm } from "../../helpers.ts";

type SandboxToolsModule = typeof import("../../../lib/sandbox/tools.ts");

const FAKE_HOST_PATH = "/home/host-user/.acme/auth.json";

const NPM_TOOL = {
  id: "demo-npm",
  name: "Demo Npm",
  install: { type: "npm" as const, cmd: "@demo/npm-tool@1.0.0" },
  sandboxBase: "/home/host-user/.agent-infra/sandboxes/demo-npm",
  containerMount: "/home/devuser/.demo-npm",
  versionCmd: "demo-npm --version",
  setupHint: "fixture"
};

const SHELL_TOOL = {
  id: "demo-shell",
  name: "Demo Shell",
  install: { type: "shell" as const, cmd: 'curl -fsSL https://example.com/install.sh | bash' },
  sandboxBase: "/home/host-user/.agent-infra/sandboxes/demo-shell",
  containerMount: "/home/devuser/.demo-shell",
  versionCmd: "demo-shell --version",
  setupHint: "fixture"
};

test("toolNpmPackagesArg returns space-separated npm packages and ignores shell tools", async () => {
  const sandboxTools = await loadFreshEsm<SandboxToolsModule>("lib/sandbox/tools.js");

  assert.equal(sandboxTools.toolNpmPackagesArg([NPM_TOOL, SHELL_TOOL]), "@demo/npm-tool@1.0.0");
  assert.equal(sandboxTools.toolNpmPackagesArg([SHELL_TOOL]), "");
});

test("toolNpmPackagesArg includes the agent-infra builtin package", async () => {
  const sandboxTools = await loadFreshEsm<SandboxToolsModule>("lib/sandbox/tools.js");
  const [agentInfra] = sandboxTools.resolveTools({
    home: "/home/host-user",
    project: "demo",
    tools: ["agent-infra"]
  });

  assert.equal(sandboxTools.toolNpmPackagesArg([agentInfra!]), "@fitlab-ai/agent-infra@latest");
  assert.deepEqual(sandboxTools.imageSignatureFields([agentInfra!]), [
    { id: "agent-infra", install: { type: "npm", cmd: "@fitlab-ai/agent-infra@latest" } }
  ]);
});

test("toolShellInstallScript returns empty string when no shell tools are present", async () => {
  const sandboxTools = await loadFreshEsm<SandboxToolsModule>("lib/sandbox/tools.js");

  assert.equal(sandboxTools.toolShellInstallScript([]), "");
  assert.equal(sandboxTools.toolShellInstallScript([NPM_TOOL]), "");
});

test("toolShellInstallScript composes per-tool shebang + set -e + comment header + cmd", async () => {
  const sandboxTools = await loadFreshEsm<SandboxToolsModule>("lib/sandbox/tools.js");

  const script = sandboxTools.toolShellInstallScript([NPM_TOOL, SHELL_TOOL]);

  assert.match(script, /^#!\/bin\/bash\nset -e\n/);
  assert.match(script, /# install: demo-shell\ncurl -fsSL https:\/\/example\.com\/install\.sh \| bash/);
  // npm tool is excluded from the shell script
  assert.equal(script.includes("@demo/npm-tool"), false);
});

test("toolShellInstallScript handles multi-line shell commands without escaping", async () => {
  const sandboxTools = await loadFreshEsm<SandboxToolsModule>("lib/sandbox/tools.js");
  const multiline = {
    ...SHELL_TOOL,
    id: "multi",
    install: { type: "shell" as const, cmd: "echo step-1\necho step-2" }
  };

  const script = sandboxTools.toolShellInstallScript([multiline]);

  assert.ok(script.includes("# install: multi\necho step-1\necho step-2"));
});

test("toolShellInstallScriptBase64 round-trips back to the script via base64 decode", async () => {
  const sandboxTools = await loadFreshEsm<SandboxToolsModule>("lib/sandbox/tools.js");

  const b64 = sandboxTools.toolShellInstallScriptBase64([SHELL_TOOL]);
  assert.notEqual(b64, "");
  const decoded = Buffer.from(b64, "base64").toString("utf8");
  assert.equal(decoded, sandboxTools.toolShellInstallScript([SHELL_TOOL]));
});

test("toolShellInstallScriptBase64 returns empty string when no shell tools are present", async () => {
  const sandboxTools = await loadFreshEsm<SandboxToolsModule>("lib/sandbox/tools.js");

  assert.equal(sandboxTools.toolShellInstallScriptBase64([]), "");
  assert.equal(sandboxTools.toolShellInstallScriptBase64([NPM_TOOL]), "");
});

test("imageSignatureFields exposes only id and install — mount/env fields are excluded", async () => {
  const sandboxTools = await loadFreshEsm<SandboxToolsModule>("lib/sandbox/tools.js");

  const withMountA = { ...SHELL_TOOL, containerMount: "/home/devuser/.a", hostLiveMounts: [{ hostPath: FAKE_HOST_PATH, containerSubpath: "auth.json" }] };
  const withMountB = { ...SHELL_TOOL, containerMount: "/home/devuser/.b", hostLiveMounts: [{ hostPath: "/other/path", containerSubpath: "other.json" }] };

  assert.deepEqual(
    sandboxTools.imageSignatureFields([withMountA]),
    sandboxTools.imageSignatureFields([withMountB])
  );
});

test("imageSignatureFields changes when install.cmd changes — drives docker image rebuild", async () => {
  const sandboxTools = await loadFreshEsm<SandboxToolsModule>("lib/sandbox/tools.js");

  const v1 = { ...SHELL_TOOL, install: { type: "shell" as const, cmd: "install v1" } };
  const v2 = { ...SHELL_TOOL, install: { type: "shell" as const, cmd: "install v2" } };

  assert.notDeepEqual(
    sandboxTools.imageSignatureFields([v1]),
    sandboxTools.imageSignatureFields([v2])
  );
});

test("imageSignatureFields changes when install.type switches from npm to shell", async () => {
  const sandboxTools = await loadFreshEsm<SandboxToolsModule>("lib/sandbox/tools.js");

  const npm = { ...NPM_TOOL, id: "swap", install: { type: "npm" as const, cmd: "same-cmd" } };
  const shell = { ...NPM_TOOL, id: "swap", install: { type: "shell" as const, cmd: "same-cmd" } };

  assert.notDeepEqual(
    sandboxTools.imageSignatureFields([npm]),
    sandboxTools.imageSignatureFields([shell])
  );
});
