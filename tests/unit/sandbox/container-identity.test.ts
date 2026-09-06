import assert from 'node:assert/strict';
import test from 'node:test';
import { classifySandboxContainerInspection, inspectSandboxControlContainer } from '../../../lib/sandbox/control/container-identity.ts';
import { captureSandboxAuthority } from '../../../lib/sandbox/engines/authority.ts';

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

test('container identity treats only structured not-found as absent', () => {
  assert.deepEqual(classifySandboxContainerInspection(identity, { notFound: true }), {
    state: 'absent',
    id: 'container-id'
  });
  assert.equal(classifySandboxContainerInspection(identity, { error: new Error('No such container') }).state, 'unknown');
  assert.equal(classifySandboxContainerInspection(identity, { error: new Error('error: no such object: container-id') }).state, 'unknown');
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

test('container inspection maps only an authoritative exact-empty query to absent', async () => {
  const id = 'f'.repeat(64);
  const evidence = captureSandboxAuthority('native', {
    env: { DOCKER_CONTEXT: 'default' },
    lockDomain: 'e'.repeat(64),
    probe: (_cmd, args) => ({ status: 0, signal: null, stdout: JSON.stringify(args.at(-1) === '{{json .ID}}' ? 'daemon-id' : { ApiVersion: '1.50' }), stderr: '', pid: 1, output: [] })
  });
  const manifest = {
    engine: 'native',
    containerIdentity: { id, labels: {} },
    authorityEvidence: evidence
  } as any;
  const absent = await inspectSandboxControlContainer(manifest, {
    probe: (_cmd, args) => (args.includes('version') || args.includes('info'))
      ? ({ status: 0, signal: null, stdout: JSON.stringify(args.at(-1) === '{{json .ID}}' ? 'daemon-id' : { ApiVersion: '1.50' }), stderr: '', pid: 1, output: [] })
      : ({ status: 0, signal: null, stdout: '', stderr: '', pid: 1, output: [] })
  });
  assert.deepEqual(absent, { state: 'absent', id });

  const unknown = await inspectSandboxControlContainer(manifest, {
    probe: (_cmd, args) => (args.includes('version') || args.includes('info'))
      ? ({ status: 0, signal: null, stdout: JSON.stringify(args.at(-1) === '{{json .ID}}' ? 'daemon-id' : { ApiVersion: '1.50' }), stderr: '', pid: 1, output: [] })
      : ({ status: 1, signal: null, stdout: '', stderr: 'No such container', pid: 1, output: [] })
  });
  assert.equal(unknown.state, 'unknown');
});
