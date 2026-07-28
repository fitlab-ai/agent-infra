import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { INTERNAL_CLI_PATH } from '../../helpers.ts';

function canonical(enabled: readonly string[]) {
  return ['claude-code', 'codex', 'gemini-cli', 'opencode'].map((id) => ({
    id,
    enabled: enabled.includes(id),
    installInSandbox: false
  }));
}

function fixture(config: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-client-next-steps-'));
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.agents', '.airc.json'),
    typeof config === 'string' ? config : `${JSON.stringify(config, null, 2)}\n`
  );
  return root;
}

function run(root: string, args: string[]) {
  return spawnSync(
    process.execPath,
    [INTERNAL_CLI_PATH, 'agent-client', 'next-steps', ...args],
    { cwd: root, encoding: 'utf8' }
  );
}

test('agent-client next-steps renders enabled built-ins and custom TUIs in text and JSON', () => {
  const root = fixture({
    project: 'demo',
    agentClients: canonical(['codex', 'gemini-cli']),
    customTUIs: [
      { name: 'Acme', dir: '.acme/commands', invoke: 'acme ${projectName}:${skillName}' }
    ]
  });

  const text = run(root, ['--skill', 'review-code', '--task-ref', '16']);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(
    text.stdout,
    '  - Codex: $review-code 16\n'
      + '  - Gemini CLI: /demo:review-code 16\n'
      + '  - Acme: acme demo:review-code 16\n'
  );
  assert.equal(text.stderr, '');

  const json = run(root, [
    '--skill', 'review-code',
    '--task-ref', 'TASK-20260718-232501',
    '--format', 'json'
  ]);
  assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.status, 'rendered');
  assert.equal(payload.changed, false);
  assert.equal(payload.commands.length, 3);
  assert.equal(payload.commands[0].command, '$review-code TASK-20260718-232501');
  assert.deepEqual(payload.diagnostics, []);
  assert.equal(payload.error, null);
});

test('agent-client next-steps preserves legacy selection and empty output semantics', () => {
  const legacy = fixture({ project: 'demo', tuis: ['opencode'], sandbox: { tools: [] } });
  const legacyResult = run(legacy, ['--skill', 'commit']);
  assert.equal(legacyResult.status, 0, legacyResult.stderr);
  assert.equal(legacyResult.stdout, '  - OpenCode: /commit\n');

  const empty = fixture({ project: 'demo', agentClients: canonical([]), customTUIs: [] });
  const emptyResult = run(empty, ['--skill', 'commit']);
  assert.equal(emptyResult.status, 0, emptyResult.stderr);
  assert.equal(emptyResult.stdout, '');
});

test('agent-client next-steps reports custom diagnostics without hiding valid commands', () => {
  const root = fixture({
    project: 'demo',
    agentClients: canonical(['codex']),
    customTUIs: [
      { name: 'Bad', dir: '../outside', invoke: 'bad ${skillName}' },
      { name: 'Good', dir: '.good', invoke: 'good ${skillName}' }
    ]
  });
  const result = run(root, ['--skill', 'commit']);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '  - Codex: $commit\n  - Good: good commit\n');
  assert.match(result.stderr, /INVALID_CUSTOM_TUI at customTUIs\[0\]\.dir/);
});

test('agent-client next-steps fails closed for invalid config and arguments', () => {
  for (const [root, args, code] of [
    [fixture('{'), ['--skill', 'commit'], 'AGENT_CLIENT_CONFIG_INVALID'],
    [fixture({ project: 'demo', agentClients: [] }), ['--skill', 'commit'], 'MISSING_AGENT_CLIENT'],
    [fixture({ project: 'demo', agentClients: canonical([]) }), ['--unknown'], 'AGENT_CLIENT_PAYLOAD_INVALID'],
    [fixture({ project: 'demo', agentClients: canonical([]) }), ['--skill', 'commit', '--skill', 'test'], 'AGENT_CLIENT_PAYLOAD_INVALID']
  ] as const) {
    const result = run(root, [...args]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, code);
  }
});
