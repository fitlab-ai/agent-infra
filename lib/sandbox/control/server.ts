import { finalizationTerminalResponse } from './finalization-response.ts';
import { completedReentryView } from './completed-reentry.ts';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getProcessStartTime } from '../../server/process-state.ts';
import { assertGitWorktreeBinding } from '../../git/worktree-identity.ts';
import {
  controlError,
  DEFAULT_SANDBOX_CONTROL_TIMING,
  SANDBOX_CONTROL_MAX_RESPONSE_BYTES,
  SANDBOX_CONTROL_MAX_TERMINAL_RECORD_BYTES,
  type SandboxControlManifest,
  type SandboxControlRequest,
  type SandboxControlResponse,
  type SandboxControlTimingPolicy
} from './protocol.ts';
import { prepareSandboxControlExecution, type PreparedSandboxControlExecution, type SandboxControlExecutionResult } from './executor.ts';
import {
  atomicWriteJsonNoReplace,
  createSandboxControlPayload,
  cleanupStaleSandboxControlLease,
  executionPath,
  readJsonFile,
  readActiveLease,
  readExecution,
  readSandboxControlPayload,
  readSandboxControlResultEvidence,
  readSandboxControlTerminalResult,
  createSandboxControlTerminalResult,
  sandboxControlEncodedJsonBytes,
  sandboxControlGenerationUsage,
  sanitizeSandboxControlOutput,
  sanitizeSandboxControlResult,
  payloadPath,
  writeSandboxControlPayload,
  writeSandboxControlReservation,
  writeSandboxControlResultEvidence,
  writeSandboxControlTerminalResult,
  appendSandboxControlAudit,
  terminateSandboxControlExecution,
  writeSandboxControlStatus,
  readSandboxControlStatus
} from './state.ts';
import { validateSandboxControlRequest } from './protocol.ts';
import {
  appendCriticalAudit,
  appendDiagnosticAudit,
  createSandboxControlAuditContext,
  writeSandboxControlTransition
} from './audit.ts';
import { parseTaskControlOperation } from '../../task/control-authority.ts';
import {
  classifySandboxControlRecovery,
  findSandboxControlRecoveryOperation,
  operationRecoveryBinding
} from '../../task/control-recovery.ts';
import { readRun } from '../../task/orchestration.ts';
import { captureRepositorySnapshot } from '../../task/workspace-snapshot.ts';
import { parseTypedTaskFrontmatter } from '../../task/frontmatter.ts';
import { locateHotTaskDirs, resolveTaskRef } from '../../task/resolve-ref.ts';
import { loadShortIdByTaskId } from '../../task/short-id.ts';
import { inspectSandboxControlContainer, type ContainerObservation } from './container-identity.ts';
import {
  acquireSandboxControlBrokerStartup,
  garbageCollectSandboxControlRoot,
  isSandboxControlRootQuiescing,
  readSandboxControlManifest
} from './lifecycle.ts';
import type { BrokerOwner } from './lifecycle.ts';
import { nextSandboxControlBackoff } from './timing.ts';
import { readTaskFinalizationReceipt } from '../../task/finalization.ts';
import { readCodexControllerRegistration } from './controller-registration.ts';
import { validateSandboxControlIdentity } from './identity-sentinel.ts';
import {
  mergeSandboxTaskView,
  taskViewAfterFinalization,
  taskViewForManifest,
  type SandboxTaskView
} from './task-view.ts';
import { taskCreateOutputUnavailableResult } from '../../task/create-service.ts';

type ActiveExecution = {
  request: SandboxControlRequest;
  prepared: PreparedSandboxControlExecution;
  result: SandboxControlExecutionResult | null;
  resultEvidenceWritten: boolean;
  failure: unknown;
  settled: boolean;
};

function safeRealpath(value: string): string | null {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return null;
  }
}

function appendBrokerAudit(
  manifest: SandboxControlManifest,
  event: string,
  fields: Record<string, string | number | boolean | null> = {}
): void {
  appendDiagnosticAudit(manifest, event, { source: 'broker', ...fields });
}

function operationKey(request: SandboxControlRequest, output?: string): string | null {
  if (request.family === 'task-finalization') return request.operation;
  if (request.family === 'task-create') return 'create';
  if (request.family === 'codex-controller') return request.command;
  if (request.family !== 'task-lifecycle' && request.family !== 'task-orchestration') return null;
  if (request.family === 'task-orchestration' && request.args[1] === 'route') {
    if (!output) return 'route';
    try {
      const value = JSON.parse(output) as Record<string, unknown>;
      if (value.changed === true && value.status === 'completed') return 'route.clean-completion';
      if (value.result && typeof value.result === 'object' && !Array.isArray(value.result)
        && (value.result as Record<string, unknown>).changed === true
          && (value.result as Record<string, unknown>).status === 'completed') return 'route.clean-completion';
    } catch {
      // Keep the parsed request operation when the handler output is not JSON.
    }
    return 'route.read';
  }
  try {
    const operation = parseTaskControlOperation(request.family, request.args);
    return operation.family === 'task-orchestration' ? operation.intent : operation.request.intent;
  } catch {
    return null;
  }
}

function recoveryOperationKey(
  request: SandboxControlRequest,
  terminalResult: ReturnType<typeof readSandboxControlTerminalResult> | null,
  output: string | undefined
): string | null {
  const operation = operationKey(request, output);
  if (operation !== 'route') return operation;
  const routeOperation = output && operationKey(request, output) === 'route.clean-completion'
    ? 'route.clean-completion' : output ? 'route.read' : null;
  const digest = terminalResult?.intentDigest
    ?? (routeOperation ? createHash('sha256').update(`${request.family}\0${routeOperation}`, 'utf8').digest('hex') : null);
  for (const candidate of ['route.read', 'route.clean-completion'] as const) {
    const expected = operationRecoveryBinding(request.id, request.generation, null, request.family, candidate).intentDigest;
    if (digest === expected) return candidate;
  }
  return null;
}

function terminalResultMatchesRequest(
  request: SandboxControlRequest,
  terminalResult: ReturnType<typeof readSandboxControlTerminalResult>
): boolean {
  const operation = operationKey(request);
  const candidates = operation === 'route'
    ? ['route.read', 'route.clean-completion']
    : operation ? [operation] : [];
  return candidates.some((candidate) => createHash('sha256').update(`${request.family}\0${candidate}`, 'utf8').digest('hex') === terminalResult.intentDigest);
}

function criticalRequestPhase(
  manifest: SandboxControlManifest,
  request: SandboxControlRequest,
  phase: Parameters<typeof createSandboxControlAuditContext>[1]['phase'],
  outcome: Parameters<typeof createSandboxControlAuditContext>[1]['outcome'],
  reference?: string | null
): void {
  const context = createSandboxControlAuditContext(manifest, {
    requestId: request.id,
    family: request.family,
    operation: operationKey(request),
    phase,
    outcome
  });
  appendCriticalAudit(manifest, context, { reference: reference ?? null });
  writeSandboxControlTransition(manifest, { requestId: request.id, phase, reference });
}

