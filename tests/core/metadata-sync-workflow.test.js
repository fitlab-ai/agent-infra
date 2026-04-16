import test from "node:test";
import assert from "node:assert/strict";

import { read } from "../helpers.js";

const workflowTargets = [
  ".github/workflows/metadata-sync.yml",
  "templates/.github/workflows/metadata-sync.yml"
];

test("metadata-sync workflow template stays in sync with the root workflow", () => {
  const [rootPath, templatePath] = workflowTargets;

  assert.equal(read(rootPath), read(templatePath));
});

test("metadata-sync workflow listens to task comment create and edit events and skips PR comments", () => {
  workflowTargets.forEach((relativePath) => {
    const content = read(relativePath);

    assert.match(content, /issue_comment:\s*[\s\S]*types:\s*\[created, edited\]/, `${relativePath} should react to created and edited issue comments`);
    assert.match(content, /if: \$\{\{ !github\.event\.issue\.pull_request \}\}/, `${relativePath} should skip PR comment events`);
    assert.match(content, /<!-- sync-issue:TASK-\[0-9\]\{8\}-\[0-9\]\{6\}:task -->/, `${relativePath} should only process synced task comments`);
  });
});

test("metadata-sync workflow syncs type labels, milestones, and fallback issue types", () => {
  workflowTargets.forEach((relativePath) => {
    const content = read(relativePath);

    assert.match(content, /Checkout shared scripts/, `${relativePath} should check out the shared workflow scripts before syncing type labels`);
    assert.match(content, /\.github\/scripts\/sync-labels-to-set\.sh/, `${relativePath} should delegate type label sync to the shared script`);
    assert.match(content, /--prefix "type:"/, `${relativePath} should scope type label syncs to the type: prefix`);
    assert.match(content, /--target "\$TYPE_LABEL"/, `${relativePath} should pass the mapped type label as the target set`);
    assert.match(content, /dependency-upgrade\) +TYPE_LABEL="type: dependency-upgrade"/, `${relativePath} should map dependency-upgrade to the matching label`);
    assert.match(content, /--milestone "\$MILESTONE"/, `${relativePath} should sync milestone values from frontmatter`);
    assert.match(content, /feature\|enhancement\) ISSUE_TYPE="Feature"/, `${relativePath} should map feature-like task types to the Feature issue type`);
    assert.match(content, /\*\) +ISSUE_TYPE="Task"/, `${relativePath} should fall back to the Task issue type`);
  });
});

test("metadata-sync workflow only replaces type labels when the mapped label is known", () => {
  workflowTargets.forEach((relativePath) => {
    const content = read(relativePath);

    assert.match(
      content,
      /if \[ -n "\$TYPE_LABEL" \]; then[\s\S]*\.github\/scripts\/sync-labels-to-set\.sh[\s\S]*--prefix "type:"[\s\S]*--target "\$TYPE_LABEL"[\s\S]*fi/,
      `${relativePath} should skip removing labels when the type value has no known mapping`
    );
  });
});
