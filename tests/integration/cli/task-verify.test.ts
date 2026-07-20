import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { INTERNAL_CLI_PATH } from '../../helpers.ts';

test('internal task-verify passes resolved identity to the validator and preserves exit codes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-verify-integration-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const id = 'TASK-20260101-000001';
  const dir = path.join(root, '.agents', 'workspace', 'active', id);
  const scripts = path.join(root, '.agents', 'scripts');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${id}\n---\n`);
  fs.writeFileSync(path.join(dir, 'code.md'), '# Code\n');
  fs.writeFileSync(path.join(scripts, 'validate-artifact.js'), `
const args = process.argv.slice(2);
const blocked = process.env.FIXTURE_BLOCKED === '1';
const gate = blocked ? 'blocked' : 'pass';
const normalizedArgs = args.filter((value,index) => value !== '--format' && args[index - 1] !== '--format');
const payload = args[0] === 'check'
  ? {status:gate,skill:args[args.indexOf('--skill') + 1],type:args[1],message:normalizedArgs.join('|')}
  : {gate,skill:args[1],checks:[{type:'fixture',status:gate,message:normalizedArgs.join('|')}],summary:'fixture',action:'fixture'};
if (args[args.indexOf('--format') + 1] === 'text') {
  const lines = payload.checks
    ? [\`Verification: \${payload.gate} | Skill: \${payload.skill}\`,'',...payload.checks.map(check => \`  [\${check.status}] \${check.type} - \${check.message}\`),'',\`Result: \${payload.summary} - \${payload.action}\`]
    : [\`Check: \${payload.status} | Skill: \${payload.skill} | Type: \${payload.type}\`,'',\`  [\${payload.status}] \${payload.type} - \${payload.message}\`,'',\`Result: 1 passed, 0 failed - Requested check passed\`];
  process.stdout.write(lines.join('\\n') + '\\n');
} else process.stdout.write(JSON.stringify(payload) + '\\n');
process.exit(blocked ? 2 : 0);
`);

  const pass = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-verify', id, 'code.completed', '--artifact', 'code.md', '--format', 'text'], { cwd: root, encoding: 'utf8' });
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /Verification: pass \| Skill: code-task/);
  assert.match(pass.stdout, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const direct = spawnSync(process.execPath, [path.join(scripts, 'validate-artifact.js'), 'gate', 'code-task', dir, 'code.md', '--format', 'text'], { cwd: root, encoding: 'utf8' });
  assert.equal(pass.stdout, direct.stdout);

  const preflight = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-verify', id, 'complete-task.preflight', '--format', 'text'], { cwd: root, encoding: 'utf8' });
  assert.equal(preflight.status, 0, preflight.stderr);
  assert.equal((preflight.stdout.match(/^Check: pass/gm) ?? []).length, 2);
  assert.doesNotMatch(preflight.stdout, /undefined/);

  const blocked = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-verify', id, 'commit.completed'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, FIXTURE_BLOCKED: '1' }
  });
  assert.equal(blocked.status, 2);
  assert.equal(JSON.parse(blocked.stdout).status, 'blocked');

  const duplicate = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-verify', id, 'commit.completed', '--format', 'json', '--format', 'text'], { cwd: root, encoding: 'utf8' });
  assert.equal(duplicate.status, 1);
  assert.equal(JSON.parse(duplicate.stdout).error.code, 'VERIFY_PAYLOAD_INVALID');
});
