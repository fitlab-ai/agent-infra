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
  listEnabledAgentClientAdaptersByCapability,
  listInstalledAgentClientAdapters
} from '../../../lib/agent-clients/registry.ts';

const CAPABILITY_MATRIX = {
  'claude-code': {
    instructions: 'compatible',
    skills: 'compatible',
    commands: 'integrated',
    hooks: 'integrated',
    subagents: 'experimental',
    orchestration: 'unsupported',
    sandbox: 'integrated',
    verification: 'compatible'
  },
  codex: {
    instructions: 'compatible',
    skills: 'compatible',
    commands: 'integrated',
    hooks: 'integrated',
    subagents: 'experimental',
    orchestration: 'unsupported',
    sandbox: 'integrated',
    verification: 'compatible'
  },
  'antigravity-cli': {
    instructions: 'compatible',
    skills: 'integrated',
    commands: 'integrated',
    hooks: 'compatible',
    subagents: 'unsupported',
    orchestration: 'unsupported',
    sandbox: 'integrated',
    verification: 'compatible'
  },
  opencode: {
    instructions: 'compatible',
    skills: 'compatible',
    commands: 'integrated',
    hooks: 'compatible',
    subagents: 'unsupported',
    orchestration: 'unsupported',
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
    modelSelection: {
      kind: 'interactive-only',
      command: '/model',
      guidance: 'Use the host model picker.'
    },
    delegationEvidence: {
      actualModel: 'unavailable',
      actualReasoningEffort: 'unavailable'
    },
    project: {
      ownedPathPrefixes: ['.codex/'],
      managed: ['.codex/hooks.json'],
      merged: [],
      ejected: [],
      seedCommands: [],
      customCommand: undefined
    },
    sandbox: {
      createTool: () => ({
        id: 'codex',
        name: 'Codex',
        install: { type: 'npm', cmd: '@openai/codex' },
        sandboxBase: '/tmp/codex',
        containerMount: '/home/devuser/.codex',
        versionCmd: 'codex --version',
        setupHint: 'Ready'
      }),
      aliases: [],
      hooks: []
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
  const before = {
    ...input,
    capabilities: structuredClone(input.capabilities),
    project: structuredClone(input.project),
    sandbox: {
      ...input.sandbox,
      aliases: structuredClone(input.sandbox.aliases),
      hooks: [...input.sandbox.hooks]
    }
  };
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
  assert.ok(Object.isFrozen(adapter.project.seedCommands));

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
        ownedPathPrefixes: ['.codex'],
        managed: [],
        merged: [],
        ejected: [],
        seedCommands: []
      }
    }),
    adapterInput({
      project: {
        ownedPathPrefixes: ['.codex\\'],
        managed: [],
        merged: [],
        ejected: [],
        seedCommands: []
      }
    }),
    adapterInput({
      project: {
        ownedPathPrefixes: ['.codex/', '.codex/'],
        managed: [],
        merged: [],
        ejected: [],
        seedCommands: []
      }
    })
  ];

  for (const invalid of invalidInputs) {
    assert.throws(() => defineAgentClientAdapter(invalid as AgentClientAdapter));
  }
});

test('adapter custom commands validate paths, placeholders, metadata, and immutability', () => {
  const adapter = defineAgentClientAdapter(adapterInput({
    project: {
      ...adapterInput().project,
      customCommand: {
        target: '.codex/commands/${skillName}.md',
        frontmatter: { agent: 'general', subtask: false },
        argumentsToken: '$ARGUMENTS',
        includeUsage: true,
        inheritDisableModelInvocation: true
      }
    }
  }));

  assert.deepEqual(adapter.project.customCommand, {
    target: '.codex/commands/${skillName}.md',
    frontmatter: { agent: 'general', subtask: false },
    argumentsToken: '$ARGUMENTS',
    includeUsage: true,
    inheritDisableModelInvocation: true
  });
  assert.ok(Object.isFrozen(adapter.project.customCommand));
  assert.ok(Object.isFrozen(adapter.project.customCommand?.frontmatter));

  const invalidDescriptors = [
    { target: '../${skillName}.md', frontmatter: {} },
    { target: '.codex/commands/static.md', frontmatter: {} },
    { target: '.codex/${skillName}/${skillName}.md', frontmatter: {} },
    { target: '.codex/commands/${unknown}.md', frontmatter: {} },
    { target: '.codex/commands/${skillName}.md', frontmatter: { nested: {} } },
    { target: '.codex/commands/${skillName}.md', frontmatter: {}, argumentsToken: '' },
    { target: '.codex/commands/${skillName}.md', frontmatter: {}, includeUsage: 'yes' },
    { target: '.codex/commands/${skillName}.md', frontmatter: {}, inheritDisableModelInvocation: 1 }
  ];
  for (const customCommand of invalidDescriptors) {
    assert.throws(() => defineAgentClientAdapter(adapterInput({
      project: {
        ...adapterInput().project,
        customCommand: customCommand as never
      }
    })), /invalid custom command/);
  }
});

