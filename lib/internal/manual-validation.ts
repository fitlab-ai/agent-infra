import fs from 'node:fs';
import path from 'node:path';

import { activityWarnings } from '../task/activity-log.ts';
import { lifecycleExecutions } from '../task/lifecycle-execution.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { prepareAndRenderPrSummaryContent } from '../platform/pr-summary.ts';
import { applyTaskEvent } from '../task/events.ts';
import { normalizeAgentToken } from '../agent-clients/tokens.ts';
import { createManualValidationReceipt, manualValidationFinalSummaryDigest, manualValidationFinalSummaryProjectionMatches, readManualValidationReceipt, writeManualValidationReceiptAtomic } from '../task/manual-validation-receipt.ts';
import { archiveManualValidationGeneration, createManualValidationTransaction, readManualValidationTransaction, retryManualValidationTransaction, summaryPreimageDigest, transitionManualValidationTransaction, validateManualValidationGenerationArchive, writeManualValidationTransactionAtomic } from '../task/manual-validation-transaction.ts';
import type { ManualValidationTransaction, ManualValidationTransactionResult } from '../task/manual-validation-transaction.ts';
import type { ManualValidationReceipt } from '../task/manual-validation-receipt.ts';
import { sha256File } from '../task/artifact-receipts.ts';
import { summaryCommentState } from '../platform/pr-summary.ts';
import { syncPullRequestSummary } from '../platform/coordinated-writes.ts';
import type { PlatformClient } from '../platform/context.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = `Usage: agent-infra-internal manual-validation transaction <task-ref> --prepare --artifact <artifact> --summary-file <path> --agent <agent> [--cwd <path>]
       agent-infra-internal manual-validation transaction <task-ref> --artifact <artifact> --summary-file <path> --change-report-file <path> --agent <agent> [--result pr_created|pr_reused|no_op] [--cwd <path>]`;

type OutputFormat = 'json' | 'text';
type ManualValidationCoordinatorOptions = {
  client?: PlatformClient;
  archiveGeneration?: typeof archiveManualValidationGeneration;
};
type ManualValidationResult = {
  status: 'applied' | 'failed';
  changed: false;
  error: { code: string; message: string } | null;
  transaction?: ManualValidationTransaction;
  receipt?: ManualValidationReceipt;
  prepared?: boolean;
  idempotent?: boolean;
  [key: string]: unknown;
};
function result(status: 'applied' | 'failed', error: { code: string; message: string } | null = null, extra: Record<string, unknown> = {}): ManualValidationResult {
  return { status, changed: false, error, ...extra };
}

function printFailure(format: OutputFormat, error: { code: string; message: string }): void {
  if (format === 'json') process.stdout.write(`${JSON.stringify(result('failed', error))}\n`);
  else process.stderr.write(`${error.code}: ${error.message}\n`);
  process.exitCode = 1;
}

function manualSummaryBody(body: string, phase: 'pending' | 'final'): string {
  const content = JSON.parse(body) as Record<string, unknown>;
  const manual = content.manualValidation as Record<string, unknown>;
  manual.state = phase === 'pending' ? 'pending' : 'passed';
  return JSON.stringify(content);
}

function renderedManualSummaryBody(body: string, phase: 'pending' | 'final', taskContent: string): string {
  return prepareAndRenderPrSummaryContent(JSON.parse(manualSummaryBody(body, phase)), taskContent).rendered;
}

function openManualValidationStarted(taskMdPath: string): { present: boolean; transactionId: string | null } {
  let content: string;
  try { content = fs.readFileSync(taskMdPath, 'utf8'); }
  catch { return { present: false, transactionId: null }; }
  const row = lifecycleExecutions(content)
    .filter((item) => item.family === 'manual-validation')
    .at(-1);
  if (!row) return { present: false, transactionId: null };
  return {
    present: true,
    transactionId: row.transactionId ?? null
  };
}

async function executeManualValidationTransaction(taskRef: string, values: Record<string, string>, cwd: string, options: ManualValidationCoordinatorOptions = {}) {
  const prepareOnly = values.prepare === 'true';
  const required = prepareOnly
    ? ['artifact', 'summaryFile', 'agent'] as const
    : ['artifact', 'summaryFile', 'changeReportFile', 'agent'] as const;
  const missing = required.find((key) => !values[key]);
  if (missing) return result('failed', { code: 'MANUAL_VALIDATION_TRANSACTION_ARGS_INVALID', message: `transaction requires --${missing.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}` });
  const agent = normalizeAgentToken(values.agent!);
  if (!agent) return result('failed', { code: 'MANUAL_VALIDATION_TRANSACTION_ARGS_INVALID', message: 'transaction agent is invalid' });
  const primaryResult = values.result ?? 'no_op';
  if (!['pr_created', 'pr_reused', 'no_op'].includes(primaryResult)) return result('failed', { code: 'MANUAL_VALIDATION_TRANSACTION_ARGS_INVALID', message: '--result must be pr_created, pr_reused, or no_op' });
  const resolved = resolveTaskRef(taskRef, { repoRoot: cwd });
  if (!resolved.ok) return result('failed', { code: resolved.code, message: resolved.message });
  return executeManualValidationTransactionAtResolvedTask(taskRef, values, cwd, resolved, agent, primaryResult as 'pr_created' | 'pr_reused' | 'no_op', prepareOnly, options);
}

function selectManualValidationGeneration(
  resolved: Extract<ReturnType<typeof resolveTaskRef>, { ok: true }>,
  pullRequest: ManualValidationPullRequest,
  evidenceDigest: string,
  artifact: string
): ManualValidationGenerationSelection {
  let transactionResult = readManualValidationTransaction(resolved.taskDir, {
    taskId: resolved.taskId,
    prNumber: pullRequest.number,
    prHeadSha: pullRequest.head.sha,
    evidenceDigest,
    artifact
  });
  let previousTransaction: ManualValidationTransaction | null = null;
  if (!transactionResult.ok && transactionResult.error.code === 'MANUAL_VALIDATION_TRANSACTION_IDENTITY_MISMATCH') {
    const existing = readManualValidationTransaction(resolved.taskDir);
    if (!existing.ok) return { error: existing.error };
    if (!['aborted', 'recovery-required', 'committed'].includes(existing.value.phase)) return { error: transactionResult.error };
    try { validateManualValidationGenerationArchive(resolved.taskDir, existing.value, existing.value.phase === 'committed'); }
    catch (error) {
      return { error: { code: 'MANUAL_VALIDATION_TRANSACTION_RECOVERY_REQUIRED', message: error instanceof Error ? error.message : String(error) } };
    }
    previousTransaction = existing.value;
    transactionResult = { ok: false, error: { code: 'MANUAL_VALIDATION_TRANSACTION_MISSING', message: 'previous failed transaction was archived for a new pull-request head' } };
  }
  if (!transactionResult.ok && transactionResult.error.code !== 'MANUAL_VALIDATION_TRANSACTION_MISSING') return { error: transactionResult.error };
  return { transactionResult, previousTransaction };
}

async function loadManualValidationInputs(
  taskRef: string,
  values: Record<string, string>,
  cwd: string,
  resolved: Extract<ReturnType<typeof resolveTaskRef>, { ok: true }>,
  agent: string,
  primaryResult: 'pr_created' | 'pr_reused' | 'no_op',
  prepareOnly: boolean,
  options: ManualValidationCoordinatorOptions
): Promise<{ input: ManualValidationInputContext } | { result: ManualValidationResult }> {
  const artifactPath = path.resolve(resolved.taskDir, values.artifact!);
  if (!prepareOnly && !fs.existsSync(artifactPath)) return { result: result('failed', { code: 'MANUAL_VALIDATION_ARTIFACT_MISSING', message: `manual-validation artifact is missing: ${values.artifact}` }) };
  const currentState = await summaryCommentState(taskRef, { cwd, client: options.client });
  if (!currentState.pullRequest) return { result: result('failed', { code: 'MANUAL_VALIDATION_PR_REQUIRED', message: 'canonical pull-request head is unavailable' }) };
  const pullRequest = currentState.pullRequest;
  const preimageBody = currentState.comment?.body ?? '';
  const preimage = { commentId: currentState.comment?.id ?? null, body: preimageBody, digest: summaryPreimageDigest(preimageBody) };
  const finalBodyWithoutReceipt = fs.readFileSync(path.resolve(cwd, values.summaryFile!), 'utf8');
  const taskContent = fs.readFileSync(resolved.taskMdPath, 'utf8');
  const evidenceDigest = sha256File(path.resolve(cwd, values.summaryFile!));
  return {
    input: {
      taskRef, values, cwd, resolved, agent, primaryResult, prepareOnly, options,
      artifactPath, pullRequest, preimage, finalBodyWithoutReceipt, taskContent, evidenceDigest,
      archiveGeneration: options.archiveGeneration ?? archiveManualValidationGeneration
    }
  };
}

function selectManualValidationExecution(input: ManualValidationInputContext): ManualValidationExecutionResult {
  const { values, resolved, finalBodyWithoutReceipt, taskContent } = input;
  const { pullRequest, evidenceDigest } = input;
  const generation = selectManualValidationGeneration(resolved, pullRequest, evidenceDigest, values.artifact!);
  if ('error' in generation) return { result: result('failed', generation.error) };
  const transactionResult = generation.transactionResult;
  if (transactionResult.ok && transactionResult.value.phase === 'committed') {
    return { result: result('applied', null, { transaction: transactionResult.value, receipt: transactionResult.value.committedReceipt, idempotent: true, warnings: activityWarnings(taskContent) }) };
  }
  const openStarted = transactionResult.ok ? { present: false, transactionId: null } : openManualValidationStarted(resolved.taskMdPath);
  if (openStarted.present && !openStarted.transactionId) {
    return { result: result('failed', { code: 'MANUAL_VALIDATION_TRANSACTION_RECOVERY_REQUIRED', message: 'open manual-validation started event has no recoverable transactionId' }) };
  }
  if (generation.previousTransaction && openStarted.transactionId === generation.previousTransaction.transactionId) {
    return { result: result('failed', { code: 'MANUAL_VALIDATION_TRANSACTION_RECOVERY_REQUIRED', message: 'previous manual-validation generation is still open; retry the existing transaction before starting a new generation' }) };
  }
  return {
    context: {
      ...input,
      pendingBody: manualSummaryBody(finalBodyWithoutReceipt, 'pending'),
      transactionResult,
      previousTransaction: generation.previousTransaction,
      transactionId: transactionResult.ok ? transactionResult.value.transactionId : (openStarted.transactionId ?? values.transactionId ?? `mv-${Date.now()}`),
      transaction: null,
      idempotent: transactionResult.ok,
      warnings: [],
      startedEventApplied: false
    }
  };
}

async function prepareManualValidationExecution(
  taskRef: string,
  values: Record<string, string>,
  cwd: string,
  resolved: Extract<ReturnType<typeof resolveTaskRef>, { ok: true }>,
  agent: string,
  primaryResult: 'pr_created' | 'pr_reused' | 'no_op',
  prepareOnly: boolean,
  options: ManualValidationCoordinatorOptions
): Promise<ManualValidationExecutionResult> {
  const loaded = await loadManualValidationInputs(taskRef, values, cwd, resolved, agent, primaryResult, prepareOnly, options);
  if ('result' in loaded) return loaded;
  return selectManualValidationExecution(loaded.input);
}

function createExecutionTransaction(context: ManualValidationExecutionContext): ManualValidationTransaction {
  return createManualValidationTransaction({
    transactionId: context.transactionId,
    taskId: context.resolved.taskId,
    prNumber: context.pullRequest.number,
    prHeadSha: context.pullRequest.head.sha,
    evidenceDigest: context.evidenceDigest,
    summaryPreimage: context.preimage,
    pendingSummaryDigest: summaryPreimageDigest(context.pendingBody),
    finalSummaryDigest: manualValidationFinalSummaryDigest(renderedManualSummaryBody(context.finalBodyWithoutReceipt, 'final', context.taskContent)),
    artifact: context.values.artifact!,
    attempt: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
}

function currentManualValidationWarnings(context: ManualValidationExecutionContext): { code: string; message: string }[] {
  return context.warnings.length
    ? context.warnings.filter((warning, index) => context.warnings.findIndex((item) => item.code === warning.code && item.message === warning.message) === index)
    : activityWarnings(context.taskContent);
}

function startNewManualValidationExecution(context: ManualValidationExecutionContext): ManualValidationResult | null {
  const transaction = createExecutionTransaction(context);
  const started = applyTaskEvent({ taskRef: context.taskRef, event: 'manual-validation.started', agent: context.agent, initiator: 'model', requestId: context.transactionId, reasonCode: 'user-request', transactionId: context.transactionId }, { repoRoot: context.cwd });
  if (started.status === 'failed') return result('failed', started.error ?? { code: 'MANUAL_VALIDATION_TRANSACTION_FAILED', message: 'manual-validation started event failed' });
  context.warnings.push(...(started.warnings ?? []));
  context.startedEventApplied = true;
  if (context.previousTransaction) {
    try { context.archiveGeneration(context.resolved.taskDir, context.previousTransaction, context.previousTransaction.phase === 'committed'); }
    catch (error) { return result('failed', { code: 'MANUAL_VALIDATION_TRANSACTION_RECOVERY_REQUIRED', message: error instanceof Error ? error.message : String(error) }); }
  }
  writeManualValidationTransactionAtomic(context.resolved.taskDir, transaction);
  context.transaction = transaction;
  return null;
}

function resumeManualValidationExecution(context: ManualValidationExecutionContext & { transactionResult: { ok: true; value: ManualValidationTransaction } }): ManualValidationResult | null {
  let transaction = context.transactionResult.value;
  if (['aborted', 'recovery-required'].includes(transaction.phase)) {
    const retried = retryManualValidationTransaction(transaction);
    if (!retried.ok) return result('failed', retried.error);
    transaction = retried.value;
    writeManualValidationTransactionAtomic(context.resolved.taskDir, transaction);
  }
  context.transaction = transaction;
  return null;
}

function ensureManualValidationStartedEvent(context: ManualValidationExecutionContext): ManualValidationResult | null {
  const transaction = context.transaction!;
  if (transaction.phase !== 'prepared' || context.startedEventApplied) return null;
  const started = applyTaskEvent({ taskRef: context.taskRef, event: 'manual-validation.started', agent: context.agent, initiator: 'model', requestId: transaction.transactionId, reasonCode: 'user-request', transactionId: transaction.transactionId }, { repoRoot: context.cwd });
  if (started.status === 'failed') return result('failed', started.error ?? { code: 'MANUAL_VALIDATION_TRANSACTION_FAILED', message: 'manual-validation started event failed' });
  context.warnings.push(...(started.warnings ?? []));
  return null;
}

function startOrResumeManualValidationExecution(context: ManualValidationExecutionContext): ManualValidationResult | null {
  const preparationResult = context.transactionResult.ok
    ? resumeManualValidationExecution(context as ManualValidationExecutionContext & { transactionResult: { ok: true; value: ManualValidationTransaction } })
    : startNewManualValidationExecution(context);
  if (preparationResult) return preparationResult;
  const startedResult = ensureManualValidationStartedEvent(context);
  if (startedResult) return startedResult;
  if (context.prepareOnly) return result('applied', null, { transaction: context.transaction, prepared: true, idempotent: context.idempotent, warnings: currentManualValidationWarnings(context) });
  return null;
}

function transitionAndPersistManualValidation(context: ManualValidationExecutionContext, phase: Parameters<typeof transitionManualValidationTransaction>[1], patch: Parameters<typeof transitionManualValidationTransaction>[2] = {}): void {
  const transaction = context.transaction!;
  const next = transitionManualValidationTransaction(transaction, phase, patch);
  if (!next.ok) throw new Error(`${next.error.code}: ${next.error.message}`);
  context.transaction = next.value;
  writeManualValidationTransactionAtomic(context.resolved.taskDir, next.value);
}

async function stageManualValidationPendingSummary(context: ManualValidationExecutionContext): Promise<void> {
  if (context.transaction!.phase !== 'prepared') return;
  const staged = await syncPullRequestSummary(context.taskRef, {
    cwd: context.cwd, client: context.options.client, agent: context.agent, body: context.pendingBody,
    changeReportFile: path.resolve(context.cwd, context.values.changeReportFile!),
    primaryResult: context.primaryResult, strict: true,
    manualValidation: { phase: 'pending', transactionId: context.transaction!.transactionId }
  });
  if (!['applied', 'no-op'].includes(staged.status)) throw new Error(`${(staged.error ?? { code: 'MANUAL_VALIDATION_TRANSACTION_FAILED', message: 'pending summary staging failed' }).code}: ${(staged.error ?? { code: 'MANUAL_VALIDATION_TRANSACTION_FAILED', message: 'pending summary staging failed' }).message}`);
  transitionAndPersistManualValidation(context, 'summary-staged');
}

function readOrCreateManualValidationReceipt(context: ManualValidationExecutionContext): ManualValidationReceipt {
  const transaction = context.transaction!;
  const receiptResult = readManualValidationReceipt(context.resolved.taskDir, {
    transactionId: transaction.transactionId,
    taskId: context.resolved.taskId,
    prNumber: context.pullRequest.number,
    prHeadSha: context.pullRequest.head.sha,
    evidenceDigest: transaction.evidenceDigest,
    artifact: context.values.artifact!
  });
  if (receiptResult.ok) return receiptResult.value;
  if (receiptResult.error.code !== 'MANUAL_VALIDATION_RECEIPT_MISSING') throw new Error(`${receiptResult.error.code}: ${receiptResult.error.message}`);
  const receipt = createManualValidationReceipt({
    transactionId: transaction.transactionId,
    taskId: context.resolved.taskId,
    prNumber: context.pullRequest.number,
    prHeadSha: context.pullRequest.head.sha,
    evidenceDigest: transaction.evidenceDigest,
    artifact: context.values.artifact!,
    artifactSha256: sha256File(context.artifactPath),
    pendingSummaryDigest: transaction.pendingSummaryDigest,
    finalSummaryDigest: transaction.finalSummaryDigest,
    committedAt: new Date().toISOString()
  });
  writeManualValidationReceiptAtomic(context.resolved.taskDir, receipt);
  return receipt;
}

function appendManualValidationCompletionEvent(context: ManualValidationExecutionContext, receipt: ManualValidationReceipt): void {
  const transaction = context.transaction!;
  if (transaction.phase === 'summary-staged') transitionAndPersistManualValidation(context, 'receipt-committed', { committedReceipt: receipt.receiptDigest });
  if (context.transaction!.phase !== 'receipt-committed' || context.transaction!.eventAppended) return;
  const completed = applyTaskEvent({ taskRef: context.taskRef, event: 'manual-validation.completed', agent: context.agent, initiator: 'model', requestId: transaction.transactionId, reasonCode: 'user-request', artifact: context.values.artifact, summaryResult: 'human-confirmed validation and committed receipt', transactionId: transaction.transactionId, receiptDigest: receipt.receiptDigest, prHeadSha: receipt.prHeadSha }, { repoRoot: context.cwd });
  if (completed.status === 'failed') throw new Error(`${(completed.error ?? { code: 'MANUAL_VALIDATION_TRANSACTION_FAILED', message: 'manual-validation completion event failed' }).code}: ${(completed.error ?? { code: 'MANUAL_VALIDATION_TRANSACTION_FAILED', message: 'manual-validation completion event failed' }).message}`);
  context.warnings.push(...(completed.warnings ?? []));
  transitionAndPersistManualValidation(context, 'receipt-committed', { eventAppended: true });
}

async function promoteAndVerifyManualValidationSummary(context: ManualValidationExecutionContext, receipt: ManualValidationReceipt): Promise<void> {
  if (context.transaction!.phase === 'receipt-committed') transitionAndPersistManualValidation(context, 'final-promotion-in-progress');
  const promoted = await syncPullRequestSummary(context.taskRef, {
    cwd: context.cwd, client: context.options.client, agent: context.agent,
    body: manualSummaryBody(context.finalBodyWithoutReceipt, 'final'),
    changeReportFile: path.resolve(context.cwd, context.values.changeReportFile!),
    primaryResult: context.primaryResult, strict: true,
    manualValidation: { phase: 'final', transactionId: context.transaction!.transactionId, receiptDigest: receipt.receiptDigest, prHeadSha: receipt.prHeadSha, authority: 'coordinator' }
  });
  if (!['applied', 'no-op'].includes(promoted.status)) {
    const error = promoted.error ?? { code: 'MANUAL_VALIDATION_TRANSACTION_RECOVERY_REQUIRED', message: 'final summary promotion failed' };
    throw new Error(`${error.code}: ${error.message}`);
  }
  const postWrite = await summaryCommentState(context.taskRef, { cwd: context.cwd, client: context.options.client });
  if (!/^###\s+✅\s+(?:Manual Validation Passed|人工验证已通过)\s*$/mu.test(postWrite.comment?.body ?? '') || postWrite.pullRequest?.head.sha !== receipt.prHeadSha || !manualValidationFinalSummaryProjectionMatches(postWrite.comment?.body ?? '', receipt)) {
    throw new Error('MANUAL_VALIDATION_TRANSACTION_RECOVERY_REQUIRED: final summary post-write verification failed');
  }
  transitionAndPersistManualValidation(context, 'committed', { postWriteVerified: true });
}

async function recoverFailedManualValidationExecution(context: ManualValidationExecutionContext, error: unknown): Promise<ManualValidationResult> {
  const message = error instanceof Error ? error.message : String(error);
  if (context.transaction!.phase === 'final-promotion-in-progress') {
    try {
      await syncPullRequestSummary(context.taskRef, {
        cwd: context.cwd, client: context.options.client, agent: context.agent, body: context.pendingBody,
        changeReportFile: path.resolve(context.cwd, context.values.changeReportFile!),
        primaryResult: context.primaryResult, strict: true,
        manualValidation: { phase: 'pending', transactionId: context.transaction!.transactionId }
      });
    } catch {
      // Preserve recovery-required when pending compensation cannot be confirmed.
    }
  }
  const failedTransaction = transitionManualValidationTransaction(context.transaction!, 'recovery-required', { error: message.slice(0, 400) });
  if (failedTransaction.ok) writeManualValidationTransactionAtomic(context.resolved.taskDir, failedTransaction.value);
  return result('failed', { code: 'MANUAL_VALIDATION_TRANSACTION_RECOVERY_REQUIRED', message });
}

async function executeManualValidationStages(context: ManualValidationExecutionContext): Promise<ManualValidationResult> {
  try {
    await stageManualValidationPendingSummary(context);
    const receipt = readOrCreateManualValidationReceipt(context);
    appendManualValidationCompletionEvent(context, receipt);
    await promoteAndVerifyManualValidationSummary(context, receipt);
    return result('applied', null, { transaction: context.transaction, receipt, idempotent: false, warnings: currentManualValidationWarnings(context) });
  } catch (error) {
    return recoverFailedManualValidationExecution(context, error);
  }
}

async function executeManualValidationTransactionAtResolvedTask(
  taskRef: string,
  values: Record<string, string>,
  cwd: string,
  resolved: Extract<ReturnType<typeof resolveTaskRef>, { ok: true }>,
  agent: string,
  primaryResult: 'pr_created' | 'pr_reused' | 'no_op',
  prepareOnly: boolean,
  options: ManualValidationCoordinatorOptions
) {
  const prepared = await prepareManualValidationExecution(taskRef, values, cwd, resolved, agent, primaryResult, prepareOnly, options);
  if ('result' in prepared) return prepared.result;
  const startResult = startOrResumeManualValidationExecution(prepared.context);
  if (startResult) return startResult;
  return executeManualValidationStages(prepared.context);
}

function parse(args: string[], start: number): { values: Record<string, string>; error?: string } {
  const values: Record<string, string> = {};
  for (let index = start; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--prepare') {
      if (values.prepare) return { values, error: `duplicate option '${flag}'` };
      values.prepare = 'true';
      continue;
    }
    if (!['--format', '--cwd', '--artifact', '--summary-file', '--change-report-file', '--agent', '--result'].includes(flag)) return { values, error: `unknown option '${flag}'` };
    const value = args[++index];
    if (!value || value.startsWith('--')) return { values, error: `option '${flag}' requires a value` };
    const key = flag.slice(2).replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());
    if (values[key]) return { values, error: `duplicate option '${flag}'` };
    values[key] = value;
  }
  return { values };
}

type ManualValidationInvocation = {
  taskRef: string;
  values: Record<string, string>;
  format: OutputFormat;
};

type ManualValidationPullRequest = NonNullable<Awaited<ReturnType<typeof summaryCommentState>>['pullRequest']>;
type ManualValidationExecutionContext = {
  taskRef: string;
  values: Record<string, string>;
  cwd: string;
  resolved: Extract<ReturnType<typeof resolveTaskRef>, { ok: true }>;
  agent: string;
  primaryResult: 'pr_created' | 'pr_reused' | 'no_op';
  prepareOnly: boolean;
  options: ManualValidationCoordinatorOptions;
  artifactPath: string;
  pullRequest: ManualValidationPullRequest;
  preimage: { commentId: number | string | null; body: string; digest: string };
  finalBodyWithoutReceipt: string;
  taskContent: string;
  evidenceDigest: string;
  pendingBody: string;
  archiveGeneration: typeof archiveManualValidationGeneration;
  transactionResult: ManualValidationTransactionResult;
  previousTransaction: ManualValidationTransaction | null;
  transactionId: string;
  transaction: ManualValidationTransaction | null;
  idempotent: boolean;
  warnings: { code: string; message: string }[];
  startedEventApplied: boolean;
};
type ManualValidationInputContext = Pick<ManualValidationExecutionContext,
  'taskRef' | 'values' | 'cwd' | 'resolved' | 'agent' | 'primaryResult' | 'prepareOnly' | 'options'
  | 'artifactPath' | 'pullRequest' | 'preimage' | 'finalBodyWithoutReceipt' | 'taskContent' | 'evidenceDigest' | 'archiveGeneration'>;
type ManualValidationExecutionResult = { context: ManualValidationExecutionContext } | { result: ManualValidationResult };
type ManualValidationGenerationSelection = {
  transactionResult: ManualValidationTransactionResult;
  previousTransaction: ManualValidationTransaction | null;
} | { error: { code: string; message: string } };

function resolveManualValidationInvocation(args: string[]): ManualValidationInvocation | null {
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(`${USAGE}\n`); return null; }
  const operation = args[0];
  const isTransaction = operation === 'transaction' && internalHandlerRoute('manual-validation', 'transaction', operation);
  if (!isTransaction) { printFailure('json', { code: 'MANUAL_VALIDATION_ARGS_INVALID', message: 'transaction operation is required' }); return null; }
  const taskRef = args[1];
  if (!taskRef || taskRef.startsWith('--')) { printFailure('json', { code: 'MANUAL_VALIDATION_ARGS_INVALID', message: 'task ref is required' }); return null; }
  const parsed = parse(args, 2);
  if (parsed.error) { printFailure('json', { code: 'MANUAL_VALIDATION_ARGS_INVALID', message: parsed.error }); return null; }
  const values = parsed.values;
  return { taskRef, values, format: values.format === 'text' ? 'text' : 'json' };
}

function printManualValidationOutput(format: OutputFormat, output: ManualValidationResult): void {
  process.stdout.write(format === 'json' ? `${JSON.stringify(output)}\n` : `${output.status === 'applied' ? 'Manual validation transaction committed.' : `${output.error?.code}: ${output.error?.message}`}\n`);
  if (format === 'text' && Array.isArray(output.warnings)) for (const warning of output.warnings) process.stderr.write(`${warning.code}: ${warning.message}\n`);
  if (output.status === 'failed') process.exitCode = 1;
}

async function runManualValidationCommand(args: string[]): Promise<void> {
  const invocation = resolveManualValidationInvocation(args);
  if (!invocation) return;
  const output = await executeManualValidationTransaction(invocation.taskRef, invocation.values, path.resolve(invocation.values.cwd ?? process.cwd()));
  printManualValidationOutput(invocation.format, output);
}

async function manualValidation(args: string[] = []): Promise<void> {
  if (!ensureInternalHandlerRoute('manual-validation', args)) return;
  await runManualValidationCommand(args);
}

export { executeManualValidationTransaction, manualValidation };
