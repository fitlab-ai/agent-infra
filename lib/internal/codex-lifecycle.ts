import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  preflightCodexLifecycleEvidence,
  resolveCodexTerminal,
  resolveCodexThread
} from '../agent-clients/adapters/codex-lifecycle/app-server.ts';
import { createCodexLifecycleStore } from '../agent-clients/adapters/codex-lifecycle/store.ts';
import { createCodexCapabilityStore } from '../agent-clients/adapters/codex-lifecycle/capability-store.ts';
import { requestCodexCapabilityAttestation } from '../sandbox/control/client.ts';
import { controllerProofFromContext } from '../agent-clients/adapters/codex-lifecycle/controller-context.ts';
import { computeLifecycleBuildIdentity } from '../agent-clients/adapters/codex-lifecycle/build-identity.ts';
import { verifyCodexSandboxControllerContextWithWarnings } from '../agent-clients/adapters/codex-lifecycle/sandbox-controller.ts';
import type { CodexLifecycleEvent } from '../agent-clients/adapters/codex-lifecycle/evidence.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { resolveTaskContext } from '../task/resolve-ref.ts';
import { hasSealableOrchestrationDelegation, readRun } from '../task/orchestration.ts';
import {
  parseCodexLifecycleBinding,
  resolveCodexLifecycleStoreRoot,
  verifyCodexLifecycleTaskBinding
} from '../agent-clients/adapters/codex-lifecycle/binding.ts';
import type { CodexLifecycleTaskBinding } from '../agent-clients/adapters/codex-lifecycle/binding.ts';
import {
  activateCodexOrchestrationDelegation,
  activateCodexSpawnDelegation,
  reconcileCodexOrchestrationDelegation,
  sealCodexOrchestrationDelegation,
  sealCodexParentDelegation
} from '../task/codex-orchestration.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = 'Usage: agent-infra-internal codex-lifecycle <capability-arm|hook-event|resolve-start|resolve-stop|preflight|consume> [options]\n';
const MANAGED_AGENT = /^agent-infra-lifecycle-(executor|reviewer)$/;

type Parsed = Readonly<{ operation: string; values: Readonly<Record<string, string>> }>;
type UnresolvedHookChild = Omit<Extract<CodexLifecycleEvent, { type: 'hook-child' }>, 'parentThreadId'>;

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function failure(code: string, message: string): void {
  output({ status: 'failed', changed: false, evidence: null, diagnostics: [], error: { code, message } });
  process.exitCode = 1;
}

function outputBridgeResult(result: Awaited<ReturnType<typeof activateCodexOrchestrationDelegation>>): void {
  if (result.error?.code === 'ORCHESTRATION_DELEGATION_MISSING') {
    output({ status: 'ignored', changed: false, evidence: null, diagnostics: [], error: null });
    return;
  }
  output(result);
  if (result.status !== 'running') process.exitCode = 1;
}

function parse(args: string[]): Parsed | null {
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    return null;
  }
  const operation = args[0];
  if (!operation) {
    failure('CODEX_LIFECYCLE_PAYLOAD_INVALID', 'operation is required');
    return null;
  }
  const allowed = {
    'capability-arm': ['--task-id'],
    'hook-event': ['--event', '--bridge'],
    'resolve-start': ['--child-id'],
    'resolve-stop': ['--child-id'],
    preflight: ['--format', '--session-id', '--turn-id', '--tool-use-id'],
    consume: ['--child-id', '--consumer']
  }[operation];
  if (!allowed) {
    failure('CODEX_LIFECYCLE_PAYLOAD_INVALID', 'unknown operation');
    return null;
  }
  const values: Record<string, string> = {};
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!allowed.includes(flag) || Object.hasOwn(values, flag)) {
      failure('CODEX_LIFECYCLE_PAYLOAD_INVALID', `invalid or duplicate option '${flag}'`);
      return null;
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) {
      failure('CODEX_LIFECYCLE_PAYLOAD_INVALID', `option '${flag}' requires a value`);
      return null;
    }
    values[flag] = value;
  }
  return Object.freeze({ operation, values: Object.freeze(values) });
}

