import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const RUNTIME_FILES = [
  '.agents/skills/review-analysis/reference/output-templates.md',
  '.agents/skills/review-plan/reference/output-templates.md',
  '.agents/skills/review-code/reference/output-templates.md',
  '.agents/skills/code-task/reference/output-template.md',
  '.agents/skills/code-task/reference/fix-mode.md'
];

const TEMPLATE_FILES = [
  'templates/.agents/skills/review-analysis/reference/output-templates.en.md',
  'templates/.agents/skills/review-plan/reference/output-templates.en.md',
  'templates/.agents/skills/review-code/reference/output-templates.en.md',
  'templates/.agents/skills/code-task/reference/output-template.en.md',
  'templates/.agents/skills/code-task/reference/fix-mode.en.md',
  'templates/.agents/skills/review-analysis/reference/output-templates.zh-CN.md',
  'templates/.agents/skills/review-plan/reference/output-templates.zh-CN.md',
  'templates/.agents/skills/review-code/reference/output-templates.zh-CN.md',
  'templates/.agents/skills/code-task/reference/output-template.zh-CN.md',
  'templates/.agents/skills/code-task/reference/fix-mode.zh-CN.md'
];

// "Next-step" command line: a TUI prefix + invocation token + task ref.
const NEXT_STEP_LINE = /^\s*-\s*(?:Claude Code(?:\s*\/\s*OpenCode)?|Gemini CLI|Codex CLI|OpenCode)\s*[:：]\s*[/$][A-Za-z0-9:_/{}-]+\s+\{(task-id|task-ref)\}/m;

function read(p: string): string {
  return fs.readFileSync(path.resolve(p), 'utf8');
}

for (const file of [...RUNTIME_FILES, ...TEMPLATE_FILES]) {
  test(`${file}: next-step command lines use {task-ref}`, () => {
    const content = read(file);
    // No command line should still use {task-id}.
    const stillTaskId = content
      .split('\n')
      .filter((line) => /^\s*-\s*(?:Claude Code(?:\s*\/\s*OpenCode)?|Gemini CLI|Codex CLI|OpenCode)\s*[:：]\s*[/$]/m.test(line))
      .filter((line) => /\{task-id\}/.test(line));
    assert.deepEqual(
      stillTaskId,
      [],
      `next-step command lines should use {task-ref}, but found {task-id}:\n${stillTaskId.join('\n')}`
    );
    // At least one {task-ref} must exist (file should have next-step blocks).
    assert.match(content, /\{task-ref\}/, `${file} should contain at least one {task-ref}`);
  });

  test(`${file}: report titles and paths preserve {task-id}`, () => {
    const content = read(file);
    // Report-summary line ("任务 {task-id} ..." / "Task {task-id} ...") and
    // the active-workspace path ".agents/workspace/active/{task-id}/..." must
    // keep the full task id placeholder.
    const hasFullPath = /\.agents\/workspace\/active\/\{task-id\}\//.test(content);
    const hasReportSummary = /(?:任务|Task)\s+\{task-id\}/.test(content);
    assert.ok(
      hasFullPath || hasReportSummary,
      `${file} should retain {task-id} in titles or paths`
    );
  });
}
