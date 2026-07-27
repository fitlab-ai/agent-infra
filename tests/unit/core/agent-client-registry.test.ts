import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defineAgentClientAdapter
} from '../../../lib/agent-clients/adapter.ts';
import type {
  AgentClientAdapter
} from '../../../lib/agent-clients/adapter.ts';
import {
  AGENT_CLIENT_CAPABILITY_IDS,
  AGENT_CLIENT_IDS
} from '../../../lib/agent-clients/types.ts';
import type {
  AgentClientCapabilityMap,
  AgentClientState
} from '../../../lib/agent-clients/types.ts';
import {
  AGENT_CLIENT_REGISTRY,
  createAgentClientManifest,
  getAgentClientAdapter,
  getAgentClientCapability,
  listAgentClientAdapters,
  listEnabledAgentClientAdapters,
  listEnabledAgentClientAdaptersByCapability
} from '../../../lib/agent-clients/registry.ts';

const CAPABILITY_MATRIX = {
  'claude-code': {
    instructions: 'compatible',
    skills: 'compatible',
    commands: 'integrated',
    hooks: 'integrated',
    sandbox: 'integrated',
    verification: 'compatible'
  },
  codex: {
    instructions: 'compatible',
    skills: 'compatible',
    commands: 'integrated',
    hooks: 'integrated',
    sandbox: 'integrated',
    verification: 'compatible'
  },
  'gemini-cli': {
    instructions: 'compatible',
    skills: 'compatible',
    commands: 'integrated',
    hooks: 'compatible',
    sandbox: 'integrated',
    verification: 'compatible'
  },
  opencode: {
    instructions: 'compatible',
    skills: 'compatible',
    commands: 'integrated',
    hooks: 'compatible',
    sandbox: 'integrated',
    verification: 'compatible'
  }
} as const;

function capabilityMap(): AgentClientCapabilityMap {
  return Object.fromEntries(
    AGENT_CLIENT_CAPABILITY_IDS.map((capability) => [
      capability,
      { level: 'compatible' }
    ])
  ) as AgentClientCapabilityMap;
}

function adapterInput(
  overrides: Partial<AgentClientAdapter> = {}
): AgentClientAdapter {
  return {
    id: 'codex',
    displayName: 'Codex',
    capabilities: capabilityMap(),
    project: { ownedPathPrefixes: ['.codex/'] },
    ...overrides
  };
}

function stateFor(enabled: readonly string[]): AgentClientState {
  return Object.fromEntries(
    AGENT_CLIENT_IDS.map((id) => [
      id,
      {
        enabled: enabled.includes(id),
        installInSandbox: !enabled.includes(id)
      }
    ])
  ) as AgentClientState;
}

test('adapter definitions validate their closed contract without mutating input', () => {
  const input = adapterInput();
  const before = structuredClone(input);
  const adapter = defineAgentClientAdapter(input);

  assert.deepEqual(input, before);
  assert.notEqual(adapter, input);
  assert.ok(Object.isFrozen(adapter));
  assert.ok(Object.isFrozen(adapter.capabilities));
  assert.ok(Object.isFrozen(adapter.capabilities.commands));
  assert.ok(Object.isFrozen(adapter.project));
  assert.ok(Object.isFrozen(adapter.project.ownedPathPrefixes));

  const invalidInputs: unknown[] = [
    adapterInput({ id: 'unknown' as never }),
    adapterInput({ displayName: '   ' }),
    adapterInput({
      capabilities: {
        ...capabilityMap(),
        commands: { level: 'unknown' as never }
      }
    }),
    adapterInput({
      capabilities: Object.fromEntries(
        AGENT_CLIENT_CAPABILITY_IDS
          .filter((capability) => capability !== 'hooks')
          .map((capability) => [capability, { level: 'compatible' }])
      ) as AgentClientCapabilityMap
    }),
    adapterInput({ project: { ownedPathPrefixes: [] } }),
    adapterInput({ project: { ownedPathPrefixes: ['.codex'] } }),
    adapterInput({ project: { ownedPathPrefixes: ['.codex\\'] } }),
    adapterInput({ project: { ownedPathPrefixes: ['.codex/', '.codex/'] } })
  ];

  for (const invalid of invalidInputs) {
    assert.throws(() => defineAgentClientAdapter(invalid as AgentClientAdapter));
  }
});

