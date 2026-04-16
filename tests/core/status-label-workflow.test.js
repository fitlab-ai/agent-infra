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
    assert.match(content, /\.github\/scripts\/sync-labels-to-set\.sh[\s\S]*--prefix "status:"/, `${relativePath} should clean status labels through the shared script`);
  });
});

test("status-label workflow skips noop triage relabeling on reopen", () => {
  workflowTargets.forEach((relativePath) => {
    const content = read(relativePath);

    assert.match(content, /Checkout shared scripts/, `${relativePath} should check out the shared scripts before status sync runs`);
    assert.match(content, /\.github\/scripts\/sync-labels-to-set\.sh[\s\S]*--target "status: waiting-for-triage"/, `${relativePath} should delegate reopen relabeling to the shared script`);
    assert.doesNotMatch(content, /current_status_labels=\$\(gh issue view/, `${relativePath} should no longer inline the reopen diff logic`);
  });
});

test("status-label workflow clears merged issue status labels through the shared script", () => {
  workflowTargets.forEach((relativePath) => {
    const content = read(relativePath);

    assert.match(content, /Clean status labels on PR merge/, `${relativePath} should keep the PR merge cleanup step`);
    assert.match(content, /\.github\/scripts\/sync-labels-to-set\.sh[\s\S]*--issue "\$issue_number"[\s\S]*--prefix "status:"/, `${relativePath} should use the shared script for merge-triggered issue cleanup`);
  });
});