function cliVersion(): string {
  const result = spawnSync('codex', ['--version'], { encoding: 'utf8' });
  const version = /codex-cli\s+(\d+\.\d+\.\d+)/.exec(result.stdout ?? '')?.[1];
  if (result.status !== 0 || !version) throw new Error('Codex CLI version is unavailable');
  return version;
}

function hookDefinitionHash(): string {
  const file = path.join(process.cwd(), '.codex', 'hooks.json');
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function controllerBinding(taskId: string) {
  if (process.env.AGENT_INFRA_TASK_ID && process.env.AGENT_INFRA_TASK_ID !== taskId) {
    throw new Error('CODEX_LIFECYCLE_TASK_CONTEXT_MISMATCH: sandbox task view does not match lifecycle binding');
  }
  const contextPath = process.env.AGENT_INFRA_CODEX_CONTROLLER_CONTEXT;
  if (!contextPath) return undefined;
  const context = verifyCodexSandboxControllerContextWithWarnings(contextPath, { repoRoot: process.cwd() }).context;
  if (context.taskId !== taskId) throw new Error('CODEX_LIFECYCLE_TASK_CONTEXT_MISMATCH: controller task does not match lifecycle binding');
  return {
    instanceDigest: context.controllerInstanceDigest,
    controlGeneration: context.controlGeneration
  };
}

function resolveLifecycleTaskContext(expectedTaskId?: string) {
  const controllerPath = process.env.AGENT_INFRA_CODEX_CONTROLLER_CONTEXT;
  const taskId = controllerPath
    ? verifyCodexSandboxControllerContextWithWarnings(controllerPath, { repoRoot: process.cwd() }).context.taskId
    : process.env.AGENT_INFRA_TASK_ID;
  const context = taskId
    ? resolveTaskRef(taskId, { repoRoot: process.cwd() })
    : resolveTaskContext(undefined, { repoRoot: process.cwd() });
  if (!context.ok) throw new Error(`${context.code}: ${context.message}`);
  if (expectedTaskId && context.taskId !== expectedTaskId) {
    throw new Error('CODEX_LIFECYCLE_TASK_CONTEXT_MISMATCH: task context does not match lifecycle binding');
  }
  return context;
}

function verifyPendingBinding(
  binding: CodexLifecycleTaskBinding,
  nativeAgent: string,
  expected: Readonly<{ requestedModel?: string; requestedReasoningEffort?: string }> = {}
) {
  const resolved = resolveLifecycleTaskContext(binding.taskId);
  const run = readRun(resolved.taskDir);
  if (!run) throw new Error('Codex lifecycle task binding has no current orchestration run');
  verifyCodexLifecycleTaskBinding(binding, run, nativeAgent, expected);
  return { resolved, run };
}

function verifyStoredBinding(
  taskId: string,
  binding: CodexLifecycleTaskBinding,
  nativeAgent: string
): void {
  const resolved = resolveTaskRef(taskId, { repoRoot: process.cwd() });
  if (!resolved.ok) throw new Error(`${resolved.code}: ${resolved.message}`);
  const run = readRun(resolved.taskDir);
  const receipt = run?.pendingDelegation;
  if (!receipt || run?.status !== 'running'
    || receipt.id !== binding.receiptId
    || receipt.taskId !== binding.taskId
    || receipt.runId !== binding.runId
    || receipt.client !== 'codex'
    || receipt.role !== nativeRole(nativeAgent)) {
    throw new Error('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH: stored task receipt is not the current pending lifecycle event');
  }
}

function sameTaskBinding(left: CodexLifecycleTaskBinding | null | undefined, right: CodexLifecycleTaskBinding): boolean {
  return left?.taskId === right.taskId && left.runId === right.runId && left.receiptId === right.receiptId;
}

function nativeRole(nativeAgent: string): string | null {
  const match = /^agent-infra-lifecycle-(executor|reviewer)$/u.exec(nativeAgent);
  return match?.[1] ?? null;
}

function taskScopedStore(taskId: string) {
  return createCodexLifecycleStore({
    root: resolveCodexLifecycleStoreRoot(taskId, { repoRoot: process.cwd() }),
    taskId,
    cliVersion: cliVersion()
  });
}

async function readStdin(): Promise<unknown> {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 64 * 1024) throw new Error('Codex lifecycle input exceeds 64 KiB');
  }
  return JSON.parse(input || '{}') as unknown;
}

