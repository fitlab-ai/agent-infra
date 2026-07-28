import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { filePath } from "../../helpers.ts";
import defaults from "../../../lib/defaults.json" with { type: "json" };
import {
  createAgentClientManifest
} from "../../../lib/agent-clients/registry.ts";
import {
  CUSTOM_TUI_CONTRACT
} from "../../../lib/agent-clients/custom-tuis.ts";

function readGeneratedManifest(target: string) {
  const generated = fs.readFileSync(filePath(target), "utf8");
  const match = generated.match(
    /const AGENT_CLIENT_MANIFEST = (\[[\s\S]*?\n\]);\nconst CUSTOM_TUI_CONTRACT/
  );
  assert.ok(match, `expected generated manifest in ${target}`);
  return JSON.parse(match[1]!);
}

function readGeneratedCustomTUIContract(target: string) {
  const generated = fs.readFileSync(filePath(target), "utf8");
  const match = generated.match(
    /const CUSTOM_TUI_CONTRACT = (\{[\s\S]*?\n\});\nconst AGENT_INFRA_SANDBOX_TOOL/
  );
  assert.ok(match, `expected generated custom TUI contract in ${target}`);
  return JSON.parse(match[1]!);
}

test("src/sync-templates.js has one Agent Client manifest build placeholder", () => {
  const src = fs.readFileSync(filePath("src/sync-templates.js"), "utf8");
  assert.equal(
    src.match(/const AGENT_CLIENT_MANIFEST = JSON\.parse\('__AGENT_CLIENT_MANIFEST__'\);/g)?.length,
    1
  );
  assert.equal(
    src.match(/const CUSTOM_TUI_CONTRACT = JSON\.parse\('__CUSTOM_TUI_CONTRACT__'\);/g)?.length,
    1
  );
});

test("generated standalone scripts project the Registry manifest", () => {
  const expected = createAgentClientManifest();
  const targets = [
    "templates/.agents/skills/update-agent-infra/scripts/sync-templates.js",
    ".agents/skills/update-agent-infra/scripts/sync-templates.js"
  ];

  for (const target of targets) {
    assert.deepEqual(readGeneratedManifest(target), expected);
    assert.deepEqual(readGeneratedCustomTUIContract(target), CUSTOM_TUI_CONTRACT);
  }
});

test("legacy defaults contain the Registry client IDs after agent-infra", () => {
  assert.deepEqual(
    defaults.sandbox.tools,
    ["agent-infra", ...createAgentClientManifest().map((entry) => entry.id)]
  );
});

test("inline build staging leaves existing targets untouched when preparation fails", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-inline-failure-"));
  const write = (relativePath: string, content: string | Buffer) => {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };

  try {
    write("package.json", '{"type":"module"}\n');
    write("scripts/build-inline.js", fs.readFileSync(filePath("scripts/build-inline.js")));
    write("lib/defaults.json", "{}\n");
    write(
      "src/sync-templates.js",
      [
        "import {} from '../.agents/scripts/lib/agent-infra-package.js';",
        "const DEFAULTS = JSON.parse(",
        "  fs.readFileSync(new URL('../lib/defaults.json', import.meta.url), 'utf8')",
        ");",
        "const AGENT_CLIENT_MANIFEST = JSON.parse('__AGENT_CLIENT_MANIFEST__');",
        "const CUSTOM_TUI_CONTRACT = JSON.parse('__CUSTOM_TUI_CONTRACT__');",
        ""
      ].join("\n")
    );
    write(
      "dist/lib/agent-clients/registry.js",
      [
        "const entry = {",
        "  id: 'codex', displayName: 'Codex', invocation: '$${skillName}',",
        "  ownedPathPrefixes: ['.codex/'], managed: [], merged: [], ejected: []",
        "};",
        "export const AGENT_CLIENT_REGISTRY = { codex: entry };",
        "export function createAgentClientManifest() { return [entry]; }",
        ""
      ].join("\n")
    );
    write(
      "dist/lib/agent-clients/custom-tuis.js",
      "export const CUSTOM_TUI_CONTRACT = { requiredFields: ['name', 'dir', 'invoke'], allowedPlaceholders: ['skillName', 'projectName'] };\n"
    );

    const firstTarget = path.join(
      root,
      "templates/.agents/skills/update-agent-infra/scripts/sync-templates.js"
    );
    write(
      "templates/.agents/skills/update-agent-infra/scripts/sync-templates.js",
      "original\n"
    );
    fs.writeFileSync(path.join(root, ".agents"), "blocks target directory");

    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts/build-inline.js")],
      { cwd: root, encoding: "utf8" }
    );

    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(firstTarget, "utf8"), "original\n");
    assert.deepEqual(
      fs.readdirSync(path.dirname(firstTarget)).filter((name) => name.includes(".tmp-")),
      []
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
