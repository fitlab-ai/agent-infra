import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { read } from "../../helpers.ts";

const TIERS = ["unit", "integration", "e2e"] as const;

function listTestFiles(): string[] {
  const result: string[] = [];
  function walk(dir: string) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (full.endsWith(".test.ts")) {
        result.push(full);
      }
    }
  }
  walk("tests");
  return result;
}

test("every test file lives under a tier directory", () => {
  for (const f of listTestFiles()) {
    const ok = TIERS.some((tier) => f.startsWith(path.join("tests", tier) + path.sep));
    assert.ok(ok, `test file ${f} is not under tests/{unit,integration,e2e}/`);
  }
});

test("test:smoke script targets unit tier only", () => {
  const pkg = JSON.parse(read("package.json"));
  const smoke = pkg.scripts["test:smoke"];
  assert.match(smoke, /tests\/unit\/\*\*\/\*\.test\.ts/);
  assert.ok(!/tests\/integration|tests\/e2e/.test(smoke),
    "test:smoke must not include integration/e2e globs");
});

test("test:core script targets unit and integration tiers", () => {
  const pkg = JSON.parse(read("package.json"));
  const core = pkg.scripts["test:core"];
  assert.match(core, /tests\/unit\/\*\*\/\*\.test\.ts/);
  assert.match(core, /tests\/integration\/\*\*\/\*\.test\.ts/);
  assert.ok(!/tests\/e2e/.test(core),
    "test:core must not include e2e glob");
});

test("test script targets all tiers", () => {
  const pkg = JSON.parse(read("package.json"));
  const full = pkg.scripts.test;
  const allTiers = /tests\/\*\*\/\*\.test\.ts/.test(full)
    || (/tests\/unit\//.test(full) && /tests\/integration\//.test(full) && /tests\/e2e\//.test(full));
  assert.ok(allTiers, "test script must include all three tiers (or tests/**)");
});
