import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { createCodexLifecycleStore } from '../../../lib/agent-clients/adapters/codex-lifecycle/store.ts';
import {
  activateCodexOrchestrationDelegation,
  activateCodexSpawnDelegation,
  prepareCodexOrchestrationDelegation,
  reconcileCodexOrchestrationDelegation,
  sealCodexOrchestrationDelegation,
  sealCodexParentDelegation
} from '../../../lib/task/codex-orchestration.ts';
import {
  advanceOrchestration,
  beginOrResumeOrchestration,
  completeOrchestrationStage,
  dispatchOrchestrationDelegation,
  readRun
} from '../../../lib/task/orchestration.ts';

const taskId = 'TASK-20260101-000001';
const policy = {
  executor: { model: 'executor-model', reasoningEffort: 'xhigh' },
  reviewer: { model: 'reviewer-model', reasoningEffort: 'high' }
} as const;
const buildIdentity = {
  protocolVersion: 3,
  packageVersion: '0.9.7-alpha.0',
  internalExecutableBuildHash: 'a'.repeat(64),
  lifecycleContractHash: 'b'.repeat(64)
} as const;
const fixtureRoots = new Set<string>();
after(() => {
  for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
});
const hookProvenance = {
  hookSource: 'project' as const,
  hookSourcePathDigest: 'c'.repeat(64),
  hookSourceHash: 'd'.repeat(64)
};
const preflight = async () => ({
  cliVersion: '0.147.0', hookDefinitionHash: 'c'.repeat(64), staticReady: true,
  discoveredHooks: [], hookProvenance, runtimeLiveness: false, diagnostics: []
} as const);