function requestAuditFields(
  manifest: SandboxControlManifest,
  manifestPath: string,
  request: SandboxControlRequest
): Record<string, string | number | boolean | null> {
  const args = 'args' in request ? request.args : [];
  const encodedArgs = JSON.stringify(args);
  return {
    requestId: request.id,
    requestFamily: request.family,
    sandboxTaskId: manifest.taskId,
    requestGeneration: request.generation,
    requestIssuedAt: request.issuedAt,
    requestExpiresAt: request.expiresAt,
    requestArgCount: args.length,
    requestArgsSha256: createHash('sha256').update(encodedArgs, 'utf8').digest('hex'),
    requestTaskRef: args[0] ?? null,
    requestCommand: args[1] ?? null,
    controllerProofPresent: request.controllerProof !== null,
    hostCwd: process.cwd(),
    manifestPath,
    manifestPathRealpath: safeRealpath(manifestPath),
    repoRoot: manifest.repoRoot,
    repoRootRealpath: safeRealpath(manifest.repoRoot),
    worktreeRoot: manifest.worktreeRoot,
    worktreeRootRealpath: safeRealpath(manifest.worktreeRoot),
    runtimeDir: manifest.runtimeDir,
    runtimeDirRealpath: safeRealpath(manifest.runtimeDir)
  };
}

function resultAuditFields(result: SandboxControlExecutionResult): Record<string, string | number | boolean | null> {
  return {
    exitCode: result.exitCode,
    stdoutBytes: Buffer.byteLength(result.stdout, 'utf8'),
    stderrBytes: Buffer.byteLength(result.stderr, 'utf8'),
    stdoutSha256: createHash('sha256').update(result.stdout, 'utf8').digest('hex'),
    stderrSha256: createHash('sha256').update(result.stderr, 'utf8').digest('hex')
  };
}

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

function acceptedResponsePath(manifest: SandboxControlManifest, id: string): string {
  return path.join(manifest.channelDir, 'responses', `${id}.accepted.json`);
}

export function writeSandboxControlResponse(manifest: SandboxControlManifest, response: SandboxControlResponse): boolean {
  const filePath = responsePath(manifest, response.id);
  const normalized = {
    ...response,
    stdout: sanitizeSandboxControlOutput(manifest, response.stdout),
    stderr: sanitizeSandboxControlOutput(manifest, response.stderr)
  } satisfies SandboxControlResponse;
  const terminal = sandboxControlEncodedJsonBytes(normalized) <= SANDBOX_CONTROL_MAX_TERMINAL_RECORD_BYTES
    ? normalized
    : {
      ...normalized,
      stdout: '',
      stderr: 'SANDBOX_CONTROL_OUTPUT_UNAVAILABLE: terminal output exceeded the compact record limit\n',
      error: {
        code: 'SANDBOX_CONTROL_OUTPUT_UNAVAILABLE',
        message: 'SANDBOX_CONTROL_OUTPUT_UNAVAILABLE: terminal output exceeded the compact record limit',
        retryable: false
      }
    } satisfies SandboxControlResponse;
  try {
    atomicWriteJsonNoReplace(filePath, terminal);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'SANDBOX_CONTROL_TERMINAL_ALREADY_EXISTS') throw error;
    let persisted: unknown;
    try {
      persisted = readJsonFile(filePath);
    } catch {
      throw new Error('SANDBOX_CONTROL_TERMINAL_READBACK_FAILED');
    }
    if (JSON.stringify(persisted) !== JSON.stringify(terminal)) {
      throw new Error('SANDBOX_CONTROL_TERMINAL_CONFLICT');
    }
    return true;
  }
  let persisted: unknown;
  try {
    persisted = readJsonFile(filePath);
  } catch {
    throw new Error('SANDBOX_CONTROL_TERMINAL_READBACK_FAILED');
  }
  if (JSON.stringify(persisted) !== JSON.stringify(terminal)) {
    throw new Error('SANDBOX_CONTROL_TERMINAL_READBACK_FAILED');
  }
  return true;
}

type FinalizationRecovery = Readonly<{
  status: 'matched' | 'deferred' | 'not-applicable';
  response?: SandboxControlResponse;
}>;

function finalizationRecoveryResponse(
  manifest: SandboxControlManifest,
  requestId: string,
  exitCode: number
): FinalizationRecovery {
  if (!manifest.taskId || exitCode !== 0) return { status: 'not-applicable' };
  let receipt;
  try {
    receipt = readTaskFinalizationReceipt(manifest.repoRoot, manifest.taskId);
    if (!receipt || !receipt.controlBinding
      || receipt.controlBinding.generation !== manifest.generation
      || receipt.controlBinding.requestId !== requestId) return { status: 'deferred' };
    const resolved = resolveTaskRef(manifest.taskId, { repoRoot: manifest.repoRoot });
    if (!resolved.ok || resolved.state !== 'completed' || receipt.lifecycle !== 'done') return { status: 'deferred' };
  } catch {
    return { status: 'deferred' };
  }
  return { status: 'matched', response: finalizationTerminalResponse(manifest.taskId, requestId, receipt) };
}

function publishFinalizationTaskView(
  manifest: SandboxControlManifest,
  broker: BrokerOwner,
  requestId: string,
  state: 'starting' | 'healthy' | 'busy' | 'parked',
  reasonCode: string | null,
  activeRequestId: string | null
): SandboxTaskView {
  let view: SandboxTaskView;
  try {
    const resolved = resolveTaskRef(manifest.taskId ?? '', { repoRoot: manifest.repoRoot });
    const receipt = readTaskFinalizationReceipt(manifest.repoRoot, manifest.taskId ?? '');
    view = resolved.ok && resolved.state === 'completed'
      ? taskViewAfterFinalization({
          taskId: manifest.taskId ?? '', generation: manifest.generation, requestId, receipt
        })
      : {
          state: 'unknown', taskId: manifest.taskId, observedSource: 'unknown', receipt: null,
          reasonCode: 'SANDBOX_TASK_VIEW_SOURCE_UNCONFIRMED'
        };
  } catch {
    view = {
      state: 'unknown', taskId: manifest.taskId, observedSource: 'unknown', receipt: null,
      reasonCode: 'SANDBOX_TASK_VIEW_RECEIPT_INVALID'
    };
  }
  writeSandboxControlStatus(manifest, broker, state, reasonCode, activeRequestId, Date.now(), view);
  return view;
}

function payloadReference(payload: ReturnType<typeof createSandboxControlPayload>) {
  return {
    version: payload.version,
    id: payload.id,
    generation: payload.generation,
    stdoutBytes: payload.stdoutBytes,
    stderrBytes: payload.stderrBytes,
    stdoutSha256: payload.stdoutSha256,
    stderrSha256: payload.stderrSha256
  };
}

function payloadMatchesEvidence(
  payload: ReturnType<typeof readSandboxControlPayload>,
  evidence: ReturnType<typeof readSandboxControlResultEvidence>
): boolean {
  return payload.id === evidence.id
    && payload.generation === evidence.generation
    && payload.stdoutBytes === evidence.stdoutBytes
    && payload.stderrBytes === evidence.stderrBytes
    && payload.stdoutSha256 === evidence.stdoutSha256
    && payload.stderrSha256 === evidence.stderrSha256;
}

function outputMatchesEvidence(output: string, bytes: number, sha256: string): boolean {
  return Buffer.byteLength(output, 'utf8') === bytes
    && createHash('sha256').update(output, 'utf8').digest('hex') === sha256;
}

