import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { filePath } from "../../helpers.ts";
import * as builtinTuis from "../../../lib/builtin-tuis.ts";

// Source-of-truth check: ensure src/sync-templates.js (vendored standalone
// script) keeps BUILTIN_TUI_* constants in lockstep with lib/builtin-tuis.ts.
// If this test fails, edit both files together.
test("src/sync-templates.js BUILTIN_TUI_IDS matches lib/builtin-tuis.ts", () => {
  const src = fs.readFileSync(filePath("src/sync-templates.js"), "utf8");
  const idsMatch = src.match(/const BUILTIN_TUI_IDS = (\[[^\]]+\]);/m);
  assert.ok(idsMatch, "expected BUILTIN_TUI_IDS literal in src/sync-templates.js");
  const ids = JSON.parse(idsMatch![1]!.replace(/'/g, '"'));
  assert.deepEqual(ids, [...builtinTuis.BUILTIN_TUI_IDS]);
});

test("src/sync-templates.js BUILTIN_TUI_OWNED_PATH_PREFIXES matches lib/builtin-tuis.ts", () => {
  const src = fs.readFileSync(filePath("src/sync-templates.js"), "utf8");
  const blockMatch = src.match(/const BUILTIN_TUI_OWNED_PATH_PREFIXES = (\{[\s\S]*?\});/m);
  assert.ok(blockMatch, "expected BUILTIN_TUI_OWNED_PATH_PREFIXES literal in src/sync-templates.js");
  // Convert the JS object literal to JSON: quote keys and use double quotes.
  const normalized = blockMatch![1]!
    .replace(/'([^']*)'/g, '"$1"')
    .replace(/([{,]\s*)([a-zA-Z_][\w-]*)\s*:/g, '$1"$2":')
    .replace(/,(\s*[}\]])/g, '$1');
  const parsed = JSON.parse(normalized);
  assert.deepEqual(parsed, builtinTuis.BUILTIN_TUI_OWNED_PATH_PREFIXES);
});