function recordFromPayload(phase: string, payload: unknown, taskBinding?: CodexLifecycleTaskBinding): CodexLifecycleEvent | UnresolvedHookChild | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Codex lifecycle hook payload must be an object');
  }
  const value = payload as Record<string, unknown>;
  const text = (key: string) => typeof value[key] === 'string' ? value[key] as string : '';
  if (!MANAGED_AGENT.test(text('nativeAgent'))) return null;
  if (phase === 'pre-tool') return {
    type: 'hook-spawn',
    sessionId: text('sessionId'),
    turnId: text('turnId'),
    toolUseId: text('toolUseId'),
    nativeAgent: text('nativeAgent'),
    ...(text('requestedModel') ? { requestedModel: text('requestedModel') } : {}),
    ...(text('requestedReasoningEffort') ? { requestedReasoningEffort: text('requestedReasoningEffort') } : {}),
    hookDefinitionHash: text('hookDefinitionHash'),
    ...(taskBinding ? { taskBinding } : {})
  };
  if (phase === 'subagent-start') return {
    type: 'hook-child',
    sessionId: text('sessionId'),
    turnId: text('turnId'),
    childThreadId: text('childThreadId'),
    nativeAgent: text('nativeAgent'),
    source: 'hook'
  };
  if (phase === 'subagent-stop') return {
    type: 'hook-stop',
    sessionId: text('sessionId'),
    turnId: text('turnId'),
    childThreadId: text('childThreadId'),
    nativeAgent: text('nativeAgent')
  };
  if (phase === 'post-tool') return null;
  throw new Error(`unknown Codex lifecycle hook phase '${phase}'`);
}

function payloadText(payload: unknown, key: string): string {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    && typeof (payload as Record<string, unknown>)[key] === 'string'
    ? (payload as Record<string, string>)[key]!
    : '';
}

function resolveHookTaskContext(phase: string, toolName: string, payload: unknown) {
  const spawnName = payloadText(payload, 'taskName');
  const needsSpawnBinding = phase === 'pre-tool' || (phase === 'post-tool' && toolName === 'collaborationspawn_agent');
  const spawnBinding = needsSpawnBinding ? parseCodexLifecycleBinding(spawnName) : null;
  if (needsSpawnBinding && !spawnBinding) {
    throw new Error('CODEX_LIFECYCLE_TASK_BINDING_MISSING: task_name must carry the prepared task binding');
  }
  const nativeAgent = payloadText(payload, 'nativeAgent');
  const taskContext = spawnBinding
    ? verifyPendingBinding(spawnBinding.binding, nativeAgent, {
        requestedModel: payloadText(payload, 'requestedModel') || undefined,
        requestedReasoningEffort: payloadText(payload, 'requestedReasoningEffort') || undefined
      }).resolved
    : resolveLifecycleTaskContext();
  const store = taskScopedStore(taskContext.taskId);
  if (spawnBinding) verifyStoredBinding(taskContext.taskId, spawnBinding.binding, nativeAgent);
  return { spawnBinding, nativeAgent, taskContext, store };
}

function currentHookTaskBinding(
  taskDir: string,
  taskId: string,
  spawnBinding: ReturnType<typeof parseCodexLifecycleBinding>,
  nativeAgent: string
) {
  if (!spawnBinding) {
    const run = readRun(taskDir);
    const receipt = run?.pendingDelegation;
    if (!receipt || receipt.client !== 'codex' || receipt.role !== nativeRole(nativeAgent)) {
      throw new Error('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH: no matching pending task receipt');
    }
    verifyStoredBinding(taskId, { taskId: receipt.taskId, runId: receipt.runId, receiptId: receipt.id }, nativeAgent);
  }
  const receipt = readRun(taskDir)?.pendingDelegation;
  return receipt && { taskId: receipt.taskId, runId: receipt.runId, receiptId: receipt.id };
}

function validateHookStopIdentity(
  store: ReturnType<typeof taskScopedStore>,
  event: Extract<CodexLifecycleEvent, { type: 'hook-stop' }>,
  currentBinding: ReturnType<typeof currentHookTaskBinding>
): void {
  const record = store.read(event.childThreadId);
  const child = record.state.child;
  if (!currentBinding || !sameTaskBinding(record.taskBinding, currentBinding)
    || !child
    || child.sessionId !== event.sessionId
    || child.turnId !== event.turnId
    || child.childThreadId !== event.childThreadId
    || child.nativeAgent !== event.nativeAgent) {
    throw new Error('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH: stop event does not match the current task receipt and child');
  }
}

