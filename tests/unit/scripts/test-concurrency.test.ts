import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";

import {
  TEST_CONCURRENCY_ENV,
  defaultTestConcurrency,
  parseTestConcurrency,
  testConcurrencyFromEnv
} from "../../../scripts/test-concurrency.js";

test("default test concurrency follows available parallelism", () => {
  assert.equal(
    defaultTestConcurrency(),
    Math.max(1, os.availableParallelism() * 2)
  );
});

test("test concurrency accepts positive safe integer overrides", () => {
  assert.equal(parseTestConcurrency("1"), 1);
  assert.equal(parseTestConcurrency("4"), 4);
  assert.equal(parseTestConcurrency(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  assert.equal(testConcurrencyFromEnv({ [TEST_CONCURRENCY_ENV]: "7" }), 7);
});

test("test concurrency rejects invalid overrides", () => {
  for (const value of ["", "0", "-1", "1.5", " 4", "4 ", "not-a-number", String(Number.MAX_SAFE_INTEGER + 1)]) {
    assert.throws(() => parseTestConcurrency(value), /AGENT_INFRA_TEST_CONCURRENCY/);
  }
  assert.equal(testConcurrencyFromEnv({}), defaultTestConcurrency());
});
