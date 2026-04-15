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

test("status-label workflow skips noop triage relabeling on reopen", () => {
  workflowTargets.forEach((relativePath) => {
    const content = read(relativePath);

    assert.match(content, /current_status_labels=\$\(gh issue view/, `${relativePath} should cache current status labels before diffing`);
    assert.match(content, /if \[ "\$label" != "status: waiting-for-triage" \]; then[\s\S]*--remove-label "\$label"/, `${relativePath} should only remove stale status labels on reopen`);
    assert.match(content, /if ! printf '%s\\n' "\$current_status_labels" \| grep -qxF "status: waiting-for-triage"; then[\s\S]*--add-label "status: waiting-for-triage"/, `${relativePath} should only add the triage label when it is missing`);
  });
});
