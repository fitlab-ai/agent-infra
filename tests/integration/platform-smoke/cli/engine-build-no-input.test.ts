import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDocker } from '../../../../lib/sandbox/engine.ts';
import { buildSandboxImageArgs } from '../../../../lib/sandbox/image-build.ts';
import { createTempDir, onPlatforms } from '../../../helpers.ts';

test('full engine preparation and image build queries close stdin, preserve errors and do not retry', onPlatforms('linux', 'darwin'), async () => {
  const root = createTempDir('engine-build-stdin-');
  const log = path.join(root, 'calls');
  const script = `#!/bin/sh\nprintf '%s %s\\n' "\${0##*/}" "$*" >> "$TASK04_LOG"\n[ -c /dev/stdin ] || { echo "unexpected pipe $*" >&2; exit 91; }\ncase "\${0##*/}:$*" in\n  'docker:buildx inspect --bootstrap') [ "\${TASK04_FAIL_BUILD:-0}" = 0 ] || exit 42 ;;\n  'id:-u') [ "\${TASK04_FAIL_ID:-0}" = 0 ] || { echo id-failed >&2; exit 43; }; echo 123 ;;\n  'id:-g') echo 456 ;;\nesac\n`;
  for (const name of ['docker', 'id', 'which']) fs.writeFileSync(path.join(root, name), script, { mode: 0o755 });
  const previous = { ...process.env };
  process.env.PATH = `${root}${path.delimiter}${process.env.PATH}`;
  process.env.TASK04_LOG = log;
  delete process.env.DOCKER_HOST;
  const lines = () => fs.readFileSync(log, 'utf8').trim().split('\n');
  const config = { project: 'test', imageName: 'test-image', repoRoot: root };
  try {
    await ensureDocker({ engine: 'native' }, null, { platformFn: () => 'linux' });
    assert.deepEqual(lines(), ['which docker', 'docker info', 'docker buildx inspect --bootstrap']);
    fs.writeFileSync(log, '');
    const args = buildSandboxImageArgs(config, [], '/Dockerfile', 'sig', { engine: 'native', env: {} });
    assert.ok(args.includes('HOST_UID=123'));
    assert.ok(args.includes('HOST_GID=456'));
    assert.deepEqual(lines(), ['docker info --format {{.SecurityOptions}}', 'id -u', 'id -g']);
    fs.writeFileSync(log, '');
    process.env.TASK04_FAIL_ID = '1';
    assert.throws(() => buildSandboxImageArgs(config, [], '/Dockerfile', 'sig', { engine: 'native', env: {} }), (error: Error & { status?: number; stderr?: Buffer }) => error.status === 43 && String(error.stderr).includes('id-failed'));
    assert.deepEqual(lines(), ['docker info --format {{.SecurityOptions}}', 'id -u']);
    delete process.env.TASK04_FAIL_ID;
    fs.writeFileSync(log, '');
    process.env.TASK04_FAIL_BUILD = '1';
    await assert.rejects(ensureDocker({ engine: 'native' }, null, { platformFn: () => 'linux' }), /Docker BuildKit is not available/);
    assert.deepEqual(lines(), ['which docker', 'docker info', 'docker buildx inspect --bootstrap']);
  } finally {
    for (const key of ['PATH', 'TASK04_LOG', 'TASK04_FAIL_ID', 'TASK04_FAIL_BUILD', 'DOCKER_HOST', 'DOCKER_CONTEXT']) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});