test('adapter definitions reject nullish nested fields with client context', () => {
  assert.throws(
    () => defineAgentClientAdapter({
      ...adapterInput(),
      capabilities: null
    } as unknown as AgentClientAdapter),
    /Agent Client 'codex' has an invalid capability map/
  );
  assert.throws(
    () => defineAgentClientAdapter({
      ...adapterInput(),
      project: undefined
    } as unknown as AgentClientAdapter),
    /Agent Client 'codex' has an invalid project descriptor/
  );
});

test('registry is complete, canonical, deeply frozen, and matches the capability matrix', () => {
  const adapters = listAgentClientAdapters();

  assert.deepEqual(adapters.map((adapter) => adapter.id), AGENT_CLIENT_IDS);
  assert.deepEqual(Object.keys(AGENT_CLIENT_REGISTRY), AGENT_CLIENT_IDS);
  assert.ok(Object.isFrozen(AGENT_CLIENT_REGISTRY));
  assert.ok(Object.isFrozen(adapters));

  for (const adapter of adapters) {
    assert.equal(AGENT_CLIENT_REGISTRY[adapter.id], adapter);
    assert.deepEqual(
      Object.fromEntries(
        AGENT_CLIENT_CAPABILITY_IDS.map((capability) => [
          capability,
          adapter.capabilities[capability].level
        ])
      ),
      CAPABILITY_MATRIX[adapter.id]
    );
  }

  const ownedPaths = adapters.flatMap((adapter) =>
    adapter.project.ownedPathPrefixes.map((prefix) => ({
      id: adapter.id,
      prefix
    }))
  );
  for (const [index, current] of ownedPaths.entries()) {
    for (const other of ownedPaths.slice(index + 1)) {
      const hasCrossClientOverlap = current.id !== other.id
        && (
          current.prefix.startsWith(other.prefix)
          || other.prefix.startsWith(current.prefix)
        );
      assert.equal(
        hasCrossClientOverlap,
        false,
        `owned paths overlap: ${current.prefix} and ${other.prefix}`
      );
    }
  }
});

test('registry queries preserve canonical order and keep enabled separate from sandbox install state', () => {
  const state = stateFor(['opencode', 'codex']);

  assert.deepEqual(
    listEnabledAgentClientAdapters(state).map((adapter) => adapter.id),
    ['codex', 'opencode']
  );
  assert.deepEqual(listEnabledAgentClientAdapters(stateFor([])), []);
  assert.deepEqual(
    listEnabledAgentClientAdapters(stateFor(AGENT_CLIENT_IDS)).map((adapter) => adapter.id),
    AGENT_CLIENT_IDS
  );

  assert.deepEqual(
    listEnabledAgentClientAdaptersByCapability(
      stateFor(AGENT_CLIENT_IDS),
      'hooks',
      ['integrated']
    ).map((adapter) => adapter.id),
    ['claude-code', 'codex']
  );
  assert.deepEqual(
    listEnabledAgentClientAdaptersByCapability(
      stateFor(['gemini-cli', 'opencode']),
      'hooks',
      ['compatible', 'compatible']
    ).map((adapter) => adapter.id),
    ['gemini-cli', 'opencode']
  );
  assert.deepEqual(
    listEnabledAgentClientAdaptersByCapability(
      stateFor(AGENT_CLIENT_IDS),
      'sandbox',
      []
    ),
    []
  );
});

test('single adapter and capability queries reject unknown runtime IDs', () => {
  assert.equal(getAgentClientAdapter('codex').displayName, 'Codex');
  assert.deepEqual(getAgentClientCapability('codex', 'commands'), {
    level: 'integrated'
  });
  assert.throws(
    () => getAgentClientAdapter('unknown'),
    /No Agent Client adapter registered for 'unknown'/
  );
});

test('manifest is a fresh frozen JSON-safe projection of registry metadata', () => {
  const first = createAgentClientManifest();
  const second = createAgentClientManifest();

  assert.notEqual(first, second);
  assert.ok(Object.isFrozen(first));
  assert.deepEqual(first.map((entry) => entry.id), AGENT_CLIENT_IDS);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);

  for (const entry of first) {
    assert.deepEqual(Object.keys(entry), ['id', 'displayName', 'ownedPathPrefixes']);
    assert.ok(Object.isFrozen(entry));
    assert.ok(Object.isFrozen(entry.ownedPathPrefixes));
  }
});
