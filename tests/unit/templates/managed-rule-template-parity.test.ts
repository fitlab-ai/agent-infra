import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PAIRS: ReadonlyArray<readonly [string, string]> = [
  [
    '.agents/rules/release-commands.md',
    'templates/.agents/rules/release-commands.zh-CN.md',
  ],
  [
    '.agents/rules/review-handshake.md',
    'templates/.agents/rules/review-handshake.zh-CN.md',
  ],
  [
    '.agents/rules/review-method.md',
    'templates/.agents/rules/review-method.zh-CN.md',
  ],
  [
    '.agents/rules/sync-content-generation.md',
    'templates/.agents/rules/sync-content-generation.zh-CN.md',
  ],
];

for (const [runtimePath, templatePath] of PAIRS) {
  test(`${runtimePath} is byte-identical to its managed template`, () => {
    const runtime = fs.readFileSync(path.resolve(process.cwd(), runtimePath), 'utf8');
    const template = fs.readFileSync(path.resolve(process.cwd(), templatePath), 'utf8');
    assert.equal(runtime, template, `${runtimePath} drifted from ${templatePath}`);
  });
}
