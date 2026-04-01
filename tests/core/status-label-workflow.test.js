import test from "node:test";
import assert from "node:assert/strict";

import { read } from "../helpers.js";

const workflowTargets = [
  ".github/workflows/status-label.yml",
  "templates/.github/workflows/status-label.yml"
];

test("status-label workflow only removes status labels for completed issue closes", () => {
  workflowTargets.forEach((relativePath) => {
    const content = read(relativePath);

    assert.match(
      content,
      /- name: Remove status labels on issue close[\s\S]*github\.event\.issue\.state_reason == 'completed'/,
      `${relativePath} should gate issue-close cleanup on completed state_reason`
    );
  });
});
