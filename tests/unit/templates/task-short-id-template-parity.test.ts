import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const RUNTIME = path.resolve(process.cwd(), '.agents/scripts/task-short-id.js');
const TEMPLATE = path.resolve(process.cwd(), 'templates/.agents/scripts/task-short-id.js');

test('task-short-id compatibility adapter is byte-identical between runtime and template', () => {
  const runtime = fs.readFileSync(RUNTIME, 'utf8').replace(/^#![^\n]*\n/, '');
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  assert.equal(
    runtime,
    template,
    'parseShortIdArg drifted between .agents/scripts/task-short-id.js and templates/.agents/scripts/task-short-id.js'
  );
});
