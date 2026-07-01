import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseRunArgs, runSkill } from '../../../lib/run/index.ts';
import { buildTuiCommand, renderPrompt, selectTui } from '../../../lib/run/tui.ts';

const TASK_ID = 'TASK-20260430-163836';

function writeTaskFixture(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'run-skill-repo-'));
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', TASK_ID);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, 'task.md'),
    [
      '---',
      `id: ${TASK_ID}`,
      'branch: agent-infra-feature-server-command-protocol',
      '---',
      '',
      '# Task'
    ].join('\n'),
    'utf8'
  );
  return repoRoot;
}

test('parseRunArgs accepts create-task without task-ref and captures --tui', () => {
  const parsed = parseRunArgs(['create-task', 'write', 'docs', '--tui', 'claude']);
  assert.deepEqual(parsed, {
    skill: 'create-task',
    taskRef: null,
    args: ['write', 'docs'],
    tui: 'claude'
  });
});

test('parseRunArgs requires task-ref for task skills', () => {
  assert.throws(() => parseRunArgs(['code-task']), /requires a task-ref/);
  assert.deepEqual(parseRunArgs(['code-task', '#7', '--tui', 'codex']), {
    skill: 'code-task',
    taskRef: '#7',
    args: [],
    tui: 'codex'
  });
});

test('TUI selection uses cli override, per-skill default, command default, then codex', () => {
  assert.equal(selectTui('code-task', { cliTui: 'gemini', command: {} }), 'gemini');
  assert.equal(
    selectTui('review-code', {
      command: { defaultTui: 'codex', skillTuiDefaults: { 'review-code': 'claude' } }
    }),
    'claude'
  );
  assert.equal(selectTui('plan-task', { command: { defaultTui: 'opencode' } }), 'opencode');
  assert.equal(selectTui('plan-task', { command: {} }), 'codex');
});

test('renderPrompt uses each TUI prompt prefix', () => {
  assert.equal(renderPrompt({ tui: 'claude', skill: 'code-task', args: ['#7'] }), '/code-task #7');
  assert.equal(renderPrompt({ tui: 'opencode', skill: 'code-task', args: ['#7'] }), '/code-task #7');
  assert.equal(renderPrompt({ tui: 'gemini', skill: 'code-task', args: ['#7'] }), '/agent-infra:code-task #7');
  assert.equal(renderPrompt({ tui: 'codex', skill: 'code-task', args: ['#7'] }), '$code-task #7');
});

test('buildTuiCommand returns argv arrays, not shell strings', () => {
  assert.deepEqual(buildTuiCommand('codex', '$code-task #7'), [
    'codex',
    ['exec', '--dangerously-bypass-approvals-and-sandbox', '$code-task #7']
  ]);
  assert.deepEqual(buildTuiCommand('claude', '/code-task #7'), [
    'claude',
    ['--dangerously-skip-permissions', '--print', '/code-task #7']
  ]);
});

test('runSkill routes create-task to host and task skills to sandbox', async () => {
  const calls: string[] = [];
  const repoRoot = writeTaskFixture();
  const createCode = await runSkill(['create-task', 'demo'], {
    repoRoot,
    command: { defaultTui: 'codex' },
    runHost: async (command) => {
      calls.push(`host:${command.join(' ')}`);
      return { exitCode: 0 };
    },
    runSandbox: async () => {
      throw new Error('sandbox should not be used');
    }
  });
  assert.equal(createCode, 0);
  assert.match(calls[0] ?? '', /^host:codex exec/);

  const taskCode = await runSkill(['code-task', TASK_ID], {
    repoRoot,
    command: { defaultTui: 'codex' },
    runHost: async () => {
      throw new Error('host should not be used');
    },
    runSandbox: async (request) => {
      calls.push(`sandbox:${request.taskRef}:${request.command.join(' ')}`);
      return { exitCode: 2, signal: null, stdout: '', stderr: '' };
    }
  });
  assert.equal(taskCode, 2);
  assert.match(calls.at(-1) ?? '', new RegExp(`^sandbox:${TASK_ID}:codex exec`));
});

test('runSkill forwards sandbox stdout and stderr to the ai run process output', async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const repoRoot = writeTaskFixture();
  const code = await runSkill(['code-task', TASK_ID], {
    repoRoot,
    command: { defaultTui: 'codex' },
    writeStdout: (chunk) => stdout.push(chunk),
    writeStderr: (chunk) => stderr.push(chunk),
    runSandbox: async () => ({
      exitCode: 0,
      signal: null,
      stdout: 'skill summary\n',
      stderr: 'warning\n'
    })
  });

  assert.equal(code, 0);
  assert.deepEqual(stdout, ['skill summary\n']);
  assert.deepEqual(stderr, ['warning\n']);
});

test('runSkill honors command.allowedSkills as a narrowing allow-list', async () => {
  await assert.rejects(
    () =>
      runSkill(['code-task', '#7'], {
        command: { allowedSkills: ['plan-task'] },
        runHost: async () => ({ exitCode: 0 }),
        runSandbox: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' })
      }),
    /not allowed/
  );
});
