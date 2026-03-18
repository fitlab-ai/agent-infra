import test from "node:test";
import assert from "node:assert/strict";

import { read } from "./helpers.js";

test(".airc.json declares templates as the template source", () => {
  const collaborator = JSON.parse(read(".airc.json"));

  assert.equal(collaborator.templateSource, "templates/");
});

test(".airc.json merged patterns use recursive command globs and explicit skill paths", () => {
  const collaborator = JSON.parse(read(".airc.json"));
  const merged = collaborator.files.merged;

  [
    "**/test.*",
    "**/test-integration.*",
    "**/release.*",
    "**/upgrade-dependency.*",
    ".agents/skills/test/SKILL.*",
    ".agents/skills/test-integration/SKILL.*",
    ".agents/skills/release/SKILL.*",
    ".agents/skills/upgrade-dependency/SKILL.*"
  ].forEach((pattern) => {
    assert.ok(merged.includes(pattern), `merged should include ${pattern}`);
  });

  [
    "*/test.*",
    "*/test-integration.*",
    "*/release.*",
    "*/upgrade-dependency.*"
  ].forEach((pattern) => {
    assert.ok(!merged.includes(pattern), `merged should not include legacy ${pattern}`);
  });
});

test(".airc.json does not contain license field", () => {
  const collaborator = JSON.parse(read(".airc.json"));

  assert.ok(!("license" in collaborator), "license field should not exist in .airc.json");
});

test(".airc.json excludes deprecated codex prompt paths", () => {
  const collaborator = JSON.parse(read(".airc.json"));

  assert.ok(
    !collaborator.files.managed.includes(".codex/commands/"),
    ".codex/commands/ should not be in managed list"
  );
  assert.ok(
    !collaborator.files.managed.includes(".codex/scripts/"),
    ".codex/scripts/ should not be in managed list"
  );
});
