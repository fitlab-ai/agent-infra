import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Structurally traverse every skill markdown file (runtime + bilingual templates)
// and assert that next-step TUI commands use the short-id placeholder {task-ref},
// never the full-id {task-id}. This replaces the previous hard-coded file list so
// newly added skills cannot silently regress.
const SCAN_DIRS = ['.agents/skills', 'templates/.agents/skills'];

// A TUI command token: "/cmd", "/agent-infra:cmd", "/{{project}}:cmd" or "$cmd"
// (bullet line or Markdown table cell) immediately followed by a task placeholder.
// The token prefix is intentionally permissive (anything but whitespace / backtick /
// pipe) so it also matches the "{{project}}" Gemini form and table-cell commands.
const TUI_TOKEN = /([/$][^\s`|]+)\s+\{(task-id|task-ref)\}/g;

function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdown(p));
    else if (entry.name.endsWith('.md')) out.push(p);
  }
  return out;
}

const files = SCAN_DIRS.flatMap((dir) => listMarkdown(path.resolve(dir)));

for (const file of files) {
  const rel = path.relative(process.cwd(), file);
  const content = fs.readFileSync(file, 'utf8');
  const tokens = [...content.matchAll(TUI_TOKEN)];
  if (tokens.length === 0) continue; // file has no next-step TUI commands

  test(`${rel}: next-step commands use {task-ref}, not {task-id}`, () => {
    const offenders = tokens
      .filter((m) => m[2] === 'task-id')
      .map((m) => `${m[1]} {${m[2]}}`);
    assert.deepEqual(
      offenders,
      [],
      `next-step command tokens must use {task-ref}, but found {task-id}:\n${offenders.join('\n')}`
    );
    // A file that contains TUI command tokens must reference the short id.
    assert.ok(content.includes('{task-ref}'), `${rel} has TUI command tokens but no {task-ref}`);
  });
}

// Report titles ("任务 {task-id} ..." / "Task {task-id} ...") and artifact paths
// (".agents/workspace/active/{task-id}/...") must keep the full {task-id} form.
test('report titles and artifact paths keep the full {task-id}', () => {
  const runtime = fs.readFileSync(path.resolve('.agents/skills/analyze-task/SKILL.md'), 'utf8');
  assert.match(
    runtime,
    /\.agents\/workspace\/active\/\{task-id\}\//,
    'artifact paths must keep the full {task-id}'
  );
  assert.match(
    runtime,
    /(?:任务|Task)\s+\{task-id\}/,
    'report titles must keep the full {task-id}'
  );
});
