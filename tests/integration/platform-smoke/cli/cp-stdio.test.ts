import test from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from '../../../../lib/cp.ts';
import { onPlatforms } from '../../../helpers.ts';

test('clipboard command uses a closed input device only when no input is supplied', onPlatforms('linux', 'darwin'), () => {
  const script = "const fs = require('node:fs'); process.stdout.write(fs.fstatSync(0).isCharacterDevice() ? 'device' : 'pipe'); process.stderr.write('diagnostic'); process.exitCode = 7";
  const noInput = runCommand(process.execPath, ['-e', script]);
  assert.equal(noInput.stdout, 'device');
  assert.equal(noInput.stderr, 'diagnostic');
  assert.equal(noInput.status, 7);
  for (const input of ['', 'actual input']) {
    const withInput = runCommand(process.execPath, ['-e', "const fs = require('node:fs'); process.stdout.write(fs.fstatSync(0).isCharacterDevice() ? 'device:' : 'pipe:'); process.stdin.on('data', x => process.stdout.write(x)); process.stdin.on('end', () => process.stderr.write('done'))"], input);
    assert.equal(withInput.status, 0);
    assert.equal(withInput.stdout, `pipe:${input}`);
    assert.equal(withInput.stderr, 'done');
  }
  const missing = runCommand('/nonexistent-agent-infra-command', []);
  assert.equal((missing.error as NodeJS.ErrnoException).code, 'ENOENT');
});
