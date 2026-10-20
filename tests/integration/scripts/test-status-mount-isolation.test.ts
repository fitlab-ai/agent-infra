import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { createTempDir, filePath } from '../../helpers.ts';

test('status mount preloader maps Windows task paths and preserves filesystem arguments', (t) => {
  const root = createTempDir('task-workspace-preloader-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const source = path.win32.join('/task-workspace', 'payload.txt');
    const copied = path.win32.join('/task-workspace', 'copied.txt');
    const renamed = path.win32.join('/task-workspace', 'renamed.txt');
    fs.writeFileSync(source, '/task-workspace/data', { encoding: 'utf8' });
    fs.copyFileSync(source, copied, fs.constants.COPYFILE_EXCL);
    fs.renameSync(copied, renamed);
    process.stdout.write(JSON.stringify({
      data: fs.readFileSync(renamed, { encoding: 'utf8' }),
      nativePath: fs.realpathSync.native(renamed)
    }));
  `;
  const result = spawnSync(process.execPath, ['--require', filePath('scripts/test-status-mount-isolation.cjs'), '-e', script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '', AGENT_INFRA_TEST_TASK_WORKSPACE_ROOT: root }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    data: '/task-workspace/data',
    nativePath: path.join(root, 'renamed.txt')
  });
});