test('Codex prepares the requested stage from current task and model policy', async () => {
  const f = fixture();
  const result = await prepareCodexOrchestrationDelegation(taskId, {
    client: 'codex', requestedModel: 'executor-model', requestedReasoningEffort: 'xhigh'
  }, {
    repoRoot: f.root, preflight,
    orchestrationOptions: { captureWorkspace: () => 'before', id: () => 'stage-1' }
  });
  assert.equal(result.status, 'running', JSON.stringify(result.error));
  assert.equal(result.run?.pendingDelegation?.stage, 'analysis');
  assert.equal(result.run?.pendingDelegation?.requestedModel, 'executor-model');
  assert.equal(result.run?.pendingDelegation?.status, 'prepared');
  assert.equal(readRun(f.taskDir)?.pendingDelegation?.stage, 'analysis');
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-orchestration-'));
  fixtureRoots.add(root);
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: active\ncurrent_step: requirement-analysis\nagent_infra_version: v0.9.11-alpha.0\n---\n\n# Task\n## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n`);
  beginOrResumeOrchestration(taskId, { repoRoot: root, client: 'codex', modelPolicy: policy, id: () => 'run-1' });
  return { root, taskDir };
}

test('Codex prepare rejects missing model or effort before preparing a stage', async () => {
  for (const { input, expectedCode } of [
    { input: { requestedReasoningEffort: 'xhigh' }, expectedCode: 'ORCHESTRATION_REQUESTED_MODEL_REQUIRED' },
    { input: { requestedModel: 'executor-model' }, expectedCode: 'ORCHESTRATION_REQUESTED_REASONING_EFFORT_REQUIRED' }
  ]) {
    const f = fixture();
    const result = await prepareCodexOrchestrationDelegation(taskId, {
      client: 'codex',
      ...input,
    }, {
      repoRoot: f.root,
      buildIdentity,
      preflight,
      orchestrationOptions: { captureWorkspace: () => 'before' }
    });
    assert.equal(result.error?.code, expectedCode);
    assert.equal(readRun(f.taskDir)?.pendingDelegation, null);
  }
});

test('Codex prepare rejects route policy mismatches before workspace capture', async () => {
  for (const { input, expectedCode } of [
    { input: { requestedModel: 'wrong-model', requestedReasoningEffort: 'xhigh' }, expectedCode: 'ORCHESTRATION_REQUESTED_MODEL_MISMATCH' },
    { input: { requestedModel: 'executor-model', requestedReasoningEffort: 'wrong-effort' }, expectedCode: 'ORCHESTRATION_REQUESTED_REASONING_EFFORT_MISMATCH' }
  ]) {
    const f = fixture();
    let captures = 0;
    const result = await prepareCodexOrchestrationDelegation(taskId, {
      client: 'codex', ...input
    }, {
      repoRoot: f.root,
      buildIdentity,
      preflight,
      orchestrationOptions: { captureWorkspace: () => { captures += 1; return 'before'; } }
    });
    assert.equal(result.error?.code, expectedCode);
    assert.equal(captures, 0);
    assert.equal(readRun(f.taskDir)?.pendingDelegation, null);
    assert.equal(readRun(f.taskDir)?.baseline, '');
  }
});

test('Codex prepare reports workspace snapshot failures', async () => {
  const f = fixture();
  let captures = 0;
  const result = await prepareCodexOrchestrationDelegation(taskId, {
    client: 'codex', requestedModel: 'executor-model', requestedReasoningEffort: 'xhigh',
  }, {
    repoRoot: f.root,
    buildIdentity,
    preflight,
    orchestrationOptions: {
      captureWorkspace: () => {
        captures += 1;
        throw new Error('snapshot unavailable');
      }
    }
  });
  assert.equal(result.error?.code, 'ORCHESTRATION_SNAPSHOT_FAILED');
  assert.equal(captures, 1);
  assert.equal(readRun(f.taskDir)?.pendingDelegation, null);
  assert.equal(readRun(f.taskDir)?.baseline, '');
});

test('Codex prepare preflight fails before workspace capture or receipt creation', async () => {
  const f = fixture();
  let captures = 0;
  const result = await prepareCodexOrchestrationDelegation(taskId, {
    client: 'codex', requestedModel: 'executor-model', requestedReasoningEffort: 'xhigh'
  }, {
    repoRoot: f.root,
    preflight: async () => { throw new Error('CODEX_PREFLIGHT_HOOKS_NOT_LOADED'); },
    orchestrationOptions: { captureWorkspace: () => { captures += 1; return 'before'; } }
  });
  assert.equal(result.error?.code, 'ORCHESTRATION_CLIENT_PREFLIGHT_FAILED');
  assert.equal(captures, 0);
  assert.equal(readRun(f.taskDir)?.pendingDelegation, null);
  assert.equal(readRun(f.taskDir)?.baseline, '');
});

test('Codex prepare preserves the typed orchestration state error', async () => {
  const f = fixture();
  const runPath = path.join(f.taskDir, 'orchestration.json');
  const invalidRun = { ...JSON.parse(fs.readFileSync(runPath, 'utf8')), schemaVersion: 3 };
  fs.writeFileSync(runPath, `${JSON.stringify(invalidRun, null, 2)}\n`);
  let captures = 0;

  const result = await prepareCodexOrchestrationDelegation(taskId, {
    client: 'codex',
    requestedModel: 'executor-model',
    requestedReasoningEffort: 'xhigh',
  }, {
    repoRoot: f.root,
    buildIdentity,
    preflight,
    orchestrationOptions: { captureWorkspace: () => { captures += 1; return 'before'; } }
  });

  assert.equal(result.error?.code, 'ORCHESTRATION_STATE_INVALID');
  assert.equal(
    result.error?.message,
    'orchestration.json does not match the current runtime structure; the file was left unchanged; rebuild the sandbox or manually repair the state before retrying'
  );
  assert.equal(captures, 0);
});

test('Codex parent reconciliation ignores unrelated completed waits', async () => {
  const f = fixture();
  const store = createCodexLifecycleStore({
    root: path.join(f.root, '.agents', 'workspace', '.runtime', 'codex-lifecycle'),
    cliVersion: '0.147.0'
  });
  const result = await sealCodexParentDelegation('unrelated-parent', { repoRoot: f.root, store });
  assert.equal(result.error?.code, 'ORCHESTRATION_DELEGATION_MISSING');
  assert.equal(readRun(f.taskDir)?.status, 'running');
});

test('Codex bridge completes sealing after evidence consumption survives a crash window', async () => {
  const f = fixture();
  const prepared = await prepareCodexOrchestrationDelegation(taskId, {
    client: 'codex', requestedModel: 'executor-model', requestedReasoningEffort: 'xhigh',
  }, {
    repoRoot: f.root,
    buildIdentity,
    preflight,
    orchestrationOptions: { captureWorkspace: () => 'before', id: () => 'receipt-1' }
  });
  assert.equal(prepared.run?.pendingDelegation?.status, 'prepared');
  assert.equal(dispatchOrchestrationDelegation(taskId, {
    repoRoot: f.root, now: () => '2026-08-14T00:00:00.500Z'
  }).run?.pendingDelegation?.spawnDispatchedAt !== null, true);

  const store = createCodexLifecycleStore({
    root: path.join(f.root, '.agents', 'workspace', '.runtime', 'codex-lifecycle'),
    cliVersion: '0.147.0',
    now: () => '2026-08-14T00:00:02.000Z'
  });
  store.apply({
    type: 'hook-spawn', sessionId: 'parent', turnId: 'parent-turn', toolUseId: 'spawn-tool',
    nativeAgent: 'agent-infra-lifecycle-executor', requestedModel: 'executor-model',
    requestedReasoningEffort: 'xhigh', hookDefinitionHash: 'c'.repeat(64)
  });
  store.apply({
    type: 'hook-child', sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
    parentThreadId: 'parent',
    nativeAgent: 'agent-infra-lifecycle-executor'
  });
  const started = await activateCodexOrchestrationDelegation('child', {
    repoRoot: f.root,
    buildIdentity,
    preflight,
    store,
    orchestrationOptions: { now: () => '2026-08-14T00:00:03.000Z' },
    resolveThread: async () => ({
      resolution: {
        thread: { type: 'app-thread', childThreadId: 'child', parentThreadId: 'parent', forkedFromId: null, sourceParentThreadId: 'parent', nativeAgent: 'agent-infra-lifecycle-executor' },
        settings: { type: 'app-settings', childThreadId: 'child', model: 'executor-model', reasoningEffort: 'xhigh' }
      },
      reroutes: [], diagnostics: []
    })
  });
  assert.equal(started.run?.pendingDelegation?.status, 'activated');
  assert.equal(started.run?.pendingDelegation?.hostEvidence?.kind, 'codex-lifecycle-v2');
  assert.equal(started.run?.pendingDelegation?.hostEvidence?.startRevision, 4);
  assert.equal((await activateCodexOrchestrationDelegation('child', {
    repoRoot: f.root, store, buildIdentity,
    preflight,
    resolveThread: async () => ({
      resolution: {
        thread: { type: 'app-thread', childThreadId: 'child', parentThreadId: 'parent', forkedFromId: null, sourceParentThreadId: 'parent', nativeAgent: 'agent-infra-lifecycle-executor' },
        settings: { type: 'app-settings', childThreadId: 'child', model: 'executor-model', reasoningEffort: 'xhigh' }
      },
      reroutes: [], diagnostics: []
    })
  })).changed, false);

  const completed = completeOrchestrationStage(taskId, {
    stage: 'analysis', round: 1, artifact: 'analysis.md', agent: 'codex'
  }, { repoRoot: f.root });
  assert.equal(completed.run?.pendingDelegation?.status, 'stage-completed');
  store.apply({
    type: 'hook-stop', sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
    nativeAgent: 'agent-infra-lifecycle-executor'
  });
  store.apply({ type: 'app-terminal', childThreadId: 'child', turnId: 'child-turn', status: 'completed' });
  const pending = readRun(f.taskDir)?.pendingDelegation;
  assert.equal(pending?.status, 'stage-completed');
  store.consume('child', pending!.id, pending!.hostEvidence?.hookDefinitionHash);
  assert.equal(store.read('child').consumer, 'receipt-1');
  const sealed = await sealCodexOrchestrationDelegation('child', {
    repoRoot: f.root,
    store,
    resolveTerminal: async () => ({ type: 'app-terminal', childThreadId: 'child', turnId: 'child-turn', status: 'completed' }),
    orchestrationOptions: {
      captureWorkspace: () => 'after',
      diffWorkspace: () => ['.agents/workspace/active/TASK-20260101-000001/analysis.md']
    }
  });
  assert.equal(sealed.run?.pendingDelegation?.status, 'sealed');
  assert.equal(sealed.run?.pendingDelegation?.hostEvidence?.consumer, 'receipt-1');
  assert.equal(store.read('child').consumer, 'receipt-1');
  assert.equal((await sealCodexOrchestrationDelegation('child', { repoRoot: f.root, store })).changed, false);

  assert.equal(reconcileCodexOrchestrationDelegation('child', { repoRoot: f.root }).status, 'running');
  const advanced = advanceOrchestration(taskId, { repoRoot: f.root });
  assert.equal(advanced.run?.receipts[0]?.status, 'consumed');
});

test('Codex bridge activates and seals from trusted parent spawn and wait evidence', async () => {
  const f = fixture();
  await prepareCodexOrchestrationDelegation(taskId, {
    client: 'codex', requestedModel: 'executor-model', requestedReasoningEffort: 'xhigh',
  }, {
    repoRoot: f.root,
    buildIdentity,
    preflight,
    orchestrationOptions: { captureWorkspace: () => 'before', id: () => 'receipt-1' }
  });
  dispatchOrchestrationDelegation(taskId, { repoRoot: f.root });
  const store = createCodexLifecycleStore({
    root: path.join(f.root, '.agents', 'workspace', '.runtime', 'codex-lifecycle'),
    cliVersion: '0.147.0'
  });
  store.apply({
    type: 'hook-spawn', sessionId: 'parent', turnId: 'parent-turn', toolUseId: 'spawn-tool',
    nativeAgent: 'agent-infra-lifecycle-executor', requestedModel: 'executor-model',
    requestedReasoningEffort: 'xhigh', hookDefinitionHash: 'c'.repeat(64)
  });
  store.apply({
    type: 'hook-child', sessionId: 'parent', turnId: 'parent-turn', childThreadId: 'child',
    parentThreadId: 'parent', nativeAgent: 'agent-infra-lifecycle-executor', source: 'hook'
  });
  const rollout = path.join(f.root, 'rollout-parent.jsonl');
  fs.writeFileSync(rollout, [
    JSON.stringify({ type: 'response_item', payload: {
      type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', call_id: 'spawn-tool',
      arguments: JSON.stringify({ agent_type: 'agent-infra-lifecycle-executor', task_name: 'analysis_executor_r1', model: 'executor-model', reasoning_effort: 'xhigh' })
    } }),
    JSON.stringify({ type: 'event_msg', payload: {
      type: 'item_completed', thread_id: 'parent', turn_id: 'parent-turn',
      item: {
        type: 'SubAgentActivity', id: 'spawn-tool', kind: 'started',
        agent_thread_id: 'child', agent_path: '/root/analysis_executor_r1'
      }
    } })
  ].join('\n'));
  const started = await activateCodexSpawnDelegation({
    sessionId: 'parent', turnId: 'parent-turn', toolUseId: 'spawn-tool', transcriptPath: rollout,
    nativeAgent: 'agent-infra-lifecycle-executor', taskName: 'analysis_executor_r1',
    requestedModel: 'executor-model', requestedReasoningEffort: 'xhigh'
  }, {
    repoRoot: f.root,
    buildIdentity,
    preflight,
    store,
    resolveThread: async () => ({
      resolution: {
        thread: { type: 'app-thread', childThreadId: 'child', parentThreadId: 'parent', forkedFromId: null, sourceParentThreadId: 'parent', nativeAgent: 'agent-infra-lifecycle-executor' },
        settings: { type: 'app-settings', childThreadId: 'child', model: 'executor-model', reasoningEffort: 'xhigh' }
      },
      reroutes: [], diagnostics: []
    })
  });
  assert.equal(started.run?.pendingDelegation?.status, 'activated');
  assert.equal(store.read('child').state.child?.source, 'hook');
  const unrelated = await sealCodexParentDelegation('parent', {
    repoRoot: f.root,
    store,
    resolveTerminal: async () => { throw new Error('CODEX_TURN_NOT_TERMINAL'); }
  });
  assert.equal(unrelated.error?.code, 'ORCHESTRATION_DELEGATION_MISSING');
  assert.equal(readRun(f.taskDir)?.pendingDelegation?.status, 'activated');
  completeOrchestrationStage(taskId, {
    stage: 'analysis', round: 1, artifact: 'analysis.md', agent: 'codex'
  }, { repoRoot: f.root });
  const stageCompleted = fs.readFileSync(path.join(f.taskDir, 'orchestration.json'), 'utf8');
  const sealed = await sealCodexParentDelegation('parent', {
    repoRoot: f.root,
    store,
    resolveTerminal: async () => ({ type: 'app-terminal', childThreadId: 'child', turnId: 'child-turn', status: 'completed' }),
    orchestrationOptions: {
      captureWorkspace: () => 'after',
      diffWorkspace: () => ['.agents/workspace/active/TASK-20260101-000001/analysis.md']
    }
  });
  assert.equal(sealed.run?.pendingDelegation?.status, 'sealed');
  assert.equal(store.read('child').state.stopEvidence?.hookStopObserved, false);

  fs.writeFileSync(path.join(f.taskDir, 'orchestration.json'), stageCompleted);
  const replayed = await sealCodexParentDelegation('parent', {
    repoRoot: f.root,
    store,
    orchestrationOptions: {
      captureWorkspace: () => 'after',
      diffWorkspace: () => ['.agents/workspace/active/TASK-20260101-000001/analysis.md']
    }
  });
  assert.equal(replayed.run?.pendingDelegation?.status, 'sealed');
  assert.equal(store.read('child').consumer, 'receipt-1');
});
