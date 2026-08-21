import test from "node:test";
import assert from "node:assert/strict";

import { read } from "../../helpers.ts";
import { normalizeAgentClients } from "../../../lib/agent-clients/config.ts";
import { parseCustomTools, resolveTools } from "../../../lib/sandbox/tools.ts";

const collaborator = JSON.parse(read(".agents/.airc.json"));
const merged = collaborator.files.merged;
const managed = collaborator.files.managed;
const GIT_LFS_INSTALL_COMMAND = [
  "set -eu",
  "version=3.7.1",
  "case \"$(uname -m)\" in",
  "  x86_64) arch=amd64; sha256=1c0b6ee5200ca708c5cebebb18fdeb0e1c98f1af5c1a9cba205a4c0ab5a5ec08 ;;",
  "  aarch64|arm64) arch=arm64; sha256=73a9c90eeb4312133a63c3eaee0c38c019ea7bfa0953d174809d25b18588dd8d ;;",
  "  *) echo \"Unsupported Git LFS architecture: $(uname -m)\" >&2; exit 1 ;;",
  "esac",
  "archive=\"git-lfs-linux-${arch}-v${version}.tar.gz\"",
  "tmp_dir=\"$(mktemp -d)\"",
  "trap 'rm -rf \"$tmp_dir\"' EXIT",
  "curl -fsSL \"https://github.com/git-lfs/git-lfs/releases/download/v${version}/${archive}\" -o \"$tmp_dir/$archive\"",
  "printf '%s  %s\\n' \"$sha256\" \"$tmp_dir/$archive\" | sha256sum -c -",
  "tar -xzf \"$tmp_dir/$archive\" -C \"$tmp_dir\"",
  "mkdir -p /home/devuser/.npm-global/bin",
  "install -m 0755 \"$tmp_dir/git-lfs-${version}/git-lfs\" /home/devuser/.npm-global/bin/git-lfs"
].join("\n");

test(".agents/.airc.json does not declare templateSource", () => {
  assert.ok(!("templateSource" in collaborator));
});

test(".agents/.airc.json does not contain license field", () => {
  assert.ok(!("license" in collaborator), "license field should not exist in .agents/.airc.json");
});

test(".agents/.airc.json declares labels.in mapping for module labels", () => {
  assert.deepEqual(collaborator.labels.in, {
    cli: ["bin/", "lib/", "src/", "tests/unit/cli/", "tests/integration/cli/", "tests/e2e/cli/"],
    templates: ["templates/", "tests/unit/templates/"],
    core: ["assets/", "scripts/", "tests/unit/core/", "tests/integration/core/", "tests/e2e/core/"],
    meta: [".agents/", ".github/", "tests/helpers/", "tests/unit/scripts/", "tests/integration/scripts/", "tests/e2e/scripts/"]
  });
});

test(".agents/.airc.json declares default sandbox configuration", () => {
  assert.deepEqual(collaborator.sandbox, {
    engine: { darwin: "orbstack" },
    runtimes: ["node22"],
    tools: ["agent-infra", "git-lfs"],
    customTools: [
      {
        id: "git-lfs",
        name: "Git LFS",
        install: { type: "shell", cmd: GIT_LFS_INSTALL_COMMAND },
        versionCmd: "git lfs version",
        setupHint: "Git LFS should be installed in the sandbox image."
      }
    ],
    dockerfile: null,
    vm: { cpu: null, memory: null, disk: null }
  });
});

test(".agents/.airc.json declares canonical Agent Client configuration", () => {
  assert.deepEqual(collaborator.agentClients, [
    { id: "claude-code", enabled: true, installInSandbox: true },
    { id: "codex", enabled: true, installInSandbox: true },
    { id: "antigravity-cli", enabled: true, installInSandbox: false },
    { id: "opencode", enabled: true, installInSandbox: true }
  ]);
});

test(".agents/.airc.json resolves every selected sandbox tool", () => {
  const customTools = parseCustomTools(collaborator.sandbox.customTools, { home: "/tmp" });
  const agentClients = normalizeAgentClients(collaborator);
  const tools = resolveTools({
    home: "/tmp",
    project: collaborator.project,
    tools: collaborator.sandbox.tools,
    customTools,
    agentClientState: agentClients.state
  });

  assert.deepEqual(
    tools.map((tool) => tool.id),
    ["agent-infra", "claude-code", "codex", "opencode", "git-lfs"]
  );
  const gitLfs = tools.find((tool) => tool.id === "git-lfs");
  assert.deepEqual(gitLfs?.install, { type: "shell", cmd: GIT_LFS_INSTALL_COMMAND });
  assert.equal(gitLfs?.versionCmd, "git lfs version");
});

test(".agents/.airc.json declares github as the default platform", () => {
  assert.deepEqual(collaborator.platform, { type: "github" });
});

test(".agents/.airc.json declares prFlow=required for this project", () => {
  assert.equal(collaborator.prFlow, "required");
});

const mergedPresent = [
  ".git-hooks/pre-commit",
  "**/test.*",
  "**/test-integration.*",
  "**/release.*",
  "**/upgrade-dependency.*",
  ".agents/rules/testing-discipline.*",
  ".agents/skills/test/SKILL.*",
  ".agents/skills/test-integration/SKILL.*",
  ".agents/skills/release/SKILL.*",
  ".agents/skills/upgrade-dependency/SKILL.*"
];

const mergedAbsent = [
  "*/test.*",
  "*/test-integration.*",
  "*/release.*",
  "*/upgrade-dependency.*",
  ".mailmap"
];

for (const pattern of mergedPresent) {
  test(`.agents/.airc.json merged includes \`${pattern}\``, () => {
    assert.ok(merged.includes(pattern));
  });
}

for (const pattern of mergedAbsent) {
  test(`.agents/.airc.json merged excludes \`${pattern}\``, () => {
    assert.ok(!merged.includes(pattern));
  });
}

const managedPresent = [
  ".git-hooks/check-large-files.cjs",
  ".git-hooks/check-version-format.sh",
  ".agents/scripts/",
  ".agents/hooks/",
  ".codex/hooks.json"
];

const managedAbsent = [
  ".codex/commands/",
  ".codex/scripts/",
  ".editorconfig"
];

for (const pattern of managedPresent) {
  test(`.agents/.airc.json managed includes \`${pattern}\``, () => {
    assert.ok(managed.includes(pattern));
  });
}

for (const pattern of managedAbsent) {
  test(`.agents/.airc.json managed excludes \`${pattern}\``, () => {
    assert.ok(!managed.includes(pattern));
  });
}