function matchingHookChildSpawns(
  store: ReturnType<typeof taskScopedStore>,
  binding: ReturnType<typeof currentHookTaskBinding>,
  event: UnresolvedHookChild
) {
  return binding ? store.findByTaskBinding(binding).filter((record) =>
    record.state.spawn?.sessionId === event.sessionId
    && record.state.spawn?.nativeAgent === event.nativeAgent
  ) : [];
}

async function applyHookChildEvent(
  event: UnresolvedHookChild,
  currentBinding: NonNullable<ReturnType<typeof currentHookTaskBinding>>,
  taskContext: ReturnType<typeof resolveLifecycleTaskContext>,
  store: ReturnType<typeof taskScopedStore>,
  bridge: boolean,
  resolved?: Awaited<ReturnType<typeof resolveCodexThread>>
): Promise<void> {
  const candidates = matchingHookChildSpawns(store, currentBinding, event);
  if (candidates.length !== 1) {
    throw new Error('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH: child event has no unique spawn for the current task receipt');
  }
  const childResolution = resolved ?? await resolveCodexThread(event.childThreadId);
  verifyStoredBinding(taskContext.taskId, currentBinding, event.nativeAgent);
  const latestCandidates = matchingHookChildSpawns(store, currentBinding, event);
  if (latestCandidates.length !== 1 || latestCandidates[0]!.revision !== candidates[0]!.revision) {
    throw new Error('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH: task receipt spawn became ambiguous during child resolution');
  }
  if (childResolution.resolution.thread.childThreadId !== event.childThreadId
    || childResolution.resolution.thread.parentThreadId !== event.sessionId
    || childResolution.resolution.thread.nativeAgent !== event.nativeAgent) {
    throw new Error('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH: resolved child does not match the current spawn');
  }
  verifyStoredBinding(taskContext.taskId, currentBinding, event.nativeAgent);
  const spawn = latestCandidates[0]!.state.spawn;
  if (!spawn) throw new Error('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH: current spawn record is missing');
  const result = store.applyToSpawn({
    sessionId: spawn.sessionId, turnId: spawn.turnId, toolUseId: spawn.toolUseId, taskBinding: currentBinding
  }, { ...event, parentThreadId: childResolution.resolution.thread.parentThreadId }, latestCandidates[0]!.revision);
  if (bridge) {
    outputBridgeResult(await activateCodexOrchestrationDelegation(event.childThreadId, {
      store, orchestrationOptions: { repoRoot: process.cwd(), taskId: taskContext.taskId },
      resolveThread: async () => childResolution
    }));
    return;
  }
  output({ status: result.state.status, changed: true, evidence: result.state, diagnostics: childResolution.diagnostics, error: result.state.error });
  if (result.state.status === 'invalid') process.exitCode = 1;
}

