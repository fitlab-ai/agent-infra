import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const TASK_CONTEXT_SKILLS = [
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
  'check-task',
  'complete-manual-validation',
  'watch-pr'
];

const SHORT_ID_ONLY_SKILLS = [
  'restore-task',
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

for (const name of SHORT_ID_ONLY_SKILLS) {
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

for (const name of TASK_CONTEXT_SKILLS) {
  for (const [variant, p] of [
    ['runtime', path.resolve('.agents/skills', name, 'SKILL.md')],
    ['English template', path.resolve('templates/.agents/skills', name, 'SKILL.en.md')],
    ['Chinese template', path.resolve('templates/.agents/skills', name, 'SKILL.zh-CN.md')]
  ] as const) {
    test(`${variant} SKILL.md (${name}) delegates task identity to task-context`, () => {
      const content = read(p);
      assert.ok(content.includes('agent-infra-internal task-context resolve'));
      assert.ok(content.includes('taskId'));
    });
  }

  test(`TUI wrappers (${name}) preserve full task-scope arguments`, () => {
    const claude = read(path.resolve('.claude/commands', `${name}.md`));
    const opencode = read(path.resolve('.opencode/commands', `${name}.md`));
    const gemini = read(path.resolve('.gemini/commands/agent-infra', `${name}.toml`));
    assert.ok(claude.includes('--task <ref>'));
    assert.ok(opencode.includes('$ARGUMENTS'));
    assert.ok(gemini.includes('{{args}}'));
  });

  test(`TUI templates (${name}) preserve platform-specific argument variables`, () => {
    for (const locale of ['en', 'zh-CN']) {
      assert.ok(read(path.resolve('templates/.claude/commands', `${name}.${locale}.md`)).includes('--task <ref>'));
      assert.ok(read(path.resolve('templates/.opencode/commands', `${name}.${locale}.md`)).includes('$ARGUMENTS'));
      assert.ok(read(path.resolve('templates/.gemini/commands/_project_', `${name}.${locale}.toml`)).includes('{{args}}'));
    }
  });
}
