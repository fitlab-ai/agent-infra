import assert from 'node:assert/strict';
import test from 'node:test';
import { classifySandboxContainerInspection } from '../../../lib/sandbox/control/container-identity.ts';

const identity = {
  id: 'container-id',
  labels: {
    'demo.sandbox': '',
    'demo.sandbox.branch': 'feature/example'
  }
} as const;

test('container identity classifies an exact stopped object as found', () => {
  assert.deepEqual(classifySandboxContainerInspection(identity, {
    id: 'container-id',
    running: false,
    labels: identity.labels
  }), {
    state: 'found',
    id: 'container-id',
    running: false,
    labels: identity.labels
  });
});

test('container identity treats authoritative not-found as absent', () => {
  assert.deepEqual(classifySandboxContainerInspection(identity, { notFound: true }), {
    state: 'absent',
    id: 'container-id'
  });
  assert.deepEqual(classifySandboxContainerInspection(identity, { error: new Error('No such container') }), {
    state: 'absent',
    id: 'container-id'
  });
  assert.deepEqual(classifySandboxContainerInspection(identity, { error: new Error('error: no such object: container-id') }), {
    state: 'absent',
    id: 'container-id'
  });
});

test('container identity fails closed for same-name replacement and label drift', () => {
  assert.equal(classifySandboxContainerInspection(identity, {
    id: 'replacement-id',
    running: true,
    labels: identity.labels
  }).state, 'unknown');
  assert.equal(classifySandboxContainerInspection(identity, {
    id: 'container-id',
    running: true,
    labels: { ...identity.labels, 'demo.sandbox.branch': 'other' }
  }).state, 'unknown');
  assert.equal(classifySandboxContainerInspection(identity, {
    error: new Error('daemon unavailable')
  }).state, 'unknown');
});
