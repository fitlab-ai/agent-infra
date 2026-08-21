import assert from 'node:assert/strict';
import test from 'node:test';
import { nextSandboxControlBackoff } from '../../../lib/sandbox/control/timing.ts';

function collectDelays(initialDelayMs: number, capMs: number, count: number): number[] {
  const delays: number[] = [];
  let currentDelayMs = initialDelayMs;
  for (let index = 0; index < count; index += 1) {
    const step = nextSandboxControlBackoff(currentDelayMs, capMs);
    delays.push(step.delayMs);
    currentDelayMs = step.nextDelayMs;
  }
  return delays;
}

test('sandbox control backoff doubles from the initial delay and caps at slow-check timing', () => {
  assert.deepEqual(collectDelays(1_000, 5_000, 5), [1_000, 2_000, 4_000, 5_000, 5_000]);
});

test('sandbox control backoff uses shortened configured timing without changing its sequence', () => {
  assert.deepEqual(collectDelays(10, 30, 5), [10, 20, 30, 30, 30]);
  assert.deepEqual(nextSandboxControlBackoff(30, 30), { delayMs: 30, nextDelayMs: 30 });
});
