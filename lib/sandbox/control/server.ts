import fs from 'node:fs';
import path from 'node:path';
import { getProcessStartTime } from '../../server/process-state.ts';
import { assertGitWorktreeBinding } from '../../git/worktree-identity.ts';
import {
  controlError,
  SANDBOX_CONTROL_STATUS_INTERVAL_MS,
  type SandboxControlManifest,
  type SandboxControlRequest,
  type SandboxControlResponse
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
import {
  acquireSandboxControlBrokerStartup,
  isSandboxControlRootQuiescing,
  readSandboxControlManifest
} from './lifecycle.ts';

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

function recoverProcessing(manifest: SandboxControlManifest): void {
  for (const entry of fs.readdirSync(manifest.processingDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{16,64}$/.test(entry.name)) continue;
    const descriptor = executionPath(manifest, entry.name);
    const existingResponse = responsePath(manifest, entry.name);
    if (fs.existsSync(descriptor)) {
      const execution = readExecution(descriptor);
      if (!terminateSandboxControlExecution(execution)) {
        throw new Error(`SANDBOX_CONTROL_EXECUTION_STILL_RUNNING: ${entry.name}`);
      }
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
      if (!terminal) writeResponse(manifest, unknown(entry.name));
    } else {
      writeResponse(manifest, notExecuted(entry.name));
    }
    fs.rmSync(path.join(manifest.processingDir, entry.name), { recursive: true, force: true });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sandboxControlSafeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.toUpperCase().startsWith('AGENT_INFRA_CONTROL_')));
}

export async function serveSandboxControl(
  manifestPath: string,
  signal: AbortSignal = new AbortController().signal
): Promise<void> {
  const manifest = readSandboxControlManifest(manifestPath);
  const root = path.dirname(manifestPath);
  const startTime = getProcessStartTime(process.pid);
  if (!startTime) throw new Error('SANDBOX_CONTROL_BROKER_IDENTITY_UNAVAILABLE');
  const releaseStartup = await acquireSandboxControlBrokerStartup(root, { pid: process.pid, startTime });
  const requestsDir = path.join(manifest.channelDir, 'requests');
  const responsesDir = path.join(manifest.channelDir, 'responses');
  const consumedDir = path.join(root, 'consumed');
  const broker = { pid: process.pid, startTime };
  const brokerPath = path.join(root, 'broker.json');
  const brokerRecord = `${JSON.stringify({ version: 2, ...broker, token: manifest.token, generation: manifest.generation })}\n`;
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
  try {
    writeSandboxControlStatus(manifest, broker, 'starting', null, null);
    appendSandboxControlAudit(manifest, 'broker-start', { pid: broker.pid });
    recoverProcessing(manifest);
    while (!signal.aborted) {
      let current: SandboxControlManifest;
      try {
        current = readSandboxControlManifest(manifestPath);
      } catch {
        break;
      }
      if (current.token !== manifest.token || current.generation !== manifest.generation) break;

      if (active?.settled) {
        if (active.result) {
          writeResponse(manifest, {
            version: 2, id: active.request.id, phase: 'completed', exitCode: active.result.exitCode,
            stdout: active.result.stdout, stderr: active.result.stderr, error: null
          });
        } else {
          writeResponse(manifest, unknown(active.request.id));
        }
        fs.rmSync(path.join(manifest.processingDir, active.request.id), { recursive: true, force: true });
        active = null;
      }

      let reasonCode: string | null = null;
      try {
        if (cleanupStaleSandboxControlLease(manifest)) {
          appendSandboxControlAudit(manifest, 'lease-stale-cleanup');
        }
        if (readActiveLease(manifest)) reasonCode = 'SANDBOX_CONTROL_HANDOFF_ACTIVE';
      } catch {
        reasonCode = 'SANDBOX_CONTROL_HANDOFF_ACTIVE';
      }
      reasonCode ??= bindingReason(manifest);
      const state = reasonCode ? 'parked' : active ? 'busy' : 'healthy';
      const stateKey = `${state}:${reasonCode ?? ''}:${active?.request.id ?? ''}`;
      const now = Date.now();
      if (stateKey !== lastState || now - lastStatusAt >= SANDBOX_CONTROL_STATUS_INTERVAL_MS) {
        writeSandboxControlStatus(manifest, broker, state, reasonCode, active?.request.id ?? null, now);
        lastStatusAt = now;
      }
      if (stateKey !== lastState) {
        appendSandboxControlAudit(manifest, 'broker-state', { state, reasonCode, requestId: active?.request.id ?? null });
        lastState = stateKey;
      }

      for (const name of fs.readdirSync(requestsDir).sort()) {
        if (!/^[a-f0-9-]{16,64}\.json$/.test(name)) continue;
        const id = name.slice(0, -5);
        const source = path.join(requestsDir, name);
        let claimed: string | null = null;
        try {
          claimed = claimRequest(manifest, source, id);
          consumeRequest(consumedDir, id);
          if (reasonCode) throw new Error(reasonCode);
          if (active) throw new Error('SANDBOX_CONTROL_BUSY');
          const request = validateSandboxControlRequest(JSON.parse(fs.readFileSync(claimed, 'utf8')), manifest);
          if (bindingReason(manifest)) throw new Error('SANDBOX_WORKTREE_BINDING_LOST');
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
          writeResponse(manifest, {
            version: 2, id, phase: 'accepted', exitCode: null, stdout: '', stderr: '', error: null
          });
          try {
            prepared.start();
          } catch (error) {
            prepared.terminate();
            writeResponse(manifest, unknown(id));
            fs.rmSync(path.join(manifest.processingDir, id), { recursive: true, force: true });
            active = null;
            claimed = null;
            appendSandboxControlAudit(manifest, 'executor-gate-failed', { requestId: id });
            continue;
          }
        } catch (error) {
          writeResponse(manifest, rejected(id, error));
          if (claimed) fs.rmSync(path.dirname(claimed), { recursive: true, force: true });
        }
      }
      await delay(25);
    }
  } finally {
    if (active) {
      active.prepared.terminate();
      writeResponse(manifest, unknown(active.request.id));
    }
    appendSandboxControlAudit(manifest, 'broker-stop', { pid: broker.pid });
    try {
      if (fs.readFileSync(brokerPath, 'utf8') === brokerRecord) fs.unlinkSync(brokerPath);
    } catch {
      // A newer owner or recovery path owns the record.
    }
  }
}
