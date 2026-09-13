import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { filePath } from '../../helpers.ts';
import { createCollector } from '../../../scripts/test-event-collector.js';

const fileA = path.join(os.tmpdir(), 'collector-a.test.ts');

function event(file: string, name: string, nesting: number, details: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { file, name, nesting, details, ...extra };
}

test('collector reconstructs early complete, nested and sibling identities with every result state', () => {
  const collector = createCollector({ cwd: os.tmpdir(), mode: 'source' });
  const file = fileA;
  collector.handle('test:complete', event(file, 'same', 1, { passed: true }, { testNumber: 2 }));
  collector.handle('test:start', event(file, 'A', 0, {}));
  collector.handle('test:start', event(file, 'same', 1, {}));
  collector.handle('test:pass', event(file, 'same', 1, {}, { testNumber: 2 }));
  collector.handle('test:start', event(file, 'same', 1, {}));
  collector.handle('test:complete', event(file, 'same', 1, { passed: true }, { testNumber: 3 }));
  collector.handle('test:pass', event(file, 'same', 1, {}, { testNumber: 3 }));
  collector.handle('test:start', event(file, 'failed', 1, {}));
  collector.handle('test:complete', event(file, 'failed', 1, { passed: false }, { testNumber: 4 }));
  collector.handle('test:fail', event(file, 'failed', 1, {}, { testNumber: 4 }));
  collector.handle('test:start', event(file, 'skipped', 1, {}));
  collector.handle('test:complete', event(file, 'skipped', 1, { passed: true }, { testNumber: 5, skip: 'platform' }));
  collector.handle('test:pass', event(file, 'skipped', 1, {}, { testNumber: 5, skip: 'platform' }));
  collector.handle('test:start', event(file, 'todo', 1, {}));
  collector.handle('test:complete', event(file, 'todo', 1, { passed: true }, { testNumber: 6, todo: true }));
  collector.handle('test:pass', event(file, 'todo', 1, {}, { testNumber: 6, todo: true }));
  collector.handle('test:complete', event(file, 'A', 0, { passed: true, type: 'suite' }, { testNumber: 1 }));
  collector.handle('test:pass', event(file, 'A', 0, { type: 'suite' }, { testNumber: 1 }));
  collector.handle('test:summary', {
    file,
    success: true,
    counts: { tests: 5, suites: 1, passed: 2, skipped: 1, todo: 1, failed: 1, cancelled: 0, topLevel: 1 }
  });

  const result = collector.finish();
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.equal(result.files[0]?.tests.length, 6);
  assert.deepEqual(result.files[0]?.tests[0]?.path[0], {
    kind: 'suite',
    name: 'A',
    siblingOrdinal: 1
  });
  assert.deepEqual(new Set(result.files[0]?.tests.map((item) => item.status)), new Set(['pass', 'fail', 'skip', 'todo']));
  const same = result.files[0]?.tests.filter((item) => item.name === 'same');
  assert.deepEqual(same?.map((item) => item.path.at(-1)?.siblingOrdinal), [1, 2]);
});

test('collector fails closed for ambiguous and conflicting events', () => {
  const collector = createCollector({ cwd: os.tmpdir(), mode: 'source' });
  const file = path.join(os.tmpdir(), 'collector-invalid.test.ts');
  collector.handle('test:complete', event(file, 'same', 0, { passed: true }, { testNumber: 1 }));
  collector.handle('test:complete', event(file, 'same', 0, { passed: true }, { testNumber: 2 }));
  collector.handle('test:start', event(file, 'same', 0, {}));
  collector.handle('test:pass', event(file, 'same', 0, {}, { testNumber: 9 }));
  const result = collector.finish();
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((message) => message.includes('ambiguous')));

  const conflict = createCollector({ cwd: os.tmpdir(), mode: 'source' });
  conflict.handle('test:start', event(file, 'conflict', 0, {}));
  conflict.handle('test:complete', event(file, 'conflict', 0, { passed: true }, { testNumber: 1 }));
  conflict.handle('test:pass', event(file, 'conflict', 0, {}, { testNumber: 9 }));
  const conflictResult = conflict.finish();
  assert.equal(conflictResult.valid, false);
  assert.ok(conflictResult.errors.some((message) => message.includes('testNumber')));
});

test('source collector runs a process-isolated TypeScript fixture through NODE_OPTIONS', async (t) => {
  const tempRoot = filePath('.tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempRoot, 'collector-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = path.join(root, 'source-fixture.test.ts');
  fs.writeFileSync(fixture, 'import test from "node:test";\ntest("source fixture", () => {});\n');
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  childEnv.NODE_OPTIONS = [childEnv.NODE_OPTIONS, '--experimental-strip-types', '--no-warnings'].filter(Boolean).join(' ');
  const result = spawnSync(process.execPath, [
    filePath('scripts/test-event-collector.js'), '--mode', 'source', path.relative(filePath('.'), fixture)
  ], {
    cwd: filePath('.'),
    encoding: 'utf8',
    env: childEnv
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout) as { valid: boolean; success: boolean; files: Array<{ file: string }> };
  assert.equal(payload.valid, true);
  assert.equal(payload.success, true);
  assert.equal(payload.files[0]?.file, path.relative(filePath('.'), fixture).replaceAll(path.sep, '/'));
});
