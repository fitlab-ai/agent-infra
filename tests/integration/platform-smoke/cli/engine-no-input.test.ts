import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dockerDesktopAdapter } from '../../../../lib/sandbox/engines/docker-desktop.ts';
import { nativeAdapter } from '../../../../lib/sandbox/engines/native.ts';
import { orbstackAdapter } from '../../../../lib/sandbox/engines/orbstack.ts';
import { wsl2Adapter } from '../../../../lib/sandbox/engines/wsl2.ts';
import { colimaAdapter } from '../../../../lib/sandbox/engines/colima.ts';
import { runOk, runSafe } from '../../../../lib/sandbox/shell.ts';
import { createTempDir, onPlatforms } from '../../../helpers.ts';

test('Desktop and Colima adapters run no-input probes with closed stdin', onPlatforms('linux', 'darwin'), async () => {
  const bin = createTempDir('engine-probes-');
  for (const cmd of ['docker', 'colima', 'which', 'orb', 'wsl.exe']) fs.writeFileSync(path.join(bin, cmd), '#!/bin/sh\n[ -c /dev/stdin ]\n', { mode: 0o755 });
  const prior = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${prior}`;
  const fns = { runOk, runSafe, run: () => '', runVerbose: () => { throw new Error('unexpected start'); } };
  try {
    assert.equal(await dockerDesktopAdapter.ensure({}, null, fns), false);
    assert.equal(await colimaAdapter.ensure({}, null, fns), false);
    assert.equal(colimaAdapter.startVm?.({}, null, fns), 'already-running');
    assert.equal(await nativeAdapter.ensure({}, null, fns), false);
    assert.equal(await orbstackAdapter.ensure({}, null, fns), false);
    assert.equal(orbstackAdapter.startVm?.({}, null, fns), 'already-running');
    assert.equal(await wsl2Adapter.ensure({}, null, fns), false);
  } finally { process.env.PATH = prior; }
});
