import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { commandSpecs } from '../../helpers/command-specs.ts';
import { isTaskScopeSkill } from '../../../lib/task/skill-scope.ts';

const TASK_CONTEXT_SKILL_USAGES: Record<string, string> = {
  'analyze-task': '[--task <ref> | -t <ref>]',
  'review-analysis': '[--task <ref> | -t <ref>]',
  'plan-task': '[--task <ref> | -t <ref>]',
  'review-plan': '[--task <ref> | -t <ref>]',
  'code-task': '[--task <ref> | -t <ref>]',
  'review-code': '[--task <ref> | -t <ref>]',
  commit: '[--task <ref> | -t <ref>]',
  'create-pr': '[--task <ref> | -t <ref>] [target-branch]',
  'complete-task': '[--task <ref> | -t <ref>] [--skip-pr] [--force]',
  'cancel-task': '[--task <ref> | -t <ref>] <reason>',
  'block-task': '[--task <ref> | -t <ref>] [reason]',
  'check-task': '[--task <ref> | -t <ref>]',
  'complete-manual-validation': '[--task <ref> | -t <ref>] [pr-ref] <verification-summary>',
  'watch-pr': '[--task <ref> | -t <ref>] | [--pr <number>] | [<pr-url>]',
  'run-manual-validation': '[--task <ref> | -t <ref>] [--scope snapshot|inplace] [--timeout <ms>] [--format text|json] -- <command...>',
  'run-task': '[--task <ref> | -t <ref>] [--executor-model <model> --executor-reasoning-effort <effort> --reviewer-model <model> --reviewer-reasoning-effort <effort>]'
};

const TASK_CONTEXT_SKILLS = Object.keys(TASK_CONTEXT_SKILL_USAGES);

test('public task scope registry covers the documented sixteen skills only', () => {
  assert.equal(TASK_CONTEXT_SKILLS.length, 16);
  for (const name of TASK_CONTEXT_SKILLS) assert.equal(isTaskScopeSkill(name), true);
  assert.equal(isTaskScopeSkill('post-release'), false);
  assert.equal(isTaskScopeSkill('test'), false);
  assert.equal(isTaskScopeSkill('test-integration'), false);
});

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
  test(`command spec (${name}) declares the approved public grammar`, () => {
    assert.equal(commandSpecs[name]?.usage, TASK_CONTEXT_SKILL_USAGES[name]);
  });

  for (const [variant, p] of [
    ['runtime', path.resolve('.agents/skills', name, 'SKILL.md')],
    ['English template', path.resolve('templates/.agents/skills', name, 'SKILL.en.md')],
    ['Chinese template', path.resolve('templates/.agents/skills', name, 'SKILL.zh-CN.md')]
  ] as const) {
    test(`${variant} SKILL.md (${name}) delegates task identity to task-context`, () => {
      const content = read(p);
      assert.ok(content.includes('agent-infra-internal task-context resolve'));
      if (name !== 'run-task' && name !== 'run-manual-validation') {
        assert.ok(content.includes('taskId'));
      }
    });
  }

  test(`TUI wrappers (${name}) preserve full task-scope arguments`, () => {
    const claude = read(path.resolve('.claude/commands', `${name}.md`));
    const opencode = read(path.resolve('.opencode/commands', `${name}.md`));
    assert.ok(claude.includes(`usage: "/${name} ${TASK_CONTEXT_SKILL_USAGES[name]}"`));
    assert.ok(opencode.includes('$ARGUMENTS'));
  });

  test(`TUI templates (${name}) preserve platform-specific argument variables`, () => {
    for (const locale of ['en', 'zh-CN']) {
      assert.ok(read(path.resolve('templates/.claude/commands', `${name}.${locale}.md`)).includes(`usage: "/${name} ${TASK_CONTEXT_SKILL_USAGES[name]}"`));
      assert.ok(read(path.resolve('templates/.opencode/commands', `${name}.${locale}.md`)).includes('$ARGUMENTS'));
    }
  });
}