function genericRecoveryResponse(
  request: SandboxControlRequest,
  exitCode: number,
  payload: ReturnType<typeof readSandboxControlPayload> | null,
  cause: 'publish' | 'recovery' = 'recovery'
): SandboxControlResponse {
  const outputUnavailable = request.family === 'task-create' && !payload;
  return {
    version: 2,
    id: request.id,
    phase: 'completed',
    exitCode,
    stdout: outputUnavailable ? `${JSON.stringify(taskCreateOutputUnavailableResult(request.id))}\n` : '',
    stderr: payload ? '' : cause === 'publish'
      ? 'SANDBOX_CONTROL_OUTPUT_UNAVAILABLE: output payload was not retained\n'
      : 'SANDBOX_CONTROL_OUTPUT_UNAVAILABLE: broker restarted after executor completion\n',
    error: null,
    outputState: payload ? 'available' : 'unavailable',
    payload: payload ? payloadReference(payload) : null
  };
}

type RecoveryJournalEvidence = Readonly<{
  exists: boolean;
  completedSteps: readonly string[];
  failure: string | null;
}>;

type RecoveryDomainEvidence = Readonly<{
  domain: Readonly<Record<string, unknown>> | null;
  journal: RecoveryJournalEvidence;
}>;

function parseRecoveryOutput(output: string | null): Record<string, unknown> | null {
  if (output === null) return null;
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.result && typeof record.result === 'object' && !Array.isArray(record.result)) {
      return record.result as Record<string, unknown>;
    }
    return record;
  } catch {
    return null;
  }
}

function emptyRecoveryJournal(): RecoveryJournalEvidence {
  return { exists: false, completedSteps: [], failure: null };
}

function readLifecycleJournalEvidence(repoRoot: string, taskId: string): RecoveryJournalEvidence {
  const journalPath = locateHotTaskDirs(repoRoot, taskId)
    .map((entry) => path.join(entry.taskDir, '.task-lifecycle.json'))
    .find((candidate) => fs.existsSync(candidate));
  if (!journalPath) return emptyRecoveryJournal();
  try {
    const value = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Record<string, unknown>;
    const completedSteps = Array.isArray(value.completedSteps)
      ? value.completedSteps.filter((step): step is string => typeof step === 'string')
      : [];
    const failure = value.failure && typeof value.failure === 'object' && !Array.isArray(value.failure)
      && typeof (value.failure as Record<string, unknown>).code === 'string'
      ? (value.failure as Record<string, unknown>).code as string
      : null;
    return { exists: true, completedSteps, failure };
  } catch {
    return { exists: true, completedSteps: [], failure: 'SANDBOX_CONTROL_LIFECYCLE_JOURNAL_INVALID' };
  }
}

function taskCreateDomainEvidence(
  manifest: SandboxControlManifest,
  output: Record<string, unknown> | null
): Readonly<Record<string, unknown>> {
  if (!output || !['applied', 'no-op', 'degraded'].includes(String(output.status))) {
    return { consistent: false };
  }
  const task = output.task && typeof output.task === 'object' && !Array.isArray(output.task)
    ? output.task as Record<string, unknown> : null;
  const taskId = typeof task?.id === 'string' ? task.id : null;
  const shortId = typeof task?.shortId === 'string' ? task.shortId : null;
  if (!taskId || !shortId) return { consistent: false };
  try {
    const resolved = resolveTaskRef(taskId, { repoRoot: manifest.repoRoot });
    const shortIds = loadShortIdByTaskId(manifest.repoRoot);
    return {
      consistent: resolved.ok && resolved.taskId === taskId && resolved.state === 'active' && shortIds.get(taskId) === shortId,
      taskId,
      shortId
    };
  } catch {
    return { consistent: false };
  }
}

function controllerDomainEvidence(
  manifest: SandboxControlManifest,
  manifestPath: string,
  request: SandboxControlRequest,
  output: Record<string, unknown> | null
): Readonly<Record<string, unknown>> {
  if (!output || output.error !== null || typeof output.status !== 'string') return { consistent: false };
  try {
    const registration = readCodexControllerRegistration(manifestPath);
    if (request.family !== 'codex-controller') return { consistent: false };
    if (request.command === 'open') {
      const lease = output.lease && typeof output.lease === 'object' && !Array.isArray(output.lease)
        ? output.lease as Record<string, unknown> : null;
      return {
        consistent: output.status === 'opened' && output.changed === true
          && lease?.taskId === registration.taskId
          && lease.controlGeneration === registration.controlGeneration
          && lease.controllerInstanceDigest === registration.controllerInstanceDigest
          && registration.taskId === manifest.taskId
          && registration.controlGeneration === manifest.generation
      };
    }
    if (request.command === 'verify') {
      const binding = output.binding && typeof output.binding === 'object' && !Array.isArray(output.binding)
        ? output.binding as Record<string, unknown> : null;
      return {
        consistent: output.status === 'verified' && output.changed === false
          && binding?.taskId === registration.taskId
          && binding.controlGeneration === registration.controlGeneration
          && binding.controllerInstanceDigest === registration.controllerInstanceDigest
      };
    }
    return { consistent: false };
  } catch (error) {
    return { consistent: request.family === 'codex-controller' && request.command === 'close'
      && (error as { code?: string }).code === 'CODEX_SANDBOX_CONTROLLER_REGISTRATION_MISSING'
      && output?.status === 'closed' && typeof output.changed === 'boolean' };
  }
}

function orchestrationDomainEvidence(
  operation: ReturnType<typeof findSandboxControlRecoveryOperation>,
  terminalResult: ReturnType<typeof readSandboxControlTerminalResult>,
  output: Record<string, unknown> | null,
  run: ReturnType<typeof readRun> | null
): Readonly<Record<string, unknown>> {
  if (!operation || !output) return { consistent: false };
  const outputRun = output.run && typeof output.run === 'object' && !Array.isArray(output.run)
    ? output.run as Record<string, unknown> : null;
  const runMatches = outputRun === null ? run === null : run !== null && JSON.stringify(run) === JSON.stringify(outputRun);
  if (operation.class === 'read-only') {
    return {
      consistent: output.status === terminalResult.status && output.changed === terminalResult.changed && runMatches,
      snapshotValid: true,
      status: run?.status ?? terminalResult.status,
      pendingDelegation: run?.pendingDelegation ?? null
    };
  }
  if (!run || !outputRun) return { consistent: false };
  return {
    consistent: output.status === terminalResult.status && output.changed === terminalResult.changed && runMatches,
    status: run.status,
    pendingDelegation: run.pendingDelegation
  };
}

