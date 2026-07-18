import test from 'node:test';
import assert from 'node:assert/strict';

import { eventCatalog, validateTaskEventRequest } from '../../../lib/task/events.ts';

test('event catalog exposes the approved closed set', () => {
  assert.equal(eventCatalog.length, 15);
  assert.equal(new Set(eventCatalog).size, 15);
  assert.ok(eventCatalog.includes('manual-validation.started'));
  assert.ok(eventCatalog.includes('manual-validation.completed'));
});

test('event payload validation rejects fields outside an event schema', () => {
  const result = validateTaskEventRequest({
    taskRef: '1', event: 'analyze.started', agent: 'codex', round: 1, artifact: 'analysis.md'
  });
  assert.equal(result?.code, 'EVENT_PAYLOAD_INVALID');
});

test('code fix completion requires its review identity', () => {
  const result = validateTaskEventRequest({
    taskRef: '1', event: 'code.completed', agent: 'codex', round: 2,
    artifact: 'code-r2.md', blockers: 1, major: 0, minor: 0, manualValidation: 0
  });
  assert.equal(result?.code, 'EVENT_PAYLOAD_INVALID');
});

test('decision implementation identity is canonical and mutually exclusive with fix identity', () => {
  assert.equal(validateTaskEventRequest({
    taskRef: '1', event: 'code.started', agent: 'codex', implementationInput: 'II-1',
    fixFor: 'review-code.md'
  })?.code, 'EVENT_PAYLOAD_INVALID');
  assert.equal(validateTaskEventRequest({
    taskRef: '1', event: 'code.started', agent: 'codex', implementationInput: 'II-0'
  })?.code, 'EVENT_PAYLOAD_INVALID');
});
