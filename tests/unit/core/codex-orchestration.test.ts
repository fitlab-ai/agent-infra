import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCodexLifecycleStore } from '../../../lib/agent-clients/adapters/codex-lifecycle/store.ts';
import {
  activateCodexOrchestrationDelegation,
  prepareCodexOrchestrationDelegation,
  reconcileCodexOrchestrationDelegation,
  sealCodexOrchestrationDelegation
} from '../../../lib/task/codex-orchestration.ts';
import {
  advanceOrchestration,
  beginOrResumeOrchestration,
  completeOrchestrationStage,
  readRun
} from '../../../lib/task/orchestration.ts';

const taskId = 'TASK-20260101-000001';
const policy = {
  executor: { model: 'executor-model', reasoningEffort: 'xhigh' },
  reviewer: { model: 'reviewer-model', reasoningEffort: 'high' }
} as const;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-orchestration-'));
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\ncurrent_step: requirement-analysis\n---\n\n# Task\n`);
  beginOrResumeOrchestration(taskId, { repoRoot: root, client: 'codex', modelPolicy: policy, id: () => 'run-1' });
  return { root, taskDir };
}

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

test('Codex bridge completes sealing after evidence consumption survives a crash window', async () => {
  const f = fixture();
  const prepared = await prepareCodexOrchestrationDelegation(taskId, {
    client: 'codex', requestedModel: 'executor-model', requestedReasoningEffort: 'xhigh'
  }, {
    repoRoot: f.root,
    preflight: async () => ({
      cliVersion: '0.147.0', hookDefinitionHash: 'hook-hash', staticReady: true,
      discoveredHooks: [], runtimeLiveness: false, diagnostics: []
    }),
    orchestrationOptions: { captureWorkspace: () => 'before', id: () => 'receipt-1' }
  });
  assert.equal(prepared.run?.pendingDelegation?.status, 'prepared');

  const store = createCodexLifecycleStore({
    root: path.join(f.root, '.agents', 'workspace', '.runtime', 'codex-lifecycle'),
    cliVersion: '0.147.0',
    now: () => '2026-08-14T00:00:02.000Z'
  });
  store.apply({
    type: 'hook-spawn', sessionId: 'parent', turnId: 'parent-turn', toolUseId: 'tool',
    nativeAgent: 'agent-infra-lifecycle-executor', requestedModel: 'executor-model',
    requestedReasoningEffort: 'xhigh', hookDefinitionHash: 'hook-hash'
  });
  store.apply({
    type: 'hook-child', sessionId: 'child', turnId: 'child-turn', childThreadId: 'child',
    parentThreadId: 'parent',
    nativeAgent: 'agent-infra-lifecycle-executor'
  });
  const started = await activateCodexOrchestrationDelegation('child', {
    repoRoot: f.root,
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
  assert.equal(started.run?.pendingDelegation?.hostEvidence?.startRevision, 4);
  assert.equal((await activateCodexOrchestrationDelegation('child', {
    repoRoot: f.root, store,
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
    type: 'hook-stop', sessionId: 'child', turnId: 'child-turn', childThreadId: 'child',
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