function readRecoveryDomain(
  manifest: SandboxControlManifest,
  manifestPath: string,
  request: SandboxControlRequest,
  operation: ReturnType<typeof findSandboxControlRecoveryOperation>,
  terminalResult: ReturnType<typeof readSandboxControlTerminalResult>,
  payloadOutput: string | null
): RecoveryDomainEvidence {
  if (!operation) return { domain: null, journal: emptyRecoveryJournal() };
  const taskRef = request.family === 'task-finalization'
    ? manifest.taskId
    : 'args' in request ? request.args[0] ?? null : manifest.taskId;
  const output = parseRecoveryOutput(payloadOutput);
  if (!taskRef && operation.family !== 'task-create' && operation.family !== 'codex-controller') {
    return { domain: null, journal: emptyRecoveryJournal() };
  }

  if (operation.family === 'task-finalization') {
    const taskId = manifest.taskId;
    if (!taskId) return { domain: null, journal: emptyRecoveryJournal() };
    try {
      const receipt = readTaskFinalizationReceipt(manifest.repoRoot, taskId);
      const resolved = resolveTaskRef(taskId, { repoRoot: manifest.repoRoot });
      const consistent = Boolean(receipt && resolved.ok && resolved.state === 'completed'
        && receipt.controlBinding?.generation === manifest.generation
        && receipt.controlBinding.requestId === request.id
        && receipt.lifecycle === 'done');
      return { domain: { consistent, completedSteps: terminalResult.completedSteps }, journal: emptyRecoveryJournal() };
    } catch {
      return { domain: { consistent: false }, journal: emptyRecoveryJournal() };
    }
  }

  if (operation.family === 'task-lifecycle') {
    if (!taskRef || !terminalResult.targetState) return { domain: null, journal: emptyRecoveryJournal() };
    const journal = readLifecycleJournalEvidence(manifest.repoRoot, taskRef);
    try {
      const resolved = resolveTaskRef(taskRef, { repoRoot: manifest.repoRoot });
      const shortIds = loadShortIdByTaskId(manifest.repoRoot);
      const shortIdMatches = terminalResult.targetState === 'active'
        ? shortIds.has(resolved.ok ? resolved.taskId : taskRef)
        : !shortIds.has(resolved.ok ? resolved.taskId : taskRef);
      return {
        domain: { consistent: resolved.ok && resolved.state === terminalResult.targetState && shortIdMatches },
        journal
      };
    } catch {
      return { domain: { consistent: false }, journal };
    }
  }

  if (operation.family === 'task-orchestration') {
    if (!taskRef) return { domain: null, journal: emptyRecoveryJournal() };
    try {
      const resolved = resolveTaskRef(taskRef, { repoRoot: manifest.repoRoot });
      if (!resolved.ok) return { domain: { consistent: false }, journal: emptyRecoveryJournal() };
      const run = readRun(resolved.taskDir);
      if (!run && operation.class !== 'read-only') return { domain: { consistent: false }, journal: emptyRecoveryJournal() };
      if (operation.class === 'route.clean-completion') {
        const snapshot = captureRepositorySnapshot(manifest.repoRoot);
        const metadata = parseTypedTaskFrontmatter(fs.readFileSync(resolved.taskMdPath, 'utf8'));
        const completion = run?.completionEvidence ?? null;
        const consistent = run !== null && run.status === 'completed'
          && run.pendingDelegation === null
          && completion !== null
          && completion.kind === 'reviewed-head-clean'
          && terminalResult.completionEvidence !== null
          && JSON.stringify(completion) === JSON.stringify(terminalResult.completionEvidence)
          && snapshot.head === completion.head
          && snapshot.headTree === completion.headTree
          && snapshot.worktreeTree === completion.worktreeTree
          && metadata.last_reviewed_commit === completion.lastReviewedCommit;
        return {
          domain: {
            consistent,
            status: run?.status ?? null,
            pendingDelegation: run?.pendingDelegation ?? null,
            completionEvidence: completion,
            snapshot,
            lastReviewedCommit: metadata.last_reviewed_commit
          },
          journal: emptyRecoveryJournal()
        };
      }
      return { domain: orchestrationDomainEvidence(operation, terminalResult, output, run), journal: emptyRecoveryJournal() };
    } catch {
      return { domain: { consistent: false }, journal: emptyRecoveryJournal() };
    }
  }

  if (operation.family === 'task-create') {
    return { domain: taskCreateDomainEvidence(manifest, output), journal: emptyRecoveryJournal() };
  }
  if (operation.family === 'codex-controller') {
    return { domain: controllerDomainEvidence(manifest, manifestPath, request, output), journal: emptyRecoveryJournal() };
  }
  return { domain: null, journal: emptyRecoveryJournal() };
}

function recoveryResponse(
  manifest: SandboxControlManifest,
  manifestPath: string,
  request: SandboxControlRequest,
  evidence: ReturnType<typeof readSandboxControlResultEvidence>,
  payload: ReturnType<typeof readSandboxControlPayload> | null,
  terminalResult: ReturnType<typeof readSandboxControlTerminalResult>
): SandboxControlResponse | null {
  const operationName = recoveryOperationKey(request, terminalResult, payload?.stdout);
  const operation = operationName ? findSandboxControlRecoveryOperation(request.family, operationName) : null;
  if (!operation) return null;
  if (payload) {
    const payloadTerminal = createSandboxControlTerminalResult(manifest, {
      id: request.id, family: request.family, operation: operationName
    }, payload.stdout);
    if (JSON.stringify(payloadTerminal) !== JSON.stringify(terminalResult)) return unknown(request.id);
  }
  let finalization: FinalizationRecovery | null = null;
  if (request.family === 'task-finalization' && evidence.exitCode === 0) {
    finalization = finalizationRecoveryResponse(manifest, request.id, evidence.exitCode);
    if (finalization.status === 'deferred') return null;
  }
  const recovery = readRecoveryDomain(manifest, manifestPath, request, operation, terminalResult, payload?.stdout ?? null);
  const binding = operationRecoveryBinding(request.id, manifest.generation, manifest.taskId, request.family, operationName!);
  const decision = classifySandboxControlRecovery({
    operation,
    binding,
    startedCommitted: true,
    terminalResult,
    domain: recovery.domain,
    journal: recovery.journal
  });
  if (decision.outcome === 'unknown' || decision.outcome === 'in-progress') return unknown(request.id);
  if (decision.outcome === 'not-executed') return notExecuted(request.id);
  if (decision.outcome !== 'success' && decision.outcome !== 'failure') return null;
  if (request.family === 'task-finalization' && evidence.exitCode === 0) {
    if (finalization?.status !== 'matched') return null;
    return finalization.response ?? null;
  }
  return genericRecoveryResponse(request, evidence.exitCode, payload);
}

function terminalMatchesEvidence(
  manifest: SandboxControlManifest,
  manifestPath: string,
  request: SandboxControlRequest,
  response: SandboxControlResponse,
  evidence: ReturnType<typeof readSandboxControlResultEvidence>,
  payload: ReturnType<typeof readSandboxControlPayload> | null,
  payloadInvalid: boolean,
  terminalResult: ReturnType<typeof readSandboxControlTerminalResult>
): { valid: boolean; payloadReferenced: boolean } {
  if (request.family === 'task-finalization' && evidence.exitCode === 0) {
    const expected = recoveryResponse(manifest, manifestPath, request, evidence, payload, terminalResult);
    return {
      valid: expected !== null && JSON.stringify(response) === JSON.stringify(expected),
      payloadReferenced: false
    };
  }
  if (response.version !== 2 || response.id !== request.id || response.phase !== 'completed'
    || response.exitCode !== evidence.exitCode || response.error !== null) {
    return { valid: false, payloadReferenced: false };
  }
  if (response.outputState === 'available') {
    const reference = response.payload;
    return {
      valid: !payloadInvalid && payload !== null && response.stdout === '' && response.stderr === ''
        && reference !== undefined && reference !== null
        && reference.version === payload.version
        && reference.id === payload.id
        && reference.generation === payload.generation
        && reference.stdoutBytes === payload.stdoutBytes
        && reference.stderrBytes === payload.stderrBytes
        && reference.stdoutSha256 === payload.stdoutSha256
        && reference.stderrSha256 === payload.stderrSha256
        && payloadMatchesEvidence(payload, evidence),
      payloadReferenced: true
    };
  }
  if (response.outputState === 'unavailable') {
    const causes = ['recovery', 'publish'] as const;
    const valid = causes.some((cause) => JSON.stringify(response)
      === JSON.stringify(genericRecoveryResponse(request, evidence.exitCode, null, cause)));
    return { valid, payloadReferenced: false };
  }
  return {
    valid: response.payload === undefined
      && outputMatchesEvidence(response.stdout, evidence.stdoutBytes, evidence.stdoutSha256)
      && outputMatchesEvidence(response.stderr, evidence.stderrBytes, evidence.stderrSha256),
    payloadReferenced: false
  };
}

