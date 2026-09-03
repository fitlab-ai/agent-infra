import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerPlatformAdapter } from "../../../lib/platform/adapters.ts";
import { platformResult } from "../../../lib/platform/types.ts";
import { check, evaluateRequiredChecks } from "../../../lib/platform/verification-required.ts";
import { buildBoundFact, buildUnboundFact, encodePrDeliveryFact } from "../../../lib/task/pr-delivery-fact.ts";

const shared = {
  passResult: (type: string, message: string) => ({ type, status: "pass", message }),
  failResult: (type: string, message: string, failType?: string) => ({ type, status: "fail", message, fail_type: failType }),
  blockedResult: (type: string, message: string, failType?: string) => ({ type, status: "blocked", message, fail_type: failType })
};

const SHA = "a".repeat(40);
const BOUND_FACT = encodePrDeliveryFact(buildBoundFact({
  identity: { resource: { kind: "number", value: 42 }, repository: "acme/widgets", url: "https://github.com/acme/widgets/pull/42", head: { repository: "acme/widgets", ref: "feature", sha: SHA }, base: { repository: "acme/widgets", ref: "main", sha: "b".repeat(40) } },
  source: "created", verifiedAt: "2026-01-01T00:00:00.000Z", remoteState: "open"
}));
const UNBOUND_FACT = encodePrDeliveryFact(buildUnboundFact());

function evaluate(overrides: Record<string, unknown> = {}) {
  return evaluateRequiredChecks({
    metadata: { id: "TASK-20260101-000001", pr_delivery_fact: BOUND_FACT, last_reviewed_commit: SHA },
    localHead: SHA,
    inspection: {
      status: "no-op",
      pullRequest: { number: 42, headSha: SHA },
      checks: { state: "passed", required: [] },
      error: null
    },
    ...overrides
  }, shared);
}

test("required-checks passes when the reviewed, local, and PR heads match a successful checks snapshot", () => {
  assert.equal(evaluate().status, "pass");
  assert.equal(evaluate({
    inspection: {
      status: "no-op",
      pullRequest: { number: 42, headSha: SHA },
      checks: { state: "no-required", required: [] },
      error: null
    }
  }).status, "pass");
});

test("required-checks fails closed when any head differs", () => {
  assert.equal(evaluate({ localHead: "b".repeat(40) }).status, "fail");
  assert.equal(evaluate({ metadata: { id: "TASK-20260101-000001", pr_delivery_fact: BOUND_FACT, last_reviewed_commit: "b".repeat(40) } }).status, "fail");
  assert.equal(evaluate({
    inspection: {
      status: "no-op",
      pullRequest: { number: 42, headSha: "b".repeat(40) },
      checks: { state: "passed", required: [] },
      error: null
    }
  }).status, "fail");
});

test("required-checks accepts only a verified merged-equivalent relation", () => {
  const result = evaluate({
    localHead: "b".repeat(40),
    relation: { status: "merged-equivalent", reviewedHead: SHA, mergeCommit: "b".repeat(40) }
  });
  assert.equal(result.status, "pass");
  assert.match(result.message, /verified squash merge equivalence/);

  assert.equal(evaluate({
    localHead: "b".repeat(40),
    relation: { status: "failed", message: "squash content mismatch" }
  }).status, "fail");
  assert.equal(evaluate({
    localHead: "b".repeat(40),
    relation: { status: "blocked", message: "merge object missing" }
  }).status, "blocked");
});

test("required-checks preserves pending and unavailable snapshots as blocked", () => {
  assert.equal(evaluate({
    inspection: {
      status: "blocked",
      pullRequest: { number: 42, headSha: SHA },
      checks: { state: "pending", required: [] },
      error: { message: "checks pending" }
    }
  }).status, "blocked");
  assert.equal(evaluate({
    inspection: {
      status: "blocked",
      pullRequest: null,
      checks: { state: "pending", required: [] },
      error: { message: "network unavailable" }
    }
  }).status, "blocked");
});

test("required-checks preserves the original platform failure", () => {
  const result = evaluate({
    inspection: {
      status: "failed",
      pullRequest: null,
      checks: { state: "pending", required: [] },
      error: { message: "Task TASK-20260101-000001 not found" }
    }
  });

  assert.deepEqual(result, {
    type: "required-checks",
    status: "fail",
    message: "Task TASK-20260101-000001 not found",
    fail_type: "check_failed"
  });
});

test("required-checks reports failed and cancelled checks as failures", () => {
  for (const state of ["failed", "cancelled"]) {
    assert.equal(evaluate({
      inspection: {
        status: "failed",
        pullRequest: { number: 42, headSha: SHA },
        checks: { state, required: [] },
        error: { message: `checks ${state}` }
      }
    }).status, "fail");
  }
});

test("required-checks skips tasks without a PR or with PR flow disabled", () => {
  assert.equal(evaluate({ metadata: { id: "TASK-20260101-000001", pr_delivery_fact: UNBOUND_FACT }, localHead: null, inspection: null }).status, "pass");
  assert.equal(evaluate({
    metadata: { id: "TASK-20260101-000001", pr_delivery_fact: BOUND_FACT },
    prFlow: "disabled",
    localHead: null,
    inspection: null
  }).status, "pass");
});

test("required-checks fails closed when an applicable platform adapter lacks checks inspection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "required-checks-adapter-"));
  try {
    fs.mkdirSync(path.join(root, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agents", ".airc.json"), JSON.stringify({
      platform: { type: "checks-unsupported-test" },
      prFlow: "required"
    }));
    registerPlatformAdapter({
      type: "checks-unsupported-test",
      resolveContext() {
        return platformResult("no-op", {
          platform: {
            type: "checks-unsupported-test",
            repository: "acme/widgets",
            currentUser: "reviewer"
          }
        });
      }
    });
    const result = await check({ taskDir: root }, {
      ...shared,
      repoRoot: root,
      loadTask() {
        return { ok: true, metadata: { id: "TASK-20260101-000001", pr_delivery_fact: BOUND_FACT } };
      }
    });
    assert.equal(result.status, "blocked");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
