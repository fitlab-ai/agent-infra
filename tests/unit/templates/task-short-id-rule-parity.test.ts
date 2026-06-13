import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const RUNTIME = path.resolve(process.cwd(), '.agents/rules/task-short-id.md');
const TEMPLATE_ZH = path.resolve(process.cwd(), 'templates/.agents/rules/task-short-id.zh-CN.md');
const TEMPLATE_EN = path.resolve(process.cwd(), 'templates/.agents/rules/task-short-id.en.md');

function read(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

// Structural check: the SKILL parameter resolver section must contain
// the executable bash guard literal — not just any prose mentioning it.
const SKILL_GUARD_LITERAL = '`^[#]?[0-9]+$`';
const SKILL_BASH_LITERAL = '[[ "{task-id}" =~ ^[#]?[0-9]+$ ]]';

test('task-short-id rule doc (runtime) embeds the executable SKILL parser guard', () => {
  const content = read(RUNTIME);
  assert.ok(content.includes(SKILL_GUARD_LITERAL), 'rule doc should reference the parser regex literal');
  assert.ok(content.includes(SKILL_BASH_LITERAL), 'rule doc should embed the runnable bash guard');
});

test('task-short-id rule doc (zh-CN template) embeds the executable SKILL parser guard', () => {
  const content = read(TEMPLATE_ZH);
  assert.ok(content.includes(SKILL_GUARD_LITERAL), 'zh-CN template should reference the parser regex literal');
  assert.ok(content.includes(SKILL_BASH_LITERAL), 'zh-CN template should embed the runnable bash guard');
});

test('task-short-id rule doc (en template) embeds the executable SKILL parser guard', () => {
  const content = read(TEMPLATE_EN);
  assert.ok(content.includes(SKILL_GUARD_LITERAL), 'en template should reference the parser regex literal');
  assert.ok(content.includes(SKILL_BASH_LITERAL), 'en template should embed the runnable bash guard');
});

// Structural check: the resolution-scope table for sandbox entrypoints must
// reference both `ai sandbox exec` and `ai sandbox create` (canonical entry
// points after this PR — they share `resolveTaskBranch`).
const SANDBOX_EXEC = '`ai sandbox exec';
const SANDBOX_CREATE = '`ai sandbox create';

test('task-short-id rule doc lists both sandbox exec and sandbox create entry points', () => {
  for (const [name, p] of [
    ['runtime', RUNTIME],
    ['zh-CN', TEMPLATE_ZH],
    ['en', TEMPLATE_EN]
  ] as const) {
    const content = read(p);
    assert.ok(content.includes(SANDBOX_EXEC), `${name} should list ai sandbox exec in resolution scope`);
    assert.ok(content.includes(SANDBOX_CREATE), `${name} should list ai sandbox create in resolution scope`);
  }
});
