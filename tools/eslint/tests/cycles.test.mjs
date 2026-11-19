import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../check-cycles.mjs', import.meta.url));
function check(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'cycles-'));
  try {
    mkdirSync(path.join(root, 'bin'));
    mkdirSync(path.join(root, 'lib'));
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(root, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    return spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('detects self, multi-file and re-export cycles', () => {
  for (const files of [
    { 'lib/a.ts': "import './a.ts';" },
    { 'lib/a.ts': "import './b.js';", 'lib/b.ts': "import './a.ts';" },
    { 'lib/a.ts': "export * from './b';", 'lib/b/index.ts': "export { x } from '../a';" }
  ]) {
    const result = check(files);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cycle/i);
    assert.match(result.stderr, /lib\/a\.ts/);
  }
});

test('ignores type-only edges and detects mixed imports', () => {
  const types = { 'lib/a.ts': "import type { B } from './b';", 'lib/b.ts': "export type { A } from './a';" };
  assert.equal(check(types).status, 0);
  types['lib/a.ts'] = "import { type B, value } from './b';";
  types['lib/b.ts'] = "import './a';";
  assert.equal(check(types).status, 1);
});

test('fails on unresolved runtime imports and syntax errors', () => {
  for (const files of [{ 'bin/a.ts': "import './missing';" }, { 'bin/a.ts': 'const = ;' }]) {
    const result = check(files);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /bin\/a\.ts/);
  }
});


test('resolves index and js references while ignoring existing files outside the graph', () => {
  const result = check({
    'lib/a.ts': "import { value } from './nested'; import '../outside.js';",
    'lib/nested/index.ts': "export { value } from './value.js';",
    'lib/nested/value.ts': 'export const value = 1;',
    'outside.js': 'export const external = 1;'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /3 TypeScript files/);
});

test('ignores import and re-export declarations containing only type specifiers', () => {
  const result = check({
    'lib/a.ts': "import { type B } from './b';",
    'lib/b.ts': "export { type A } from './a';"
  });
  assert.equal(result.status, 0, result.stderr);
});
