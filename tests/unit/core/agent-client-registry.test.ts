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
    invocation: '$${skillName}',
    capabilities: capabilityMap(),
    project: {
      ownedPathPrefixes: ['.codex/'],
      managed: ['.codex/hooks.json'],
      merged: [],
      ejected: []
    },
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
  assert.ok(Object.isFrozen(adapter.project.managed));
  assert.ok(Object.isFrozen(adapter.project.merged));
  assert.ok(Object.isFrozen(adapter.project.ejected));

  const invalidInputs: unknown[] = [
    adapterInput({ id: 'unknown' as never }),
    adapterInput({ displayName: '   ' }),
    adapterInput({ invocation: '' }),
    adapterInput({ invocation: '$command' }),
    adapterInput({ invocation: '$${unknown}' }),
    adapterInput({ invocation: '$${skillName} $${unknown' }),
    adapterInput({ invocation: '$${skillName}\nnext' }),
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
    adapterInput({
      project: {
        ownedPathPrefixes: [],
        managed: [],
        merged: [],
        ejected: []
      }
    }),
    adapterInput({
      project: {
        ownedPathPrefixes: ['.codex'],
        managed: [],
        merged: [],
        ejected: []
      }
    }),
    adapterInput({
      project: {
        ownedPathPrefixes: ['.codex\\'],
        managed: [],
        merged: [],
        ejected: []
      }
    }),
    adapterInput({
      project: {
        ownedPathPrefixes: ['.codex/', '.codex/'],
        managed: [],
        merged: [],
        ejected: []
      }
    })
  ];

  for (const invalid of invalidInputs) {
    assert.throws(() => defineAgentClientAdapter(invalid as AgentClientAdapter));
  }
});

test('adapter project assets must be literal owned relative paths without overlaps', () => {
  const invalidProjects = [
    {
      ownedPathPrefixes: ['.codex/'],
      managed: undefined,
      merged: [],
      ejected: []
    },
    {
      ownedPathPrefixes: ['.codex/'],
      managed: ['/tmp/hooks.json'],
      merged: [],
      ejected: []
    },
    {
      ownedPathPrefixes: ['.codex/'],
      managed: ['.codex/../outside.json'],
      merged: [],
      ejected: []
    },
    {
      ownedPathPrefixes: ['.codex/'],
      managed: ['.other/hooks.json'],
      merged: [],
      ejected: []
    },
    {
      ownedPathPrefixes: ['.codex/'],
      managed: ['.codex/hooks.json', '.codex/hooks.json'],
      merged: [],
      ejected: []
    },
    {
      ownedPathPrefixes: ['.codex/'],
      managed: ['.codex/hooks.json'],
      merged: ['.codex/hooks.json'],
      ejected: []
    }
  ];

  for (const project of invalidProjects) {
    assert.throws(
      () => defineAgentClientAdapter(adapterInput({
        project: project as AgentClientAdapter['project']
      })),
      /Agent Client 'codex'.*(project asset|owned path)/
    );
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

  assert.deepEqual(
    Object.fromEntries(adapters.map((adapter) => [adapter.id, adapter.invocation])),
    {
      'claude-code': '/${skillName}',
      codex: '$${skillName}',
      'gemini-cli': '/${projectName}:${skillName}',
      opencode: '/${skillName}'
    }
  );

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

test('registry exposes the exact built-in project asset matrix', () => {
  assert.deepEqual(
    Object.fromEntries(listAgentClientAdapters().map((adapter) => [
      adapter.id,
      adapter.project
    ])),
    {
      'claude-code': {
        ownedPathPrefixes: ['.claude/'],
        managed: ['.claude/commands/'],
        merged: ['.claude/settings.json'],
        ejected: []
      },
      codex: {
        ownedPathPrefixes: ['.codex/'],
        managed: ['.codex/hooks.json'],
        merged: [],
        ejected: []
      },
      'gemini-cli': {
        ownedPathPrefixes: ['.gemini/'],
        managed: ['.gemini/commands/'],
        merged: ['.gemini/settings.json'],
        ejected: []
      },
      opencode: {
        ownedPathPrefixes: ['.opencode/'],
        managed: ['.opencode/commands/'],
        merged: [],
        ejected: []
      }
    }
  );
});

test('manifest projects invocation and remains deeply frozen', () => {
  const manifest = createAgentClientManifest();

  assert.deepEqual(
    manifest.map(({ id, displayName, invocation }) => ({ id, displayName, invocation })),
    [
      { id: 'claude-code', displayName: 'Claude Code', invocation: '/${skillName}' },
      { id: 'codex', displayName: 'Codex', invocation: '$${skillName}' },
      { id: 'gemini-cli', displayName: 'Gemini CLI', invocation: '/${projectName}:${skillName}' },
      { id: 'opencode', displayName: 'OpenCode', invocation: '/${skillName}' }
    ]
  );
  assert.ok(Object.isFrozen(manifest));
  assert.ok(manifest.every((entry) => Object.isFrozen(entry)));
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
    assert.deepEqual(
      Object.keys(entry),
      ['id', 'displayName', 'invocation', 'ownedPathPrefixes', 'managed', 'merged', 'ejected']
    );
    assert.ok(Object.isFrozen(entry));
    assert.ok(Object.isFrozen(entry.ownedPathPrefixes));
    assert.ok(Object.isFrozen(entry.managed));
    assert.ok(Object.isFrozen(entry.merged));
    assert.ok(Object.isFrozen(entry.ejected));
  }
});
