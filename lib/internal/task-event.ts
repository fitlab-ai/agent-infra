import { normalizeAgentToken, AGENT_USAGE_HINT } from '../agent-clients/tokens.ts';
import { applyTaskEvent, eventCatalog } from '../task/events.ts';
import type { TaskEventRequest, Verdict } from '../task/events.ts';
import { consumeHumanOverride, failureId, overrideDryRunConflict } from '../task/human-override.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from '../task/task-execution-lock.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';
import { parseArtifactName } from '../task/artifact-name.ts';
import { canonicalSemanticDigest, sha256Content } from '../task/artifact-operations.ts';
import {
  consumeLifecycleFinalizationReceipt,
  currentLifecycleAuthority,
  readLifecycleFinalizationReceipt,
  type LifecycleFinalizationReceipt
} from '../task/lifecycle-finalization-receipt.ts';
import {
  consumeArtifactRecovery,
  recordArtifactRecoveryPassed,
  type ArtifactRecoveryContext
} from '../task/artifact-recovery.ts';
import type { ArtifactSchemaFamily } from '../task/artifact-schema.ts';
import fs from 'node:fs';
import path from 'node:path';

const USAGE = `Usage: agent-infra-internal task-event <N | TASK-id> <event> --agent <agent> [event options] [--orchestrated] [--dry-run]

Apply one closed-set task lifecycle event and print a structured JSON result.
Events: ${eventCatalog.join(', ')}
`;

const FLAGS: Record<string, keyof TaskEventRequest> = {
  '--agent': 'agent', '--round': 'round', '--question': 'question', '--artifact': 'artifact',
  '--artifact-sha256': 'artifactSha256', '--semantic-digest': 'semanticDigest',
  '--initiator': 'initiator', '--request-id': 'requestId', '--reason-code': 'reasonCode',
  '--source-finding': 'sourceFinding', '--source-artifact': 'sourceArtifact', '--source-sha256': 'sourceSha256',
  '--fix-for': 'fixFor', '--implementation-input': 'implementationInput',
  '--verdict': 'verdict', '--blockers': 'blockers', '--major': 'major',
  '--minor': 'minor', '--manual-validation': 'manualValidation', '--files-modified': 'filesModified',
  '--tests-passed': 'testsPassed', '--summary-result': 'summaryResult',
  '--transaction-id': 'transactionId', '--receipt-digest': 'receiptDigest', '--pr-head-sha': 'prHeadSha',
  '--override-ticket': 'overrideTicket', '--override-target': 'overrideTarget', '--override-scope': 'overrideScope'
};
const NUMERIC = new Set(['round', 'question', 'blockers', 'major', 'minor', 'manualValidation', 'filesModified', 'testsPassed']);
const COMPLETED_FAMILIES: Readonly<Record<string, ArtifactSchemaFamily>> = {
  'analyze.completed': 'analysis',
  'review-analysis.completed': 'review-analysis',
  'plan.completed': 'plan',
  'review-plan.completed': 'review-plan',
  'code.completed': 'code',
  'review-code.completed': 'review-code'
};

function sandboxFinalizationReceipt(
  request: TaskEventRequest,
  resolved: Readonly<{ repoRoot: string; taskId: string; taskDir: string }>
): LifecycleFinalizationReceipt | null {
  const family = COMPLETED_FAMILIES[request.event];
  if (!family) return null;
  const artifact = request.artifact;
  const parsed = artifact ? parseArtifactName(artifact) : null;
  if (!artifact || !parsed || parsed.family !== family) return null;
  const receipt = readLifecycleFinalizationReceipt(resolved.repoRoot, resolved.taskId, family, artifact);
  const sandboxBound = process.env.AGENT_INFRA_TASK_ID === resolved.taskId
    && Boolean(process.env.AGENT_INFRA_CONTROL_STATUS_DIR)
    && Boolean(process.env.AGENT_INFRA_CONTROL_GENERATION)
    && Boolean(process.env.AGENT_INFRA_CONTROL_ROOT_ID);
  if (!receipt) {
    if (sandboxBound) throw new Error('LIFECYCLE_FINALIZATION_RECEIPT_MISSING');
    return null;
  }
  const authority = currentLifecycleAuthority(process.env, resolved.taskId);
  const content = fs.readFileSync(path.join(resolved.taskDir, artifact), 'utf8');
  if (receipt.round !== parsed.round
    || receipt.artifactSha256 !== sha256Content(content)
    || receipt.semanticDigest !== canonicalSemanticDigest(content)
    || receipt.authorityMode !== authority.mode
    || receipt.authorityDigest !== authority.digest
    || (request.artifactSha256 !== undefined && request.artifactSha256 !== receipt.artifactSha256)
    || (request.semanticDigest !== undefined && request.semanticDigest !== receipt.semanticDigest)) {
    throw new Error('LIFECYCLE_FINALIZATION_RECEIPT_MISMATCH');
  }
  return receipt;
}

