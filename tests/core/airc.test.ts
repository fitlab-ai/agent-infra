import test from "node:test";
import assert from "node:assert/strict";

import { read } from "../helpers.ts";

const collaborator = JSON.parse(read(".agents/.airc.json"));
const merged = collaborator.files.merged;
const managed = collaborator.files.managed;

test(".agents/.airc.json does not declare templateSource", () => {
  assert.ok(!("templateSource" in collaborator));
});

test(".agents/.airc.json does not contain license field", () => {
  assert.ok(!("license" in collaborator), "license field should not exist in .agents/.airc.json");
});

test(".agents/.airc.json declares labels.in mapping for module labels", () => {
  assert.deepEqual(collaborator.labels.in, {
    cli: ["bin/", "lib/", "src/", "tests/cli/"],
    templates: ["templates/", "tests/templates/"],
    core: ["assets/", "scripts/", "tests/core/"],
    meta: [".agents/", ".github/", "tests/helpers/", "tests/scripts/"]
  });
});

test(".agents/.airc.json declares default sandbox configuration", () => {
  assert.deepEqual(collaborator.sandbox, {
    engine: "orbstack",
    runtimes: ["node22"],
    tools: ["claude-code", "codex", "gemini-cli", "opencode"],
    dockerfile: null,
    vm: { cpu: null, memory: null, disk: null }
  });
});

test(".agents/.airc.json declares github as the default platform", () => {
  assert.deepEqual(collaborator.platform, { type: "github" });
});

const mergedPresent = [
  ".git-hooks/pre-commit",
  "**/test.*",
  "**/test-integration.*",
  "**/release.*",
  "**/upgrade-dependency.*",
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