async function attestCapabilityReference(payload: unknown): Promise<boolean> {
  const capabilityRef = payloadText(payload, 'capabilityRef');
  if (!capabilityRef) return false;
  const contextPath = process.env.AGENT_INFRA_CODEX_CONTROLLER_CONTEXT;
  if (contextPath) {
    const { context } = verifyCodexSandboxControllerContextWithWarnings(contextPath, { repoRoot: process.cwd() });
    if (context.taskId !== process.env.AGENT_INFRA_TASK_ID) {
      throw new Error('CODEX_LIFECYCLE_TASK_CONTEXT_MISMATCH: controller task does not match sandbox task');
    }
    const sessionId = payloadText(payload, 'sessionId');
    const turnId = payloadText(payload, 'turnId');
    const toolUseId = payloadText(payload, 'toolUseId');
    const hookHash = payloadText(payload, 'hookDefinitionHash');
    if (!sessionId || !turnId || !toolUseId || !hookHash) {
      throw new Error('CODEX_CAPABILITY_IDENTITY_INVALID: hook identity is incomplete');
    }
    const result = requestCodexCapabilityAttestation({
      controllerProof: controllerProofFromContext(context),
      taskId: context.taskId,
      attestationPrivateKey: context.attestationPrivateKey,
      attestation: [capabilityRef, sessionId, turnId, toolUseId, hookHash]
    });
    output({ status: result.status, changed: result.changed, evidence: result.evidence, diagnostics: [], error: null });
    return true;
  }
  if (process.env.AGENT_INFRA_TASK_ID && process.env.AGENT_INFRA_CONTROL_TOKEN) {
    throw new Error('CODEX_SANDBOX_CONTROLLER_CONTEXT_REQUIRED: capability attestation requires a verified controller');
  }
  const capabilityStore = createCodexCapabilityStore({ taskId: process.env.AGENT_INFRA_TASK_ID });
  const armed = capabilityStore.inspectReference(capabilityRef);
  const expectedTaskId = process.env.AGENT_INFRA_TASK_ID ?? resolveLifecycleTaskContext(armed.taskId).taskId;
  const capability = capabilityStore.attestByReference({
    capabilityRef,
    expectedTaskId,
    sessionId: payloadText(payload, 'sessionId'),
    turnId: payloadText(payload, 'turnId'),
    toolUseId: payloadText(payload, 'toolUseId'),
    hookDefinitionHash: payloadText(payload, 'hookDefinitionHash'),
    buildIdentity: computeLifecycleBuildIdentity(process.cwd()),
    controller: controllerBinding(armed.taskId)
  });
  output({
    status: capability.status, changed: true,
    evidence: {
      revision: capability.revision, sessionId: capability.sessionId, turnId: capability.turnId,
      toolUseId: capability.toolUseId, expiresAt: capability.expiresAt
    },
    diagnostics: [], error: null
  });
  return true;
}

async function handleBridgePostTool(
  toolName: string,
  payload: unknown,
  nativeAgent: string,
  taskId: string,
  store: ReturnType<typeof taskScopedStore>
): Promise<void> {
  const orchestrationOptions = { repoRoot: process.cwd(), taskId };
  if (toolName === 'collaborationspawn_agent') {
    if (!MANAGED_AGENT.test(nativeAgent)) {
      output({ status: 'ignored', changed: false, evidence: null, diagnostics: [], error: null });
      return;
    }
    const requestedModel = payloadText(payload, 'requestedModel');
    const requestedReasoningEffort = payloadText(payload, 'requestedReasoningEffort');
    const bridged = await activateCodexSpawnDelegation({
      sessionId: payloadText(payload, 'sessionId'), turnId: payloadText(payload, 'turnId'),
      toolUseId: payloadText(payload, 'toolUseId'), transcriptPath: payloadText(payload, 'transcriptPath'),
      nativeAgent, taskName: payloadText(payload, 'taskName'),
      ...(requestedModel ? { requestedModel } : {}),
      ...(requestedReasoningEffort ? { requestedReasoningEffort } : {})
    }, { store, orchestrationOptions });
    outputBridgeResult(bridged);
    return;
  }
  if (toolName === 'collaborationwait_agent') {
    outputBridgeResult(await sealCodexParentDelegation(payloadText(payload, 'sessionId'), { store, orchestrationOptions }));
    return;
  }
  output({ status: 'ignored', changed: false, evidence: null, diagnostics: [], error: null });
}

async function sealConsumedHookStop(
  event: Extract<CodexLifecycleEvent, { type: 'hook-stop' }>,
  store: ReturnType<typeof taskScopedStore>,
  taskId: string
): Promise<void> {
  const result = await sealCodexOrchestrationDelegation(event.childThreadId, {
    store, orchestrationOptions: { repoRoot: process.cwd(), taskId }
  });
  outputBridgeResult(result);
}

function handleMissingHookEvent(phase: string, bridge: boolean, payload: unknown, taskId: string): void {
  if (phase === 'post-tool' && bridge) {
    const value = payload as Record<string, unknown>;
    outputBridgeResult(reconcileCodexOrchestrationDelegation(String(value.childThreadId ?? ''), {
      orchestrationOptions: { repoRoot: process.cwd(), taskId }
    }));
    return;
  }
  output({ status: 'ignored', changed: false, evidence: null, diagnostics: [], error: null });
}