function usageFailure(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'EVENT_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

export function parseTaskEventRequest(args: readonly string[]): TaskEventRequest {
  if (args.length < 2) throw new Error('task ref and event are required');
  const request: TaskEventRequest = { taskRef: args[0]!, event: args[1]!, agent: '' };
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--orchestrated') {
      if (seen.has(flag)) throw new Error(`duplicate option '${flag}'`);
      seen.add(flag); request.orchestrated = true; continue;
    }
    if (flag === '--dry-run') {
      if (seen.has(flag)) throw new Error(`duplicate option '${flag}'`);
      seen.add(flag); request.dryRun = true; continue;
    }
    const key = FLAGS[flag];
    if (!key) throw new Error(`unknown option '${flag}'`);
    if (seen.has(flag)) throw new Error(`duplicate option '${flag}'`);
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`option '${flag}' requires a value`);
    seen.add(flag);
    if (NUMERIC.has(key)) (request as Record<string, unknown>)[key] = Number(value);
    else if (key === 'verdict') request.verdict = value as Verdict;
    else (request as Record<string, unknown>)[key] = value;
  }
  const agent = normalizeAgentToken(String(request.agent ?? ''));
  if (!agent) throw new Error(`invalid --agent '${request.agent}': ${AGENT_USAGE_HINT}`);
  request.agent = agent;
  const dryRunConflict = overrideDryRunConflict(request as unknown as Record<string, unknown>);
  if (dryRunConflict) throw new Error(dryRunConflict.message);
  return request;
}

async function taskEvent(args: string[] = []): Promise<void> {
  if (!ensureInternalHandlerRoute('task-event', args)) return;
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  if (!internalHandlerRoute('task-event', 'event', args[1] ? 'event' : '')) { usageFailure('task ref and event are required'); return; }
  let request: TaskEventRequest;
  try { request = parseTaskEventRequest(args); }
  catch (error) { usageFailure(error instanceof Error ? error.message : String(error)); return; }
  const resolved = resolveTaskRef(request.taskRef);
  if (!resolved.ok) {
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: resolved.code, message: resolved.message } })}\n`);
    process.exitCode = 1;
    return;
  }
  let result;
  let humanOverride: unknown = null;
  try {
    result = await withTaskExecutionLock(resolved.repoRoot, resolved.taskId, `task-event.${request.event}`, async () => {
      let receipt: LifecycleFinalizationReceipt | null;
      let recovery: ArtifactRecoveryContext | null = null;
      try {
        receipt = sandboxFinalizationReceipt(request, resolved);
        if (receipt) {
          if (!request.requestId) throw new Error('LIFECYCLE_FINALIZATION_REQUEST_ID_MISSING');
          recovery = recordArtifactRecoveryPassed({
            taskId: receipt.taskId,
            family: receipt.family,
            artifact: receipt.artifact,
            round: receipt.round,
            requestId: request.requestId,
            phase: 'task-event.completed',
            authorityDigest: receipt.authorityDigest
          }, {
            repoRoot: resolved.repoRoot,
            taskDir: resolved.taskDir,
            recoveryId: receipt.operationId,
            lockAlreadyHeld: true,
            expectedFinalSha256: receipt.artifactSha256,
            expectedFinalSemanticDigest: receipt.semanticDigest
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          status: 'failed' as const, changed: false, event: request.event, requestRef: request.taskRef,
          taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: null, toStep: null,
          action: null, phase: null, round: null, artifact: request.artifact ?? null,
          fixFor: request.fixFor ?? null, implementationInput: request.implementationInput ?? null,
          artifactContext: null, timestamp: null, agentInfraVersion: null, operations: [],
          error: { code: /^([A-Z][A-Z0-9_]+)/u.exec(message)?.[1] ?? 'LIFECYCLE_FINALIZATION_RECEIPT_INVALID', message }
        };
      }
      let current = applyTaskEvent(request, { lockAlreadyHeld: true });
      const values = request as Record<string, unknown>;
      if (current.status !== 'failed' || !values.overrideTicket) {
        if (receipt && (current.status === 'applied' || current.status === 'no-op')) {
          if (recovery) consumeArtifactRecovery(recovery, { lockAlreadyHeld: true });
          consumeLifecycleFinalizationReceipt(resolved.repoRoot, receipt);
        }
        return current;
      }
      if (!values.overrideTarget || !values.overrideScope) {
        return { ...current, humanOverride: { status: 'failed', error: { code: 'OVERRIDE_PAYLOAD_INVALID', message: 'override ticket requires target and scope' } } } as typeof current & { humanOverride: unknown };
      }
      const consumed = await consumeHumanOverride({
        taskRef: request.taskRef,
        ticketId: String(values.overrideTicket),
        failureId: failureId('task-event', current.error?.code ?? 'EVENT_TRANSITION_INVALID'),
        target: String(values.overrideTarget),
        scope: String(values.overrideScope)
      }, {
        effectExecutor: (capability) => {
          const retried = applyTaskEvent(request, { lockAlreadyHeld: true, manualOverride: capability });
          current = retried;
          return retried.status === 'failed' || retried.status === 'planned'
            ? { code: 'OVERRIDE_EFFECT_FAILED', message: retried.status === 'planned' ? 'producer returned planned; no task event was committed' : `${retried.error?.code ?? 'EVENT_FAILED'}: ${retried.error?.message ?? 'manual task event effect failed'}` }
            : null;
        }
      });
      humanOverride = consumed;
      return current;
    });
  } catch (error) {
    if (!(error instanceof TaskExecutionLockError)) throw error;
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: error.code, message: error.message } })}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(humanOverride ? { ...result, humanOverride } : result)}\n`);
  const overrideFailed = Boolean(
    humanOverride && typeof humanOverride === 'object' &&
    (humanOverride as { status?: unknown }).status === 'failed'
  );
  if (result.status === 'failed' || overrideFailed) process.exitCode = 1;
}

export { taskEvent };
