import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { filePath } from "../../helpers.ts";
import defaults from "../../../lib/defaults.json" with { type: "json" };
import {
  createAgentClientManifest
} from "../../../lib/agent-clients/registry.ts";

function readGeneratedManifest(target: string) {
  const generated = fs.readFileSync(filePath(target), "utf8");
  const match = generated.match(
    /const AGENT_CLIENT_MANIFEST = (\[[\s\S]*?\n\]);\nconst AGENT_INFRA_SANDBOX_TOOL/
  );
  assert.ok(match, `expected generated manifest in ${target}`);
  return JSON.parse(match[1]!);
}

test("src/sync-templates.js has one Agent Client manifest build placeholder", () => {
  const src = fs.readFileSync(filePath("src/sync-templates.js"), "utf8");
  assert.equal(
    src.match(/const AGENT_CLIENT_MANIFEST = JSON\.parse\('__AGENT_CLIENT_MANIFEST__'\);/g)?.length,
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
  }
});

test("legacy defaults contain the Registry client IDs after agent-infra", () => {
  assert.deepEqual(
    defaults.sandbox.tools,
    ["agent-infra", ...createAgentClientManifest().map((entry) => entry.id)]
  );
});
