import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { createCodexLifecycleStore } from '../../../lib/agent-clients/adapters/codex-lifecycle/store.ts';
import { createCodexCapabilityStore } from '../../../lib/agent-clients/adapters/codex-lifecycle/capability-store.ts';
import { computeLifecycleBuildIdentity } from '../../../lib/agent-clients/adapters/codex-lifecycle/build-identity.ts';
import {
  contextFromControllerLease,
  writeCodexSandboxControllerContext
} from '../../../lib/agent-clients/adapters/codex-lifecycle/controller-context.ts';
import { getProcessStartTime } from '../../../lib/server/process-state.ts';
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
  cliVersion: '0.147.0', hookDefinitionHash: 'hook-hash', staticReady: true,
  discoveredHooks: [], hookProvenance, runtimeLiveness: false, diagnostics: []
} as const);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-orchestration-'));
  fixtureRoots.add(root);
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\ncurrent_step: requirement-analysis\n---\n\n# Task\n`);
  beginOrResumeOrchestration(taskId, { repoRoot: root, client: 'codex', modelPolicy: policy, id: () => 'run-1' });
  return { root, taskDir };
}

function capability(
  root: string,
  token: string,
  controller?: Readonly<{ instanceDigest: string; controlGeneration: string }>
) {
  const store = createCodexCapabilityStore({
    root: path.join(root, '.agents', 'workspace', '.runtime', 'codex-capabilities'),
    token: () => token
  });
  const armed = store.arm({ taskId, buildIdentity, ...(controller ? { controller } : {}) });
  store.attest({
    token: armed.token,
    sessionId: 'parent',
    turnId: 'parent-turn',
    toolUseId: 'capability-tool',
    hookDefinitionHash: 'hook-hash',
    buildIdentity,
    ...(controller ? { controller } : {})
  });
  return { store, token: armed.token };
}

test('Codex prepare consumes a controller-bound capability from the trusted broker binding', async () => {
  const f = fixture();
  const controller = { instanceDigest: 'e'.repeat(64), controlGeneration: 'generation-1' };
  const currentCapability = capability(f.root, 'broker-controller-token', controller);
  const previous = process.env.AGENT_INFRA_CONTROL_CONTROLLER_BINDING;
  process.env.AGENT_INFRA_CONTROL_CONTROLLER_BINDING = JSON.stringify(controller);
  try {
    const result = await prepareCodexOrchestrationDelegation(taskId, {
      client: 'codex',
      requestedModel: 'executor-model',
      requestedReasoningEffort: 'xhigh',
      capabilityToken: currentCapability.token
    }, {
      repoRoot: f.root,
      capabilityStore: currentCapability.store,
      buildIdentity,
      preflight,
      orchestrationOptions: { captureWorkspace: () => 'before', id: () => 'receipt-controller' }
    });
    assert.equal(result.status, 'running');
    assert.equal(result.run?.pendingDelegation?.lifecycleProvenance?.controllerInstanceDigest, controller.instanceDigest);
    assert.equal(result.run?.pendingDelegation?.lifecycleProvenance?.controlGeneration, controller.controlGeneration);
  } finally {
    if (previous === undefined) delete process.env.AGENT_INFRA_CONTROL_CONTROLLER_BINDING;
    else process.env.AGENT_INFRA_CONTROL_CONTROLLER_BINDING = previous;
  }
});

