import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createLinuxClipboardAdapter } from '../../../../lib/sandbox/clipboard/linux.ts';
import { createDarwinClipboardAdapter } from '../../../../lib/sandbox/clipboard/darwin.ts';
import { createWin32ClipboardAdapter } from '../../../../lib/sandbox/clipboard/win32.ts';
import { createTempDir, onPlatforms } from '../../../helpers.ts';

test('clipboard default executors run noninteractive probes without stdin pipes', onPlatforms('linux', 'darwin'), () => {
  const bin = createTempDir('clipboard-stdin-shim-');
  for (const command of ['wl-paste', 'osascript', 'powershell.exe']) {
    fs.writeFileSync(path.join(bin, command), '#!/bin/sh\n[ -c /dev/stdin ] || exit 91\nprintf "image/png\\n"\n', { mode: 0o755 });
  }
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous}`;
  try {
    assert.deepEqual(createLinuxClipboardAdapter({ env: { WAYLAND_DISPLAY: 'fake' } }).available(), { ok: true });
    assert.deepEqual(createDarwinClipboardAdapter().available(), { ok: true });
    assert.deepEqual(createWin32ClipboardAdapter().available(), { ok: true });
  } finally {
    process.env.PATH = previous;
  }
});
