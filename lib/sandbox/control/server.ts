import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProcessStartTime } from '../../server/process-state.ts';
import { assertGitWorktreeBinding } from '../../git/worktree-identity.ts';
import {
  controlError,
  DEFAULT_SANDBOX_CONTROL_TIMING,
  type SandboxControlManifest,
  type SandboxControlRequest,
  type SandboxControlResponse,
  type SandboxControlTimingPolicy
} from './protocol.ts';
import { prepareSandboxControlExecution, type PreparedSandboxControlExecution, type SandboxControlExecutionResult } from './executor.ts';
import {
  appendSandboxControlAudit,
  atomicWriteJson,
  cleanupStaleSandboxControlLease,
  executionPath,
  readActiveLease,
  readExecution,
  terminateSandboxControlExecution,
  writeSandboxControlStatus
} from './state.ts';
import { validateSandboxControlRequest } from './protocol.ts';
import { inspectSandboxControlContainer, type ContainerObservation } from './container-identity.ts';
import {
  acquireSandboxControlBrokerStartup,
  garbageCollectSandboxControlRoot,
  isSandboxControlRootQuiescing,
  readSandboxControlManifest
} from './lifecycle.ts';
import type { BrokerOwner } from './lifecycle.ts';
import { nextSandboxControlBackoff } from './timing.ts';

type ActiveExecution = {
  request: SandboxControlRequest;
  prepared: PreparedSandboxControlExecution;
  result: SandboxControlExecutionResult | null;
  failure: unknown;
  settled: boolean;
};

function assertRealDirectory(directory: string, parent?: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('SANDBOX_CONTROL_CHANNEL_INVALID');
  if (parent && path.dirname(fs.realpathSync.native(directory)) !== fs.realpathSync.native(parent)) {
    throw new Error('SANDBOX_CONTROL_CHANNEL_INVALID');
  }
}

function responsePath(manifest: SandboxControlManifest, id: string): string {
  return path.join(manifest.channelDir, 'responses', `${id}.json`);
}

function writeResponse(manifest: SandboxControlManifest, response: SandboxControlResponse): void {
  atomicWriteJson(responsePath(manifest, response.id), response);
}

function rejected(id: string, error: unknown): SandboxControlResponse {
  const detail = controlError(error);
  return { version: 2, id, phase: 'rejected', exitCode: null, stdout: '', stderr: `${detail.message}\n`, error: detail };
}

function unknown(id: string): SandboxControlResponse {
  const error = {
    code: 'SANDBOX_CONTROL_RESULT_UNKNOWN',
    message: 'SANDBOX_CONTROL_RESULT_UNKNOWN: accepted execution ended without a provable result; inspect domain state before retrying',
    retryable: false
  };
  return { version: 2, id, phase: 'rejected', exitCode: null, stdout: '', stderr: `${error.message}\n`, error };
}

function notExecuted(id: string): SandboxControlResponse {
  const error = {
    code: 'SANDBOX_CONTROL_NOT_EXECUTED',
    message: 'SANDBOX_CONTROL_NOT_EXECUTED: request was claimed but never accepted; retry with a new request id',
    retryable: true
  };
  return { version: 2, id, phase: 'rejected', exitCode: null, stdout: '', stderr: `${error.message}\n`, error };
}

