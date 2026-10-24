import { createHash } from 'node:crypto';

import type { LoadedContext, PlatformClient } from './context.ts';
import { resolvePlatformProviderContext } from './context.ts';
import { providerError, providerOperationContext, providerResourceToken, providerStatus, unsupportedProviderOperation } from './provider-bridge.ts';
import type { ResourceIdentity } from './resource-identity.ts';
import { parseResourceIdentity, resourceIdentityNumber } from './resource-identity.ts';
import type { ManagedSummaryExecution, ManagedSummaryIntent, PlatformOperation } from '../task/platform-operation-journal.ts';
import { recordPlatformOperation } from '../task/platform-operation-journal.ts';
import type { PlatformError, PlatformResult } from './types.ts';
import { platformResult } from './types.ts';

type ManagedSummaryKind = 'pull-request-summary' | 'summary-comment' | 'cancel-comment';
type ManagedSummaryRemoteComment = Readonly<{
  id: string;
  body: string;
  author: string | null;
  createdSequence: number | null;
}>;
type ManagedSummaryPrepared = Readonly<{
  parent: ResourceIdentity;
  marker: string;
  body: string;
  position: 'none' | 'summary-last';
  fence: ManagedSummaryExecution['fence'];
  authorizationDigest?: string;
}>;
type ManagedSummaryPolicy = Readonly<{
  kind: ManagedSummaryKind;
  taskRef: string;
  target: string;
  requestDigest: string;
  dependency: 'deferred' | 'required';
  cwd: string;
  client?: PlatformClient;
  loaded?: LoadedContext;
  agent: string;
  prepare: () => Promise<ManagedSummaryPrepared>;
  validate: (execution: ManagedSummaryExecution, phase: 'before-write' | 'readback' | 'recovery') => Promise<PlatformError | null>;
  positionSatisfied?: (comments: readonly ManagedSummaryRemoteComment[], marker: string) => boolean;
  authorizeReposition?: (comment: ManagedSummaryRemoteComment, currentUser: string | null) => PlatformError | null;
}>;

type ManagedSummaryOutput = Readonly<{
  result: PlatformResult;
  action: 'create' | 'update' | 'reposition' | 'no-op';
}>;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function markerBody(body: string): string {
  return body.replace(/\r\n/g, '\n').split('\n', 1)[0] || '';
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, '\n').replace(/\n+$/, '\n');
}

function remoteComments(loaded: LoadedContext, parent: ResourceIdentity): Promise<
  | { ok: true; comments: ManagedSummaryRemoteComment[] }
  | { ok: false; error: PlatformError }
> {
  const list = loaded.provider.comments?.list
    ? loaded.provider.comments.list({ context: providerOperationContext(loaded), parent })
    : Promise.resolve(unsupportedProviderOperation(loaded.provider, 'comments.list'));
  return list.then((response) => response.ok
    ? {
      ok: true as const,
      comments: response.value.map((comment) => ({
        id: String(comment.id),
        body: comment.body,
        author: comment.author?.name ?? null,
        createdSequence: comment.createdSequence
      }))
    }
    : { ok: false as const, error: providerError(response.error, 'PLATFORM_PROVIDER_OPERATION_FAILED') });
}

function errorResult(loaded: LoadedContext, parent: ResourceIdentity | null, error: PlatformError, action: ManagedSummaryOutput['action'] = 'no-op', parentKind: 'issue' | 'pull-request' = 'issue'): ManagedSummaryOutput {
  return {
    action,
    result: platformResult(providerStatus(error), {
      platform: loaded.context.platform,
      capabilities: loaded.context.capabilities,
      operations: loaded.context.operations,
      resource: {
        kind: parentKind,
        number: parent ? resourceIdentityNumber(parent) : null,
        ...(parent ? { identity: parent } : {})
      },
      error
    })
  };
}

function recordExecution(policy: ManagedSummaryPolicy, operation: PlatformOperation, execution: ManagedSummaryExecution, state: PlatformOperation['state'], lastCode: string | null = null): void {
  const intent: ManagedSummaryIntent = { requestDigest: policy.requestDigest, execution };
  recordPlatformOperation({
    taskRef: policy.taskRef,
    cwd: policy.cwd,
    kind: operation.kind,
    target: operation.target,
    expectedDigest: operation.expectedDigest,
    stableId: operation.id,
    dependency: operation.dependency,
    state,
    lastCode,
    managedSummary: intent,
    ...(operation.pullRequestSummary ? { pullRequestSummary: operation.pullRequestSummary } : {})
  });
}

