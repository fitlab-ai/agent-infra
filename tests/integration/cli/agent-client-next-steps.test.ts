import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { INTERNAL_CLI_PATH } from '../../helpers.ts';

function canonical(enabled: readonly string[]) {
  return ['claude-code', 'codex', 'antigravity-cli', 'opencode', 'traecli'].map((id) => ({
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
    agentClients: canonical(['codex', 'antigravity-cli']),
    customTUIs: [
      { name: 'Acme', dir: '.acme/commands', invoke: 'acme ${projectName}:${skillName}' }
    ]
  });

  const text = run(root, ['--skill', 'review-code', '--task-ref', '16']);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(
    text.stdout,
    '  - Codex: $review-code --task 16\n'
      + '  - Antigravity CLI: /review-code --task 16\n'
      + '  - Acme: acme demo:review-code --task 16\n'
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
  assert.equal(payload.commands[0].command, '$review-code --task TASK-20260718-232501');
  assert.deepEqual(payload.diagnostics, []);
  assert.equal(payload.error, null);

  const versioned = run(root, [
    '--skill', 'post-release',
    '--task-ref', '16',
    '--version', '1.2.3'
  ]);
  assert.equal(versioned.status, 0, versioned.stderr);
  assert.equal(
    versioned.stdout,
    '  - Codex: $post-release 16 1.2.3\n'
      + '  - Antigravity CLI: /post-release 16 1.2.3\n'
      + '  - Acme: acme demo:post-release 16 1.2.3\n'
  );
});

test('agent-client next-steps fails closed for legacy selection and preserves empty output semantics', () => {
  const legacy = fixture({ project: 'demo', tuis: ['opencode'], sandbox: { tools: [] } });
  const legacyResult = run(legacy, ['--skill', 'commit']);
  assert.equal(legacyResult.status, 1);
  assert.equal(JSON.parse(legacyResult.stdout).error.code, 'MISSING_AGENT_CLIENT');

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
    [fixture({ project: 'demo', agentClients: canonical([]) }), ['--skill', 'commit', '--skill', 'test'], 'AGENT_CLIENT_PAYLOAD_INVALID'],
    [fixture({ project: 'demo', agentClients: canonical([]) }), ['--skill', 'commit', '--version', '1.2.3', '--version', '1.2.4'], 'AGENT_CLIENT_PAYLOAD_INVALID'],
    [fixture({ project: 'demo', agentClients: canonical([]) }), ['--skill', 'commit', '--version'], 'AGENT_CLIENT_PAYLOAD_INVALID'],
    [fixture({ project: 'demo', agentClients: canonical([]) }), ['--skill', 'commit', '--version', 'v1.2.3'], 'AGENT_CLIENT_RENDER_INVALID']
  ] as const) {
    const result = run(root, [...args]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, code);
  }
});

test('agent-client model-selection labels host-only guidance without inventing a catalog', () => {
  const root = fixture({ project: 'demo', agentClients: canonical(['claude-code']) });
  const result = spawnSync(
    process.execPath,
    [INTERNAL_CLI_PATH, 'agent-client', 'model-selection', '--client', 'claude-code', '--format', 'json'],
    { cwd: root, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.context.kind, 'interactive-only');
  assert.equal(payload.context.command, '/model');
  assert.equal('models' in payload.context, false);
});
