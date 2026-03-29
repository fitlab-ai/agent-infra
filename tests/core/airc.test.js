import test from "node:test";
import assert from "node:assert/strict";

import { read } from "../helpers.js";

test(".agents/.airc.json does not declare templateSource", () => {
  const collaborator = JSON.parse(read(".agents/.airc.json"));

  assert.ok(!("templateSource" in collaborator));
});

test(".agents/.airc.json merged patterns use recursive command globs and explicit skill paths", () => {
  const collaborator = JSON.parse(read(".agents/.airc.json"));
  const merged = collaborator.files.merged;

  [
    ".github/hooks/pre-commit",
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

test(".agents/.airc.json does not contain license field", () => {
  const collaborator = JSON.parse(read(".agents/.airc.json"));

  assert.ok(!("license" in collaborator), "license field should not exist in .agents/.airc.json");
});

test(".agents/.airc.json declares labels.in mapping for module labels", () => {
  const collaborator = JSON.parse(read(".agents/.airc.json"));

  assert.deepEqual(collaborator.labels.in, {
    cli: ["bin/", "lib/", "src/", "tests/cli/"],
    templates: ["templates/", "tests/templates/"],
    core: ["scripts/", "assets/", "tests/core/"]
  });
});

test(".agents/.airc.json excludes deprecated codex prompt paths", () => {
  const collaborator = JSON.parse(read(".agents/.airc.json"));

  assert.ok(
    collaborator.files.managed.includes(".github/hooks/check-version-format.sh"),
    ".github/hooks/check-version-format.sh should be in managed list"
  );
  assert.ok(
    collaborator.files.managed.includes(".agents/scripts/"),
    ".agents/scripts/ should be in managed list"
  );
  assert.ok(
    collaborator.files.managed.includes(".claude/hooks/"),
    ".claude/hooks/ should be in managed list"
  );
  assert.ok(
    !collaborator.files.managed.includes(".codex/commands/"),
    ".codex/commands/ should not be in managed list"
  );
  assert.ok(
    !collaborator.files.managed.includes(".codex/scripts/"),
    ".codex/scripts/ should not be in managed list"
  );
  assert.ok(
    !collaborator.files.managed.includes(".editorconfig"),
    ".editorconfig should not be in managed list"
  );
  assert.ok(
    !collaborator.files.merged.includes(".mailmap"),
    ".mailmap should not be in merged list"
  );
});
