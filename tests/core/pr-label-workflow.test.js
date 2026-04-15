import test from "node:test";
import assert from "node:assert/strict";

import { read } from "../helpers.js";

const workflowTargets = [
  ".github/workflows/pr-label.yml",
  "templates/.github/workflows/pr-label.yml"
];

test("pr-label workflow template stays in sync with the root workflow", () => {
  const [rootPath, templatePath] = workflowTargets;

  assert.equal(read(rootPath), read(templatePath));
});

test("pr-label workflow reacts to PR open and synchronize events", () => {
  workflowTargets.forEach((relativePath) => {
    const content = read(relativePath);

    assert.match(content, /pull_request_target:\s*[\s\S]*types:\s*\[opened, synchronize\]/, `${relativePath} should react to opened and synchronize events`);
    assert.match(content, /group: pr-label-\$\{\{ github\.event\.pull_request\.number \}\}/, `${relativePath} should serialize runs per PR`);
  });
});

test("pr-label workflow syncs in: labels from .airc.json mappings and backfills assignees", () => {
  workflowTargets.forEach((relativePath) => {
    const content = read(relativePath);

    assert.match(content, /jq '\.labels\.in \/\/ \{\}' \.agents\/\.airc\.json/, `${relativePath} should read labels.in from .agents/.airc.json`);
    assert.match(content, /startswith\(\$prefix\)/, `${relativePath} should match changed files by configured path prefixes`);
    assert.match(content, /select\(startswith\("in: "\)\)/, `${relativePath} should only manage concrete in: labels`);
    assert.match(content, /--add-label "\$label"/, `${relativePath} should add missing module labels`);
    assert.match(content, /--remove-label "\$label"/, `${relativePath} should remove stale module labels`);
    assert.match(content, /issues: write/, `${relativePath} should request issue write permission for PR labels`);
    assert.match(content, /pull-requests: write/, `${relativePath} should request pull request write permission for assignee updates`);
    assert.match(content, /ASSIGNEES_JSON: \$\{\{ toJSON\(github\.event\.pull_request\.assignees\) \}\}/, `${relativePath} should inspect current assignees from the event payload`);
    assert.match(content, /--add-assignee "\$CREATOR"/, `${relativePath} should assign the PR creator when no assignee exists`);
  });
});