function publishExecutionResult(
  manifest: SandboxControlManifest,
  request: SandboxControlRequest,
  result: SandboxControlExecutionResult,
  broker: BrokerOwner,
  brokerOwns: () => boolean
): boolean {
  const normalized = sanitizeSandboxControlResult(manifest, result);
  writeSandboxControlTerminalResult(manifest, {
    id: request.id,
    family: request.family,
    operation: operationKey(request, normalized.stdout)
  }, normalized.stdout);
  if (fs.existsSync(path.join(manifest.processingDir, request.id, 'transitions'))) {
    criticalRequestPhase(manifest, request, 'completed', normalized.exitCode === 0 ? 'success' : 'failure');
    criticalRequestPhase(manifest, request, 'evidence-written', normalized.exitCode === 0 ? 'success' : 'failure');
    criticalRequestPhase(manifest, request, 'publish-authorized', normalized.exitCode === 0 ? 'success' : 'failure');
  }
  let terminal: SandboxControlResponse | null = null;
  if (request.family === 'task-finalization') {
    const finalization = finalizationRecoveryResponse(manifest, request.id, normalized.exitCode);
    if (finalization.status === 'deferred') return false;
    terminal = finalization.response ?? null;
  }
  if (!terminal) {
    const inline: SandboxControlResponse = {
      version: 2, id: request.id, phase: 'completed', exitCode: normalized.exitCode,
      stdout: normalized.stdout, stderr: normalized.stderr, error: null
    };
    if (sandboxControlEncodedJsonBytes(inline) <= SANDBOX_CONTROL_MAX_TERMINAL_RECORD_BYTES) {
      terminal = inline;
    }
    let payload: ReturnType<typeof createSandboxControlPayload> | null = null;
    if (!terminal) {
      try {
        payload = createSandboxControlPayload(manifest, request.id, normalized);
        const usage = sandboxControlGenerationUsage(manifest);
        if (usage.bytes + sandboxControlEncodedJsonBytes(payload) <= SANDBOX_CONTROL_MAX_RESPONSE_BYTES) {
          writeSandboxControlPayload(manifest, request.id, normalized);
        } else {
          payload = null;
        }
      } catch {
        payload = null;
      }
      terminal = genericRecoveryResponse(request, normalized.exitCode, payload, 'publish');
    }
  }
  if (!brokerOwns()) return false;
  if (request.family === 'task-finalization' && normalized.exitCode === 0) {
    const view = publishFinalizationTaskView(manifest, broker, request.id, 'healthy', null, null);
    if (view.state === 'unknown') return false;
  }
  const committed = writeSandboxControlResponse(manifest, terminal);
  if (committed && fs.existsSync(path.join(manifest.processingDir, request.id, 'transitions'))) {
    criticalRequestPhase(manifest, request, 'published-committed', normalized.exitCode === 0 ? 'success' : 'failure');
  }
  return committed;
}

function writeAcceptedResponse(manifest: SandboxControlManifest, response: SandboxControlResponse): void {
  atomicWriteJsonNoReplace(acceptedResponsePath(manifest, response.id), response);
}

