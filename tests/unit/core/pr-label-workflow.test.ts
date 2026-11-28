import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";

import { read } from "../../helpers.ts";

const root = parse(read(".github/workflows/pr-label.yml"));
const template = parse(read("templates/.github/workflows/pr-label.yml"));

test("PR label workflows preserve the PR event and concurrency contract", () => {
  for (const workflow of [root, template]) {
    assert.deepEqual(workflow.on.pull_request_target.types, ["opened", "synchronize"]);
    assert.equal(workflow.concurrency.group, "pr-label-${{ github.event.pull_request.number }}");
    assert.equal(workflow.concurrency["cancel-in-progress"], true);
  }
});

test("repository PR label workflow uses trusted source without dependency artifacts", () => {
  const job = root.jobs["label-and-assign"];
  assert.equal(job.permissions.issues, "write");
  assert.equal(job.permissions["pull-requests"], "write");
  const checkout = job.steps.find((step: any) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "${{ github.sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  assert.ok(job.steps.some((step: any) => step.run?.includes(".github/scripts/sync-pr-in-labels.ts")));
});
