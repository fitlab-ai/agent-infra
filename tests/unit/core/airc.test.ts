import test from "node:test";
import assert from "node:assert/strict";

import { read } from "../../helpers.ts";

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
    cli: ["bin/", "lib/", "src/", "tests/unit/cli/", "tests/integration/cli/", "tests/e2e/cli/"],
    templates: ["templates/", "tests/unit/templates/"],
    core: ["assets/", "scripts/", "tests/unit/core/", "tests/integration/core/", "tests/e2e/core/"],
    meta: [".agents/", ".github/", "tests/helpers/", "tests/unit/scripts/", "tests/integration/scripts/", "tests/e2e/scripts/"]
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

test(".agents/.airc.json declares requiresPullRequest=true for this project", () => {
  assert.equal(collaborator.requiresPullRequest, true);
});

const libDefaults = JSON.parse(read("lib/defaults.json"));

test("lib/defaults.json defaults requiresPullRequest to true", () => {
  assert.equal(libDefaults.requiresPullRequest, true);
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