function removeAcceptedResponse(manifest: SandboxControlManifest, id: string): void {
  fs.rmSync(acceptedResponsePath(manifest, id), { force: true });
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

function assertCurrentSandboxControlIdentity(manifest: SandboxControlManifest, manifestPath: string): void {
  const result = validateSandboxControlIdentity({
    publicStatusDir: manifest.publicStatusDir,
    root: path.dirname(path.resolve(manifestPath)),
    mode: manifest.mode,
    taskId: manifest.taskId,
    generation: manifest.generation,
    controlRootId: manifest.controlRootId
  });
  if (result.state !== 'valid') {
    throw new Error(`SANDBOX_CONTROL_IDENTITY_${result.state.replaceAll('-', '_').toUpperCase()}`);
  }
}

function recoverProcessing(manifest: SandboxControlManifest, manifestPath: string, broker: BrokerOwner, brokerOwns: () => boolean): boolean {
  for (const entry of fs.readdirSync(manifest.processingDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{16,64}$/.test(entry.name)) continue;
    if (!brokerOwns()) return false;
    const descriptor = executionPath(manifest, entry.name);
    const existingResponse = responsePath(manifest, entry.name);
    const processingDirectory = path.join(manifest.processingDir, entry.name);
    const transitionsDirectory = path.join(processingDirectory, 'transitions');
    const transitionProtocolActive = fs.existsSync(transitionsDirectory);
    const startedCommitted = fs.existsSync(path.join(transitionsDirectory, 'started-committed.json'));
    let payloadReferenced = false;
    if (fs.existsSync(descriptor)) {
      const execution = readExecution(descriptor);
      let resultEvidence: ReturnType<typeof readSandboxControlResultEvidence> | null = null;
      let terminalResult: ReturnType<typeof readSandboxControlTerminalResult> | null = null;
      let payload: ReturnType<typeof readSandboxControlPayload> | null = null;
      let payloadInvalid = false;
      let request: SandboxControlRequest | null = null;
      let existingTerminalResponse: SandboxControlResponse | null = null;
      try {
        const rawRequest = JSON.parse(fs.readFileSync(path.join(processingDirectory, 'request.json'), 'utf8')) as Record<string, unknown>;
        request = validateSandboxControlRequest(rawRequest, manifest, {
          now: typeof rawRequest.issuedAt === 'number' ? rawRequest.issuedAt : undefined
        });
      } catch {
        // Missing or malformed request evidence remains fail-closed below.
      }
      const resultPath = path.join(manifest.processingDir, entry.name, 'result.json');
      if (fs.existsSync(resultPath)) {
        try {
          resultEvidence = readSandboxControlResultEvidence(resultPath);
          if (resultEvidence.id !== entry.name || resultEvidence.generation !== manifest.generation) {
            resultEvidence = null;
          }
        } catch {
          resultEvidence = null;
        }
      }
      const terminalResultPathValue = path.join(processingDirectory, 'terminal-result.json');
      if (fs.existsSync(terminalResultPathValue)) {
        try {
          terminalResult = readSandboxControlTerminalResult(terminalResultPathValue);
          if (terminalResult.requestId !== entry.name || terminalResult.generation !== manifest.generation
            || !request || !terminalResultMatchesRequest(request, terminalResult)) {
            terminalResult = null;
          }
        } catch {
          terminalResult = null;
        }
      }
      const publishedPayloadPath = payloadPath(manifest, entry.name);
      if (fs.existsSync(publishedPayloadPath)) {
        try {
          payload = readSandboxControlPayload(publishedPayloadPath);
          if (payload.id !== entry.name || payload.generation !== manifest.generation
            || (resultEvidence !== null && !payloadMatchesEvidence(payload, resultEvidence))) {
            payloadInvalid = true;
          }
        } catch {
          payloadInvalid = true;
        }
      }
      if (transitionProtocolActive && startedCommitted && !terminalResult) {
        if (!brokerOwns()) return false;
        if (!terminateSandboxControlExecution(execution)) {
          throw new Error(`SANDBOX_CONTROL_EXECUTION_STILL_RUNNING: ${entry.name}`);
        }
        appendDiagnosticAudit(manifest, 'orphan-tree-terminated', { requestId: entry.name });
        writeSandboxControlResponse(manifest, unknown(entry.name));
        continue;
      }
      if (transitionProtocolActive && !startedCommitted && terminalResult) continue;
      if (!terminateSandboxControlExecution(execution)) {
        throw new Error(`SANDBOX_CONTROL_EXECUTION_STILL_RUNNING: ${entry.name}`);
      }
      if (!brokerOwns()) return false;
      appendDiagnosticAudit(manifest, 'orphan-tree-terminated', { requestId: entry.name });
      let terminal = false;
      if (fs.existsSync(existingResponse)) {
        try {
          const response = JSON.parse(fs.readFileSync(existingResponse, 'utf8')) as SandboxControlResponse;
          existingTerminalResponse = response;
          terminal = response.version === 2 && response.id === entry.name
            && (response.phase === 'completed' || response.phase === 'rejected');
          if (terminal && response.outputState === 'available') {
            if (!response.payload || payloadInvalid || !payload
              || response.payload.version !== payload.version
              || response.payload.id !== payload.id
              || response.payload.generation !== payload.generation
              || response.payload.stdoutBytes !== payload.stdoutBytes
              || response.payload.stderrBytes !== payload.stderrBytes
              || response.payload.stdoutSha256 !== payload.stdoutSha256
              || response.payload.stderrSha256 !== payload.stderrSha256) throw new Error('payload missing or mismatched');
            payloadReferenced = true;
          } else if (terminal && ((response.outputState !== undefined && response.outputState !== 'unavailable')
            || response.payload !== undefined && response.payload !== null)) {
            throw new Error('payload state invalid');
          }
          if (!terminal) throw new Error('SANDBOX_CONTROL_RESPONSE_LAYOUT_INVALID');
        } catch {
          throw new Error('SANDBOX_CONTROL_RESPONSE_LAYOUT_INVALID');
        }
      }
      if (terminal && (!request || !resultEvidence)) continue;
      if (!terminalResult) {
        if (terminal) continue;
        if (!brokerOwns()) return false;
        if (!resultEvidence || !request || payloadInvalid) continue;
        writeSandboxControlResponse(manifest, unknown(entry.name));
        continue;
      }
      if (terminal && request && resultEvidence) {
        const reconciliation = terminalMatchesEvidence(manifest, manifestPath, request, existingTerminalResponse!, resultEvidence, payload, payloadInvalid, terminalResult);
        if (!reconciliation.valid) continue;
        payloadReferenced = reconciliation.payloadReferenced;
        if (request.family === 'task-finalization' && resultEvidence.exitCode === 0) {
          const view = publishFinalizationTaskView(manifest, broker, request.id, 'starting', null, null);
          if (view.state === 'unknown') continue;
        }
      }
      if (!terminal) {
        if (!brokerOwns()) return false;
        if (!resultEvidence || !request || payloadInvalid) continue;
        const recovered = recoveryResponse(manifest, manifestPath, request, resultEvidence, payload, terminalResult);
        if (!recovered) continue;
        if (request.family === 'task-finalization' && resultEvidence.exitCode === 0) {
          const view = publishFinalizationTaskView(manifest, broker, request.id, 'starting', null, null);
          if (view.state === 'unknown') continue;
        }
        writeSandboxControlResponse(manifest, recovered);
        const preserveRecoveryEvidence = recovered.error?.code === 'SANDBOX_CONTROL_RESULT_UNKNOWN';
        if (transitionProtocolActive && !preserveRecoveryEvidence) {
          writeSandboxControlTransition(manifest, { requestId: entry.name, phase: 'recovered' });
        }
        if (preserveRecoveryEvidence) continue;
        payloadReferenced = Boolean(payload) && request.family !== 'task-finalization';
      }
    } else {
      if (!brokerOwns()) return false;
      if (transitionProtocolActive && startedCommitted) {
        writeSandboxControlResponse(manifest, unknown(entry.name));
        continue;
      }
      writeSandboxControlResponse(manifest, notExecuted(entry.name));
    }
    if (!brokerOwns()) return false;
    removeAcceptedResponse(manifest, entry.name);
    fs.rmSync(processingDirectory, { recursive: true, force: true });
    if (!payloadReferenced) fs.rmSync(payloadPath(manifest, entry.name), { force: true });
  }
  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sandboxControlSafeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => {
    const normalized = key.toUpperCase();
    return !normalized.startsWith('AGENT_INFRA_CONTROL_')
      && normalized !== 'AGENT_INFRA_TASK_ID'
      && normalized !== 'AGENT_INFRA_RUNTIME_DIR'
      && normalized !== 'AGENT_INFRA_EXECUTOR_MANIFEST';
  }));
}

