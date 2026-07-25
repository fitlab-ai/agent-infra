import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

import { filePath, gitSafeEnv } from "../../helpers.ts";

test("canonical demo is configured for Git LFS and satisfies the asset contract", () => {
  const gifPath = filePath("assets/demo-init.gif");
  const gif = fs.readFileSync(gifPath);
  const attributes = spawnSync(
    "git",
    ["check-attr", "filter", "diff", "merge", "text", "--", "assets/demo-init.gif"],
    { cwd: filePath("."), encoding: "utf8", env: gitSafeEnv() }
  );

  assert.equal(attributes.status, 0, attributes.stderr);
  assert.deepEqual(
    attributes.stdout.trim().split("\n").map((line) => line.slice(line.lastIndexOf(": ") + 2)),
    ["lfs", "lfs", "lfs", "unset"]
  );
  assert.ok(gif.subarray(0, 6).equals(Buffer.from("GIF87a")) || gif.subarray(0, 6).equals(Buffer.from("GIF89a")));
  assert.ok(gif.byteLength <= 4 * 1024 * 1024);
  assert.equal(fs.readFileSync(filePath("assets/demo-init.inputs.sha256"), "utf8").trim().length, 64);
  for (const readme of ["README.md", "README.zh-CN.md"]) {
    const content = fs.readFileSync(filePath(readme), "utf8");
    assert.equal(content.includes('src="./assets/demo-init.gif"'), true);
  }
});
