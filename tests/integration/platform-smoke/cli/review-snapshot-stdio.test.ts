import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTempDir, gitSafeEnv, onPlatforms } from '../../../helpers.ts';

test('review snapshot forwards Git stderr on success and failure while retaining error bytes', onPlatforms('linux', 'darwin'), () => {
  const bin = createTempDir('review-stderr-shim-');
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nprintf marker-stderr >&2\nexit "${TASK04_GIT_EXIT:-0}"\n', { mode: 0o755 });
  const moduleUrl = new URL('../../../../lib/git/review-snapshot.ts', import.meta.url).href;
  const code = `import { snapshotReview } from ${JSON.stringify(moduleUrl)}; try { snapshotReview({cwd:process.cwd(),mode:'staged',baseline:'HEAD',globs:[]}); } catch (e) { process.stdout.write(JSON.stringify({status:e.status,stderr:String(e.stderr||''),code:e.code})); }`;
  const env = gitSafeEnv({ PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  const ok = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { encoding: 'utf8', env });
  assert.match(ok.stderr, /marker-stderr/);
  const failed = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { encoding: 'utf8', env: { ...env, TASK04_GIT_EXIT: '23' } });
  assert.match(failed.stderr, /marker-stderr/);
  const detail = JSON.parse(failed.stdout);
  assert.equal(detail.status, 23);
  assert.equal(detail.stderr, 'marker-stderr');
  const missing = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { encoding: 'utf8', env: { ...env, PATH: createTempDir('missing-git-') } });
  assert.equal(JSON.parse(missing.stdout).code, 'ENOENT');
});