test('Codex prepare rejects mismatched broker and verified local controller bindings before consume', async () => {
  const f = fixture();
  const contractFiles = [
    '.codex/hooks.json',
    '.codex/agents/agent-infra-lifecycle-executor.toml',
    '.codex/agents/agent-infra-lifecycle-reviewer.toml',
    '.agents/hooks/lifecycle-delegation.js',
    '.agents/skills/run-task/SKILL.md',
    '.agents/rules/lifecycle-orchestration.md'
  ];
  for (const relative of contractFiles) {
    const file = path.join(f.root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${relative}\n`);
  }
  const realBuild = computeLifecycleBuildIdentity(f.root);
  const processStartTime = getProcessStartTime(process.pid);
  assert.ok(processStartTime);
  const profileFiles = contractFiles.slice(1, 3).map((relative) => path.join(f.root, relative)).sort();
  const profileHash = crypto.createHash('sha256');
  for (const file of profileFiles) {
    profileHash.update(path.basename(file));
    profileHash.update('\0');
    profileHash.update(fs.readFileSync(file));
    profileHash.update('\0');
  }
  const contextPath = path.join(f.root, 'controller-context.json');
  writeCodexSandboxControllerContext(contextPath, contextFromControllerLease({
    version: 1,
    leaseId: '7'.repeat(64),
    leaseSecret: '8'.repeat(64),
    taskId,
    controlGeneration: 'local-generation',
    controllerInstanceDigest: 'e'.repeat(64),
    controllerProcess: { pid: process.pid, startTime: processStartTime },
    buildIdentity: realBuild,
    issuedAt: Date.now() - 1_000,
    expiresAt: Date.now() + 60_000
  }, {
    hookDefinitionHash: crypto.createHash('sha256').update(fs.readFileSync(path.join(f.root, '.codex', 'hooks.json'))).digest('hex'),
    lifecycleProfilesHash: profileHash.digest('hex')
  }));
  const currentCapability = capability(f.root, 'dual-controller-token');
  const previousContext = process.env.AGENT_INFRA_CODEX_CONTROLLER_CONTEXT;
  const previousBinding = process.env.AGENT_INFRA_CONTROL_CONTROLLER_BINDING;
  const previousGeneration = process.env.AGENT_INFRA_CONTROL_GENERATION;
  process.env.AGENT_INFRA_CODEX_CONTROLLER_CONTEXT = contextPath;
  process.env.AGENT_INFRA_CONTROL_GENERATION = 'local-generation';
  process.env.AGENT_INFRA_CONTROL_CONTROLLER_BINDING = JSON.stringify({
    instanceDigest: 'f'.repeat(64),
    controlGeneration: 'broker-generation'
  });
  try {
    const result = await prepareCodexOrchestrationDelegation(taskId, {
      client: 'codex', capabilityToken: currentCapability.token
    }, {
      repoRoot: f.root,
      capabilityStore: currentCapability.store,
      buildIdentity,
      preflight,
      orchestrationOptions: { captureWorkspace: () => { throw new Error('workspace must not be captured'); } }
    });
    assert.equal(result.error?.code, 'CODEX_SANDBOX_CONTROLLER_BINDING_MISMATCH');
    assert.equal(currentCapability.store.inspect(currentCapability.token).status, 'attested');
    assert.equal(readRun(f.taskDir)?.pendingDelegation, null);
  } finally {
    if (previousContext === undefined) delete process.env.AGENT_INFRA_CODEX_CONTROLLER_CONTEXT;
    else process.env.AGENT_INFRA_CODEX_CONTROLLER_CONTEXT = previousContext;
    if (previousBinding === undefined) delete process.env.AGENT_INFRA_CONTROL_CONTROLLER_BINDING;
    else process.env.AGENT_INFRA_CONTROL_CONTROLLER_BINDING = previousBinding;
    if (previousGeneration === undefined) delete process.env.AGENT_INFRA_CONTROL_GENERATION;
    else process.env.AGENT_INFRA_CONTROL_GENERATION = previousGeneration;
  }
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

test('Codex prepare preserves safe provenance detail from capability consume', async () => {
  const f = fixture();
  const currentCapability = capability(f.root, 'capability-detail-token');
  let captures = 0;
  const result = await prepareCodexOrchestrationDelegation(taskId, {
    client: 'codex', requestedModel: 'executor-model', requestedReasoningEffort: 'xhigh',
    capabilityToken: currentCapability.token
  }, {
    repoRoot: f.root,
    capabilityStore: currentCapability.store,
    buildIdentity: { ...buildIdentity, packageVersion: '0.9.8-alpha.0' },
    preflight: async () => ({
      ...(await preflight()),
      hookDefinitionHash: 'd'.repeat(64)
    }),
    orchestrationOptions: { captureWorkspace: () => { captures += 1; return 'before'; } }
  });

  assert.equal(result.error?.code, 'CODEX_CAPABILITY_PROVENANCE_MISMATCH');
  assert.equal(result.error?.message, 'CODEX_CAPABILITY_PROVENANCE_MISMATCH: capability consumption identity does not match');
  assert.equal(JSON.stringify(result.error?.detail).includes('capability-detail-token'), false);
  assert.equal(result.error?.detail?.kind, 'codex-capability-provenance-mismatch');
  assert.equal(result.error?.detail?.version, 1);
  assert.equal(result.error?.detail?.fields.buildIdentity.packageVersion.matches, false);
  assert.equal(result.error?.detail?.fields.hookDefinitionHash.matches, false);
  assert.equal(captures, 0);
  assert.equal(readRun(f.taskDir)?.pendingDelegation, null);
  assert.equal(readRun(f.taskDir)?.baseline, '');
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
  const currentCapability = capability(f.root, 'capability-token-one');
  const prepared = await prepareCodexOrchestrationDelegation(taskId, {
    client: 'codex', requestedModel: 'executor-model', requestedReasoningEffort: 'xhigh',
    capabilityToken: currentCapability.token
  }, {
    repoRoot: f.root,
    capabilityStore: currentCapability.store,
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
    requestedReasoningEffort: 'xhigh', hookDefinitionHash: 'hook-hash'
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
  assert.deepEqual(started.run?.pendingDelegation?.lifecycleProvenance, {
    ...buildIdentity,
    hookDefinitionHash: 'hook-hash',
    ...hookProvenance,
    capabilitySessionId: 'parent',
    capabilityTurnId: 'parent-turn',
    capabilityToolUseId: 'capability-tool',
    controllerInstanceDigest: null,
    controlGeneration: null
  });
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
  const currentCapability = capability(f.root, 'capability-token-two');
  await prepareCodexOrchestrationDelegation(taskId, {
    client: 'codex', requestedModel: 'executor-model', requestedReasoningEffort: 'xhigh',
    capabilityToken: currentCapability.token
  }, {
    repoRoot: f.root,
    buildIdentity,
    capabilityStore: currentCapability.store,
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
    requestedReasoningEffort: 'xhigh', hookDefinitionHash: 'hook-hash'
  });
  const rollout = path.join(f.root, 'rollout-parent.jsonl');
  fs.writeFileSync(rollout, [
    JSON.stringify({ type: 'response_item', payload: {
      type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', call_id: 'spawn-tool',
      arguments: JSON.stringify({ agent_type: 'agent-infra-lifecycle-executor', task_name: 'analysis_executor_r1', model: 'executor-model', reasoning_effort: 'xhigh' })
    } }),
    JSON.stringify({ type: 'event_msg', payload: {
      type: 'sub_agent_activity', event_id: 'spawn-tool', kind: 'started',
      agent_thread_id: 'child', agent_path: '/root/analysis_executor_r1'
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
