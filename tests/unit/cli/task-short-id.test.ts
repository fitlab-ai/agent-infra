import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeShortIdInput,
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
  { input: '5', L: 2, expectKind: 'shortId', expectValue: '05' },
  { input: '05', L: 2, expectKind: 'shortId', expectValue: '05' },
  { input: '005', L: 2, expectKind: 'shortId', expectValue: '05' },
  // removed hash-prefixed syntax passes through for task resolvers to reject
  { input: '#5', L: 2, expectKind: 'pass', expectValue: '#5' },
  { input: '#05', L: 2, expectKind: 'pass', expectValue: '#05' },
  { input: '#005', L: 2, expectKind: 'pass', expectValue: '#005' },
  // boundary at capacity, L=2
  { input: '99', L: 2, expectKind: 'shortId', expectValue: '99' },
  { input: '#099', L: 2, expectKind: 'pass', expectValue: '#099' },
  // over capacity, L=2
  { input: '100', L: 2, expectKind: 'error', expectErrorMatch: /exceeds shortIdLength=2/ },
  { input: '#100', L: 2, expectKind: 'pass', expectValue: '#100' },
  // reserved zero, L=2
  { input: '0', L: 2, expectKind: 'error', expectErrorMatch: /reserved/ },
  { input: '00', L: 2, expectKind: 'error', expectErrorMatch: /reserved/ },
  { input: '#0', L: 2, expectKind: 'pass', expectValue: '#0' },
  { input: '#00', L: 2, expectKind: 'pass', expectValue: '#00' },
  { input: '#000', L: 2, expectKind: 'pass', expectValue: '#000' },
  // L=1
  { input: '5', L: 1, expectKind: 'shortId', expectValue: '5' },
  { input: '9', L: 1, expectKind: 'shortId', expectValue: '9' },
  { input: '10', L: 1, expectKind: 'error', expectErrorMatch: /exceeds shortIdLength=1/ },
  // L=3
  { input: '#5', L: 3, expectKind: 'pass', expectValue: '#5' },
  { input: '999', L: 3, expectKind: 'shortId', expectValue: '999' },
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
