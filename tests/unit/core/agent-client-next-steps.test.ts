import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CUSTOM_TUI_CONTRACT,
  normalizeCustomTUIs
} from '../../../lib/agent-clients/custom-tuis.ts';
import {
  renderNextStepCommands
} from '../../../lib/agent-clients/next-steps.ts';
import { renderAgentClientInvocation } from '../../../lib/agent-clients/invocation.ts';
import { AGENT_CLIENT_IDS } from '../../../lib/agent-clients/types.ts';
import type { AgentClientState } from '../../../lib/agent-clients/types.ts';

function stateFor(enabled: readonly string[]): AgentClientState {
  return Object.fromEntries(
    AGENT_CLIENT_IDS.map((id) => [
      id,
      { enabled: enabled.includes(id), installInSandbox: false }
    ])
  ) as AgentClientState;
}

test('shared invocation renderer expands adapter placeholders and appends arguments', () => {
  assert.equal(
    renderAgentClientInvocation('/${projectName}:${skillName}', {
      projectName: 'demo',
      skillName: 'review-code',
      args: ['19', '--strict']
    }),
    '/demo:review-code 19 --strict'
  );
  assert.equal(
    renderAgentClientInvocation('$${skillName}', { skillName: 'code-task' }),
    '$code-task'
  );
});

test('custom TUI contract is JSON-safe and normalization preserves valid input order', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(CUSTOM_TUI_CONTRACT)), CUSTOM_TUI_CONTRACT);

  const input = [
    {
      name: 'Acme',
      dir: './.acme/commands',
      invoke: 'acme ${projectName} ${skillName}',
      extra: true
    },
    {
      name: 'Beta',
      dir: '.beta/prompts',
      invoke: 'beta ${skillName}'
    }
  ];
  const before = structuredClone(input);
  const result = normalizeCustomTUIs('/repo', input);

  assert.deepEqual(result, {
    items: [
      {
        name: 'Acme',
        dir: '.acme/commands',
        invocation: 'acme ${projectName} ${skillName}'
      },
      {
        name: 'Beta',
        dir: '.beta/prompts',
        invocation: 'beta ${skillName}'
      }
    ],
    diagnostics: []
  });
  assert.deepEqual(input, before);
  assert.ok(Object.isFrozen(result.items));
  assert.ok(result.items.every((item) => Object.isFrozen(item)));
  assert.ok(Object.isFrozen(result.diagnostics));
});

test('custom TUI normalization skips invalid entries with stable paths', () => {
  assert.deepEqual(normalizeCustomTUIs('/repo', null), {
    items: [],
    diagnostics: [{ code: 'INVALID_CUSTOM_TUIS', path: 'customTUIs' }]
  });

  const result = normalizeCustomTUIs('/repo', [
    null,
    { name: '', dir: '.x', invoke: 'x ${skillName}' },
    { name: 'X', dir: '../outside', invoke: 'x ${skillName}' },
    { name: 'X', dir: '.x\\commands', invoke: 'x ${skillName}' },
    { name: 'X', dir: '.x', invoke: 'x' },
    { name: 'X', dir: '.x', invoke: 'x ${unknown} ${skillName}' },
    { name: 'X', dir: '.x', invoke: 'x ${skillName} ${unknown' },
    { name: 'X\nY', dir: '.x', invoke: 'x ${skillName}' },
    { name: 'X', dir: '.x', invoke: 'x ${skillName}\nnext' }
  ]);

  assert.deepEqual(result.items, []);
  assert.deepEqual(result.diagnostics, [
    { code: 'INVALID_CUSTOM_TUI', path: 'customTUIs[0]' },
    { code: 'INVALID_CUSTOM_TUI', path: 'customTUIs[1].name' },
    { code: 'INVALID_CUSTOM_TUI', path: 'customTUIs[2].dir' },
    { code: 'INVALID_CUSTOM_TUI', path: 'customTUIs[3].dir' },
    { code: 'INVALID_CUSTOM_TUI_PLACEHOLDER', path: 'customTUIs[4].invoke' },
    { code: 'INVALID_CUSTOM_TUI_PLACEHOLDER', path: 'customTUIs[5].invoke' },
    { code: 'INVALID_CUSTOM_TUI_PLACEHOLDER', path: 'customTUIs[6].invoke' },
    { code: 'INVALID_CUSTOM_TUI', path: 'customTUIs[7].name' },
    { code: 'INVALID_CUSTOM_TUI', path: 'customTUIs[8].invoke' }
  ]);
});

test('next-step renderer uses Registry order, appends custom entries, and freezes output', () => {
  const custom = normalizeCustomTUIs('/repo', [
    { name: 'Acme', dir: '.acme', invoke: 'acme ${projectName}:${skillName}' }
  ]).items;
  const result = renderNextStepCommands({
    projectName: 'demo',
    state: stateFor(['opencode', 'codex']),
    customTUIs: custom,
    skillName: 'review-code',
    taskRef: '16'
  });

  assert.deepEqual(result, [
    {
      source: 'builtin',
      clientId: 'codex',
      displayName: 'Codex',
      command: '$review-code 16'
    },
    {
      source: 'builtin',
      clientId: 'opencode',
      displayName: 'OpenCode',
      command: '/review-code 16'
    },
    {
      source: 'custom',
      displayName: 'Acme',
      command: 'acme demo:review-code 16'
    }
  ]);
  assert.ok(Object.isFrozen(result));
  assert.ok(result.every((entry) => Object.isFrozen(entry)));
  assert.deepEqual(renderNextStepCommands({
    projectName: 'demo',
    state: stateFor([]),
    customTUIs: [],
    skillName: 'commit'
  }), []);
});

test('next-step renderer validates names and task refs without evaluating invocation text', () => {
  const base = {
    projectName: 'demo',
    state: stateFor(['claude-code']),
    customTUIs: [],
    skillName: 'review-plan'
  };

  assert.equal(renderNextStepCommands(base)[0]?.command, '/review-plan');
  assert.equal(
    renderNextStepCommands({ ...base, taskRef: 'TASK-20260718-232501' })[0]?.command,
    '/review-plan TASK-20260718-232501'
  );
  for (const input of [
    { ...base, projectName: 'bad\nname' },
    { ...base, skillName: 'bad name' },
    { ...base, taskRef: '#16' },
    { ...base, taskRef: 'bad' }
  ]) {
    assert.throws(() => renderNextStepCommands(input));
  }
});