async function handlePreflight(parsed: Parsed): Promise<void> {
  const format = parsed.values['--format'] ?? 'json';
  if (!['text', 'json'].includes(format)) throw new Error("format must be 'text' or 'json'");
  const runtimeFields = [parsed.values['--session-id'], parsed.values['--turn-id'], parsed.values['--tool-use-id']];
  if (runtimeFields.some(Boolean) && !runtimeFields.every(Boolean)) {
    throw new Error('preflight runtime identity requires --session-id, --turn-id, and --tool-use-id together');
  }
  const runtimeIdentity = runtimeFields.every(Boolean)
    ? { sessionId: runtimeFields[0]!, turnId: runtimeFields[1]!, toolUseId: runtimeFields[2]! }
    : undefined;
  const result = await preflightCodexLifecycleEvidence(process.cwd(), runtimeIdentity);
  if (format === 'text') {
    process.stdout.write(`Codex lifecycle static preflight: ready\nCLI: ${result.cliVersion}\nRuntime hook liveness: ${result.runtimeLiveness ? 'observed' : 'not-yet-observed'}\n`);
  } else output({ status: 'ready', changed: false, evidence: result, diagnostics: result.diagnostics, error: null });
}

function armCapability(parsed: Parsed): void {
  const taskId = parsed.values['--task-id'];
  if (!taskId) throw new Error('capability-arm requires --task-id');
  const resolved = resolveTaskRef(taskId, { repoRoot: process.cwd() });
  if (!resolved.ok) throw new Error(`${resolved.code}: ${resolved.message}`);
  const armed = createCodexCapabilityStore({ taskId: resolved.taskId }).arm({
    taskId: resolved.taskId, buildIdentity: computeLifecycleBuildIdentity(process.cwd()),
    controller: controllerBinding(resolved.taskId)
  });
  output({
    status: 'armed', changed: true, capabilityRef: armed.capabilityRef, marker: armed.marker,
    expiresAt: armed.expiresAt, buildIdentity: armed.buildIdentity, error: null
  });
}