function operationResult(
  loaded: LoadedContext,
  execution: ManagedSummaryExecution,
  action: ManagedSummaryOutput['action'],
  status: 'applied' | 'no-op' | 'blocked' | 'failed',
  error: PlatformError | null = null,
  changed = status === 'applied'
): ManagedSummaryOutput {
  return {
    action,
    result: platformResult(status, {
      changed,
      platform: loaded.context.platform,
      capabilities: loaded.context.capabilities,
      operations: [{ name: `summary:${action}`, status: status === 'applied' ? 'applied' : status === 'no-op' ? 'no-op' : 'failed', reasonCode: error?.code ?? null }],
      resource: {
        kind: execution.parentKind,
        number: resourceIdentityNumber(execution.parent),
        identity: execution.parent
      },
      comment: {
        kind: execution.marker.includes(':cancel -->') ? 'cancel' : 'summary',
        marker: execution.marker,
        ids: execution.remoteId ? [/^\d+$/u.test(execution.remoteId) ? Number(execution.remoteId) : execution.remoteId] : [],
        parts: 1
      },
      error
    })
  };
}

async function listForExecution(policy: ManagedSummaryPolicy, loaded: LoadedContext, execution: ManagedSummaryExecution) {
  const observed = await remoteComments(loaded, execution.parent);
  if (!observed.ok) return { ok: false as const, result: errorResult(loaded, execution.parent, observed.error, execution.action) };
  const matches = observed.comments.filter((comment) => markerBody(comment.body) === execution.marker);
  if (matches.length > 1) return { ok: false as const, result: errorResult(loaded, execution.parent, {
    code: policy.kind === 'pull-request-summary' ? 'PR_SUMMARY_MARKER_AMBIGUOUS' : 'MANAGED_SUMMARY_MARKER_AMBIGUOUS',
    message: policy.kind === 'pull-request-summary' ? 'Multiple PR comments contain the summary marker' : 'Multiple comments use the managed summary marker', retryable: false
  }, execution.action) };
  return { ok: true as const, comments: observed.comments, current: matches[0] ?? null };
}

function matchesFrozenPreimage(current: ManagedSummaryRemoteComment | null, execution: ManagedSummaryExecution): boolean {
  if (execution.action === 'reposition' && (execution.phase === 'deleted' || execution.phase === 'prepared')) return current === null;
  if (execution.preimage.kind === 'absent') return current === null;
  return current?.id === execution.preimage.id && normalizeBody(current.body) === normalizeBody(execution.preimage.body);
}

function hasFrozenPostimage(current: ManagedSummaryRemoteComment | null, positionOk: boolean, execution: ManagedSummaryExecution): boolean {
  return Boolean(current && normalizeBody(current.body) === normalizeBody(execution.body) && positionOk);
}

function unknownOutcome(policy: ManagedSummaryPolicy, operation: PlatformOperation, loaded: LoadedContext, execution: ManagedSummaryExecution): ManagedSummaryOutput {
  recordExecution(policy, operation, execution, 'unknown', 'MANAGED_SUMMARY_OUTCOME_UNKNOWN');
  return errorResult(loaded, execution.parent, {
    code: 'MANAGED_SUMMARY_OUTCOME_UNKNOWN',
    message: 'Remote summary differs from both the frozen preimage and expected content; operation remains pending for safe recovery',
    retryable: true
  }, execution.action);
}

