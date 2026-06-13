import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const RUNTIME = path.resolve(process.cwd(), '.agents/scripts/task-short-id.js');
const TEMPLATE = path.resolve(process.cwd(), 'templates/.agents/scripts/task-short-id.js');

function extractParseShortIdArg(content: string): string {
  const m = content.match(/function parseShortIdArg\(arg, shortIdLength\) \{[\s\S]+?\n\}/);
  assert.ok(m, 'parseShortIdArg function not found');
  return m[0]
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
    .trim();
}

test('parseShortIdArg function body is byte-identical between runtime and template scripts', () => {
  const runtime = extractParseShortIdArg(fs.readFileSync(RUNTIME, 'utf8'));
  const template = extractParseShortIdArg(fs.readFileSync(TEMPLATE, 'utf8'));
  assert.equal(
    runtime,
    template,
    'parseShortIdArg drifted between .agents/scripts/task-short-id.js and templates/.agents/scripts/task-short-id.js'
  );
});
