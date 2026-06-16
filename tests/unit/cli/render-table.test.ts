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

test('formatTable zebra: header + odd rows unchanged vs baseline; row count preserved', () => {
  const headers = ['#', 'NAME'];
  const rows = [['1', 'a'], ['2', 'b'], ['3', 'c'], ['4', 'd']];
  const plain = formatTable(headers, rows); // zebra off → baseline, never dimmed
  const out = formatTable(headers, rows, { zebra: true });

  // Structural guarantees that hold regardless of the ambient color state:
  // the header and odd-numbered data rows are byte-identical to the baseline
  // (which proves they carry no ANSI), and the row count is preserved. The
  // colored even-row wrapping is verified in the forced-color integration test
  // (tests/integration/cli/render-table-zebra.test.ts), because pc.dim is a
  // no-op under NO_COLOR and an in-process equality check would pass vacuously.
  assert.equal(out.length, plain.length);
  assert.equal(out[0], plain[0]); // header never dimmed
  assert.equal(out[1], plain[1]); // odd data row 1 unchanged
  assert.equal(out[3], plain[3]); // odd data row 3 unchanged
});
