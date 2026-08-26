import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { INTERNAL_CLI_PATH, writeNodeCommandShim } from '../../helpers.ts';

test('codex sandbox controller rejects removed identity options before starting Codex', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-controller-cli-'));
  const marker = path.join(root, 'codex-started');
  const fakeBin = path.join(root, 'bin');
  fs.mkdirSync(fakeBin);
  const codexScript = path.join(root, 'codex.js');
  fs.writeFileSync(codexScript, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'started');\n`);
  writeNodeCommandShim(path.join(fakeBin, 'codex'), codexScript);

  try {
    for (const option of ['--task-id', '--task-ref']) {
      const result = spawnSync(
        process.execPath,
        [INTERNAL_CLI_PATH, 'codex-sandbox-controller', 'run', option, 'TASK-20260101-000001'],
        { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}` } }
      );
      assert.equal(result.status, 2, option);
      const payload = JSON.parse(result.stdout) as { error?: { code?: string } };
      assert.equal(payload.error?.code, 'CODEX_SANDBOX_CONTROLLER_IDENTITY_OPTION_UNSUPPORTED', option);
    }
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