test('Claude adapter owns commands, agents, rules, custom rendering, and lifecycle hooks', () => {
  const adapter = getAgentClientAdapter('claude-code');

  assert.deepEqual(adapter.project.managed, [
    '.claude/commands/',
    '.claude/agents/',
    '.claude/rules/'
  ]);
  assert.deepEqual(adapter.project.customCommand, {
    target: '.claude/commands/${skillName}.md',
    frontmatter: {},
    includeUsage: true,
    inheritDisableModelInvocation: true
  });
  assert.deepEqual(
    adapter.sandbox.hooks.map(({ id, phase }) => ({ id, phase })),
    [
      { id: 'claude-code-credential-preflight', phase: 'prepare' },
      { id: 'claude-code-before-container-create', phase: 'before-container-create' },
      { id: 'claude-code-before-enter', phase: 'before-enter' }
    ]
  );
});

test('adapter project assets must be literal owned relative paths without overlaps', () => {
  const invalidProjects = [
    {
      ownedPathPrefixes: ['.codex/'],
      managed: undefined,
      merged: [],
      ejected: [],
      seedCommands: []
    },
    {
      ownedPathPrefixes: ['.codex/'],
      managed: ['/tmp/hooks.json'],
      merged: [],
      ejected: [],
      seedCommands: []
    },
    {
      ownedPathPrefixes: ['.codex/'],
      managed: ['.codex/../outside.json'],
      merged: [],
      ejected: [],
      seedCommands: []
    },
    {
      ownedPathPrefixes: ['.codex/'],
      managed: ['.other/hooks.json'],
      merged: [],
      ejected: [],
      seedCommands: []
    },
    {
      ownedPathPrefixes: ['.codex/'],
      managed: ['.codex/hooks.json', '.codex/hooks.json'],
      merged: [],
      ejected: [],
      seedCommands: []
    },
    {
      ownedPathPrefixes: ['.codex/'],
      managed: ['.codex/hooks.json'],
      merged: ['.codex/hooks.json'],
      ejected: [],
      seedCommands: []
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
      'antigravity-cli': '/${skillName}',
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
        managed: ['.claude/commands/', '.claude/agents/', '.claude/rules/'],
        merged: ['.claude/settings.json'],
        ejected: [],
        seedCommands: [{
          templates: {
            en: '.claude/commands/update-agent-infra.en.md',
            'zh-CN': '.claude/commands/update-agent-infra.zh-CN.md'
          },
          target: '.claude/commands/update-agent-infra.md'
        }],
        customCommand: {
          target: '.claude/commands/${skillName}.md',
          frontmatter: {},
          includeUsage: true,
          inheritDisableModelInvocation: true
        }
      },
      codex: {
        ownedPathPrefixes: ['.codex/'],
        managed: ['.codex/hooks.json', '.codex/agents/'],
        merged: [],
        ejected: [],
        seedCommands: []
      },
      'antigravity-cli': {
        ownedPathPrefixes: [],
        managed: [],
        merged: [],
        ejected: [],
        seedCommands: []
      },
      opencode: {
        ownedPathPrefixes: ['.opencode/'],
        managed: ['.opencode/commands/'],
        merged: [],
        ejected: [],
        seedCommands: [{
          templates: {
            en: '.opencode/commands/update-agent-infra.en.md',
            'zh-CN': '.opencode/commands/update-agent-infra.zh-CN.md'
          },
          target: '.opencode/commands/update-agent-infra.md'
        }],
        customCommand: {
          target: '.opencode/commands/${skillName}.md',
          frontmatter: { agent: 'general', subtask: false },
          argumentsToken: '$ARGUMENTS'
        }
      }
    }
  );
});

