import test from "node:test";
import assert from "node:assert/strict";

import { getDefaults } from "../../../lib/platform/verification-sync.ts";

test("typed platform verification exposes default status labels and markers", () => {
  const defaults = getDefaults();
  assert.equal(defaults.statusLabels.inProgress, "status: in-progress");
  assert.equal(defaults.statusLabels.pendingDesignWork, "status: pending-design-work");
  assert.equal(defaults.statusLabels.waitingForTriage, "status: waiting-for-triage");
  assert.equal(defaults.markers.task, "<!-- sync-issue:{task-id}:task -->");
  assert.equal(defaults.markers.artifact, "<!-- sync-issue:{task-id}:{artifact-stem} -->");
  assert.equal(defaults.markers.artifactChunk, "<!-- sync-issue:{task-id}:{artifact-stem}:{part}/{total} -->");
  assert.equal(defaults.markers.prSummary, "<!-- sync-pr:{task-id}:summary -->");
});
