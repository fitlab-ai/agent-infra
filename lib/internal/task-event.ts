import { normalizeAgentToken, AGENT_USAGE_HINT } from '../agent-clients/tokens.ts';
import { applyTaskEvent, eventCatalog } from '../task/events.ts';
import type { TaskEventRequest, Verdict } from '../task/events.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from '../task/task-execution-lock.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

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
  '--transaction-id': 'transactionId', '--receipt-digest': 'receiptDigest', '--pr-head-sha': 'prHeadSha'
};
const NUMERIC = new Set(['round', 'question', 'blockers', 'major', 'minor', 'manualValidation', 'filesModified', 'testsPassed']);

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
  try {
    result = await withTaskExecutionLock(resolved.repoRoot, resolved.taskId, `task-event.${request.event}`, async () => applyTaskEvent(request, { lockAlreadyHeld: true }));
  } catch (error) {
    if (!(error instanceof TaskExecutionLockError)) throw error;
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: error.code, message: error.message } })}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}

export { taskEvent };
