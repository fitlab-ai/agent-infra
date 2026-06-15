import test from "node:test";
import assert from "node:assert/strict";

import { read } from "../../helpers.ts";

const skillsWithGating = [
  ".agents/skills/commit/SKILL.md",
  ".agents/skills/commit/reference/task-status-update.md",
  ".agents/skills/complete-task/SKILL.md",
  ".agents/skills/create-pr/SKILL.md",
  "templates/.agents/skills/commit/SKILL.en.md",
  "templates/.agents/skills/commit/reference/task-status-update.en.md",
  "templates/.agents/skills/complete-task/SKILL.en.md",
  "templates/.agents/skills/create-pr/SKILL.en.md",
  "templates/.agents/skills/commit/SKILL.zh-CN.md",
  "templates/.agents/skills/commit/reference/task-status-update.zh-CN.md",
  "templates/.agents/skills/complete-task/SKILL.zh-CN.md",
  "templates/.agents/skills/create-pr/SKILL.zh-CN.md"
];

for (const skillPath of skillsWithGating) {
  test(`${skillPath} references prFlow gating`, () => {
    const content = read(skillPath);
    assert.match(content, /prFlow/);
  });
}

const createPrPaths: Array<{ path: string; stopMarker: string }> = [
  { path: ".agents/skills/create-pr/SKILL.md", stopMarker: "立即停止" },
  { path: "templates/.agents/skills/create-pr/SKILL.zh-CN.md", stopMarker: "立即停止" },
  { path: "templates/.agents/skills/create-pr/SKILL.en.md", stopMarker: "stop immediately" }
];

for (const { path, stopMarker } of createPrPaths) {
  test(`${path} describes refusal path when prFlow is disabled`, () => {
    const content = read(path);
    const gateIndex = content.indexOf("prFlow");
    assert.ok(gateIndex >= 0, "prFlow mention required");

    const disabledIndex = content.indexOf("disabled", gateIndex);
    const stopIndex = content.indexOf(stopMarker, gateIndex);

    assert.ok(disabledIndex >= 0 && disabledIndex - gateIndex < 800,
      "expected `disabled` to appear near the prFlow mention");
    assert.ok(stopIndex >= 0 && stopIndex - gateIndex < 800,
      `expected refusal language (${stopMarker}) to appear near the prFlow mention`);
  });
}
