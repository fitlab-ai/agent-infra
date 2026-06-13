import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const LIFECYCLE_SKILLS = [
  'analyze-task',
  'review-analysis',
  'plan-task',
  'review-plan',
  'code-task',
  'review-code',
  'commit',
  'create-pr',
  'complete-task',
  'cancel-task',
  'block-task',
  'restore-task',
  'check-task',
  'create-task',
  'import-issue',
  'import-codescan',
  'import-dependabot',
  'close-codescan',
  'close-dependabot'
];

const GUARD_LITERAL = '`^[#]?[0-9]+$`';

function read(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

// Structural check: every lifecycle SKILL.md (runtime + en/zh-CN templates)
// must reference the new SKILL-parameter parser regex literal. The regex
// itself is the executable contract — if the doc shows it, the parser
// behaves consistently. We do not assert against any prose wording.

for (const name of LIFECYCLE_SKILLS) {
  test(`runtime SKILL.md (${name}) declares the SKILL parameter guard`, () => {
    const p = path.resolve('.agents/skills', name, 'SKILL.md');
    assert.ok(fs.existsSync(p), `missing runtime SKILL.md for ${name}`);
    const content = read(p);
    assert.ok(
      content.includes(GUARD_LITERAL),
      `${p} should reference ${GUARD_LITERAL} in the task-id short-ref guard`
    );
  });

  test(`zh-CN template SKILL.md (${name}) declares the SKILL parameter guard`, () => {
    const p = path.resolve('templates/.agents/skills', name, 'SKILL.zh-CN.md');
    assert.ok(fs.existsSync(p), `missing zh-CN template SKILL.md for ${name}`);
    const content = read(p);
    assert.ok(
      content.includes(GUARD_LITERAL),
      `${p} should reference ${GUARD_LITERAL} in the task-id short-ref guard`
    );
  });

  test(`en template SKILL.md (${name}) declares the SKILL parameter guard`, () => {
    const p = path.resolve('templates/.agents/skills', name, 'SKILL.en.md');
    assert.ok(fs.existsSync(p), `missing en template SKILL.md for ${name}`);
    const content = read(p);
    assert.ok(
      content.includes(GUARD_LITERAL),
      `${p} should reference ${GUARD_LITERAL} in the task-id short-ref guard`
    );
  });
}
