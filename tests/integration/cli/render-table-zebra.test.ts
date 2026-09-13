import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// picocolors freezes its color-support decision at module-load time, and
// loadFreshEsm only cache-busts the target module (not the bare 'picocolors'
// dependency). So the only reliable way to exercise the colored zebra path is a
// fresh child process with color forced on (FORCE_COLOR=1, NO_COLOR removed).
// This test fails if formatTable forgets to wrap even data rows in pc.dim.
test('formatTable zebra: even data rows are dim-wrapped when color is forced on', () => {
  const tableUrl = new URL('../../../lib/table.ts', import.meta.url).href;
  const script = [
    `import { formatTable } from ${JSON.stringify(tableUrl)};`,
    `const rows = [['1', 'a'], ['2', 'b'], ['3', 'c'], ['4', 'd']];`,
    `const out = formatTable(['#', 'NAME'], rows, { zebra: true });`,
    `process.stdout.write(JSON.stringify(out));`
  ].join('\n');

  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '1' };
  delete env.NO_COLOR; // FORCE_COLOR only takes effect when NO_COLOR is unset

  const stdout = execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', '--input-type=module', '--eval', script],
    { encoding: 'utf8', env }
  );

  const out = JSON.parse(stdout) as string[];
  const ESC = String.fromCharCode(27);
  const OPEN = `${ESC}[2m`;
  const CLOSE = `${ESC}[22m`;

  assert.equal(out.length, 5);
  const [row0, row1, row2, row3, row4] = out as [string, string, string, string, string];
  // Header + odd data rows (rows 1 and 3 -> indices 0, 2 after the header) carry no ANSI.
  assert.ok(!row0.includes(ESC), 'header must not be dimmed');
  assert.ok(!row1.includes(ESC), 'odd data row 1 must not be dimmed');
  assert.ok(!row3.includes(ESC), 'odd data row 3 must not be dimmed');
  // Even data rows (rows 2 and 4 -> indices 2, 4) must be dim-wrapped.
  assert.ok(row2.startsWith(OPEN) && row2.endsWith(CLOSE), 'even data row 2 must be dim-wrapped');
  assert.ok(row4.startsWith(OPEN) && row4.endsWith(CLOSE), 'even data row 4 must be dim-wrapped');
});
