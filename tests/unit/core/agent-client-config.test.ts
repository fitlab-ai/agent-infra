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
  AgentClientConfigError,
  normalizeAgentClients,
  serializeAgentClients
} from '../../../lib/agent-clients/config.ts';
import { AGENT_CLIENTS_SCHEMA } from '../../../lib/agent-clients/schema.ts';

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

function errorDetails(run: () => unknown): { code: string; path: string } {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof AgentClientConfigError);
    return { code: error.code, path: error.path };
  }
  assert.fail('Expected normalization to fail');
}

test('agent client vocabulary is closed, unique, and recognized by the shared guard', () => {
  assert.deepEqual(AGENT_CLIENT_IDS, ['claude-code', 'codex', 'antigravity-cli', 'opencode', 'traecli']);
  assert.equal(new Set(AGENT_CLIENT_IDS).size, AGENT_CLIENT_IDS.length);
  assert.deepEqual(AGENT_CLIENT_CAPABILITY_IDS, [
    'instructions',
    'skills',
    'commands',
    'hooks',
    'subagents',
    'orchestration',
    'sandbox',
    'verification'
  ]);
  assert.equal(new Set(AGENT_CLIENT_CAPABILITY_IDS).size, AGENT_CLIENT_CAPABILITY_IDS.length);
  assert.deepEqual(AGENT_CLIENT_SUPPORT_LEVELS, [
    'compatible',
    'integrated',
    'verified',
    'experimental',
    'unsupported'
  ]);
  assert.equal(new Set(AGENT_CLIENT_SUPPORT_LEVELS).size, AGENT_CLIENT_SUPPORT_LEVELS.length);
  assert.equal(isAgentClientId('codex'), true);
  assert.equal(isAgentClientId('other'), false);
});

test('schema is JSON-safe and expresses the canonical tuple order', () => {
  const json = JSON.stringify(AGENT_CLIENTS_SCHEMA);
  assert.deepEqual(JSON.parse(json), AGENT_CLIENTS_SCHEMA);

  const schema = AGENT_CLIENTS_SCHEMA as Record<string, any>;
  assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
  assert.deepEqual(schema.required, ['agentClients']);
  assert.equal(schema.properties.agentClients.minItems, AGENT_CLIENT_IDS.length);
  assert.equal(schema.properties.agentClients.maxItems, AGENT_CLIENT_IDS.length);
  assert.equal(schema.properties.agentClients.additionalItems, false);
  assert.equal(Array.isArray(schema.properties.agentClients.items), true);
  assert.deepEqual(
    schema.properties.agentClients.items.map((item: Record<string, any>) => item.properties.id.const),
    AGENT_CLIENT_IDS
  );
  assert.deepEqual(
    schema.properties.agentClients.items[0].required,
    ['id', 'enabled', 'installInSandbox']
  );
  assert.deepEqual(
    schema.properties.customTUIs.items.required,
    ['name', 'dir', 'invoke']
  );
  assert.equal(schema.properties.customTUIs.items.additionalProperties, true);
  assert.equal(schema.properties.customTUIs.items.properties.name.type, 'string');
  assert.equal(schema.properties.customTUIs.items.properties.dir.type, 'string');
  assert.equal(schema.properties.customTUIs.items.properties.invoke.type, 'string');
  assert.deepEqual(
    schema.definitions.agentClientCapabilityId.enum,
    AGENT_CLIENT_CAPABILITY_IDS
  );
  assert.deepEqual(
    schema.definitions.agentClientSupportLevel.enum,
    AGENT_CLIENT_SUPPORT_LEVELS
  );
});

test('canonical input is normalized without mutation and preserves the required order', () => {
  const input = canonical();
  const before = structuredClone(input);
  const result = normalizeAgentClients({ agentClients: input });

  assert.deepEqual(result.state, ALL_ENABLED);
  assert.deepEqual(result.canonical, canonical());
  assert.deepEqual(input, before);

  const second = normalizeAgentClients({ agentClients: result.canonical });
  assert.deepEqual(second.canonical, result.canonical);
  assert.notEqual(second.canonical, result.canonical);
});

test('canonical config rejects a reordered client array instead of silently sorting it', () => {
  const input = [...canonical()].reverse();
  const error = errorDetails(() => normalizeAgentClients({ agentClients: input }));

  assert.deepEqual(error, {
    code: 'INVALID_AGENT_CLIENTS',
    path: 'agentClients[0].id'
  });
});

test('canonical config preserves a complete per-client orchestration policy', () => {
  const policy = {
    executor: { model: 'executor-model', reasoningEffort: 'xhigh' },
    reviewer: { model: 'executor-model', reasoningEffort: 'high' }
  };
  const input = canonical().map((entry) =>
    entry.id === 'codex' ? { ...entry, orchestration: policy } : entry
  );
  const result = normalizeAgentClients({ agentClients: input });

  assert.deepEqual(result.canonical, input);
  assert.deepEqual(result.state.codex.orchestration, policy);
  assert.deepEqual(
    errorDetails(() => normalizeAgentClients({
      agentClients: canonical().map((entry) => entry.id === 'codex'
        ? { ...entry, orchestration: { ...policy, reviewer: { model: '', reasoningEffort: 'high' } } }
        : entry)
    })),
    { code: 'INVALID_AGENT_CLIENTS', path: 'agentClients[1].orchestration.reviewer.model' }
  );
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
    assert.equal(errorDetails(() => normalizeAgentClients({ agentClients })).code, expected);
  }

  const missing = canonical().slice(0, 3);
  missing.push({ id: 'codex', enabled: true, installInSandbox: true });
  assert.equal(
    errorDetails(() => normalizeAgentClients({ agentClients: missing })).code,
    'DUPLICATE_AGENT_CLIENT'
  );
});

test('legacy fields are rejected after canonical validation and do not affect state', () => {
  assert.deepEqual(
    errorDetails(() => normalizeAgentClients({
      agentClients: canonical(),
      tuis: ['codex']
    })),
    { code: 'INVALID_AGENT_CLIENTS', path: 'tuis' }
  );
  assert.deepEqual(
    errorDetails(() => normalizeAgentClients({
      agentClients: canonical(),
      sandbox: { tools: ['agent-infra', 'codex'] }
    })),
    { code: 'INVALID_AGENT_CLIENTS', path: 'sandbox.tools[1]' }
  );
  assert.equal(
    errorDetails(() => normalizeAgentClients({
      tuis: AGENT_CLIENT_IDS,
      sandbox: { tools: AGENT_CLIENT_IDS }
    })).code,
    'MISSING_AGENT_CLIENT'
  );
});

test('canonical normalization preserves non-client sandbox tools without projecting them', () => {
  const input = {
    agentClients: canonical(['codex'], ['claude-code']),
    sandbox: { tools: ['agent-infra', 'custom-tool'] }
  };
  const result = normalizeAgentClients(input);

  assert.deepEqual(result.state, Object.fromEntries(
    AGENT_CLIENT_IDS.map((id) => [id, {
      enabled: id === 'codex',
      installInSandbox: id === 'claude-code'
    }])
  ));
  assert.deepEqual(result.canonical, input.agentClients);
});
