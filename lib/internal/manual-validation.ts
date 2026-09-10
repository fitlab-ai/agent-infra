import fs from 'node:fs';
import path from 'node:path';

import { parseTypedTaskFrontmatter } from '../task/frontmatter.ts';
import { locateActivityLog, pairEntries } from '../task/activity-log.ts';
import { readPrDeliveryFact } from '../task/pr-delivery-fact.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { applyTaskEvent } from '../task/events.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from '../task/task-execution-lock.ts';
import { normalizeAgentToken } from '../agent-clients/tokens.ts';
import { readManualValidationEvidence, manualValidationEvidenceDigest, validateManualValidationEvidence } from '../task/manual-validation-evidence.ts';
import type { ManualValidationEvidence } from '../task/manual-validation-evidence.ts';
import { createManualValidationReceipt, manualValidationFinalSummaryDigest, manualValidationFinalSummaryProjectionMatches, readManualValidationReceipt, writeManualValidationReceiptAtomic } from '../task/manual-validation-receipt.ts';
import { archiveManualValidationGeneration, createManualValidationTransaction, readManualValidationTransaction, retryManualValidationTransaction, summaryPreimageDigest, transitionManualValidationTransaction, validateManualValidationGenerationArchive, writeManualValidationTransactionAtomic } from '../task/manual-validation-transaction.ts';
import type { ManualValidationTransaction } from '../task/manual-validation-transaction.ts';
import type { ManualValidationReceipt } from '../task/manual-validation-receipt.ts';
import { sha256File } from '../task/artifact-receipts.ts';
import { summaryCommentState, summaryContext, syncPullRequestSummary } from '../platform/pr-summary.ts';
import type { PlatformClient } from '../platform/context.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = `Usage: agent-infra-internal manual-validation verify <task-ref> --evidence-file <path> [--format json|text] [--cwd <path>]
       agent-infra-internal manual-validation transaction <task-ref> --prepare --evidence-file <path> --artifact <artifact> --summary-file <path> --agent <agent> [--cwd <path>]
       agent-infra-internal manual-validation transaction <task-ref> --evidence-file <path> --artifact <artifact> --summary-file <path> --change-report-file <path> --agent <agent> [--result pr_created|pr_reused|no_op] [--cwd <path>]`;

type VerifyOptions = { evidenceFile: string; format: 'json' | 'text'; cwd?: string; client?: PlatformClient };
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
type VerifiedManualValidation = {
  status: 'applied';
  changed: false;
  error: null;
  taskId: string;
  evidence: ManualValidationEvidence;
  evidenceDigest: string;
  pullRequest: { number: number; head: { repository: string; ref: string; sha: string }; base: { repository: string; ref: string; sha: string } };
  freshness: 'current';
};

function result(status: 'applied' | 'failed', error: { code: string; message: string } | null = null, extra: Record<string, unknown> = {}): ManualValidationResult {
  return { status, changed: false, error, ...extra };
}

function printFailure(format: VerifyOptions['format'], error: { code: string; message: string }): void {
  if (format === 'json') process.stdout.write(`${JSON.stringify(result('failed', error))}\n`);
  else process.stderr.write(`${error.code}: ${error.message}\n`);
  process.exitCode = 1;
}

async function verifyManualValidationEvidence(taskRef: string, options: VerifyOptions): Promise<VerifiedManualValidation | ReturnType<typeof result>> {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return result('failed', { code: resolved.code, message: resolved.message }, { taskId: resolved.taskId });
  let frontmatter;
  try { frontmatter = parseTypedTaskFrontmatter(fs.readFileSync(resolved.taskMdPath, 'utf8')); }
  catch (error) { return result('failed', { code: 'MANUAL_VALIDATION_EVIDENCE_INVALID', message: error instanceof Error ? error.message : String(error) }); }
  const fact = readPrDeliveryFact(frontmatter);
  if (fact.status !== 'valid' || fact.fact.state !== 'bound') return result('failed', { code: 'MANUAL_VALIDATION_EVIDENCE_PR_REQUIRED', message: 'task has no verified bound pull request' });
  const summary = await summaryContext(taskRef, { cwd: resolved.repoRoot, client: options.client });
  if (!summary.pullRequest) return result('failed', { code: 'MANUAL_VALIDATION_EVIDENCE_PR_REQUIRED', message: 'canonical pull-request head is unavailable' });
  const evidence = readManualValidationEvidence(path.resolve(resolved.repoRoot, options.evidenceFile));
  if (!evidence.ok) return result('failed', evidence.error);
  const identity = validateManualValidationEvidence(evidence.value, {
    taskId: evidence.value.mode === 'branch-only' ? null : resolved.taskId,
    branch: summary.pullRequest.head.ref,
    commit: summary.pullRequest.head.sha
  });
  if (!identity.ok) return result('failed', identity.error);
  return result('applied', null, {
    taskId: resolved.taskId,
    evidence: evidence.value,
    evidenceDigest: manualValidationEvidenceDigest(evidence.value),
    pullRequest: { number: summary.pullRequest.number, head: summary.pullRequest.head, base: summary.pullRequest.base },
    freshness: 'current'
  });
}

function manualSummaryBody(body: string, phase: 'pending' | 'final', transactionId: string, receiptDigest = '', evidenceDigest = '', prHeadSha = ''): string {
  const withoutPrevious = body
    .replace(/^###\s+✅\s+(?:Manual Validation Passed|人工验证已通过)\s*$/gmu, '')
    .replace(/^###\s+⏳\s+(?:Manual Validation Pending|人工验证待收尾)\s*$/gmu, '')
    .replace(/Manual validation passed(?:\s+→)?/giu, 'Manual validation pending');
  const section = phase === 'pending'
    ? `### ⏳ Manual Validation Pending\n\nManual validation evidence is staged; transaction ${transactionId} is awaiting final promotion.`
    : `### ✅ Manual Validation Passed\n\nManual validation passed; transaction=${transactionId}; receipt=${receiptDigest}; evidence=${evidenceDigest}; head=${prHeadSha}.`;
  return `${withoutPrevious.replace(/\s+$/u, '')}\n\n${section}\n`;
}

