import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExactContainerListArgs, discoverExactContainer } from '../../../lib/sandbox/engines/docker-exact-discovery.ts';

const id = 'a'.repeat(64);

function result(status: number | null, stdout: string, stderr = ''): any {
  return { status, signal: status === null ? 'SIGTERM' : null, stdout, stderr, pid: 1, output: [] };
}

test('exact discovery uses only the full-ID, untruncated machine-readable selector', () => {
  const args = buildExactContainerListArgs(id);

  assert.deepEqual(args, [
    'container', 'ls', '--all', '--no-trunc', '--filter', `id=${id}`, '--format', '{{.ID}}'
  ]);
  assert.equal(args.filter((arg) => arg.startsWith('--filter')).length, 1);
  assert.equal(args.some((arg) => /status|label|limit/i.test(arg)), false);
});

test('exact empty output is the only absence proof', () => {
  const calls: string[][] = [];
  const observed = discoverExactContainer('native', id, {
    probe: (_cmd, args) => {
      calls.push(args);
      return result(0, '');
    }
  });

  assert.deepEqual(observed, { state: 'absent', id, evidence: 'exact-empty' });
  assert.equal(calls.length, 1);
});

test('a matching full ID is inspected before it is reported as present', () => {
  const calls: string[][] = [];
  const observed = discoverExactContainer('native', id, {
    probe: (_cmd, args) => {
      calls.push(args);
      if (args[1] === 'ls') return result(0, `${id}\n`);
      return result(0, `${JSON.stringify({
        Id: id,
        State: { Running: false },
        Config: { Labels: { 'demo.sandbox': '' } }
      })}\n`);
    }
  });

  assert.deepEqual(observed, {
    state: 'found',
    id,
    running: false,
    labels: { 'demo.sandbox': '' },
    evidence: 'exact-present'
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ['container', 'inspect', '--format', '{{json .}}', id]);
});

test('transport errors remain unknown even when stderr says no such container', () => {
  const observed = discoverExactContainer('native', id, {
    probe: () => result(1, '', 'Error: No such container: old-name')
  });

  assert.equal(observed.state, 'unknown');
  assert.match(observed.reason, /exit|transport|failed/i);
});

test('short, mismatched, and malformed rows fail closed', () => {
  const conflict = discoverExactContainer('native', id, {
    probe: (_cmd, args) => result(0, args[1] === 'ls' ? `${'b'.repeat(64)}\n` : '')
  });
  assert.deepEqual(conflict, { state: 'conflict', reason: 'exact container query returned a different ID' });

  for (const stdout of ['a'.repeat(12), `${id}\n${id}\n`, 'not-json']) {
    const observed = discoverExactContainer('native', id, {
      probe: (_cmd, args) => result(0, args[1] === 'ls' ? stdout : '')
    });
    assert.equal(observed.state, 'unknown', stdout);
  }
});