test('Codex adapter owns its lifecycle and recovery capabilities', () => {
  const adapter = getAgentClientAdapter('codex');

  assert.deepEqual(
    adapter.sandbox.hooks.map(({ id, phase }) => ({ id, phase })),
    [{ id: 'codex-before-container-create', phase: 'before-container-create' }]
  );
  assert.deepEqual(
    adapter.sandbox.recoveryChecks?.map(({ id, finding }) => ({
      id,
      repairKind: finding.repairKind
    })),
    [
      { id: 'command-available', repairKind: 'hard-failure' },
      { id: 'state-writable', repairKind: 'permissions' },
      { id: 'prompts-link', repairKind: 'builtin-link' }
    ]
  );
  assert.ok(Object.isFrozen(adapter.sandbox.recoveryChecks));
  assert.ok(adapter.sandbox.recoveryChecks?.every((check) => Object.isFrozen(check)));
});

test('adapter recovery checks validate probes, findings, repairs, and unique IDs', () => {
  const validCheck = {
    id: 'prompts-link',
    probe: { script: 'test -L "$1"', args: ['/tmp/prompts'] },
    finding: {
      repairKind: 'builtin-link' as const,
      message: 'Link is missing.',
      path: '/tmp/prompts'
    },
    repair: {
      user: 'devuser',
      command: 'ln',
      args: ['-sfn', '/workspace/commands', '/tmp/prompts']
    }
  };
  const withChecks = (
    recoveryChecks: AgentClientAdapter['sandbox']['recoveryChecks']
  ): AgentClientAdapter => adapterInput({
    sandbox: {
      ...adapterInput().sandbox,
      recoveryChecks
    }
  });

  const adapter = defineAgentClientAdapter(withChecks([validCheck]));
  assert.ok(Object.isFrozen(adapter.sandbox.recoveryChecks?.[0]?.probe.args));
  assert.ok(Object.isFrozen(adapter.sandbox.recoveryChecks?.[0]?.repair?.args));

  const invalidChecks: unknown[] = [
    {},
    [{ ...validCheck, id: 'INVALID' }],
    [{ ...validCheck, probe: { script: '', args: [] } }],
    [{ ...validCheck, finding: { repairKind: 'unknown', message: 'Bad.' } }],
    [{
      ...validCheck,
      finding: { repairKind: 'permissions', message: 'Not writable.' },
      repair: undefined
    }],
    [{ ...validCheck, repair: undefined }],
    [validCheck, validCheck]
  ];
  for (const recoveryChecks of invalidChecks) {
    assert.throws(() => defineAgentClientAdapter(withChecks(
      recoveryChecks as AgentClientAdapter['sandbox']['recoveryChecks']
    )));
  }
});

test('adapter seed commands require owned literal targets and language templates', () => {
  assert.throws(() => defineAgentClientAdapter(adapterInput({
    project: {
      ...adapterInput().project,
      seedCommands: [{
        templates: { en: '.codex/en.md', 'zh-CN': '.codex/zh.md' },
        target: '../outside.md'
      }]
    }
  })), /invalid seed target/);

  assert.throws(() => defineAgentClientAdapter(adapterInput({
    project: {
      ...adapterInput().project,
      seedCommands: [{
        templates: { en: '/tmp/en.md', 'zh-CN': '.codex/zh.md' },
        target: '.codex/${unknown}/command.md'
      }]
    }
  })), /invalid seed target|invalid seed templates/);
});

test('OpenCode sandbox health check uses its version flag', () => {
  const tool = getAgentClientAdapter('opencode').sandbox.createTool({
    home: '/tmp/home',
    project: 'demo'
  });

  assert.equal(tool.versionCmd, 'opencode --version');
});