async function codexLifecycle(args: string[] = []): Promise<void> {
  if (!ensureInternalHandlerRoute('codex-lifecycle', args)) return;
  const parsed = parse(args);
  if (!parsed || process.exitCode) return;
  try {
    if (internalHandlerRoute('codex-lifecycle', 'preflight', parsed.operation)) {
      await handlePreflight(parsed);
      return;
    }

    if (internalHandlerRoute('codex-lifecycle', 'capability-arm', parsed.operation)) {
      armCapability(parsed);
      return;
    }

    if (internalHandlerRoute('codex-lifecycle', 'hook-event', parsed.operation)) {
      const phase = parsed.values['--event'];
      if (!phase || !['pre-tool', 'subagent-start', 'post-tool', 'subagent-stop'].includes(phase)) {
        throw new Error('hook-event requires a known --event');
      }
      if (parsed.values['--bridge'] !== undefined && parsed.values['--bridge'] !== 'true') {
        throw new Error("hook-event --bridge must be 'true'");
      }
      const payload = await readStdin();
      if (phase === 'post-tool' && await attestCapabilityReference(payload)) return;
      const toolName = payloadText(payload, 'toolName');
      const hookContext = resolveHookTaskContext(phase, toolName, payload);
      const { spawnBinding, nativeAgent, taskContext, store } = hookContext;
      if (phase === 'post-tool' && parsed.values['--bridge'] === 'true') {
        await handleBridgePostTool(toolName, payload, nativeAgent, taskContext.taskId, store);
        return;
      }
      const event = recordFromPayload(phase, payload, spawnBinding?.binding);
      if (!event) {
        handleMissingHookEvent(phase, parsed.values['--bridge'] === 'true', payload, taskContext.taskId);
        return;
      }
      const currentBinding = currentHookTaskBinding(taskContext.taskDir, taskContext.taskId, spawnBinding, nativeAgent);
      if (event.type === 'hook-stop') {
        validateHookStopIdentity(store, event, currentBinding);
      }
      if (parsed.values['--bridge'] === 'true' && event.type === 'hook-stop'
        && store.read(event.childThreadId).consumer) {
        await sealConsumedHookStop(event, store, taskContext.taskId);
        return;
      }
      if (event.type === 'hook-child') {
        await applyHookChildEvent(event, currentBinding!, taskContext, store, parsed.values['--bridge'] === 'true');
        return;
      }
      if (!currentBinding) throw new Error('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH: current task receipt is missing');
      verifyStoredBinding(taskContext.taskId, currentBinding, nativeAgent);
      const result = store.apply(event);
      if (parsed.values['--bridge'] === 'true' && event.type === 'hook-stop') {
        if (!hasSealableOrchestrationDelegation('codex', event.childThreadId, { repoRoot: process.cwd(), taskId: taskContext.taskId })) {
          output({ status: 'ignored', changed: false, evidence: null, diagnostics: [], error: null });
          return;
        }
        output({
          status: result.state.status,
          changed: true,
          evidence: result.state,
          diagnostics: [],
          error: result.state.error
        });
        return;
      }
      output({ status: result.state.status, changed: true, evidence: result.state, diagnostics: [], error: result.state.error });
      if (result.state.status === 'invalid') process.exitCode = 1;
      return;
    }

    const childThreadId = parsed.values['--child-id'];
    if (!childThreadId) throw new Error(`operation '${parsed.operation}' requires --child-id`);
    const taskContext = resolveLifecycleTaskContext();
    const store = taskScopedStore(taskContext.taskId);
    const existing = store.read(childThreadId);
    if (!existing.taskBinding) throw new Error('CODEX_LIFECYCLE_TASK_BINDING_MISSING: stored lifecycle identity has no task binding');
    verifyStoredBinding(
      taskContext.taskId,
      existing.taskBinding,
      existing.state.startEvidence?.nativeAgent ?? existing.state.spawn?.nativeAgent ?? ''
    );
    if (internalHandlerRoute('codex-lifecycle', 'resolve-start', parsed.operation)) {
      if (store.read(childThreadId).state.spawn?.hookDefinitionHash !== hookDefinitionHash()) {
        throw new Error('Codex lifecycle hook definition hash is stale');
      }
      const resolved = await resolveCodexThread(childThreadId);
      verifyStoredBinding(taskContext.taskId, existing.taskBinding, existing.state.startEvidence?.nativeAgent ?? existing.state.spawn?.nativeAgent ?? '');
      let latest = store.apply(resolved.resolution.thread);
      for (const reroute of resolved.reroutes) latest = store.apply(reroute);
      latest = store.apply(resolved.resolution.settings);
      output({ status: latest.state.status, changed: true, evidence: latest.state.startEvidence, diagnostics: resolved.diagnostics, error: latest.state.error });
      if (latest.state.status !== 'start-ready') process.exitCode = 1;
      return;
    }
    if (internalHandlerRoute('codex-lifecycle', 'resolve-stop', parsed.operation)) {
      const stopTurnId = store.read(childThreadId).state.stop?.turnId;
      if (!stopTurnId) throw new Error('Codex lifecycle stop hook is not available');
      const terminal = await resolveCodexTerminal(childThreadId, stopTurnId);
      verifyStoredBinding(taskContext.taskId, existing.taskBinding, existing.state.startEvidence?.nativeAgent ?? existing.state.spawn?.nativeAgent ?? '');
      const latest = store.apply(terminal);
      if (latest.state.status !== 'stop-ready') {
        throw new Error(`Codex lifecycle stop evidence is not ready (status=${latest.state.status})`);
      }
      output({ status: latest.state.status, changed: true, evidence: latest.state.stopEvidence, diagnostics: [], error: latest.state.error });
      return;
    }
    if (internalHandlerRoute('codex-lifecycle', 'consume', parsed.operation)) {
      const consumer = parsed.values['--consumer'];
      if (!consumer) throw new Error('consume requires --consumer');
      verifyStoredBinding(taskContext.taskId, existing.taskBinding, existing.state.startEvidence?.nativeAgent ?? existing.state.spawn?.nativeAgent ?? '');
      const consumed = store.consume(childThreadId, consumer, hookDefinitionHash());
      output({ status: 'consumed', changed: true, evidence: {
        start: consumed.state.startEvidence,
        stop: consumed.state.stopEvidence
      }, diagnostics: [], error: null });
    }
  } catch (error) {
    failure('CODEX_LIFECYCLE_FAILED', error instanceof Error ? error.message : String(error));
  }
}

export { codexLifecycle };
