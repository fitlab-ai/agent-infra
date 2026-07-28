import assert from 'node:assert/strict';
import test from 'node:test';

import {
  planAgentClientProjectAssets
} from '../../../lib/agent-clients/project-assets.ts';
import { listAgentClientAdapters } from '../../../lib/agent-clients/registry.ts';

const adapters = listAgentClientAdapters();
const sharedDefaults = {
  managed: ['.agents/README.md'],
  merged: ['.gitignore'],
  ejected: []
};

test('project asset planning preserves user entries and appends enabled assets canonically', () => {
  const current = {
    managed: ['docs/user.md', '.opencode/commands/', '.claude/commands/'],
    merged: ['settings/user.json', '.gemini/settings.json'],
    ejected: ['.claude/commands/']
  };
  const before = structuredClone(current);
  const plan = planAgentClientProjectAssets({
    current,
    sharedDefaults,
    enabledAdapters: [adapters[3]!, adapters[1]!],
    allAdapters: adapters
  });

  assert.deepEqual(current, before);
  assert.deepEqual(plan.registry, {
    managed: [
      'docs/user.md',
      '.opencode/commands/',
      '.codex/hooks.json',
      '.agents/README.md'
    ],
    merged: ['settings/user.json', '.gitignore'],
    ejected: ['.claude/commands/']
  });
  assert.deepEqual(plan.enabledManaged, [
    '.codex/hooks.json',
    '.opencode/commands/'
  ]);
  assert.deepEqual(plan.disabledManaged, [
    '.claude/commands/',
    '.gemini/commands/'
  ]);
});

test('project asset planning supports an empty enabled set and is idempotent', () => {
  const first = planAgentClientProjectAssets({
    current: {
      managed: ['.claude/commands/', 'docs/user.md'],
      merged: ['.claude/settings.json'],
      ejected: []
    },
    sharedDefaults,
    enabledAdapters: [],
    allAdapters: adapters
  });
  const second = planAgentClientProjectAssets({
    current: first.registry,
    sharedDefaults,
    enabledAdapters: [],
    allAdapters: adapters
  });

  assert.deepEqual(first.registry, {
    managed: ['docs/user.md', '.agents/README.md'],
    merged: ['.gitignore'],
    ejected: []
  });
  assert.deepEqual(second, first);
});

test('project asset planning returns deeply frozen stable output', () => {
  const plan = planAgentClientProjectAssets({
    current: { managed: [], merged: [], ejected: [] },
    sharedDefaults,
    enabledAdapters: adapters,
    allAdapters: adapters
  });

  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.registry));
  for (const values of [
    plan.registry.managed,
    plan.registry.merged,
    plan.registry.ejected,
    plan.enabledManaged,
    plan.enabledMerged,
    plan.enabledEjected,
    plan.disabledManaged
  ]) {
    assert.ok(Object.isFrozen(values));
  }
});