async function observeOrRetry(policy: ManagedSummaryPolicy, operation: PlatformOperation, loaded: LoadedContext, execution: ManagedSummaryExecution, reportedError?: PlatformError): Promise<ManagedSummaryOutput> {
  const observed = await listForExecution(policy, loaded, execution);
  if (!observed.ok) return observed.result;
  const current = observed.current;
  const positionOk = execution.position === 'none'
    || (policy.positionSatisfied?.(observed.comments, execution.marker) ?? false);
  if (hasFrozenPostimage(current, positionOk, execution)) {
    const validation = await policy.validate(execution, 'recovery');
    if (validation) return errorResult(loaded, execution.parent, validation, execution.action);
    recordExecution(policy, operation, { ...execution, phase: 'written', remoteId: current!.id }, 'succeeded');
    return operationResult(loaded, { ...execution, remoteId: current!.id }, execution.action, 'no-op', null, false);
  }
  if (!matchesFrozenPreimage(current, execution)) return unknownOutcome(policy, operation, loaded, execution);
  if (reportedError) {
    recordExecution(policy, operation, execution, 'unknown', reportedError.code);
    return errorResult(loaded, execution.parent, reportedError, execution.action);
  }
  const ready = execution.action === 'reposition' && execution.phase === 'prepared' && !current
    ? { ...execution, phase: 'deleted' as const }
    : execution;
  if (ready !== execution) recordExecution(policy, operation, ready, 'pending');
  return performWrite(policy, operation, loaded, ready, observed.comments, true);
}

async function compensate(
  policy: ManagedSummaryPolicy,
  operation: PlatformOperation,
  loaded: LoadedContext,
  execution: ManagedSummaryExecution,
  error: PlatformError
): Promise<ManagedSummaryOutput> {
  if (execution.action === 'reposition' || !execution.remoteId) {
    recordExecution(policy, operation, execution, 'unknown', error.code);
    return errorResult(loaded, execution.parent, error, execution.action);
  }
  const observed = await listForExecution(policy, loaded, execution);
  const current = observed.ok ? observed.current : null;
  if (!observed.ok || !isControlledPostimage(current, execution)) {
    recordExecution(policy, operation, execution, 'unknown', error.code);
    return errorResult(loaded, execution.parent, {
      code: 'MANAGED_SUMMARY_COMPENSATION_UNSAFE',
      message: 'The written summary is no longer verifiably controlled by this operation; it was left untouched', retryable: true
    }, execution.action);
  }
  const restored = await restorePreimage(loaded, execution);
  if (!restored.ok) {
    recordExecution(policy, operation, execution, 'unknown', 'MANAGED_SUMMARY_COMPENSATION_FAILED');
    const failure = providerError(restored.error, 'MANAGED_SUMMARY_COMPENSATION_FAILED');
    return errorResult(loaded, execution.parent, {
      code: 'MANAGED_SUMMARY_COMPENSATION_FAILED',
      message: failure.message,
      retryable: true
    }, execution.action);
  }
  const final = await remoteComments(loaded, execution.parent);
  if (!final.ok || !compensationRestored(final.comments, execution)) {
    recordExecution(policy, operation, execution, 'unknown', 'MANAGED_SUMMARY_COMPENSATION_FAILED');
    return errorResult(loaded, execution.parent, {
      code: 'MANAGED_SUMMARY_COMPENSATION_FAILED', message: 'Compensation could not be verified; operation remains pending', retryable: true
    }, execution.action);
  }
  recordExecution(policy, operation, execution, 'failed', error.code);
  return errorResult(loaded, execution.parent, error, execution.action);
}

function isControlledPostimage(current: ManagedSummaryRemoteComment | null, execution: ManagedSummaryExecution): boolean {
  return Boolean(current && current.id === execution.remoteId && normalizeBody(current.body) === normalizeBody(execution.body));
}

async function restorePreimage(loaded: LoadedContext, execution: ManagedSummaryExecution) {
  if (execution.action === 'create') return loaded.provider.comments?.delete
    ? loaded.provider.comments.delete({
      context: providerOperationContext(loaded), parent: execution.parent,
      comment: providerResourceToken(loaded.provider, 'comment', execution.remoteId!),
      mutation: { idempotencyKey: `${execution.idempotencyKey}:compensate` }
    })
    : unsupportedProviderOperation(loaded.provider, 'comments.delete');
  if (execution.preimage.kind !== 'comment' || !loaded.provider.comments?.write) return unsupportedProviderOperation(loaded.provider, 'comments.write');
  return loaded.provider.comments.write({
    context: providerOperationContext(loaded), parent: execution.parent, body: execution.preimage.body,
    existingComment: providerResourceToken(loaded.provider, 'comment', execution.preimage.id),
    mutation: { idempotencyKey: `${execution.idempotencyKey}:compensate` }
  });
}

