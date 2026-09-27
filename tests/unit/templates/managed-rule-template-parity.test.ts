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
  [
    '.agents/rules/validation-output.md',
    'templates/.agents/rules/validation-output.zh-CN.md',
  ],
];

for (const [runtimePath, templatePath] of PAIRS) {
  test(`${runtimePath} is byte-identical to its managed template`, () => {
    const runtime = fs.readFileSync(path.resolve(process.cwd(), runtimePath), 'utf8');
    const template = fs.readFileSync(path.resolve(process.cwd(), templatePath), 'utf8');
    assert.equal(runtime, template, `${runtimePath} drifted from ${templatePath}`);
  });
}

test('English and Chinese validation output templates share the same section and list structure', () => {
  const paths = [
    '.agents/rules/validation-output.md',
    'templates/.agents/rules/validation-output.en.md',
    'templates/.agents/rules/validation-output.zh-CN.md',
  ];
  const structure = (content: string) => {
    const sections: Array<{ level: number; listItems: number }> = [{ level: 0, listItems: 0 }];
    for (const line of content.split(/\r?\n/u)) {
      const heading = /^(#{1,6})\s/u.exec(line);
      if (heading) {
        sections.push({ level: heading[1]!.length, listItems: 0 });
      } else if (/^\s{0,3}[-*+]\s/u.test(line)) {
        sections[sections.length - 1]!.listItems += 1;
      }
    }
    return sections;
  };
  const structures = paths.map((relativePath) => structure(fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')));
  assert.deepEqual(structures[1], structures[0], 'English template structure should match the source rule');
  assert.deepEqual(structures[2], structures[0], 'Chinese template structure should match the source rule');
});
