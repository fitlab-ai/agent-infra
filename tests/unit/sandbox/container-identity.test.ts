import assert from 'node:assert/strict';
import test from 'node:test';
import { classifySandboxContainerInspection, inspectSandboxControlContainer } from '../../../lib/sandbox/control/container-identity.ts';

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

test('container inspection maps only a successful exact-empty query to absent', async () => {
  const id = 'f'.repeat(64);
  const manifest = {
    engine: 'native',
    containerIdentity: { id, labels: {} }
  } as any;
  const absent = await inspectSandboxControlContainer(manifest, {
    probe: () => ({ status: 0, signal: null, stdout: '', stderr: '', pid: 1, output: [] })
  });
  assert.deepEqual(absent, { state: 'absent', id });

  const unknown = await inspectSandboxControlContainer(manifest, {
    probe: () => ({ status: 1, signal: null, stdout: '', stderr: 'No such container', pid: 1, output: [] })
  });
  assert.equal(unknown.state, 'unknown');
});


test('container inspection resolves the full ID through the configured engine and checks task labels', async () => {
  const id = 'a'.repeat(64);
  const labels = { 'demo.sandbox.task-id': 'TASK-20261023-000934' };
  const calls: string[][] = [];
  const observed = await inspectSandboxControlContainer({
    engine: 'orbstack', containerIdentity: { id, labels }
  } as any, {
    probe: (_command, args) => {
      calls.push(args);
      return { status: 0, signal: null, stderr: '', pid: 1, output: [],
        stdout: args.includes('ls') ? `${id}\n`
          : JSON.stringify({ Id: id, State: { Running: true }, Config: { Labels: labels } }) };
    }
  });
  assert.deepEqual(observed, { state: 'found', id, running: true, labels });
  assert.deepEqual(calls, [
    ['--context', 'orbstack', 'container', 'ls', '--all', '--no-trunc', '--filter', `id=${id}`, '--format', '{{.ID}}'],
    ['--context', 'orbstack', 'container', 'inspect', '--format', '{{json .}}', id]
  ]);
});