function compensationRestored(comments: readonly ManagedSummaryRemoteComment[], execution: ManagedSummaryExecution): boolean {
  const after = comments.filter((comment) => markerBody(comment.body) === execution.marker);
  if (execution.action === 'create') return after.length === 0;
  return execution.preimage.kind === 'comment' && after.length === 1
    && after[0]!.id === execution.preimage.id
    && normalizeBody(after[0]!.body) === normalizeBody(execution.preimage.body);
}

async function performWrite(
  policy: ManagedSummaryPolicy,
  operation: PlatformOperation,
  loaded: LoadedContext,
  initial: ManagedSummaryExecution,
  comments: readonly ManagedSummaryRemoteComment[],
  replay: boolean
): Promise<ManagedSummaryOutput> {
  const validation = await policy.validate(initial, replay ? 'recovery' : 'before-write');
  if (validation) return errorResult(loaded, initial.parent, validation, initial.action);
  let execution = initial;
  if (execution.action === 'reposition') {
    const reposition = await prepareReposition(policy, operation, loaded, execution, comments);
    if (reposition.result) return reposition.result;
    execution = reposition.execution;
  }
  const written = await writeFrozenBody(loaded, execution);
  if (!written.ok) return observeOrRetry(policy, operation, loaded, execution, providerError(written.error, 'MANAGED_SUMMARY_WRITE_FAILED'));
  execution = { ...execution, phase: 'written', remoteId: written.value.remoteId };
  try { recordExecution(policy, operation, execution, 'pending'); }
  catch { return observeOrRetry(policy, operation, loaded, execution); }
  return verifyWrite(policy, operation, loaded, execution);
}

async function prepareReposition(
  policy: ManagedSummaryPolicy,
  operation: PlatformOperation,
  loaded: LoadedContext,
  execution: ManagedSummaryExecution,
  comments: readonly ManagedSummaryRemoteComment[]
): Promise<{ execution: ManagedSummaryExecution; result?: ManagedSummaryOutput }> {
  const preimage = execution.preimage;
  if (execution.phase !== 'deleted') {
    if (preimage.kind !== 'comment' || !loaded.provider.comments?.delete) return { execution, result: errorResult(loaded, execution.parent, {
      code: 'MANAGED_SUMMARY_REPOSITION_INVALID', message: 'Reposition requires a verified existing summary and provider delete support', retryable: false
    }, execution.action) };
    const old = comments.find((comment) => comment.id === preimage.id);
    if (!old || normalizeBody(old.body) !== normalizeBody(preimage.body)) return { execution, result: errorResult(loaded, execution.parent, {
      code: 'MANAGED_SUMMARY_PREIMAGE_CHANGED', message: 'The summary changed after planning; no write was attempted', retryable: true
    }, execution.action) };
    const deleted = await loaded.provider.comments.delete({
      context: providerOperationContext(loaded), parent: execution.parent,
      comment: providerResourceToken(loaded.provider, 'comment', old.id), mutation: { idempotencyKey: `${execution.idempotencyKey}:delete` }
    });
    if (!deleted.ok) return { execution, result: await observeOrRetry(policy, operation, loaded, execution, providerError(deleted.error, 'MANAGED_SUMMARY_DELETE_FAILED')) };
    execution = { ...execution, phase: 'deleted' };
    recordExecution(policy, operation, execution, 'pending');
  }
  const beforeCreate = await listForExecution(policy, loaded, execution);
  if (!beforeCreate.ok) return { execution, result: beforeCreate.result };
  if (beforeCreate.current) return { execution, result: errorResult(loaded, execution.parent, {
    code: 'MANAGED_SUMMARY_REPOSITION_CONFLICT', message: 'A summary marker appeared at the destination during reposition', retryable: true
  }, execution.action) };
  return { execution };
}

async function writeFrozenBody(loaded: LoadedContext, execution: ManagedSummaryExecution) {
  const existing = execution.action === 'update' && execution.preimage.kind === 'comment'
    ? providerResourceToken(loaded.provider, 'comment', execution.preimage.id)
    : undefined;
  return loaded.provider.comments?.write
    ? loaded.provider.comments.write({
      context: providerOperationContext(loaded), parent: execution.parent, body: execution.body,
      ...(existing ? { existingComment: existing } : {}), mutation: { idempotencyKey: execution.idempotencyKey }
    })
    : unsupportedProviderOperation(loaded.provider, 'comments.write');
}

