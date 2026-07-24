import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const proxyNames = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']);

function declaredArgs(content: string): string[] {
  return content.split(/\r?\n/).flatMap((line) => {
    const instruction = line.match(/^\s*ARG\s+(.+)$/i)?.[1];
    if (!instruction) return [];
    return instruction.trim().split(/\s+/).map((entry) => entry.split('=', 1)[0]?.toUpperCase() ?? '');
  });
}

test('managed Dockerfile fragments do not declare predefined proxy args', () => {
  const runtimeDir = path.resolve('lib/sandbox/runtimes');
  for (const name of fs.readdirSync(runtimeDir).filter((entry) => entry.endsWith('.dockerfile'))) {
    const declarations = declaredArgs(fs.readFileSync(path.join(runtimeDir, name), 'utf8'));
    assert.deepEqual(declarations.filter((entry) => proxyNames.has(entry)), [], name);
  }
});
