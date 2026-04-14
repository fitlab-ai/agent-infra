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

    assert.match(content, /select\(startswith\("type:"\)\)/, `${relativePath} should enumerate existing type labels before syncing`);
    assert.match(content, /--remove-label "\$label"/, `${relativePath} should remove stale type labels`);
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
      /if \[ -n "\$TYPE_LABEL" \]; then[\s\S]*select\(startswith\("type:"\)\)[\s\S]*--remove-label "\$label"[\s\S]*--add-label "\$TYPE_LABEL"[\s\S]*fi/,
      `${relativePath} should skip removing labels when the type value has no known mapping`
    );
  });
});
