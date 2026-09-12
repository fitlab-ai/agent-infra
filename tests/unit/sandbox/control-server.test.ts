import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCodexLifecycleStore } from '../../../lib/agent-clients/adapters/codex-lifecycle/store.ts';
import { activateOrchestrationDelegation, beginOrResumeOrchestration, dispatchOrchestrationDelegation, prepareOrchestrationDelegation, readRun } from '../../../lib/task/orchestration.ts';
import { recoverStartedLifecycleUnderLock } from '../../../lib/task/lifecycle-recovery.ts';
import { withTaskExecutionLock } from '../../../lib/task/task-execution-lock.ts';
import { genericRecoveryResponse, recoveryResponse } from '../../../lib/sandbox/control/server.ts';
import type { SandboxControlManifest, SandboxControlRecoveryWarning, SandboxControlRequest, SandboxControlResultEvidence } from '../../../lib/sandbox/control/protocol.ts';
import { createSandboxControlTerminalResult } from '../../../lib/sandbox/control/state.ts';
import { writeSandboxControlTransition } from '../../../lib/sandbox/control/audit.ts';

const TASK_ID = 'TASK-20260101-000001';
const RECOVERY_REASON = 'native child terminated before result was known';
const MODEL_POLICY = {
  executor: { model: 'executor-model', reasoningEffort: 'high' },
  reviewer: { model: 'reviewer-model', reasoningEffort: 'high' }
} as const;
const PROVENANCE = {
  protocolVersion: 3,
  packageVersion: '0.9.16-alpha.0',
  internalExecutableBuildHash: 'a'.repeat(64),
  lifecycleContractHash: 'b'.repeat(64),
  hookDefinitionHash: 'hook-hash',
  hookSource: 'project' as const,
  hookSourcePathDigest: 'c'.repeat(64),
  hookSourceHash: 'd'.repeat(64),
  capabilitySessionId: 'parent',
  capabilityTurnId: 'parent-turn',
  capabilityToolUseId: 'capability-tool',
  controllerInstanceDigest: 'e'.repeat(64),
  controlGeneration: 'generation-1'
} as const;

function recoveryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-control-server-recovery-'));
  const taskDir = path.join(root, '.agents', 'workspace', 'active', TASK_ID);
  const runtimeRoot = path.join(root, '.agents', 'workspace', '.runtime', 'codex-lifecycle');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${TASK_ID}\nstatus: active\ncurrent_step: requirement-analysis\nassigned_to: codex\nupdated_at: old\nagent_infra_version: v0.9.16-alpha.0\n---\n\n# Task\n\n## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n\n## Activity Log\n`);
  const store = createCodexLifecycleStore({ root: runtimeRoot, cliVersion: '0.147.0', now: () => '2026-01-01T00:00:00.200Z' });
  store.apply({ type: 'hook-spawn', sessionId: 'parent', turnId: 'parent-turn', toolUseId: 'spawn-tool', nativeAgent: 'agent-infra-lifecycle-executor', hookDefinitionHash: 'hook-hash', requestedModel: 'executor-model', requestedReasoningEffort: 'high' });
  store.apply({ type: 'hook-child', sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child', parentThreadId: 'parent', nativeAgent: 'agent-infra-lifecycle-executor' });
  store.apply({ type: 'app-thread', childThreadId: 'child', parentThreadId: 'parent', forkedFromId: null, sourceParentThreadId: 'parent', nativeAgent: 'agent-infra-lifecycle-executor' });
  store.apply({ type: 'app-settings', childThreadId: 'child', model: 'executor-model', reasoningEffort: 'high' });
  store.apply({ type: 'app-terminal', childThreadId: 'child', turnId: 'child-turn', status: 'completed' });
  store.apply({ type: 'hook-stop', sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child', nativeAgent: 'agent-infra-lifecycle-executor' });
  assert.equal(beginOrResumeOrchestration(TASK_ID, { repoRoot: root, client: 'codex', modelPolicy: MODEL_POLICY, id: () => 'run-1', now: () => '2026-01-01T00:00:00.000Z' }).status, 'running');
  assert.equal(prepareOrchestrationDelegation(TASK_ID, { client: 'codex', requestedModel: 'executor-model', requestedReasoningEffort: 'high', lifecycleProvenance: PROVENANCE }, { repoRoot: root, supportsLifecycleDelegation: () => true, captureWorkspace: () => 'before-tree', id: () => 'receipt-1', now: () => '2026-01-01T00:00:00.100Z', monotonicNow: () => 10 }).status, 'running');
  assert.equal(dispatchOrchestrationDelegation(TASK_ID, { repoRoot: root, now: () => '2026-01-01T00:00:00.150Z', monotonicNow: () => 20 }).status, 'running');
  assert.equal(activateOrchestrationDelegation(TASK_ID, { nativeAgent: 'agent-infra-lifecycle-executor', childId: 'child', parentId: 'parent', spawnMode: 'fresh', actualModel: 'executor-model', actualReasoningEffort: 'high', hostEvidence: { kind: 'codex-lifecycle-v2', startRevision: 4, ...PROVENANCE, spawnToolUseId: 'spawn-tool', spawnObservedAt: '2026-01-01T00:00:00.200Z' } }, { repoRoot: root, now: () => '2026-01-01T00:00:00.300Z', monotonicNow: () => 30 }).status, 'running');
  fs.appendFileSync(path.join(taskDir, 'task.md'), `- 2026-01-01 00:00:00+00:00 — **Analyze Task (Round 1) [started]** by codex — started\n`);
  return { root, taskDir, store };
}

function recoveryManifest(f: ReturnType<typeof recoveryFixture>): SandboxControlManifest {
  const controlRoot = path.join(f.root, 'control');
  const channelDir = path.join(controlRoot, 'channel');
  const publicStatusDir = path.join(controlRoot, 'public');
  const processingDir = path.join(controlRoot, 'processing');
  for (const directory of [channelDir, publicStatusDir, processingDir]) fs.mkdirSync(directory, { recursive: true });
  return {
    engine: 'test', repoRoot: f.root, worktreeRoot: f.root, project: 'project', container: 'container',
    containerIdentity: { id: 'container-id', labels: {} }, authorityEvidence: {} as SandboxControlManifest['authorityEvidence'], branch: 'feature',
    mode: 'task-bound', taskId: TASK_ID, token: 'token', generation: 'generation-1', controlRootId: 'a'.repeat(96),
    channelDir, publicStatusDir, processingDir, runtimeDir: path.join(controlRoot, 'runtime')
  };
}

function recoveryRequest(id: string): SandboxControlRequest {
  return {
    version: 3, id, token: 'token', generation: 'generation-1', issuedAt: 1, expiresAt: 2,
    controllerProcess: null, controllerProof: null, family: 'task-lifecycle',
    args: [TASK_ID, 'recover-started', '--agent', 'codex', '--stage', 'analysis', '--round', '1', '--artifact', 'analysis.md', '--reason', RECOVERY_REASON]
  };
}

function resultEvidence(id: string): SandboxControlResultEvidence {
  const empty = crypto.createHash('sha256').update('').digest('hex');
  return { version: 1, id, generation: 'generation-1', exitCode: 0, stdoutBytes: 0, stderrBytes: 0, stdoutSha256: empty, stderrSha256: empty, captureState: 'metadata-only' };
}

function terminalFor(manifest: SandboxControlManifest, request: SandboxControlRequest, output: unknown) {
  return createSandboxControlTerminalResult(manifest, { id: request.id, family: request.family, operation: 'recover-started' }, JSON.stringify(output));
}

function commitPhases(manifest: SandboxControlManifest, requestId: string): void {
  writeSandboxControlTransition(manifest, { requestId, phase: 'completed' });
  writeSandboxControlTransition(manifest, { requestId, phase: 'evidence-written' });
  writeSandboxControlTransition(manifest, { requestId, phase: 'publish-authorized' });
}

test('server recovery response retains release retry warning when output payload is unavailable', () => {
  const request = {
    version: 3,
    id: 'a'.repeat(32),
    token: 'token',
    generation: 'generation-1',
    issuedAt: 1,
    expiresAt: 2,
    controllerProcess: null,
    controllerProof: null,
    family: 'task-lifecycle',
    args: ['TASK-20260904-002407', 'recover-started', '--agent', 'codex', '--stage', 'code', '--round', '1', '--artifact', 'code.md', '--reason', 'response loss']
  } as SandboxControlRequest;
  const warning: SandboxControlRecoveryWarning = {
    code: 'RECOVERY_RELEASE_RETRY_REQUIRED',
    message: 'protected claim could not be released',
    action: 'retry recover-started'
  };

  const response = genericRecoveryResponse(request, 0, null, 'recovery', warning);

  assert.equal(response.outputState, 'unavailable');
  assert.equal(response.stdout, '');
  assert.match(response.stderr, /RECOVERY_RELEASE_RETRY_REQUIRED/u);
  assert.match(response.stderr, /Action: retry recover-started/u);
});

test('server recovery wiring rebuilds consecutive release failures and converges after release', () => {
  const f = recoveryFixture();
  const manifest = recoveryManifest(f);
  const manifestPath = path.join(path.dirname(manifest.publicStatusDir), 'manifest.json');
  const request = recoveryRequest('b'.repeat(32));
  commitPhases(manifest, request.id);
  const recover = (releaseRecovery?: (child: string, consumer: string) => boolean) => withTaskExecutionLock(
    f.root,
    TASK_ID,
    'test.recover-started',
    () => recoverStartedLifecycleUnderLock(
      {
        taskRef: TASK_ID,
        intent: 'recover-started',
        agent: 'codex',
        stage: 'analysis',
        round: 1,
        artifact: 'analysis.md',
        reason: RECOVERY_REASON
      },
      { repoRoot: f.root, lifecycleStore: f.store, releaseRecovery }
    )
  );
  try {
    const first = recover(() => false);
    assert.equal(first.status, 'applied', JSON.stringify(first));
    const firstTerminal = terminalFor(manifest, request, first);
    const firstResponse = recoveryResponse(manifest, manifestPath, request, resultEvidence(request.id), null, firstTerminal);
    assert.ok(firstResponse);
    assert.match(firstResponse.stderr, /RECOVERY_RELEASE_RETRY_REQUIRED/u);
    assert.match(firstResponse.stderr, /Action: retry recover-started with the same selector and reason/u);

    const second = recover(() => false);
    assert.equal(second.status, 'applied', JSON.stringify(second));
    assert.equal(second.changed, false);
    const secondTerminal = terminalFor(manifest, request, second);
    const secondResponse = recoveryResponse(manifest, manifestPath, request, resultEvidence(request.id), null, secondTerminal);
    assert.ok(secondResponse);
    assert.equal(secondResponse.outputState, 'unavailable');
    assert.match(secondResponse.stderr, /RECOVERY_RELEASE_RETRY_REQUIRED/u);
    assert.match(secondResponse.stderr, /Action: retry recover-started with the same selector and reason/u);

    const released = recover((child, consumer) => f.store.releaseRecovery(child, consumer));
    assert.equal(released.status, 'applied', JSON.stringify(released));
    const releasedTerminal = terminalFor(manifest, request, released);
    const releasedResponse = recoveryResponse(manifest, manifestPath, request, resultEvidence(request.id), null, releasedTerminal);
    assert.ok(releasedResponse);
    assert.match(releasedResponse.stderr, /SANDBOX_CONTROL_OUTPUT_UNAVAILABLE/u);
    assert.doesNotMatch(releasedResponse.stderr, /RECOVERY_RELEASE_RETRY_REQUIRED/u);
    assert.equal(recover().status, 'no-op');
    assert.equal(readRun(f.taskDir)?.receipts.filter((receipt) => receipt.status === 'aborted').length, 1);
    assert.equal((fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8').match(/lifecycle-recovery:v1 /gu) ?? []).length, 1);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
