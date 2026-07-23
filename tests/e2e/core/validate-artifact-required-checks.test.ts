import test from "node:test";
import assert from "node:assert/strict";

import { evaluateRequiredChecks } from "../../../lib/platform/verification-required.ts";

const shared = {
  passResult: (type: string, message: string) => ({ type, status: "pass", message }),
  failResult: (type: string, message: string, failType?: string) => ({ type, status: "fail", message, fail_type: failType }),
  blockedResult: (type: string, message: string, failType?: string) => ({ type, status: "blocked", message, fail_type: failType })
};

const SHA = "a".repeat(40);

function evaluate(overrides: Record<string, unknown> = {}) {
  return evaluateRequiredChecks({
    metadata: { id: "TASK-20260101-000001", pr_number: 42, last_reviewed_commit: SHA },
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
  assert.equal(evaluate({ metadata: { id: "TASK-20260101-000001", pr_number: 42, last_reviewed_commit: "b".repeat(40) } }).status, "fail");
  assert.equal(evaluate({
    inspection: {
      status: "no-op",
      pullRequest: { number: 42, headSha: "b".repeat(40) },
      checks: { state: "passed", required: [] },
      error: null
    }
  }).status, "fail");
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
  assert.equal(evaluate({ metadata: { id: "TASK-20260101-000001" }, localHead: null, inspection: null }).status, "pass");
  assert.equal(evaluate({
    metadata: { id: "TASK-20260101-000001", pr_number: 42 },
    prFlow: "disabled",
    localHead: null,
    inspection: null
  }).status, "pass");
});
