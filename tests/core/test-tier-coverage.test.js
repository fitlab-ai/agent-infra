import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { read } from "../helpers.js";

const SCRIPT_REGEX = /node --test\s+(.+?)$/;

function extractTestFiles(scriptValue) {
  const match = scriptValue.match(SCRIPT_REGEX);
  if (!match) {
    return [];
  }

  return match[1]
    .split(/\s+/)
    .filter(Boolean)
    .filter((arg) => arg.endsWith(".test.js") || arg.includes("*"));
}

test("test:smoke files all exist on disk", () => {
  const pkg = JSON.parse(read("package.json"));
  const files = extractTestFiles(pkg.scripts["test:smoke"]);
  assert.ok(files.length > 0, "test:smoke should list at least one path");

  for (const file of files) {
    if (file.includes("*")) {
      continue;
    }
    assert.ok(fs.existsSync(file), `test:smoke references missing file: ${file}`);
  }
});

test("test:core files all exist on disk", () => {
  const pkg = JSON.parse(read("package.json"));
  const files = extractTestFiles(pkg.scripts["test:core"]);
  assert.ok(files.length > 0, "test:core should list at least one path");

  for (const file of files) {
    if (file.includes("*")) {
      continue;
    }
    assert.ok(fs.existsSync(file), `test:core references missing file: ${file}`);
  }
});

test("test:core is a strict superset of test:smoke", () => {
  const pkg = JSON.parse(read("package.json"));
  const smoke = new Set(extractTestFiles(pkg.scripts["test:smoke"]));
  const core = new Set(extractTestFiles(pkg.scripts["test:core"]));

  assert.ok(core.size > smoke.size, "test:core should add files beyond smoke");
  for (const file of smoke) {
    assert.ok(core.has(file), `test:core missing smoke file: ${file}`);
  }
});

test("test:core does not include slow contract suites reserved for full layer", () => {
  const pkg = JSON.parse(read("package.json"));
  const core = pkg.scripts["test:core"];
  const fullOnly = [
    "tests/core/validate-artifact.test.js",
    "tests/core/sync-labels-script.test.js",
    "tests/core/archive-tasks.test.js",
  ];

  for (const file of fullOnly) {
    assert.ok(
      !core.includes(file),
      `test:core must not include slow contract suite ${file}; reserved for full layer`,
    );
  }
});
