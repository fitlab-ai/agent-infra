import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  normalizeShortIdInput,
  lookupShortIdByBranch
} from '../../../lib/task/short-id.ts';

type ShortIdCase = {
  input: string;
  L: number;
  expectKind: 'shortId' | 'error' | 'pass';
  expectValue?: string;
  expectErrorMatch?: RegExp;
};

const NORMALIZE_CASES: ShortIdCase[] = [
  // bare numeric, L=2
  { input: '5', L: 2, expectKind: 'shortId', expectValue: '#05' },
  { input: '05', L: 2, expectKind: 'shortId', expectValue: '#05' },
  { input: '005', L: 2, expectKind: 'shortId', expectValue: '#05' },
  // hash-prefixed, L=2
  { input: '#5', L: 2, expectKind: 'shortId', expectValue: '#05' },
  { input: '#05', L: 2, expectKind: 'shortId', expectValue: '#05' },
  { input: '#005', L: 2, expectKind: 'shortId', expectValue: '#05' },
  // boundary at capacity, L=2
  { input: '99', L: 2, expectKind: 'shortId', expectValue: '#99' },
  { input: '#099', L: 2, expectKind: 'shortId', expectValue: '#99' },
  // over capacity, L=2
  { input: '100', L: 2, expectKind: 'error', expectErrorMatch: /exceeds shortIdLength=2/ },
  { input: '#100', L: 2, expectKind: 'error', expectErrorMatch: /exceeds shortIdLength=2/ },
  // reserved zero, L=2
  { input: '0', L: 2, expectKind: 'error', expectErrorMatch: /reserved/ },
  { input: '00', L: 2, expectKind: 'error', expectErrorMatch: /reserved/ },
  { input: '#0', L: 2, expectKind: 'error', expectErrorMatch: /reserved/ },
  { input: '#00', L: 2, expectKind: 'error', expectErrorMatch: /reserved/ },
  { input: '#000', L: 2, expectKind: 'error', expectErrorMatch: /reserved/ },
  // L=1
  { input: '5', L: 1, expectKind: 'shortId', expectValue: '#5' },
  { input: '9', L: 1, expectKind: 'shortId', expectValue: '#9' },
  { input: '10', L: 1, expectKind: 'error', expectErrorMatch: /exceeds shortIdLength=1/ },
  // L=3
  { input: '#5', L: 3, expectKind: 'shortId', expectValue: '#005' },
  { input: '999', L: 3, expectKind: 'shortId', expectValue: '#999' },
  { input: '1000', L: 3, expectKind: 'error', expectErrorMatch: /exceeds shortIdLength=3/ },
  // pass-through
  { input: 'TASK-20260612-162737', L: 2, expectKind: 'pass', expectValue: 'TASK-20260612-162737' },
  { input: 'my-branch', L: 2, expectKind: 'pass', expectValue: 'my-branch' },
  { input: '#abc', L: 2, expectKind: 'pass', expectValue: '#abc' },
  { input: '5.5', L: 2, expectKind: 'pass', expectValue: '5.5' }
];

for (const c of NORMALIZE_CASES) {
  test(`normalizeShortIdInput('${c.input}', L=${c.L}) -> ${c.expectKind}${c.expectValue ? ` ${c.expectValue}` : ''}`, () => {
    const result = normalizeShortIdInput(c.input, { shortIdLength: c.L });
    assert.equal(result.kind, c.expectKind);
    if (c.expectKind === 'shortId' || c.expectKind === 'pass') {
      assert.equal((result as { value: string }).value, c.expectValue);
    }
    if (c.expectKind === 'error' && c.expectErrorMatch) {
      assert.match((result as { message: string }).message, c.expectErrorMatch);
    }
  });
}

function mkRegistryFixture(): { repoRoot: string; activeDir: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shortid-lookup-'));
  const activeDir = path.join(repoRoot, '.agents', 'workspace', 'active');
  fs.mkdirSync(activeDir, { recursive: true });
  return { repoRoot, activeDir };
}

function writeTaskWithBranch(activeDir: string, taskId: string, branch: string): void {
  fs.mkdirSync(path.join(activeDir, taskId), { recursive: true });
  fs.writeFileSync(
    path.join(activeDir, taskId, 'task.md'),
    `---\nid: ${taskId}\nbranch: ${branch}\n---\n# body\n`
  );
}

function writeRegistry(activeDir: string, ids: Record<string, string>): void {
  fs.writeFileSync(
    path.join(activeDir, '.short-ids.json'),
    JSON.stringify({ version: 1, ids }, null, 2)
  );
}

test('lookupShortIdByBranch returns #NN when branch matches one active task', () => {
  const { repoRoot, activeDir } = mkRegistryFixture();
  writeTaskWithBranch(activeDir, 'TASK-20260101-000001', 'feature-foo');
  writeRegistry(activeDir, { '07': 'TASK-20260101-000001' });
  assert.equal(lookupShortIdByBranch('feature-foo', repoRoot), '#07');
});

test('lookupShortIdByBranch returns null when no match', () => {
  const { repoRoot, activeDir } = mkRegistryFixture();
  writeTaskWithBranch(activeDir, 'TASK-20260101-000002', 'feature-foo');
  writeRegistry(activeDir, { '07': 'TASK-20260101-000002' });
  assert.equal(lookupShortIdByBranch('feature-other', repoRoot), null);
});

test('lookupShortIdByBranch warns and returns first when multiple tasks share a branch', () => {
  const { repoRoot, activeDir } = mkRegistryFixture();
  writeTaskWithBranch(activeDir, 'TASK-20260101-000003', 'shared');
  writeTaskWithBranch(activeDir, 'TASK-20260101-000004', 'shared');
  writeRegistry(activeDir, {
    '03': 'TASK-20260101-000003',
    '04': 'TASK-20260101-000004'
  });
  const original = process.stderr.write.bind(process.stderr);
  const captured: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = lookupShortIdByBranch('shared', repoRoot);
    assert.ok(result === '#03' || result === '#04');
    assert.ok(
      captured.some((line) => /multiple active tasks/.test(line)),
      'expected stderr warning about multiple tasks'
    );
  } finally {
    process.stderr.write = original;
  }
});

test('lookupShortIdByBranch returns null when registry missing', () => {
  const { repoRoot } = mkRegistryFixture();
  assert.equal(lookupShortIdByBranch('anything', repoRoot), null);
});
