import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeCustomToolInvocations } from '../../../lib/agent-clients/custom-tool-invocations.ts';
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

test('custom tool invocation normalization preserves selected order', () => {
  const input = { sandbox: { tools: { ids: ['acme', 'beta'], definitions: {
    acme: { name: 'Acme', invoke: 'acme ${projectName} ${skillName}', extra: true },
    beta: { invoke: 'beta ${skillName}' }
  } } } };
  const before = structuredClone(input);
  const result = normalizeCustomToolInvocations(input);

  assert.deepEqual(result, {
    items: [
      {
        name: 'Acme',
        invocation: 'acme ${projectName} ${skillName}'
      },
      {
        name: 'beta',
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

test('custom tool invocation normalization skips invalid entries with stable paths', () => {
  assert.deepEqual(normalizeCustomToolInvocations(null), {
    items: [],
    diagnostics: []
  });

  const ids = ['empty-name', 'missing-skill', 'unknown-placeholder', 'malformed-placeholder', 'newline-name', 'newline-invoke'];
  const result = normalizeCustomToolInvocations({ sandbox: { tools: { ids, definitions: {
    'empty-name': { name: '', invoke: 'x ${skillName}' },
    'missing-skill': { name: 'X', invoke: 'x' },
    'unknown-placeholder': { name: 'X', invoke: 'x ${unknown} ${skillName}' },
    'malformed-placeholder': { name: 'X', invoke: 'x ${skillName} ${unknown' },
    'newline-name': { name: 'X\nY', invoke: 'x ${skillName}' },
    'newline-invoke': { name: 'X', invoke: 'x ${skillName}\nnext' }
  } } } });

  assert.deepEqual(result.items, []);
  assert.deepEqual(result.diagnostics, [
    { code: 'INVALID_CUSTOM_TOOL_INVOCATION', path: 'sandbox.tools.definitions.empty-name.name' },
    { code: 'INVALID_CUSTOM_TOOL_INVOCATION_PLACEHOLDER', path: 'sandbox.tools.definitions.missing-skill.invoke' },
    { code: 'INVALID_CUSTOM_TOOL_INVOCATION_PLACEHOLDER', path: 'sandbox.tools.definitions.unknown-placeholder.invoke' },
    { code: 'INVALID_CUSTOM_TOOL_INVOCATION_PLACEHOLDER', path: 'sandbox.tools.definitions.malformed-placeholder.invoke' },
    { code: 'INVALID_CUSTOM_TOOL_INVOCATION', path: 'sandbox.tools.definitions.newline-name.name' },
    { code: 'INVALID_CUSTOM_TOOL_INVOCATION', path: 'sandbox.tools.definitions.newline-invoke.invoke' }
  ]);
});

test('next-step renderer uses Registry order, appends custom entries, and freezes output', () => {
  const custom = normalizeCustomToolInvocations({ sandbox: { tools: { ids: ['acme'], definitions: {
    acme: { name: 'Acme', invoke: 'acme ${projectName}:${skillName}' }
  } } } }).items;
  const result = renderNextStepCommands({
    projectName: 'demo',
    state: stateFor(['opencode', 'codex']),
    customToolInvocations: custom,
    skillName: 'review-code',
    taskRef: '16'
  });

  assert.deepEqual(result, [
    {
      source: 'builtin',
      clientId: 'codex',
      displayName: 'Codex',
      command: '$review-code --task 16'
    },
    {
      source: 'builtin',
      clientId: 'opencode',
      displayName: 'OpenCode',
      command: '/review-code --task 16'
    },
    {
      source: 'custom',
      displayName: 'Acme',
      command: 'acme demo:review-code --task 16'
    }
  ]);
  assert.ok(Object.isFrozen(result));
  assert.ok(result.every((entry) => Object.isFrozen(entry)));
  assert.deepEqual(renderNextStepCommands({
    projectName: 'demo',
    state: stateFor([]),
    customToolInvocations: [],
    skillName: 'commit'
  }), []);
});

test('next-step renderer preserves positional arguments for non-task versioned skills', () => {
  const result = renderNextStepCommands({
    projectName: 'demo',
    state: stateFor(['codex']),
    customToolInvocations: [],
    skillName: 'post-release',
    taskRef: '16',
    version: '1.2.3-rc.1'
  });

  assert.equal(result[0]?.command, '$post-release 16 1.2.3-rc.1');
});

test('next-step renderer emits an explicit task flag for task-scoped skills', () => {
  const result = renderNextStepCommands({
    projectName: 'demo',
    state: stateFor(['codex']),
    customToolInvocations: [],
    skillName: 'commit',
    taskRef: '16'
  });

  assert.equal(result[0]?.command, '$commit --task 16');
});

test('next-step renderer validates names and task refs without evaluating invocation text', () => {
  const base = {
    projectName: 'demo',
    state: stateFor(['claude-code']),
    customToolInvocations: [],
    skillName: 'review-plan'
  };

  assert.equal(renderNextStepCommands(base)[0]?.command, '/review-plan');
  assert.equal(
    renderNextStepCommands({ ...base, taskRef: 'TASK-20260718-232501' })[0]?.command,
    '/review-plan --task TASK-20260718-232501'
  );
  for (const input of [
    { ...base, projectName: 'bad\nname' },
    { ...base, skillName: 'bad name' },
    { ...base, taskRef: '#16' },
    { ...base, taskRef: 'bad' }
  ]) {
    assert.throws(() => renderNextStepCommands(input));
  }

  for (const version of ['v1.2.3', 'V1.2.3', '=1.2.3', '1.2.3 ', '1.2.3;echo']) {
    assert.throws(() => renderNextStepCommands({ ...base, version }));
  }
});