export async function serveSandboxControl(
  manifestPath: string,
  signal: AbortSignal = new AbortController().signal,
  options: {
    timing?: SandboxControlTimingPolicy;
    inspectContainer?: (manifest: SandboxControlManifest) => Promise<ContainerObservation>;
    bindingCheck?: (manifest: SandboxControlManifest) => string | null;
    prepareExecution?: typeof prepareSandboxControlExecution;
    internalCliPath?: string;
  } = {}
): Promise<void> {
  const timing = options.timing ?? DEFAULT_SANDBOX_CONTROL_TIMING;
  const inspectContainer = options.inspectContainer ?? ((value: SandboxControlManifest) => inspectSandboxControlContainer(value));
  const bindingCheck = options.bindingCheck ?? bindingReason;
  const prepareExecution = options.prepareExecution ?? prepareSandboxControlExecution;
  const manifest = readSandboxControlManifest(manifestPath);
  const root = path.dirname(manifestPath);
  assertCurrentSandboxControlIdentity(manifest, manifestPath);
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
  let startupReceipt: unknown = null;
  if (manifest.taskId) {
    try {
      startupReceipt = readTaskFinalizationReceipt(manifest.repoRoot, manifest.taskId);
    } catch {
      // Preserve malformed receipt evidence as unknown rather than treating it as no receipt.
      startupReceipt = {};
    }
  }
  let taskView = taskViewForManifest({
    ...manifest,
    receipt: startupReceipt
  });
  try {
    const previous = readSandboxControlStatus(manifest.publicStatusDir);
    if (previous.generation === manifest.generation) taskView = mergeSandboxTaskView(taskView, previous.taskView);
  } catch {
    // A fresh control root has no previous task-view projection.
  }
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
    if (taskView.state === 'current' && taskView.observedSource === 'completed') {
      // Recheck durable re-entry evidence before publishing a trusted startup view.
      const unverified = { ...taskView, state: 'unknown' as const,
        reasonCode: 'SANDBOX_COMPLETED_REENTRY_EVIDENCE_INVALID' };
      try {
        taskView = await completedReentryView(manifest, inspectContainer) ?? unverified;
      } catch {
        taskView = unverified;
      }
      if (!brokerOwns()) return;
    }
    writeSandboxControlStatus(manifest, broker, 'starting', null, null, Date.now(), taskView);
    if (!brokerOwns()) return;
    appendBrokerAudit(manifest, 'broker-start', {
      pid: broker.pid,
      brokerId: broker.brokerId,
      hostCwd: process.cwd(),
      manifestPath,
      manifestPathRealpath: safeRealpath(manifestPath),
      repoRoot: manifest.repoRoot,
      repoRootRealpath: safeRealpath(manifest.repoRoot),
      worktreeRoot: manifest.worktreeRoot,
      worktreeRootRealpath: safeRealpath(manifest.worktreeRoot),
      runtimeDir: manifest.runtimeDir,
      runtimeDirRealpath: safeRealpath(manifest.runtimeDir),
      channelDir: manifest.channelDir,
      publicStatusDir: manifest.publicStatusDir,
      processingDir: manifest.processingDir,
      internalCliPath: options.internalCliPath ?? process.argv[1] ?? null
    });
    if (!recoverProcessing(manifest, manifestPath, broker, brokerOwns)) return;
    try {
      const published = readSandboxControlStatus(manifest.publicStatusDir);
      if (published.generation === manifest.generation) taskView = published.taskView;
    } catch {
      // The regular heartbeat will publish an invalid or missing projection as unknown.
    }
    while (!signal.aborted) {
      let settledExecution: ActiveExecution | null = null;
      if (!brokerOwns()) break;
      let current: SandboxControlManifest;
      try {
        current = readSandboxControlManifest(manifestPath);
        assertCurrentSandboxControlIdentity(current, manifestPath);
      } catch {
        break;
      }
      if (current.token !== manifest.token || current.generation !== manifest.generation) break;
      if (active?.result && !active.resultEvidenceWritten) {
        try {
          active.result = sanitizeSandboxControlResult(manifest, active.result);
          writeSandboxControlResultEvidence(manifest, active.request.id, active.result);
          active.resultEvidenceWritten = true;
          active.failure = null;
          active.settled = true;
        } catch (error) {
          active.failure = error;
        }
      }
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
          appendDiagnosticAudit(manifest, 'container-heartbeat-unknown', { reason: observation.reason });
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
            appendDiagnosticAudit(manifest, 'container-gc-failed', { reason: controlError(error).code });
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
          appendBrokerAudit(manifest, 'lease-stale-cleanup');
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
      if (!reasonCode && !active && taskView.state !== 'current') {
        try {
          const reentered = await completedReentryView(manifest, inspectContainer);
          if (reentered && brokerOwns() && !readActiveLease(manifest) && !bindingCheck(manifest)) {
            taskView = reentered;
          }
        } catch {
          // Invalid or changed re-entry evidence never clears the existing task view.
        }
      }
      const state = reasonCode ? 'parked' : active ? 'busy' : 'healthy';
      const stateKey = `${state}:${reasonCode ?? ''}:${active?.request.id ?? ''}`;
      if (brokerOwns() && (stateKey !== lastState || now - lastStatusAt >= timing.controlTickMs)) {
        writeSandboxControlStatus(manifest, broker, state, reasonCode, active?.request.id ?? null, now, taskView);
        lastStatusAt = now;
      }
      if (brokerOwns() && stateKey !== lastState) {
        appendBrokerAudit(manifest, 'broker-state', { state, reasonCode, requestId: active?.request.id ?? null });
        lastState = stateKey;
      }
      if (settledExecution) {
        if (!brokerOwns()) break;
        let terminalCommitted = false;
        if (settledExecution.result && settledExecution.resultEvidenceWritten) {
          terminalCommitted = publishExecutionResult(manifest, settledExecution.request, settledExecution.result, broker, brokerOwns);
          if (terminalCommitted && settledExecution.request.family === 'task-finalization') {
            try {
              const published = readSandboxControlStatus(manifest.publicStatusDir);
              if (published.generation === manifest.generation) taskView = published.taskView;
            } catch {
              taskView = { state: 'unknown', taskId: manifest.taskId, observedSource: 'unknown', receipt: null, reasonCode: 'SANDBOX_TASK_VIEW_STATUS_INVALID' };
            }
          }
        } else {
          terminalCommitted = writeSandboxControlResponse(manifest, unknown(settledExecution.request.id));
        }
        if (!terminalCommitted) return;
        appendBrokerAudit(manifest, 'executor-result-published', {
          ...requestAuditFields(manifest, manifestPath, settledExecution.request),
          resultAvailable: settledExecution.result !== null,
          resultEvidenceWritten: settledExecution.resultEvidenceWritten,
          ...(settledExecution.result ? resultAuditFields(settledExecution.result) : {})
        });
        if (!brokerOwns()) break;
        removeAcceptedResponse(manifest, settledExecution.request.id);
        fs.rmSync(path.join(manifest.processingDir, settledExecution.request.id), { recursive: true, force: true });
      }

      let retiring = false;
      for (const name of fs.readdirSync(requestsDir).sort()) {
        if (!/^[a-f0-9-]{16,64}\.json$/.test(name)) continue;
        const id = name.slice(0, -5);
        const source = path.join(requestsDir, name);
        let claimed: string | null = null;
        let validatedRequest: SandboxControlRequest | null = null;
        let prepared: PreparedSandboxControlExecution | null = null;
        try {
          if (!brokerOwns()) {
            retiring = true;
            break;
          }
          claimed = claimRequest(manifest, source, id);
          appendBrokerAudit(manifest, 'request-claimed', {
            requestId: id,
            requestSourcePath: source,
            requestClaimedPath: claimed,
            requestProcessingDir: path.dirname(claimed)
          });
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
          validatedRequest = request;
          criticalRequestPhase(manifest, request, 'validated', 'in-progress');
          appendBrokerAudit(manifest, 'request-validated', {
            ...requestAuditFields(manifest, manifestPath, request),
            requestPath: claimed
          });
          if (bindingCheck(manifest)) throw new Error('SANDBOX_WORKTREE_BINDING_LOST');
          if (readActiveLease(manifest)) throw new Error('SANDBOX_CONTROL_HANDOFF_ACTIVE');
          criticalRequestPhase(manifest, request, 'gated', 'in-progress');
          appendBrokerAudit(manifest, 'request-gates-passed', {
            ...requestAuditFields(manifest, manifestPath, request),
            requestPath: claimed,
            bindingChecked: true,
            handoffLeaseChecked: true
          });
          criticalRequestPhase(manifest, request, 'reserved', 'in-progress');
          writeSandboxControlReservation(manifest, request.id, sandboxControlGenerationUsage(manifest));
          appendBrokerAudit(manifest, 'executor-reservation-written', {
            ...requestAuditFields(manifest, manifestPath, request),
            requestPath: claimed,
            executionPath: executionPath(manifest, request.id)
          });
          appendBrokerAudit(manifest, 'executor-prepare-start', {
            ...requestAuditFields(manifest, manifestPath, request),
            requestPath: claimed,
            executorCwd: manifest.repoRoot,
            executorEntry: options.internalCliPath ?? process.argv[1] ?? null
          });
          prepared = await prepareExecution({
            manifest, manifestPath, request, requestPath: claimed,
            internalCliPath: options.internalCliPath ?? process.argv[1]!
          });
          const preparedExecution = prepared;
          if (!preparedExecution) throw new Error('SANDBOX_CONTROL_EXECUTION_PREPARE_INVALID');
          criticalRequestPhase(manifest, request, 'prepared', 'in-progress', `${preparedExecution.execution.child.pid}`);
          appendBrokerAudit(manifest, 'executor-prepared', {
            ...requestAuditFields(manifest, manifestPath, request),
            requestPath: claimed,
            executorCwd: manifest.repoRoot,
            childPid: preparedExecution.execution.child.pid,
            childStartTime: preparedExecution.execution.child.startTime,
            childProcessGroupId: preparedExecution.execution.child.processGroupId,
            executionPath: executionPath(manifest, request.id)
          });
          const execution: ActiveExecution = {
            request, prepared: preparedExecution, result: null, resultEvidenceWritten: false, failure: null, settled: false
          };
          active = execution;
          preparedExecution.completion.then(
            (result) => {
              execution.result = sanitizeSandboxControlResult(manifest, result);
              appendBrokerAudit(manifest, 'executor-completed', {
                ...requestAuditFields(manifest, manifestPath, request),
                ...resultAuditFields(execution.result),
                childPid: preparedExecution.execution.child.pid,
                childStartTime: preparedExecution.execution.child.startTime
              });
              try {
                writeSandboxControlResultEvidence(manifest, request.id, execution.result);
                execution.resultEvidenceWritten = true;
                execution.settled = true;
                appendBrokerAudit(manifest, 'executor-result-evidence-written', {
                  ...requestAuditFields(manifest, manifestPath, request),
                  resultPath: path.join(manifest.processingDir, request.id, 'result.json'),
                  ...resultAuditFields(execution.result)
                });
              } catch (error) {
                execution.failure = error;
                appendBrokerAudit(manifest, 'executor-result-evidence-failed', {
                  ...requestAuditFields(manifest, manifestPath, request),
                  errorType: error instanceof Error ? error.name : typeof error,
                });
              }
            },
            (error) => {
              execution.failure = error;
              execution.settled = true;
              appendBrokerAudit(manifest, 'executor-failed', {
                ...requestAuditFields(manifest, manifestPath, request),
                childPid: preparedExecution.execution.child.pid,
                childStartTime: preparedExecution.execution.child.startTime,
                errorType: error instanceof Error ? error.name : typeof error,
              });
            }
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
          criticalRequestPhase(manifest, request, 'accepted-authorized', 'in-progress');
          writeAcceptedResponse(manifest, {
            version: 2, id, phase: 'accepted', exitCode: null, stdout: '', stderr: '', error: null
          });
          writeSandboxControlTransition(manifest, { requestId: request.id, phase: 'accepted-committed' });
          appendBrokerAudit(manifest, 'request-accepted', {
            ...requestAuditFields(manifest, manifestPath, request),
            acceptedPath: acceptedResponsePath(manifest, id),
            executionPhase: 'prepared'
          });
          if (!brokerOwns()) {
            prepared.terminate(false);
            active = null;
            retiring = true;
            break;
          }
          try {
            criticalRequestPhase(manifest, request, 'start-authorized', 'in-progress', `${prepared.execution.child.pid}`);
            appendBrokerAudit(manifest, 'executor-start', {
              ...requestAuditFields(manifest, manifestPath, request),
              childPid: prepared.execution.child.pid,
              childStartTime: prepared.execution.child.startTime,
              executionPath: executionPath(manifest, request.id)
            });
            prepared.start(brokerOwns);
          } catch (error) {
            appendBrokerAudit(manifest, 'executor-start-failed', {
              ...requestAuditFields(manifest, manifestPath, request),
              errorType: error instanceof Error ? error.name : typeof error,
            });
            const owned = brokerOwns();
            prepared.terminate(owned);
            if (!owned || !brokerOwns()) {
              active = null;
              retiring = true;
              break;
            }
            writeSandboxControlResponse(manifest, unknown(id));
            if (!brokerOwns()) {
              active = null;
              retiring = true;
              break;
            }
            removeAcceptedResponse(manifest, id);
            fs.rmSync(path.join(manifest.processingDir, id), { recursive: true, force: true });
            active = null;
            claimed = null;
            if (!brokerOwns()) {
              retiring = true;
              break;
            }
            appendBrokerAudit(manifest, 'executor-gate-failed', { requestId: id });
            continue;
          }
        } catch (error) {
          if (prepared) {
            try { prepared.terminate(brokerOwns()); } catch { /* cleanup is best effort after a failed admission */ }
            prepared = null;
            active = null;
          }
          if (!brokerOwns()) {
            retiring = true;
            break;
          }
          const detail = controlError(error);
          appendBrokerAudit(manifest, 'request-rejected', {
            requestId: id,
            requestFamily: validatedRequest?.family ?? null,
            sandboxTaskId: manifest.taskId,
            requestPath: claimed,
            errorCode: detail.code,
            errorRetryable: detail.retryable,
            errorType: error instanceof Error ? error.name : typeof error,
          });
          writeSandboxControlResponse(manifest, rejected(id, error));
          if (!brokerOwns()) {
            retiring = true;
            break;
          }
          removeAcceptedResponse(manifest, id);
          if (claimed) fs.rmSync(path.dirname(claimed), { recursive: true, force: true });
        }
      }
      if (retiring || !brokerOwns()) break;
      await delay(timing.controlTickMs);
    }
  } finally {
    if (active) {
      const owned = brokerOwns();
      if (owned && active.result && !active.resultEvidenceWritten) {
        try {
          active.result = sanitizeSandboxControlResult(manifest, active.result);
          writeSandboxControlResultEvidence(manifest, active.request.id, active.result);
          active.resultEvidenceWritten = true;
          active.failure = null;
          active.settled = true;
        } catch (error) {
          active.failure = error;
        }
      }
      if (owned && active.result && active.resultEvidenceWritten) {
        if (publishExecutionResult(manifest, active.request, active.result, broker, brokerOwns)) {
          if (brokerOwns()) {
            removeAcceptedResponse(manifest, active.request.id);
            fs.rmSync(path.join(manifest.processingDir, active.request.id), { recursive: true, force: true });
            active = null;
          }
        }
      }
      if (active) {
        const terminationConfirmed = active.prepared.terminate(owned);
        if (owned && brokerOwns() && active.request.family === 'task-finalization') {
          const recovered = finalizationRecoveryResponse(manifest, active.request.id, 0);
          const view = recovered.status === 'matched'
            ? publishFinalizationTaskView(manifest, broker, active.request.id, 'healthy', null, null)
            : null;
          if (view?.state !== 'unknown' && recovered.status === 'matched' && recovered.response
            && writeSandboxControlResponse(manifest, recovered.response)) {
            if (terminationConfirmed && brokerOwns()) {
              removeAcceptedResponse(manifest, active.request.id);
              fs.rmSync(path.join(manifest.processingDir, active.request.id), { recursive: true, force: true });
              active = null;
            }
          }
        }
        if (owned && brokerOwns() && active && active.request.family !== 'task-finalization' && !active.resultEvidenceWritten) {
          writeSandboxControlResponse(manifest, unknown(active.request.id));
        }
      }
    }
    if (brokerOwns()) {
      appendDiagnosticAudit(manifest, 'broker-stop', { pid: broker.pid, brokerId: broker.brokerId });
      try {
        if (fs.readFileSync(brokerPath, 'utf8') === brokerRecord) fs.unlinkSync(brokerPath);
      } catch {
        // A newer owner or recovery path owns the record.
      }
    }
  }
}
