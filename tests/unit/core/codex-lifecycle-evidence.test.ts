import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCodexLifecycleState,
  reduceCodexLifecycleEvent
} from '../../../lib/agent-clients/adapters/codex-lifecycle/evidence.ts';

function happyEvents() {
  return [
    {
      type: 'hook-spawn' as const,
      sessionId: 'parent-thread',
      turnId: 'parent-turn',
      toolUseId: 'spawn-tool',
      nativeAgent: 'agent-infra-lifecycle-executor',
      requestedModel: 'gpt-5.6-sol',
      requestedReasoningEffort: 'high',
      hookDefinitionHash: 'abc123'
    },
    {
      type: 'hook-child' as const,
      sessionId: 'parent-thread',
      turnId: 'parent-turn',
      childThreadId: 'child-thread',
      nativeAgent: 'agent-infra-lifecycle-executor'
    },
    {
      type: 'app-thread' as const,
      childThreadId: 'child-thread',
      parentThreadId: 'parent-thread',
      forkedFromId: null,
      sourceParentThreadId: 'parent-thread'
    },
    {
      type: 'app-settings' as const,
      childThreadId: 'child-thread',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high'
    }
  ];
}

test('Codex lifecycle evidence becomes ready only after host-resolved identity and settings', () => {
  let state = createCodexLifecycleState('0.147.0');
  for (const event of happyEvents()) state = reduceCodexLifecycleEvent(state, event);

  assert.equal(state.status, 'start-ready');
  assert.deepEqual(state.startEvidence, {
    schemaVersion: 1,
    cliVersion: '0.147.0',
    parentThreadId: 'parent-thread',
    parentTurnId: 'parent-turn',
    spawnToolUseId: 'spawn-tool',
    childThreadId: 'child-thread',
    nativeAgent: 'agent-infra-lifecycle-executor',
    spawnMode: 'fresh',
    actualModel: { value: 'gpt-5.6-sol', source: 'codex-app-server-settings' },
    actualReasoningEffort: { value: 'high', source: 'codex-app-server-settings' },
    modelFallbackReason: null,
    reasoningEffortFallbackReason: null,
    hookDefinitionHash: 'abc123'
  });

  state = reduceCodexLifecycleEvent(state, {
    type: 'app-terminal', childThreadId: 'child-thread', turnId: 'child-turn', status: 'completed'
  });
  assert.equal(state.status, 'observed-terminal');
  state = reduceCodexLifecycleEvent(state, {
    type: 'hook-stop', sessionId: 'parent-thread', turnId: 'parent-turn',
    childThreadId: 'child-thread', nativeAgent: 'agent-infra-lifecycle-executor'
  });
  assert.equal(state.status, 'stop-ready');
  assert.deepEqual(state.stopEvidence, {
    schemaVersion: 1,
    childThreadId: 'child-thread',
    turnId: 'child-turn',
    terminalStatus: 'completed',
    hookStopObserved: true
  });
});

test('Codex lifecycle evidence fails closed on fork, identity conflict, and unexplained resolution', () => {
  for (const event of [
    { type: 'app-thread' as const, childThreadId: 'child-thread', parentThreadId: 'parent-thread', forkedFromId: 'source', sourceParentThreadId: 'parent-thread' },
    { type: 'app-thread' as const, childThreadId: 'child-thread', parentThreadId: 'other-parent', forkedFromId: null, sourceParentThreadId: 'other-parent' },
    { type: 'app-settings' as const, childThreadId: 'child-thread', model: 'other-model', reasoningEffort: 'high' },
    { type: 'app-settings' as const, childThreadId: 'child-thread', model: 'gpt-5.6-sol', reasoningEffort: 'low' }
  ]) {
    let state = createCodexLifecycleState('0.147.0');
    for (const prefix of happyEvents().slice(0, 2)) state = reduceCodexLifecycleEvent(state, prefix);
    state = reduceCodexLifecycleEvent(state, event);
    assert.equal(state.status, 'invalid');
    assert.ok(state.error?.code.startsWith('CODEX_EVIDENCE_'));
  }
});

test('Codex lifecycle evidence accepts a structured model reroute and rejects abnormal terminal status', () => {
  let state = createCodexLifecycleState('0.147.0');
  for (const event of happyEvents().slice(0, 3)) state = reduceCodexLifecycleEvent(state, event);
  state = reduceCodexLifecycleEvent(state, {
    type: 'app-reroute', childThreadId: 'child-thread', turnId: 'child-turn',
    fromModel: 'gpt-5.6-sol', toModel: 'fallback-model', reason: 'capacity'
  });
  state = reduceCodexLifecycleEvent(state, {
    type: 'app-settings', childThreadId: 'child-thread', model: 'fallback-model', reasoningEffort: 'high'
  });
  assert.equal(state.status, 'start-ready');
  assert.equal(state.startEvidence?.modelFallbackReason, 'capacity');

  state = reduceCodexLifecycleEvent(state, {
    type: 'app-terminal', childThreadId: 'child-thread', turnId: 'child-turn', status: 'failed'
  });
  assert.equal(state.status, 'invalid');
  assert.equal(state.error?.code, 'CODEX_EVIDENCE_TERMINAL_INVALID');
});