async function verifyWrite(policy: ManagedSummaryPolicy, operation: PlatformOperation, loaded: LoadedContext, execution: ManagedSummaryExecution): Promise<ManagedSummaryOutput> {
  const validationAfter = await policy.validate(execution, 'readback');
  const readback = await listForExecution(policy, loaded, execution);
  const positionOk = execution.position === 'none' || (policy.positionSatisfied?.(readback.ok ? readback.comments : [], execution.marker) ?? true);
  if (!validationAfter && readback.ok && readback.current
    && readback.current.id === execution.remoteId
    && normalizeBody(readback.current.body) === normalizeBody(execution.body)
    && positionOk) {
    recordExecution(policy, operation, execution, 'succeeded');
    return operationResult(loaded, execution, execution.action, 'applied');
  }
  const postWriteError = validationAfter
    ? execution.parentKind === 'pull-request' && validationAfter.code !== 'PR_SUMMARY_HEAD_RACE'
      ? { ...validationAfter, code: 'PR_SUMMARY_POSTWRITE_VERIFY_FAILED', retryable: true }
      : validationAfter
    : {
      code: execution.parentKind === 'pull-request' ? 'PR_SUMMARY_POSTWRITE_VERIFY_FAILED' : 'SUMMARY_BODY_READBACK_FAILED',
      message: 'Remote summary did not match the frozen expected body or position', retryable: true
    };
  return compensate(policy, operation, loaded, execution, postWriteError);
}

async function preparedIntent(policy: ManagedSummaryPolicy, loaded: LoadedContext): Promise<{ prepared: ManagedSummaryPrepared } | { result: ManagedSummaryOutput }> {
  try { return { prepared: await policy.prepare() }; }
  catch (error) {
    const value = error as { code?: string; message?: string; retryable?: boolean };
    let parent: ResourceIdentity | null = null;
    try { parent = parseResourceIdentity(JSON.parse(policy.target), 'managed summary target'); } catch { /* Target is unavailable before preparation. */ }
    return { result: errorResult(loaded, parent, {
      code: value.code || 'MANAGED_SUMMARY_PREPARATION_FAILED',
      message: value.message || String(error), retryable: value.retryable ?? false
    }, 'no-op', policy.kind === 'pull-request-summary' ? 'pull-request' : 'issue') };
  }
}

function ambiguousMarker(policy: ManagedSummaryPolicy): PlatformError {
  return {
    code: policy.kind === 'pull-request-summary' ? 'PR_SUMMARY_MARKER_AMBIGUOUS' : 'MANAGED_SUMMARY_MARKER_AMBIGUOUS',
    message: policy.kind === 'pull-request-summary' ? 'Multiple PR comments contain the summary marker' : 'Multiple comments use the managed summary marker',
    retryable: false
  };
}

function noOpExecution(policy: ManagedSummaryPolicy, operation: PlatformOperation, prepared: ManagedSummaryPrepared, current: ManagedSummaryRemoteComment): ManagedSummaryExecution {
  return {
    parentKind: policy.kind === 'pull-request-summary' ? 'pull-request' : 'issue', parent: prepared.parent,
    marker: prepared.marker, body: prepared.body, bodyDigest: digest(prepared.body), action: 'update', phase: 'prepared',
    preimage: { kind: 'comment', id: current.id, body: current.body, bodyDigest: digest(current.body) },
    fence: prepared.fence, position: prepared.position, idempotencyKey: `${operation.id}:noop`,
    ...(prepared.authorizationDigest ? { authorizationDigest: prepared.authorizationDigest } : {})
  };
}

async function returnNoop(policy: ManagedSummaryPolicy, operation: PlatformOperation, loaded: LoadedContext, prepared: ManagedSummaryPrepared, current: ManagedSummaryRemoteComment): Promise<ManagedSummaryOutput> {
  const validation = await policy.validate(noOpExecution(policy, operation, prepared, current), 'readback');
  if (validation) return errorResult(loaded, prepared.parent, validation, 'no-op', policy.kind === 'pull-request-summary' ? 'pull-request' : 'issue');
  return { action: 'no-op', result: platformResult('no-op', {
    platform: loaded.context.platform, capabilities: loaded.context.capabilities,
    resource: { kind: policy.kind === 'pull-request-summary' ? 'pull-request' : 'issue', number: resourceIdentityNumber(prepared.parent), identity: prepared.parent },
    comment: { kind: prepared.marker.includes(':cancel -->') ? 'cancel' : 'summary', marker: prepared.marker, ids: [/^\d+$/u.test(current.id) ? Number(current.id) : current.id], parts: 1 },
    error: null
  }) };
}

