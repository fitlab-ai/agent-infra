import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { check } from '../../../lib/platform/verification-sync.ts';

test('concurrent platform checks retain their own repository utilities across awaits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-context-'));
  try {
    const results = await Promise.all(['first', 'second'].map((name) => {
      const repoRoot = path.join(root, name);
      fs.mkdirSync(path.join(repoRoot, '.agents'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, '.agents', '.airc.json'), JSON.stringify({ platform: { type: 'none' } }));
      return check({ taskDir: repoRoot, config: {} }, {
        repoRoot,
        loadTask: () => ({ ok: true, content: '', metadata: { id: 'TASK-20260101-000001', issue_number: '42' } }),
        passResult: (type: string) => ({ type, status: 'pass' as const, message: name }),
        failResult: (type: string, message: string) => ({ type, status: 'fail' as const, message }),
        blockedResult: (type: string, message: string) => ({ type, status: 'blocked' as const, message }),
        getCheckedRequirements: () => [],
        normalizeContent: String,
        isBlank: (value: unknown) => value == null || value === '',
        escapeRegExp: (value: string) => value,
        safeStat: () => null,
        parseIssueNumber: () => null,
        parsePrNumber: () => null
      });
    }));
    assert.deepEqual(results.map(({ status, message }) => ({ status, message })), [
      { status: 'pass', message: 'first' },
      { status: 'pass', message: 'second' }
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
