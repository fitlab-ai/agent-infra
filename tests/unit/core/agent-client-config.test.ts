import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_CLIENT_CAPABILITY_IDS,
  AGENT_CLIENT_IDS,
  AGENT_CLIENT_SUPPORT_LEVELS,
  isAgentClientId
} from '../../../lib/agent-clients/types.ts';
import type { AgentClientState } from '../../../lib/agent-clients/types.ts';
import {
  normalizeAgentClients,
  serializeAgentClients
} from '../../../lib/agent-clients/config.ts';
import { AGENT_CLIENTS_SCHEMA } from '../../../lib/agent-clients/schema.ts';
import {
  BUILTIN_TUI_DISPLAY,
  BUILTIN_TUI_IDS,
  BUILTIN_TUI_OWNED_PATH_PREFIXES,
  isBuiltinTUIId,
  isPathOwnedByDisabledTUI,
  resolveEnabledTUIs
} from '../../../lib/builtin-tuis.ts';

const ALL_ENABLED = Object.fromEntries(
  AGENT_CLIENT_IDS.map((id) => [id, { enabled: true, installInSandbox: true }])
) as AgentClientState;

function canonical(
  enabled: readonly string[] = AGENT_CLIENT_IDS,
  sandbox: readonly string[] = AGENT_CLIENT_IDS
) {
  return AGENT_CLIENT_IDS.map((id) => ({
    id,
    enabled: enabled.includes(id),
    installInSandbox: sandbox.includes(id)
  }));
}

function errorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
      assert.fail('Expected an error with a stable code');
    }
    return String(error.code);
  }
  assert.fail('Expected normalization to fail');
}

test('agent client vocabulary is closed, unique, and recognized by the shared guard', () => {
  assert.deepEqual(AGENT_CLIENT_IDS, ['claude-code', 'codex', 'gemini-cli', 'opencode']);
  assert.equal(new Set(AGENT_CLIENT_IDS).size, AGENT_CLIENT_IDS.length);
  assert.deepEqual(AGENT_CLIENT_CAPABILITY_IDS, [
    'instructions',
    'skills',
    'commands',
    'hooks',
    'sandbox',
    'verification'
  ]);
  assert.equal(new Set(AGENT_CLIENT_CAPABILITY_IDS).size, AGENT_CLIENT_CAPABILITY_IDS.length);
  assert.deepEqual(AGENT_CLIENT_SUPPORT_LEVELS, [
    'compatible',
    'integrated',
    'verified',
    'experimental'
  ]);
  assert.equal(new Set(AGENT_CLIENT_SUPPORT_LEVELS).size, AGENT_CLIENT_SUPPORT_LEVELS.length);
  assert.equal(isAgentClientId('codex'), true);
  assert.equal(isAgentClientId('other'), false);
});

test('schema is JSON-safe and derives its closed enums from shared constants', () => {
  const json = JSON.stringify(AGENT_CLIENTS_SCHEMA);
  assert.deepEqual(JSON.parse(json), AGENT_CLIENTS_SCHEMA);

  const schema = AGENT_CLIENTS_SCHEMA as Record<string, any>;
  assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
  assert.deepEqual(schema.required, ['agentClients']);
  assert.equal(schema.properties.agentClients.minItems, AGENT_CLIENT_IDS.length);
  assert.equal(schema.properties.agentClients.maxItems, AGENT_CLIENT_IDS.length);
  assert.equal(schema.properties.agentClients.items.additionalProperties, false);
  assert.deepEqual(
    schema.properties.agentClients.items.properties.id.enum,
    AGENT_CLIENT_IDS
  );
  assert.deepEqual(
    schema.properties.agentClients.items.required,
    ['id', 'enabled', 'installInSandbox']
  );
  assert.equal(schema.properties.agentClients.items.properties.enabled.type, 'boolean');
  assert.equal(
    schema.properties.agentClients.items.properties.installInSandbox.type,
    'boolean'
  );
  assert.deepEqual(
    schema.definitions.agentClientCapabilityId.enum,
    AGENT_CLIENT_CAPABILITY_IDS
  );
  assert.deepEqual(
    schema.definitions.agentClientSupportLevel.enum,
    AGENT_CLIENT_SUPPORT_LEVELS
  );
});

test('canonical input is normalized to stable ID order without mutation', () => {
  const input = [...canonical()].reverse();
  const before = structuredClone(input);
  const result = normalizeAgentClients({ agentClients: input });

  assert.equal(result.source, 'canonical');
  assert.deepEqual(result.state, ALL_ENABLED);
  assert.deepEqual(result.canonical, canonical());
  assert.equal(result.changed, true);
  assert.equal(result.removeLegacyTuis, false);
  assert.equal(result.remainingSandboxTools, undefined);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(input, before);

  const second = normalizeAgentClients({ agentClients: result.canonical });
  assert.equal(second.changed, false);
  assert.deepEqual(second.canonical, result.canonical);
  assert.notEqual(second.canonical, result.canonical);
});

test('serializer returns a new stable array and does not mutate state', () => {
  const state = structuredClone(ALL_ENABLED);
  const before = structuredClone(state);
  const first = serializeAgentClients(state);
  const second = serializeAgentClients(state);

  assert.deepEqual(first, canonical());
  assert.deepEqual(second, first);
  assert.notEqual(first, second);
  assert.deepEqual(state, before);
});

