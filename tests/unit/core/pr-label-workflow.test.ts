import test from "node:test";
import assert from "node:assert/strict";

import { read } from "../../helpers.ts";

const workflowTargets = [
  ".github/workflows/pr-label.yml",
  "templates/.github/workflows/pr-label.yml"
];

test("pr-label workflow uses the checked-in core and the template package core", () => {
  const root = read(workflowTargets[0]!);
  const template = read(workflowTargets[1]!);
  assert.match(root, /actions\/setup-node@v7/);
  assert.match(root, /npm ci --ignore-scripts/);
  assert.match(root, /npm run build/);
  assert.match(root, /node dist\/bin\/internal-cli\.js platform-pr sync-in-labels --pr "\$PR_NUMBER"/);
  assert.match(template, /npm exec --yes --package="@fitlab-ai\/agent-infra@\$AGENT_INFRA_VERSION" -- agent-infra-internal platform-pr sync-in-labels/);
  assert.match(template, /AGENT_INFRA_VERSION: 0\.9\.13-alpha\.0/);
});

test("pr-label workflow reacts to PR open and synchronize events", () => {
  workflowTargets.forEach((relativePath) => {
    const content = read(relativePath);

    assert.match(content, /pull_request_target:\s*[\s\S]*types:\s*\[opened, synchronize\]/, `${relativePath} should react to opened and synchronize events`);
    assert.match(content, /group: pr-label-\$\{\{ github\.event\.pull_request\.number \}\}/, `${relativePath} should serialize runs per PR`);
  });
});

test("pr-label workflow delegates in-label authority and backfills assignees", () => {
  workflowTargets.forEach((relativePath) => {
    const content = read(relativePath);

    assert.match(content, /--pr "\$PR_NUMBER"/, `${relativePath} should sync labels against the PR target`);
    assert.match(content, /platform-pr sync-in-labels/, `${relativePath} should use the typed in-label intent`);
    assert.match(content, /issues: write/, `${relativePath} should request issue write permission for PR labels`);
    assert.match(content, /pull-requests: write/, `${relativePath} should request pull request write permission for assignee updates`);
    assert.match(content, /ASSIGNEES_JSON: \$\{\{ toJSON\(github\.event\.pull_request\.assignees\) \}\}/, `${relativePath} should inspect current assignees from the event payload`);
    assert.match(content, /--add-assignee "\$CREATOR"/, `${relativePath} should assign the PR creator when no assignee exists`);
  });
});