function plannedAction(policy: ManagedSummaryPolicy, loaded: LoadedContext, prepared: ManagedSummaryPrepared, comments: readonly ManagedSummaryRemoteComment[], current: ManagedSummaryRemoteComment | null): { action: ManagedSummaryExecution['action'] } | { result: ManagedSummaryOutput } {
  if (!current) return { action: 'create' };
  if (prepared.position !== 'summary-last' || (policy.positionSatisfied?.(comments, prepared.marker) ?? true)) return { action: 'update' };
  const authorization = policy.authorizeReposition?.(current, loaded.context.platform.currentUser ?? null);
  return authorization ? { result: errorResult(loaded, prepared.parent, authorization) } : { action: 'reposition' };
}

function freezeExecution(policy: ManagedSummaryPolicy, operation: PlatformOperation, prepared: ManagedSummaryPrepared, action: ManagedSummaryExecution['action'], current: ManagedSummaryRemoteComment | null): ManagedSummaryExecution {
  return {
    parentKind: policy.kind === 'pull-request-summary' ? 'pull-request' : 'issue', parent: prepared.parent,
    marker: prepared.marker, body: prepared.body, bodyDigest: digest(prepared.body), action, phase: 'prepared',
    preimage: current
      ? { kind: 'comment', id: current.id, body: current.body, bodyDigest: digest(current.body) }
      : { kind: 'absent' },
    fence: prepared.fence, position: prepared.position, idempotencyKey: `${operation.id}:${action}`,
    ...(prepared.authorizationDigest ? { authorizationDigest: prepared.authorizationDigest } : {})
  };
}

async function executeFreshSummary(policy: ManagedSummaryPolicy, operation: PlatformOperation, loaded: LoadedContext): Promise<ManagedSummaryOutput> {
  const input = await preparedIntent(policy, loaded);
  if ('result' in input) return input.result;
  const { prepared } = input;
  const listed = await remoteComments(loaded, prepared.parent);
  if (!listed.ok) return errorResult(loaded, prepared.parent, listed.error);
  const matches = listed.comments.filter((comment) => markerBody(comment.body) === prepared.marker);
  if (matches.length > 1) return errorResult(loaded, prepared.parent, ambiguousMarker(policy));
  const current = matches[0] ?? null;
  const positionOk = prepared.position === 'none' || (policy.positionSatisfied?.(listed.comments, prepared.marker) ?? true);
  if (current && normalizeBody(current.body) === normalizeBody(prepared.body) && positionOk) return returnNoop(policy, operation, loaded, prepared, current);
  const plan = plannedAction(policy, loaded, prepared, listed.comments, current);
  if ('result' in plan) return plan.result;
  const execution = freezeExecution(policy, operation, prepared, plan.action, current);
  recordExecution(policy, operation, execution, 'pending');
  return performWrite(policy, operation, loaded, execution, listed.comments, false);
}

async function executeManagedSummary(policy: ManagedSummaryPolicy, operation: PlatformOperation): Promise<ManagedSummaryOutput> {
  const loaded = policy.loaded
    ? { ok: true as const, value: policy.loaded }
    : await resolvePlatformProviderContext({ cwd: policy.cwd, client: policy.client });
  if (!loaded.ok) return { action: 'no-op', result: loaded.context };
  const intent = operation.managedSummary;
  if (!intent) return errorResult(loaded.value, null, {
    code: 'MANAGED_SUMMARY_EXECUTION_EVIDENCE_MISSING',
    message: 'Pending managed summary has no frozen preimage/postimage evidence; no remote mutation was attempted',
    retryable: true
  });
  return intent.execution
    ? observeOrRetry(policy, operation, loaded.value, intent.execution)
    : executeFreshSummary(policy, operation, loaded.value);
}

export { executeManagedSummary, digest as managedSummaryDigest };
export type { ManagedSummaryKind, ManagedSummaryOutput, ManagedSummaryPolicy, ManagedSummaryPrepared, ManagedSummaryRemoteComment };
