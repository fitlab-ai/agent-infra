import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTempDir, onPlatforms } from '../../../helpers.ts';

test('standard environment token uses closed stdin in native and WSL host fallback only', onPlatforms('linux', 'darwin'), () => {
  const root = createTempDir('gh-token-stdio-');
  const log = path.join(root, 'calls');
  fs.writeFileSync(path.join(root, 'gh'), `#!/usr/bin/env node\nconst fs=require('fs');fs.appendFileSync(process.env.FAKE_LOG, 'gh:'+(fs.fstatSync(0).isCharacterDevice()?'closed':'pipe')+'\\n');if(process.env.EXPECT_CLOSED==='1'&&!fs.fstatSync(0).isCharacterDevice())process.exit(91);process.stdout.write('synthetic-value\\n');\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'wsl.exe'), `#!/usr/bin/env node\nconst fs=require('fs');fs.appendFileSync(process.env.FAKE_LOG,'wsl:'+(fs.fstatSync(0).isCharacterDevice()?'closed':'pipe')+'\\n');process.exit(1);\n`, { mode: 0o755 });
  const script = `
    import fs from 'node:fs';
    import assert from 'node:assert/strict';
    import { buildContainerEnvFile } from ${JSON.stringify(new URL('../../../../lib/sandbox/commands/create.ts', import.meta.url).href)};
    for (const engine of ['native', 'wsl2']) {
      const result = buildContainerEnvFile([], engine, undefined, { tmpDir: process.env.FAKE_ROOT });
      assert.equal(result.dockerArgs[0], '--env-file');
      const file = engine === 'wsl2' ? process.env.FAKE_ROOT + '/' + result.dockerArgs[1].split('/').slice(-2).join('/') : result.dockerArgs[1];
      assert.equal(fs.readFileSync(file, 'utf8'), 'GH_TOKEN=synthetic-value\\n');
      result.cleanup();
    }
    let engineArgs;
    buildContainerEnvFile([], 'native', (...args) => { engineArgs=args; return ''; });
    assert.equal(engineArgs.length, 3);
    let hostArgs;
    buildContainerEnvFile([], 'wsl2', () => '', { runSafeFn: (...args) => { hostArgs=args; return ''; } });
    assert.equal(hostArgs.length, 2);
    delete process.env.GH_TOKEN;
    process.env.EXPECT_CLOSED='0';
    const noToken = buildContainerEnvFile([], 'native', undefined, { tmpDir: process.env.FAKE_ROOT });
    noToken.cleanup();
  `;
  try {
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
      encoding: 'utf8', env: { PATH: `${root}${path.delimiter}${process.env.PATH}`, HOME: root, GH_CONFIG_DIR: root, GH_TOKEN: 'synthetic-value', EXPECT_CLOSED: '1', FAKE_LOG: log, FAKE_ROOT: root }
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['gh:closed', 'wsl:pipe', 'gh:closed', 'gh:pipe']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