function consumeRequest(directory: string, id: string): void {
  try {
    fs.writeFileSync(path.join(directory, id), '', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('SANDBOX_CONTROL_REQUEST_REPLAYED');
    throw error;
  }
}

function claimRequest(manifest: SandboxControlManifest, requestPath: string, id: string): string {
  const directory = path.join(manifest.processingDir, id);
  fs.mkdirSync(directory, { mode: 0o700 });
  const claimed = path.join(directory, 'request.json');
  try {
    fs.renameSync(requestPath, claimed);
    return claimed;
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function bindingReason(manifest: SandboxControlManifest): string | null {
  try {
    assertGitWorktreeBinding(manifest.repoRoot, manifest.worktreeRoot, manifest.branch);
    return null;
  } catch {
    return 'SANDBOX_WORKTREE_BINDING_LOST';
  }
}

function recoverProcessing(manifest: SandboxControlManifest, brokerOwns: () => boolean): boolean {
  for (const entry of fs.readdirSync(manifest.processingDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{16,64}$/.test(entry.name)) continue;
    if (!brokerOwns()) return false;
    const descriptor = executionPath(manifest, entry.name);
    const existingResponse = responsePath(manifest, entry.name);
    if (fs.existsSync(descriptor)) {
      const execution = readExecution(descriptor);
      if (!terminateSandboxControlExecution(execution)) {
        throw new Error(`SANDBOX_CONTROL_EXECUTION_STILL_RUNNING: ${entry.name}`);
      }
      if (!brokerOwns()) return false;
      appendSandboxControlAudit(manifest, 'orphan-tree-terminated', { requestId: entry.name });
      let terminal = false;
      if (fs.existsSync(existingResponse)) {
        try {
          const response = JSON.parse(fs.readFileSync(existingResponse, 'utf8')) as SandboxControlResponse;
          terminal = response.version === 2 && response.id === entry.name
            && (response.phase === 'completed' || response.phase === 'rejected');
        } catch {
          terminal = false;
        }
      }
      if (!terminal) {
        if (!brokerOwns()) return false;
        writeResponse(manifest, unknown(entry.name));
      }
    } else {
      if (!brokerOwns()) return false;
      writeResponse(manifest, notExecuted(entry.name));
    }
    if (!brokerOwns()) return false;
    fs.rmSync(path.join(manifest.processingDir, entry.name), { recursive: true, force: true });
  }
  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sandboxControlSafeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.toUpperCase().startsWith('AGENT_INFRA_CONTROL_')));
}

export async function serveSandboxControl(
  manifestPath: string,
  signal: AbortSignal = new AbortController().signal,
  options: {
    timing?: SandboxControlTimingPolicy;
    inspectContainer?: (manifest: SandboxControlManifest) => Promise<ContainerObservation>;
    bindingCheck?: (manifest: SandboxControlManifest) => string | null;
  } = {}
): Promise<void> {
  const timing = options.timing ?? DEFAULT_SANDBOX_CONTROL_TIMING;
  const inspectContainer = options.inspectContainer ?? ((value: SandboxControlManifest) => inspectSandboxControlContainer(value));
  const bindingCheck = options.bindingCheck ?? bindingReason;
  const manifest = readSandboxControlManifest(manifestPath);
  const root = path.dirname(manifestPath);
  const startTime = getProcessStartTime(process.pid);
  if (!startTime) throw new Error('SANDBOX_CONTROL_BROKER_IDENTITY_UNAVAILABLE');
  const brokerId = randomUUID();
  const releaseStartup = await acquireSandboxControlBrokerStartup(root, { pid: process.pid, startTime, brokerId });
  const requestsDir = path.join(manifest.channelDir, 'requests');
  const responsesDir = path.join(manifest.channelDir, 'responses');
  const consumedDir = path.join(root, 'consumed');
  const broker: BrokerOwner = {
    version: 3,
    pid: process.pid,
    startTime,
    brokerId,
    token: manifest.token,
    generation: manifest.generation
  };
  const brokerPath = path.join(root, 'broker.json');
  const brokerRecord = `${JSON.stringify(broker)}\n`;
  const brokerOwns = (): boolean => {
    try {
      return fs.readFileSync(brokerPath, 'utf8') === brokerRecord;
    } catch {
      return false;
    }
  };
  try {
    for (const directory of [manifest.channelDir, requestsDir, responsesDir, consumedDir, manifest.publicStatusDir, manifest.processingDir]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    assertRealDirectory(manifest.channelDir);
    assertRealDirectory(requestsDir, manifest.channelDir);
    assertRealDirectory(responsesDir, manifest.channelDir);
    assertRealDirectory(consumedDir, root);
    assertRealDirectory(manifest.publicStatusDir, root);
    assertRealDirectory(manifest.processingDir, root);
    fs.writeFileSync(brokerPath, brokerRecord, { mode: 0o600, flag: 'wx' });
    if (isSandboxControlRootQuiescing(root)) {
      if (fs.readFileSync(brokerPath, 'utf8') === brokerRecord) fs.unlinkSync(brokerPath);
      return;
    }
  } finally {
    releaseStartup();
  }
  let active: ActiveExecution | null = null;
  let lastState = '';
  let lastStatusAt = 0;
  let nextBindingCheckAt = 0;
  let nextContainerHeartbeatAt = Date.now() + timing.containerHeartbeatMs;
  let containerReasonCode: string | null = null;
  let containerBackoffMs = timing.parkedBindingInitialMs;
  let bindingReasonCode: string | null = null;
  let bindingBackoffMs: number = timing.parkedBindingInitialMs;
  try {
    if (!brokerOwns()) return;
    writeSandboxControlStatus(manifest, broker, 'starting', null, null);
    if (!brokerOwns()) return;
    appendSandboxControlAudit(manifest, 'broker-start', { pid: broker.pid });
    if (!recoverProcessing(manifest, brokerOwns)) return;
    while (!signal.aborted) {
      let settledExecution: ActiveExecution | null = null;
      if (!brokerOwns()) break;
      let current: SandboxControlManifest;
      try {
        current = readSandboxControlManifest(manifestPath);
      } catch {
        break;
      }
      if (current.token !== manifest.token || current.generation !== manifest.generation) break;
      const heartbeatNow = Date.now();
      if (heartbeatNow >= nextContainerHeartbeatAt) {
        let observation: ContainerObservation;
        try {
          observation = await inspectContainer(manifest);
        } catch (error) {
          observation = { state: 'unknown', reason: controlError(error).code };
        }
        if (!brokerOwns()) break;
        if (observation.state === 'found') {
          containerReasonCode = null;
          containerBackoffMs = timing.parkedBindingInitialMs;
          nextContainerHeartbeatAt = Date.now() + timing.containerHeartbeatMs;
        } else if (observation.state === 'unknown') {
          containerReasonCode = 'SANDBOX_CONTROL_CONTAINER_UNKNOWN';
          appendSandboxControlAudit(manifest, 'container-heartbeat-unknown', { reason: observation.reason });
          const backoff = nextSandboxControlBackoff(containerBackoffMs, timing.slowCheckMs);
          nextContainerHeartbeatAt = Date.now() + backoff.delayMs;
          containerBackoffMs = backoff.nextDelayMs;
        } else {
          try {
            await garbageCollectSandboxControlRoot(root, {
              timeoutMs: timing.quiesceDeadlineMs,
              inspectContainer: (timeoutMs) => inspectContainer(manifest),
              selfOwner: broker
            });
            active = null;
            return;
          } catch (error) {
            if (!brokerOwns()) break;
            containerReasonCode = 'SANDBOX_CONTROL_CONTAINER_ABSENT_GC_FAILED';
            appendSandboxControlAudit(manifest, 'container-gc-failed', { reason: controlError(error).code });
            const backoff = nextSandboxControlBackoff(containerBackoffMs, timing.slowCheckMs);
            nextContainerHeartbeatAt = Date.now() + backoff.delayMs;
            containerBackoffMs = backoff.nextDelayMs;
          }
        }
      }

      if (active?.settled) {
        if (!brokerOwns()) break;
        settledExecution = active;
        active = null;
      }

      let reasonCode: string | null = null;
      try {
        if (!brokerOwns()) break;
        if (cleanupStaleSandboxControlLease(manifest)) {
          if (!brokerOwns()) break;
          appendSandboxControlAudit(manifest, 'lease-stale-cleanup');
        }
        if (readActiveLease(manifest)) reasonCode = 'SANDBOX_CONTROL_HANDOFF_ACTIVE';
      } catch {
        reasonCode = 'SANDBOX_CONTROL_HANDOFF_ACTIVE';
      }
      const now = Date.now();
      if (now >= nextBindingCheckAt) {
        bindingReasonCode = bindingCheck(manifest);
        if (bindingReasonCode) {
          const backoff = nextSandboxControlBackoff(bindingBackoffMs, timing.slowCheckMs);
          nextBindingCheckAt = now + backoff.delayMs;
          bindingBackoffMs = backoff.nextDelayMs;
        } else {
          nextBindingCheckAt = now + timing.slowCheckMs;
          bindingBackoffMs = timing.parkedBindingInitialMs;
        }
      }
      reasonCode ??= containerReasonCode;
      reasonCode ??= bindingReasonCode;
      const state = reasonCode ? 'parked' : active ? 'busy' : 'healthy';
      const stateKey = `${state}:${reasonCode ?? ''}:${active?.request.id ?? ''}`;
      if (brokerOwns() && (stateKey !== lastState || now - lastStatusAt >= timing.controlTickMs)) {
        writeSandboxControlStatus(manifest, broker, state, reasonCode, active?.request.id ?? null, now);
        lastStatusAt = now;
      }
      if (brokerOwns() && stateKey !== lastState) {
        appendSandboxControlAudit(manifest, 'broker-state', { state, reasonCode, requestId: active?.request.id ?? null });
        lastState = stateKey;
      }
      if (settledExecution) {
        if (!brokerOwns()) break;
        if (settledExecution.result) {
          writeResponse(manifest, {
            version: 2, id: settledExecution.request.id, phase: 'completed', exitCode: settledExecution.result.exitCode,
            stdout: settledExecution.result.stdout, stderr: settledExecution.result.stderr, error: null
          });
        } else {
          writeResponse(manifest, unknown(settledExecution.request.id));
        }
        if (!brokerOwns()) break;
        fs.rmSync(path.join(manifest.processingDir, settledExecution.request.id), { recursive: true, force: true });
      }

      let retiring = false;
      for (const name of fs.readdirSync(requestsDir).sort()) {
        if (!/^[a-f0-9-]{16,64}\.json$/.test(name)) continue;
        const id = name.slice(0, -5);
        const source = path.join(requestsDir, name);
        let claimed: string | null = null;
        try {
          if (!brokerOwns()) {
            retiring = true;
            break;
          }
          claimed = claimRequest(manifest, source, id);
          if (!brokerOwns()) {
            retiring = true;
            break;
          }
          consumeRequest(consumedDir, id);
          if (!brokerOwns()) {
            retiring = true;
            break;
          }
          if (reasonCode) throw new Error(reasonCode);
          if (active) throw new Error('SANDBOX_CONTROL_BUSY');
          const request = validateSandboxControlRequest(JSON.parse(fs.readFileSync(claimed, 'utf8')), manifest);
          if (bindingCheck(manifest)) throw new Error('SANDBOX_WORKTREE_BINDING_LOST');
          if (readActiveLease(manifest)) throw new Error('SANDBOX_CONTROL_HANDOFF_ACTIVE');
          const prepared = await prepareSandboxControlExecution({
            manifest, manifestPath, request, requestPath: claimed, internalCliPath: process.argv[1]!
          });
          const execution: ActiveExecution = { request, prepared, result: null, failure: null, settled: false };
          active = execution;
          prepared.completion.then(
            (result) => { execution.result = result; execution.settled = true; },
            (error) => { execution.failure = error; execution.settled = true; }
          );
          if (!brokerOwns()) {
            prepared.terminate(false);
            active = null;
            retiring = true;
            continue;
          }
          if (!brokerOwns()) {
            prepared.terminate(false);
            active = null;
            retiring = true;
            continue;
          }
          writeResponse(manifest, {
            version: 2, id, phase: 'accepted', exitCode: null, stdout: '', stderr: '', error: null
          });
          if (!brokerOwns()) {
            prepared.terminate(false);
            active = null;
            retiring = true;
            break;
          }
          try {
            prepared.start(brokerOwns);
          } catch (error) {
            const owned = brokerOwns();
            prepared.terminate(owned);
            if (!owned || !brokerOwns()) {
              active = null;
              retiring = true;
              break;
            }
            writeResponse(manifest, unknown(id));
            if (!brokerOwns()) {
              active = null;
              retiring = true;
              break;
            }
            fs.rmSync(path.join(manifest.processingDir, id), { recursive: true, force: true });
            active = null;
            claimed = null;
            if (!brokerOwns()) {
              retiring = true;
              break;
            }
            appendSandboxControlAudit(manifest, 'executor-gate-failed', { requestId: id });
            continue;
          }
        } catch (error) {
          if (!brokerOwns()) {
            retiring = true;
            break;
          }
          writeResponse(manifest, rejected(id, error));
          if (!brokerOwns()) {
            retiring = true;
            break;
          }
          if (claimed) fs.rmSync(path.dirname(claimed), { recursive: true, force: true });
        }
      }
      if (retiring || !brokerOwns()) break;
      await delay(timing.controlTickMs);
    }
  } finally {
    if (active) {
      const owned = brokerOwns();
      active.prepared.terminate(owned);
      if (owned && brokerOwns()) writeResponse(manifest, unknown(active.request.id));
    }
    if (brokerOwns()) {
      appendSandboxControlAudit(manifest, 'broker-stop', { pid: broker.pid, brokerId: broker.brokerId });
      try {
        if (fs.readFileSync(brokerPath, 'utf8') === brokerRecord) fs.unlinkSync(brokerPath);
      } catch {
        // A newer owner or recovery path owns the record.
      }
    }
  }
}
