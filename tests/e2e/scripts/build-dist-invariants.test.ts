import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { filePath } from "../../helpers.ts";

test("build does not emit dist/package.json", () => {
  assert.equal(
    fs.existsSync(filePath("dist/package.json")),
    false,
    "dist/package.json makes sync-templates resolve templates/ under dist/ instead of the package root (#365).",
  );
});