test('canonical validation reports stable structural error codes', () => {
  const cases: Array<[string, unknown]> = [
    ['INVALID_AGENT_CLIENTS', null],
    ['MISSING_AGENT_CLIENT', canonical().slice(0, 3)],
    [
      'DUPLICATE_AGENT_CLIENT',
      canonical().map((entry, index) => index === 3 ? { ...entry, id: 'codex' } : entry)
    ],
    [
      'UNKNOWN_AGENT_CLIENT',
      canonical().map((entry, index) => index === 3 ? { ...entry, id: 'other' } : entry)
    ],
    [
      'INVALID_AGENT_CLIENTS',
      canonical().map((entry, index) => index === 0 ? { ...entry, enabled: 'yes' } : entry)
    ],
    [
      'INVALID_AGENT_CLIENTS',
      canonical().map((entry, index) => index === 0 ? { ...entry, extra: true } : entry)
    ]
  ];

  for (const [expected, agentClients] of cases) {
    assert.equal(errorCode(() => normalizeAgentClients({ agentClients })), expected);
  }

  const missing = canonical().slice(0, 3);
  missing.push({ id: 'codex', enabled: true, installInSandbox: true });
  assert.equal(
    errorCode(() => normalizeAgentClients({ agentClients: missing })),
    'DUPLICATE_AGENT_CLIENT'
  );
});

test('legacy defaults preserve current enabled and sandbox behavior', () => {
  for (const input of [
    {},
    { tuis: null, sandbox: null },
    { tuis: 'invalid', sandbox: { tools: 'invalid' } },
    { sandbox: { tools: [] } }
  ]) {
    const result = normalizeAgentClients(input);
    assert.equal(result.source, 'legacy');
    assert.deepEqual(result.state, ALL_ENABLED);
    assert.deepEqual(result.canonical, canonical());
    assert.equal(result.changed, true);
  }
});

test('legacy arrays project independent enabled and sandbox states', () => {
  const input = {
    tuis: ['codex', 'opencode', 'unknown'],
    sandbox: {
      tools: ['agent-infra', 'claude-code', 'opencode', 'custom-tool', 'unknown-tool']
    },
    customTUIs: [{ name: 'custom' }]
  };
  const before = structuredClone(input);
  const result = normalizeAgentClients(input);

  assert.deepEqual(
    result.canonical,
    canonical(['codex', 'opencode'], ['claude-code', 'opencode'])
  );
  assert.deepEqual(
    result.remainingSandboxTools,
    ['agent-infra', 'custom-tool', 'unknown-tool']
  );
  assert.equal(result.removeLegacyTuis, true);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ['LEGACY_VALUE_IGNORED']
  );
  assert.deepEqual(input, before);
});

test('an empty legacy tuis array disables all clients independently of sandbox defaults', () => {
  const result = normalizeAgentClients({ tuis: [], sandbox: { tools: [] } });
  assert.deepEqual(result.canonical, canonical([], AGENT_CLIENT_IDS));
  assert.deepEqual(result.remainingSandboxTools, []);
});

test('canonical and present legacy signals must be equivalent', () => {
  const equivalent = normalizeAgentClients({
    agentClients: canonical(['codex'], ['claude-code']),
    tuis: ['codex'],
    sandbox: { tools: ['agent-infra', 'claude-code', 'custom-tool'] }
  });
  assert.equal(equivalent.source, 'canonical');
  assert.equal(equivalent.changed, true);
  assert.equal(equivalent.removeLegacyTuis, true);
  assert.deepEqual(equivalent.remainingSandboxTools, ['agent-infra', 'custom-tool']);

  assert.equal(
    errorCode(() => normalizeAgentClients({
      agentClients: canonical(['codex'], ['claude-code']),
      tuis: ['opencode']
    })),
    'LEGACY_CONFLICT'
  );
  assert.equal(
    errorCode(() => normalizeAgentClients({
      agentClients: canonical(['codex'], ['claude-code']),
      sandbox: { tools: ['codex'] }
    })),
    'LEGACY_CONFLICT'
  );
});

test('invalid canonical input never falls back to legacy values', () => {
  assert.equal(
    errorCode(() => normalizeAgentClients({
      agentClients: [],
      tuis: AGENT_CLIENT_IDS,
      sandbox: { tools: AGENT_CLIENT_IDS }
    })),
    'MISSING_AGENT_CLIENT'
  );
});

test('builtin TUI exports remain compatible aliases over shared client IDs', () => {
  assert.equal(BUILTIN_TUI_IDS, AGENT_CLIENT_IDS);
  assert.deepEqual(Object.keys(BUILTIN_TUI_DISPLAY), AGENT_CLIENT_IDS);
  assert.deepEqual(Object.keys(BUILTIN_TUI_OWNED_PATH_PREFIXES), AGENT_CLIENT_IDS);
  assert.equal(isBuiltinTUIId('codex'), true);
  assert.equal(isBuiltinTUIId('unknown'), false);
  assert.deepEqual(resolveEnabledTUIs([]), new Set());
  assert.deepEqual(resolveEnabledTUIs(undefined), new Set(AGENT_CLIENT_IDS));
  assert.equal(isPathOwnedByDisabledTUI('.codex/skills', new Set()), true);
  assert.equal(
    isPathOwnedByDisabledTUI('.codex/skills', new Set(AGENT_CLIENT_IDS)),
    false
  );
});
