import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execNoInput } from '../../../../lib/exec-no-input.ts';
import { createTempDir } from '../../../helpers.ts';

test('rejects conflicting input or stdio before launching a child', () => {
  const marker = path.join(createTempDir('no-input-'), 'spawned');
  const code = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`;
  for (const options of [{ input: 'payload' }, { stdio: 'inherit' }]) {
    assert.throws(() => execNoInput(process.execPath, ['-e', code], options as never));
    assert.equal(fs.existsSync(marker), false);
  }
});

test('keeps buffer and string encodings', () => {
  const args = ['-e', "process.stdout.write('result')"];
  assert.deepEqual(execNoInput(process.execPath, args), Buffer.from('result'));
  assert.equal(execNoInput(process.execPath, args, { encoding: 'utf8' }), 'result');
});

if (false) {
  // @ts-expect-error Input is not accepted on no-input execution.
  execNoInput('example', [], { input: 'payload' });
  // @ts-expect-error Stdio is fixed by the no-input contract.
  execNoInput('example', [], { stdio: 'inherit' });
}