function openManualValidationStarted(taskMdPath: string): { present: boolean; transactionId: string | null } {
  let content: string;
  try { content = fs.readFileSync(taskMdPath, 'utf8'); }
  catch { return { present: false, transactionId: null }; }
  const section = locateActivityLog(content);
  if (!section) return { present: false, transactionId: null };
  const row = pairEntries(section.entries)
    .filter((item) => item.step === 'Complete Manual Validation' && item.started && !item.done)
    .at(-1);
  if (!row) return { present: false, transactionId: null };
  return {
    present: true,
    transactionId: /(?:^|;\s*)transaction=([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:;|$)/u.exec(row.note)?.[1] ?? null
  };
}

async function executeManualValidationTransaction(taskRef: string, values: Record<string, string>, cwd: string, options: ManualValidationCoordinatorOptions = {}) {
  const prepareOnly = values.prepare === 'true';
  const required = prepareOnly
    ? ['evidenceFile', 'artifact', 'summaryFile', 'agent'] as const
    : ['evidenceFile', 'artifact', 'summaryFile', 'changeReportFile', 'agent'] as const;
  const missing = required.find((key) => !values[key]);
  if (missing) return result('failed', { code: 'MANUAL_VALIDATION_TRANSACTION_ARGS_INVALID', message: `transaction requires --${missing.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}` });
  const agent = normalizeAgentToken(values.agent!);
  if (!agent) return result('failed', { code: 'MANUAL_VALIDATION_TRANSACTION_ARGS_INVALID', message: 'transaction agent is invalid' });
  const primaryResult = values.result ?? 'no_op';
  if (!['pr_created', 'pr_reused', 'no_op'].includes(primaryResult)) return result('failed', { code: 'MANUAL_VALIDATION_TRANSACTION_ARGS_INVALID', message: '--result must be pr_created, pr_reused, or no_op' });
  const resolved = resolveTaskRef(taskRef, { repoRoot: cwd });
  if (!resolved.ok) return result('failed', { code: resolved.code, message: resolved.message });
  try {
    return await withTaskExecutionLock(
      resolved.repoRoot,
      resolved.taskId,
      `manual-validation:${taskRef}`,
      () => executeManualValidationTransactionLocked(taskRef, values, cwd, resolved, agent, primaryResult as 'pr_created' | 'pr_reused' | 'no_op', prepareOnly, options)
    );
  } catch (error) {
    if (error instanceof TaskExecutionLockError) return result('failed', { code: error.code, message: error.message });
    throw error;
  }
}

async function executeManualValidationTransactionLocked(
  taskRef: string,
  values: Record<string, string>,
  cwd: string,
  resolved: Extract<ReturnType<typeof resolveTaskRef>, { ok: true }>,
  agent: string,
  primaryResult: 'pr_created' | 'pr_reused' | 'no_op',
  prepareOnly: boolean,
  options: ManualValidationCoordinatorOptions
) {
  const verified = await verifyManualValidationEvidence(taskRef, { evidenceFile: values.evidenceFile!, format: 'json', cwd, client: options.client });
  if (verified.status === 'failed') return verified;
  if (!('evidence' in verified) || !('pullRequest' in verified)) return result('failed', { code: 'MANUAL_VALIDATION_EVIDENCE_INVALID', message: 'verified evidence result is incomplete' });
  const verifiedSuccess = verified as VerifiedManualValidation;
  const evidence = verifiedSuccess.evidence;
  const pullRequest = verifiedSuccess.pullRequest as { number: number; head: { repository: string; ref: string; sha: string }; base: { repository: string; ref: string; sha: string } };
  const artifactPath = path.resolve(resolved.taskDir, values.artifact!);
  if (!prepareOnly && !fs.existsSync(artifactPath)) return result('failed', { code: 'MANUAL_VALIDATION_ARTIFACT_MISSING', message: `manual-validation artifact is missing: ${values.artifact}` });
  const currentState = await summaryCommentState(taskRef, { cwd, client: options.client });
  if (!currentState.pullRequest || currentState.pullRequest.head.sha !== pullRequest.head.sha) return result('failed', { code: 'MANUAL_VALIDATION_EVIDENCE_STALE', message: 'pull-request head changed before transaction preparation' });
  const preimageBody = currentState.comment?.body ?? '';
  const preimage = { commentId: currentState.comment?.id ?? null, body: preimageBody, digest: summaryPreimageDigest(preimageBody) };
  const evidenceDigest = manualValidationEvidenceDigest(evidence);
  const archiveGeneration = options.archiveGeneration ?? archiveManualValidationGeneration;
  let transactionResult = readManualValidationTransaction(resolved.taskDir, { taskId: resolved.taskId, prNumber: pullRequest.number, prHeadSha: pullRequest.head.sha, evidenceDigest, artifact: values.artifact! });
  let previousTransaction: ManualValidationTransaction | null = null;
  if (!transactionResult.ok && transactionResult.error.code === 'MANUAL_VALIDATION_TRANSACTION_IDENTITY_MISMATCH') {
    const existing = readManualValidationTransaction(resolved.taskDir);
    if (!existing.ok) return result('failed', existing.error);
    if (!['aborted', 'recovery-required', 'committed'].includes(existing.value.phase)) return result('failed', transactionResult.error);
    try { validateManualValidationGenerationArchive(resolved.taskDir, existing.value, existing.value.phase === 'committed'); }
    catch (error) { return result('failed', { code: 'MANUAL_VALIDATION_TRANSACTION_RECOVERY_REQUIRED', message: error instanceof Error ? error.message : String(error) }); }
    previousTransaction = existing.value;
    transactionResult = { ok: false, error: { code: 'MANUAL_VALIDATION_TRANSACTION_MISSING', message: 'previous failed transaction was archived for a new pull-request head' } };
  }
  if (!transactionResult.ok && transactionResult.error.code !== 'MANUAL_VALIDATION_TRANSACTION_MISSING') return result('failed', transactionResult.error);
  if (transactionResult.ok && transactionResult.value.phase === 'committed') return result('applied', null, { transaction: transactionResult.value, receipt: transactionResult.value.committedReceipt, idempotent: true });
  const openStarted = transactionResult.ok ? { present: false, transactionId: null } : openManualValidationStarted(resolved.taskMdPath);
  if (openStarted.present && !openStarted.transactionId) {
    return result('failed', { code: 'MANUAL_VALIDATION_TRANSACTION_RECOVERY_REQUIRED', message: 'open manual-validation started event has no recoverable transactionId' });
  }
  if (previousTransaction && openStarted.transactionId === previousTransaction.transactionId) {
    return result('failed', { code: 'MANUAL_VALIDATION_TRANSACTION_RECOVERY_REQUIRED', message: 'previous manual-validation generation is still open; retry the existing transaction before starting a new generation' });
  }
  const transactionId = transactionResult.ok
    ? transactionResult.value.transactionId
    : (openStarted.transactionId ?? values.transactionId ?? `mv-${Date.now()}`);
  const finalBodyWithoutReceipt = fs.readFileSync(path.resolve(cwd, values.summaryFile!), 'utf8');
  const pendingBody = manualSummaryBody(finalBodyWithoutReceipt, 'pending', transactionId);
  const createTransaction = (): ManualValidationTransaction => createManualValidationTransaction({
    transactionId,
    taskId: resolved.taskId,
    prNumber: pullRequest.number,
    prHeadSha: pullRequest.head.sha,
    evidenceDigest,
    summaryPreimage: preimage,
    pendingSummaryDigest: summaryPreimageDigest(pendingBody),
    finalSummaryDigest: manualValidationFinalSummaryDigest(manualSummaryBody(finalBodyWithoutReceipt, 'final', transactionId, '<receipt>', evidenceDigest, pullRequest.head.sha)),
    artifact: values.artifact!,
    attempt: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  let transaction: ManualValidationTransaction;
  const idempotent = transactionResult.ok;
  let startedEventApplied = false;
  if (!transactionResult.ok) {
    transaction = createTransaction();
    const started = applyTaskEvent({ taskRef, event: 'manual-validation.started', agent, initiator: 'model', requestId: transactionId, reasonCode: 'user-request', transactionId }, { lockAlreadyHeld: true, repoRoot: cwd });
    if (started.status === 'failed') return result('failed', started.error ?? { code: 'MANUAL_VALIDATION_TRANSACTION_FAILED', message: 'manual-validation started event failed' });
    startedEventApplied = true;
    if (previousTransaction) {
      try { archiveGeneration(resolved.taskDir, previousTransaction, previousTransaction.phase === 'committed'); }
      catch (error) { return result('failed', { code: 'MANUAL_VALIDATION_TRANSACTION_RECOVERY_REQUIRED', message: error instanceof Error ? error.message : String(error) }); }
    }
    writeManualValidationTransactionAtomic(resolved.taskDir, transaction);
  } else {
    transaction = transactionResult.value;
    if (['aborted', 'recovery-required'].includes(transaction.phase)) {
      const retried = retryManualValidationTransaction(transaction);
      if (!retried.ok) return result('failed', retried.error);
      transaction = retried.value;
      writeManualValidationTransactionAtomic(resolved.taskDir, transaction);
    }
  }
  if (transaction.phase === 'prepared' && !startedEventApplied) {
    const started = applyTaskEvent({ taskRef, event: 'manual-validation.started', agent, initiator: 'model', requestId: transaction.transactionId, reasonCode: 'user-request', transactionId: transaction.transactionId }, { lockAlreadyHeld: true, repoRoot: cwd });
    if (started.status === 'failed') return result('failed', started.error ?? { code: 'MANUAL_VALIDATION_TRANSACTION_FAILED', message: 'manual-validation started event failed' });
  }
  if (prepareOnly) return result('applied', null, { transaction, prepared: true, idempotent });
  const transactionFailure = (failure: { code: string; message: string }): never => {
    throw new Error(`${failure.code}: ${failure.message}`);
  };
  try {
    if (transaction.phase === 'prepared') {
      const staged = await syncPullRequestSummary(taskRef, {
        cwd, client: options.client, agent, body: pendingBody, changeReportFile: path.resolve(cwd, values.changeReportFile!), primaryResult: primaryResult as 'pr_created' | 'pr_reused' | 'no_op', strict: true,
        manualValidation: { phase: 'pending', evidenceFile: values.evidenceFile!, evidenceDigest: transaction.evidenceDigest }, lockAlreadyHeld: true
      });
      if (!['applied', 'no-op'].includes(staged.status)) transactionFailure(staged.error ?? { code: 'MANUAL_VALIDATION_TRANSACTION_FAILED', message: 'pending summary staging failed' });
      const stagedTransaction = transitionManualValidationTransaction(transaction, 'summary-staged');
      if (!stagedTransaction.ok) throw new Error(`${stagedTransaction.error.code}: ${stagedTransaction.error.message}`);
      transaction = stagedTransaction.value;
      writeManualValidationTransactionAtomic(resolved.taskDir, transaction);
    }
    let receiptResult = readManualValidationReceipt(resolved.taskDir, {
      transactionId: transaction.transactionId,
      taskId: resolved.taskId,
      prNumber: pullRequest.number,
      prHeadSha: pullRequest.head.sha,
      evidenceDigest: transaction.evidenceDigest,
      artifact: values.artifact!
    });
    if (!receiptResult.ok && receiptResult.error.code !== 'MANUAL_VALIDATION_RECEIPT_MISSING') transactionFailure(receiptResult.error);
    let receipt: ManualValidationReceipt;
    if (receiptResult.ok) {
      receipt = receiptResult.value;
    } else {
      receipt = createManualValidationReceipt({
      transactionId: transaction.transactionId,
      taskId: resolved.taskId,
      prNumber: pullRequest.number,
      prHeadSha: pullRequest.head.sha,
      evidenceDigest: transaction.evidenceDigest,
      artifact: values.artifact!,
      artifactSha256: sha256File(artifactPath),
      pendingSummaryDigest: transaction.pendingSummaryDigest,
      finalSummaryDigest: transaction.finalSummaryDigest,
      committedAt: new Date().toISOString()
      });
      writeManualValidationReceiptAtomic(resolved.taskDir, receipt);
    }
    if (transaction.phase === 'summary-staged') {
      const receiptTransaction = transitionManualValidationTransaction(transaction, 'receipt-committed', { committedReceipt: receipt.receiptDigest });
      if (!receiptTransaction.ok) throw new Error(`${receiptTransaction.error.code}: ${receiptTransaction.error.message}`);
      transaction = receiptTransaction.value;
      writeManualValidationTransactionAtomic(resolved.taskDir, transaction);
    }
    if (transaction.phase === 'receipt-committed' && !transaction.eventAppended) {
      const completed = applyTaskEvent({ taskRef, event: 'manual-validation.completed', agent, initiator: 'model', requestId: transaction.transactionId, reasonCode: 'user-request', artifact: values.artifact, summaryResult: 'verified current evidence and committed receipt', evidenceFile: values.evidenceFile, transactionId: transaction.transactionId, receiptDigest: receipt.receiptDigest, evidenceDigest: receipt.evidenceDigest, prHeadSha: receipt.prHeadSha }, { lockAlreadyHeld: true, repoRoot: cwd });
      if (completed.status === 'failed') transactionFailure(completed.error ?? { code: 'MANUAL_VALIDATION_TRANSACTION_FAILED', message: 'manual-validation completion event failed' });
      const eventTransaction = transitionManualValidationTransaction(transaction, 'receipt-committed', { eventAppended: true });
      if (!eventTransaction.ok) throw new Error(`${eventTransaction.error.code}: ${eventTransaction.error.message}`);
      transaction = eventTransaction.value;
      writeManualValidationTransactionAtomic(resolved.taskDir, transaction);
    }
    if (transaction.phase === 'receipt-committed') {
      const finalTransaction = transitionManualValidationTransaction(transaction, 'final-promotion-in-progress');
      if (!finalTransaction.ok) throw new Error(`${finalTransaction.error.code}: ${finalTransaction.error.message}`);
      transaction = finalTransaction.value;
      writeManualValidationTransactionAtomic(resolved.taskDir, transaction);
    }
    const promoted = await syncPullRequestSummary(taskRef, {
      cwd, client: options.client, agent, body: manualSummaryBody(finalBodyWithoutReceipt, 'final', transaction.transactionId, receipt.receiptDigest, receipt.evidenceDigest, receipt.prHeadSha), changeReportFile: path.resolve(cwd, values.changeReportFile!), primaryResult, strict: true,
      manualValidation: { phase: 'final', evidenceFile: values.evidenceFile!, transactionId: transaction.transactionId, receiptDigest: receipt.receiptDigest, evidenceDigest: receipt.evidenceDigest, prHeadSha: receipt.prHeadSha, authority: 'coordinator' }, lockAlreadyHeld: true
    });
    if (!['applied', 'no-op'].includes(promoted.status)) transactionFailure(promoted.error ?? { code: 'MANUAL_VALIDATION_TRANSACTION_RECOVERY_REQUIRED', message: 'final summary promotion failed' });
    const postWrite = await summaryCommentState(taskRef, { cwd, client: options.client });
    if (!postWrite.comment?.body.includes('### ✅ Manual Validation Passed') || postWrite.pullRequest?.head.sha !== receipt.prHeadSha || !manualValidationFinalSummaryProjectionMatches(postWrite.comment.body, receipt)) transactionFailure({ code: 'MANUAL_VALIDATION_TRANSACTION_RECOVERY_REQUIRED', message: 'final summary post-write verification failed' });
    const committed = transitionManualValidationTransaction(transaction, 'committed', { postWriteVerified: true });
    if (!committed.ok) throw new Error(`${committed.error.code}: ${committed.error.message}`);
    writeManualValidationTransactionAtomic(resolved.taskDir, committed.value);
    return result('applied', null, { transaction: committed.value, receipt, idempotent: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (transaction.phase === 'final-promotion-in-progress') {
      try {
        await syncPullRequestSummary(taskRef, {
          cwd, client: options.client, agent, body: pendingBody, changeReportFile: path.resolve(cwd, values.changeReportFile!), primaryResult: primaryResult as 'pr_created' | 'pr_reused' | 'no_op', strict: true,
          manualValidation: { phase: 'pending', evidenceFile: values.evidenceFile!, evidenceDigest: transaction.evidenceDigest }, lockAlreadyHeld: true
        });
      } catch {
        // Preserve recovery-required when pending compensation cannot be confirmed.
      }
    }
    const failedTransaction = transitionManualValidationTransaction(transaction, 'recovery-required', { error: message.slice(0, 400) });
    if (failedTransaction.ok) writeManualValidationTransactionAtomic(resolved.taskDir, failedTransaction.value);
    return result('failed', { code: 'MANUAL_VALIDATION_TRANSACTION_RECOVERY_REQUIRED', message });
  }
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
    if (!['--evidence-file', '--format', '--cwd', '--artifact', '--summary-file', '--change-report-file', '--agent', '--result'].includes(flag)) return { values, error: `unknown option '${flag}'` };
    const value = args[++index];
    if (!value || value.startsWith('--')) return { values, error: `option '${flag}' requires a value` };
    const key = flag.slice(2).replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());
    if (values[key]) return { values, error: `duplicate option '${flag}'` };
    values[key] = value;
  }
  return { values };
}

async function manualValidation(args: string[] = []): Promise<void> {
  if (!ensureInternalHandlerRoute('manual-validation', args)) return;
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(`${USAGE}\n`); return; }
  const operation = args[0];
  const isVerify = operation === 'verify' && internalHandlerRoute('manual-validation', 'verify', operation);
  const isTransaction = operation === 'transaction' && internalHandlerRoute('manual-validation', 'transaction', operation);
  if (!isVerify && !isTransaction) { printFailure('json', { code: 'MANUAL_VALIDATION_ARGS_INVALID', message: 'verify or transaction operation is required' }); return; }
  const taskRef = args[1];
  if (!taskRef || taskRef.startsWith('--')) { printFailure('json', { code: 'MANUAL_VALIDATION_ARGS_INVALID', message: 'task ref is required' }); return; }
  const parsed = parse(args, 2);
  if (parsed.error) { printFailure('json', { code: 'MANUAL_VALIDATION_ARGS_INVALID', message: parsed.error }); return; }
  const values = parsed.values;
  const format = values.format === 'text' ? 'text' : 'json';
  if (operation === 'verify') {
    if (!values.evidenceFile) { printFailure(format, { code: 'MANUAL_VALIDATION_EVIDENCE_MISSING', message: 'manual-validation verify requires --evidence-file' }); return; }
    const output = await verifyManualValidationEvidence(taskRef, { evidenceFile: values.evidenceFile, format, cwd: values.cwd });
    process.stdout.write(format === 'json' ? `${JSON.stringify(output)}\n` : output.status === 'applied' ? 'Manual validation evidence is current.\n' : `${output.error?.code}: ${output.error?.message}\n`);
    if (output.status === 'failed') process.exitCode = 1;
    return;
  }
  const output = await executeManualValidationTransaction(taskRef, values, path.resolve(values.cwd ?? process.cwd()));
  process.stdout.write(format === 'json' ? `${JSON.stringify(output)}\n` : `${output.status === 'applied' ? 'Manual validation transaction committed.' : `${output.error?.code}: ${output.error?.message}`}\n`);
  if (output.status === 'failed') process.exitCode = 1;
}

export { executeManualValidationTransaction, manualValidation, verifyManualValidationEvidence };
