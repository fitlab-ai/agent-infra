import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function filePath(...segments: string[]): string {
  return path.resolve(process.cwd(), ...segments);
}

test('platform smoke scripts target the migrated integration boundary', () => {
  const pkg = JSON.parse(fs.readFileSync(filePath('package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const smoke = pkg.scripts['test:platform-smoke'] ?? '';
  const fastSmoke = pkg.scripts['test:platform-smoke:fast'] ?? '';
  assert.match(smoke, /tests\/integration\/platform-smoke\/\*\*\/\*\.test\.ts/);
  assert.match(fastSmoke, /--skip-build/);
  assert.match(fastSmoke, /tests\/integration\/platform-smoke\/\*\*\/\*\.test\.ts/);
});
