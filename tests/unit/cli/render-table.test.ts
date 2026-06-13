import test from 'node:test';
import assert from 'node:assert/strict';

import { formatTable } from '../../../lib/table.ts';

test('formatTable renders header + rows with padded columns', () => {
  const out = formatTable(['#', 'NAME', 'STATUS'], [
    ['1', 'alpha', 'Up 10m'],
    ['10', 'beta-longer', 'Exited']
  ]);
  assert.equal(out.length, 3);
  assert.equal(out[0], '#   NAME         STATUS');
  assert.equal(out[1], '1   alpha        Up 10m');
  assert.equal(out[2], '10  beta-longer  Exited');
});

test('formatTable handles header-only rendering', () => {
  const out = formatTable(['A', 'B'], []);
  assert.deepEqual(out, ['A  B']);
});

test('formatTable trims trailing whitespace on each row', () => {
  const out = formatTable(['A', 'B'], [['hello', '']]);
  assert.equal(out[1], 'hello');
  assert.ok(!out[1]!.endsWith(' '), 'trailing whitespace should be trimmed');
});

test('formatTable column widths track widest header or row cell', () => {
  const out = formatTable(['short', 'h'], [['a', 'verylong']]);
  // header "short" (len 5) wider than cell "a" → first col padded to 5.
  assert.equal(out[0], 'short  h');
  assert.equal(out[1], 'a      verylong');
});