test('manifest projects invocation and remains deeply frozen', () => {
  const manifest = createAgentClientManifest();

  assert.deepEqual(
    manifest.map(({ id, displayName, invocation }) => ({ id, displayName, invocation })),
    [
      { id: 'claude-code', displayName: 'Claude Code', invocation: '/${skillName}' },
      { id: 'codex', displayName: 'Codex', invocation: '$${skillName}' },
      { id: 'antigravity-cli', displayName: 'Antigravity CLI', invocation: '/${skillName}' },
      { id: 'opencode', displayName: 'OpenCode', invocation: '/${skillName}' }
    ]
  );
  assert.ok(Object.isFrozen(manifest));
  assert.ok(manifest.every((entry) => Object.isFrozen(entry)));
  assert.deepEqual(manifest.find(({ id }) => id === 'opencode')?.customCommand, {
    target: '.opencode/commands/${skillName}.md',
    frontmatter: { agent: 'general', subtask: false },
    argumentsToken: '$ARGUMENTS'
  });
  assert.ok(Object.isFrozen(manifest.find(({ id }) => id === 'opencode')?.customCommand));
});

test('registry queries preserve canonical order and keep enabled separate from sandbox install state', () => {
  const state = stateFor(['opencode', 'codex']);

  assert.deepEqual(
    listEnabledAgentClientAdapters(state).map((adapter) => adapter.id),
    ['codex', 'opencode']
  );
  assert.deepEqual(
    listInstalledAgentClientAdapters(state).map((adapter) => adapter.id),
    ['claude-code', 'antigravity-cli']
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
      stateFor(['antigravity-cli', 'opencode']),
      'hooks',
      ['compatible', 'compatible']
    ).map((adapter) => adapter.id),
    ['antigravity-cli', 'opencode']
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

test('sandbox descriptors validate ids, hooks, aliases, timeouts, and frozen output', () => {
  const adapter = defineAgentClientAdapter(adapterInput({
    sandbox: {
      ...adapterInput().sandbox,
      aliases: [{ name: 'xy', command: 'codex --yolo' }],
      hooks: [{
        id: 'prepare-state',
        phase: 'prepare',
        timeoutMs: 42,
        run: async () => ({ status: 'ready' })
      }]
    }
  }));
  const tool = adapter.sandbox.createTool({ home: '/tmp/home', project: 'demo' });

  assert.ok(Object.isFrozen(adapter.sandbox));
  assert.ok(Object.isFrozen(adapter.sandbox.aliases));
  assert.ok(Object.isFrozen(adapter.sandbox.hooks));
  assert.ok(Object.isFrozen(tool));
  assert.equal(tool.id, adapter.id);

  assert.throws(() => defineAgentClientAdapter(adapterInput({
    sandbox: {
      ...adapterInput().sandbox,
      hooks: [{
        id: 'too-slow',
        phase: 'prepare',
        timeoutMs: 300_001,
        run: async () => ({ status: 'ready' })
      }]
    }
  })));
  assert.throws(() => defineAgentClientAdapter(adapterInput({
    sandbox: {
      ...adapterInput().sandbox,
      aliases: [
        { name: 'xy', command: 'codex --yolo' },
        { name: 'xy', command: 'codex --yolo' }
      ]
    }
  })));
  assert.throws(() => defineAgentClientAdapter(adapterInput({
    sandbox: {
      ...adapterInput().sandbox,
      createTool: () => ({
        ...adapterInput().sandbox.createTool({ home: '/tmp', project: 'demo' }),
        id: 'other'
      })
    }
  })).sandbox.createTool({ home: '/tmp', project: 'demo' }));
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
      [
        'id',
        'displayName',
        'invocation',
        'ownedPathPrefixes',
        'managed',
        'merged',
        'ejected',
        ...(entry.customCommand === undefined ? [] : ['customCommand'])
      ]
    );
    assert.ok(Object.isFrozen(entry));
    assert.ok(Object.isFrozen(entry.ownedPathPrefixes));
    assert.ok(Object.isFrozen(entry.managed));
    assert.ok(Object.isFrozen(entry.merged));
    assert.ok(Object.isFrozen(entry.ejected));
    if (entry.customCommand) {
      assert.ok(Object.isFrozen(entry.customCommand));
      assert.ok(Object.isFrozen(entry.customCommand.frontmatter));
    }
  }
});
