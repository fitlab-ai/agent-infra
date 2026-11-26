import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { execNoInput } from '../../../../lib/exec-no-input.ts';

test('rejects input before starting a process', () => {
  assert.throws(() => execNoInput(process.execPath + '.missing', [], { input: 'payload' } as never), TypeError);
});

test('returns stdout and forwards stderr, preserving failures', () => {
  let stderr = '';
  mock.method(process.stderr, 'write', ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  try {
    const args = ['-e', "process.stdout.write('ok'); process.stderr.write('notice')"];
    assert.deepEqual(execNoInput(process.execPath, args), Buffer.from('ok'));
    assert.equal(execNoInput(process.execPath, args, { encoding: 'utf8' }), 'ok');
    assert.equal(stderr, 'noticenotice');
    stderr = '';
    assert.throws(() => execNoInput(process.execPath, ['-e', "process.stderr.write('failure'); process.exit(23)"], { encoding: 'utf8' }),
      (error: Error & { status?: number; stderr?: string }) => error.status === 23 && error.stderr === 'failure');
    assert.equal(stderr, 'failure');
    assert.throws(() => execNoInput(process.execPath + '.missing', []),
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  } finally {
    mock.restoreAll();
  }
});
