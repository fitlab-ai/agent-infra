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
// pipe) so it also matches table-cell commands.
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
const HELPER = /agent-infra-internal agent-client next-steps --skill ([a-z0-9-]+|\{next-skill\})( --task-ref \{task-ref\}|\s+\[--task-ref \{task-ref\}\])?/g;

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

test('runtime and bilingual next-step templates use the shared helper structure', () => {
  const runtime = listMarkdown(path.resolve('.agents/skills'))
    .filter((file) => fs.readFileSync(file, 'utf8').includes('{next-step-commands}'));
  const templates = listMarkdown(path.resolve('templates/.agents/skills'))
    .filter((file) => fs.readFileSync(file, 'utf8').includes('{next-step-commands}'));

  assert.equal(runtime.length, 26);
  assert.equal(templates.length, 52);

  for (const file of [...runtime, ...templates]) {
    const content = fs.readFileSync(file, 'utf8');
    const helpers = [...content.matchAll(HELPER)];
    assert.ok(helpers.length > 0, `${path.relative(process.cwd(), file)} has no helper invocation`);
    assert.ok(
      helpers.every((match) => match[1] && (
        !match[2]
        || match[2] === ' --task-ref {task-ref}'
        || match[2].trim() === '[--task-ref {task-ref}]'
      )),
      `${path.relative(process.cwd(), file)} has an invalid helper invocation`
    );
  }
});

test('English and Chinese next-step templates have matching helper scenarios', () => {
  const templates = listMarkdown(path.resolve('templates/.agents/skills'))
    .filter((file) => fs.readFileSync(file, 'utf8').includes('{next-step-commands}'));
  const bases = new Set(
    templates.map((file) => file.replace(/\.(?:en|zh-CN)\.md$/, ''))
  );

  assert.equal(bases.size, 26);
  for (const base of bases) {
    const en = fs.readFileSync(`${base}.en.md`, 'utf8');
    const zh = fs.readFileSync(`${base}.zh-CN.md`, 'utf8');
    const scenarios = (content: string) =>
      [...content.matchAll(HELPER)].map((match) => ({
        skill: match[1],
        taskRef: Boolean(match[2])
      }));
    assert.deepEqual(scenarios(en), scenarios(zh), path.relative(process.cwd(), base));
    assert.equal(
      en.match(/\{next-step-commands\}/g)?.length,
      zh.match(/\{next-step-commands\}/g)?.length,
      path.relative(process.cwd(), base)
    );
  }
});
