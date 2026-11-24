import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../../../lib/sandbox/shell.ts';

test('run preserves captured stdout when unsupported stdio is passed at runtime', () => {
  assert.equal(run(process.execPath, ['-e', "process.stdout.write('captured')"], { stdio: 'ignore' } as never), 'captured');
});

test('run captures output and retains errors with noInput', () => {
  assert.equal(run(process.execPath, ['-e', "process.stdout.write('  value  ')"]), 'value');
  assert.equal(run(process.execPath, ['-e', "process.stdout.write('  value  ' )"], { noInput: true }), 'value');
  assert.throws(() => run(process.execPath, ['-e', "process.stderr.write('failure'); process.exit(7)"], { noInput: true }), (err: Error & { status?: number; stderr?: string }) => err.status === 7 && String(err.stderr) === 'failure');
});

if (false) {
  // @ts-expect-error run captures stdout; arbitrary stdio is not its contract.
  run('example', [], { stdio: 'ignore' });
}
