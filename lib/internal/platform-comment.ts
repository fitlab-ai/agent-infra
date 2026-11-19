import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectTaskWorkspaceRoot } from '../task/workspace-root.ts';
import { createHash, randomUUID } from 'node:crypto';

import { normalizeAgentToken, AGENT_USAGE_HINT } from '../agent-clients/tokens.ts';
import {
  checkPlatformCommentOwner,
  listPlatformComments
} from '../platform/issue-comments.ts';
import { syncPlatformComment } from '../platform/coordinated-writes.ts';
import type { CommentKind } from '../platform/issue-comments.ts';
import { canonicalizeSummaryBody } from '../platform/comment-safety.ts';
import { platformResult } from '../platform/types.ts';
import type { PlatformResult } from '../platform/types.ts';
import { recoverTaskFromComments } from '../platform/task-recovery.ts';
import { backfillCompletionComments } from '../platform/completion-backfill.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { enumerateArtifacts } from '../task/artifacts.ts';
import { parseTaskFrontmatter } from '../task/frontmatter.ts';
import { prepareAndRenderCancelSummaryContent, prepareAndRenderDeliverySummaryContent } from '../platform/issue-summary-content.ts';

const USAGE = `Usage: agent-infra-internal platform-comment list --issue <token> [--cwd <path>]
       agent-infra-internal platform-comment recover --issue <token> --task-id <TASK-id> --output <staging-task.md> [--cwd <path>]
       agent-infra-internal platform-comment owner <task-ref> [--cwd <path>]
       agent-infra-internal platform-comment backfill <task-ref> --agent <agent> [--cwd <path>]
       agent-infra-internal platform-comment stage-summary <task-ref> --body-file <path|-> [--cwd <path>]
       agent-infra-internal platform-comment sync <task-ref> --kind <kind> --agent <agent> [--artifact <file>] [--body-file <path|->] [--status-label <label>] [--backfill] [--cwd <path>]
`;

function fail(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'COMMENT_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

function finish(result: PlatformResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
  if (result.status === 'blocked') process.exitCode = 2;
}

function parseFlags(args: string[], start: number): { values: Record<string, string | boolean>; error?: string } {
  const values: Record<string, string | boolean> = {};
  const seen = new Set<string>();
  for (let index = start; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!['--issue', '--task-id', '--output', '--cwd', '--kind', '--agent', '--artifact', '--body-file', '--status-label', '--backfill'].includes(flag)) {
      return { values, error: `unknown option '${flag}'` };
    }
    if (seen.has(flag)) return { values, error: `duplicate option '${flag}'` };
    seen.add(flag);
    if (flag === '--backfill') { values.backfill = true; continue; }
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) return { values, error: `option '${flag}' requires a value` };
    values[flag.slice(2).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  }
  return { values };
}

function readBodyFile(value: string, cwd: string): string {
  if (value === '-') return fs.readFileSync(0, 'utf8');
  return fs.readFileSync(path.resolve(cwd, value), 'utf8');
}

function rejectUnexpectedFlags(command: string, values: Record<string, string | boolean>, allowed: string[]): boolean {
  const unexpected = Object.keys(values).find((key) => !allowed.includes(key));
  if (!unexpected) return false;
  fail(`${command} does not accept '--${unexpected}'`);
  return true;
}

async function runList(values: Record<string, string | boolean>, cwd: string): Promise<void> {
  const issue = values.issue;
  if (typeof issue !== 'string' || !issue) { fail('list requires --issue <token>'); return; }
  if (rejectUnexpectedFlags('list', values, ['issue', 'cwd'])) return;
  finish(await listPlatformComments(issue, cwd));
}

function validateRecoveryOutput(output: string, cwd: string): string | null {
  const outputPath = path.resolve(cwd, output);
  const workspaceDir = resolveProjectTaskWorkspaceRoot(cwd);
  const stagingDir = path.dirname(outputPath);
  const stagingParent = fs.existsSync(stagingDir) ? path.dirname(fs.realpathSync(stagingDir)) : '';
  const realWorkspace = fs.existsSync(workspaceDir) ? fs.realpathSync(workspaceDir) : '';
  if (path.basename(outputPath) === 'task.md' && stagingParent === realWorkspace
    && path.basename(stagingDir).startsWith('.restore-staging-') && fs.existsSync(stagingDir)
    && fs.lstatSync(stagingDir).isDirectory() && !fs.existsSync(outputPath)) return outputPath;
  return null;
}

async function writeRecoveredTask(issue: string, taskId: string, outputPath: string, cwd: string): Promise<void> {
  const listed = await listPlatformComments(issue, cwd);
  if (listed.status === 'failed' || listed.status === 'blocked' || !listed.comments) { finish(listed); return; }
  try {
    const taskContent = recoverTaskFromComments({ taskId, comments: listed.comments });
    fs.writeFileSync(outputPath, taskContent, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    finish({ ...listed, status: 'applied', changed: true,
      operations: [{ name: `recovery:task:${taskId}`, status: 'applied', reasonCode: null }], error: null });
  } catch (error) {
    finish({ ...listed, status: 'failed', changed: false, error: {
      code: 'RECOVERY_EVIDENCE_MISSING', message: error instanceof Error ? error.message : String(error), retryable: false
    } });
  }
}

async function runRecover(values: Record<string, string | boolean>, cwd: string): Promise<void> {
  const issue = values.issue;
  const taskId = values.taskId;
  const output = values.output;
  if (typeof issue !== 'string' || !issue || typeof taskId !== 'string' || !/^TASK-\d{8}-\d{6}$/.test(taskId)
    || typeof output !== 'string' || !output) {
    fail('recover requires --issue <token> --task-id <TASK-id> --output <staging-task.md>'); return;
  }
  if (rejectUnexpectedFlags('recover', values, ['issue', 'taskId', 'output', 'cwd'])) return;
  const outputPath = validateRecoveryOutput(output, cwd);
  if (!outputPath) {
    fail('recover output must be a new task.md inside an existing task-workspace/.restore-staging-* directory'); return;
  }
  await writeRecoveredTask(issue, taskId, outputPath, cwd);
}

async function runOwner(taskRef: string, values: Record<string, string | boolean>, cwd: string): Promise<void> {
  if (rejectUnexpectedFlags('owner', values, ['cwd'])) return;
  finish(await checkPlatformCommentOwner(taskRef, { cwd }));
}

async function runBackfill(taskRef: string, values: Record<string, string | boolean>, cwd: string): Promise<void> {
  if (rejectUnexpectedFlags('backfill', values, ['cwd', 'agent'])) return;
  const agent = values.agent;
  if (typeof agent !== 'string' || !agent) { fail('backfill requires --agent'); return; }
  const normalizedAgent = normalizeAgentToken(agent);
  if (!normalizedAgent) { fail(`invalid --agent '${agent}': ${AGENT_USAGE_HINT}`); return; }
  finish(await backfillCompletionComments(taskRef, { cwd, agent: normalizedAgent }));
}

function stageSummaryBody(body: string, taskRef: string, cwd: string): { taskId: string; target: string; content: unknown } | null {
  const resolved = resolveTaskRef(taskRef, { repoRoot: cwd });
  if (!resolved.ok || resolved.state !== 'active') return null;
  const supplied = JSON.parse(body) as Record<string, unknown>;
  const taskContent = fs.readFileSync(resolved.taskMdPath, 'utf8');
  const title = /^#\s+(.+)$/mu.exec(taskContent)?.[1]?.trim();
  const prepared = prepareAndRenderDeliverySummaryContent(supplied, {
    taskId: resolved.taskId,
    title: title || resolved.taskId,
    artifacts: enumerateArtifacts(resolved.taskDir).filter((artifact) => artifact.name !== 'task.md').map((artifact) => artifact.name),
    verificationFallback: { state: 'not-run', detail: 'Final verification has not run at summary staging.' }
  });
  const canonical = canonicalizeSummaryBody(prepared.rendered);
  if (!canonical.ok) throw new Error(`${canonical.error.code}: ${canonical.error.message}`);
  return { taskId: resolved.taskId, target: path.join(resolved.taskDir, '.delivery-summary.json'), content: prepared.content };
}

function persistStagedSummary(target: string, taskId: string, content: unknown): boolean {
  const value = { taskId, content, contentSha256: createHash('sha256').update(JSON.stringify(content)).digest('hex') };
  const previous = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  const next = `${JSON.stringify(value)}\n`;
  if (previous === next) return false;
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, next, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* preserve primary error */ }
    throw error;
  }
  return true;
}

async function runStageSummary(taskRef: string, values: Record<string, string | boolean>, cwd: string): Promise<void> {
  if (rejectUnexpectedFlags('stage-summary', values, ['cwd', 'bodyFile'])) return;
  if (typeof values.bodyFile !== 'string') { fail('stage-summary requires --body-file'); return; }
  let body: string;
  try { body = readBodyFile(values.bodyFile, cwd); }
  catch (error) { fail(`unable to read body file: ${error instanceof Error ? error.message : String(error)}`); return; }
  let staged: ReturnType<typeof stageSummaryBody>;
  try { staged = stageSummaryBody(body, taskRef, cwd); }
  catch (error) { fail(`unable to stage summary: ${error instanceof Error ? error.message : String(error)}`); return; }
  if (!staged) { fail('stage-summary requires an active task'); return; }
  try {
    const changed = persistStagedSummary(staged.target, staged.taskId, staged.content);
    finish(changed ? platformResult('applied', { operations: [{ name: 'delivery-summary', status: 'applied', reasonCode: null }] }) : platformResult('no-op'));
  } catch (error) { fail(`unable to stage summary: ${error instanceof Error ? error.message : String(error)}`); }
}

function renderSyncBody(kind: string, body: string, taskRef: string, cwd: string): string {
  const input = JSON.parse(body) as Record<string, unknown>;
  const resolved = resolveTaskRef(taskRef, { repoRoot: cwd });
  if (!resolved.ok) throw new Error(resolved.message);
  const taskContent = fs.readFileSync(resolved.taskMdPath, 'utf8');
  const taskFrontmatter = parseTaskFrontmatter(taskContent);
  const title = /^#\s+(.+)$/mu.exec(taskContent)?.[1]?.trim();
  const artifacts = enumerateArtifacts(resolved.taskDir).filter((artifact) => artifact.name !== 'task.md').map((artifact) => artifact.name);
  return kind === 'summary'
    ? prepareAndRenderDeliverySummaryContent(input, { taskId: resolved.taskId, title: title || resolved.taskId, artifacts,
      ...(resolved.state === 'active' ? { verificationFallback: { state: 'not-run', detail: 'Final verification has not run at summary staging.' } } : {}) }).rendered
    : prepareAndRenderCancelSummaryContent(input, { taskId: resolved.taskId, title: title || resolved.taskId,
      reason: typeof taskFrontmatter.cancel_reason === 'string' ? taskFrontmatter.cancel_reason : '',
      cancelledAt: typeof taskFrontmatter.cancelled_at === 'string' ? taskFrontmatter.cancelled_at : '',
      lastCompletedArtifact: artifacts.at(-1) ?? null }).rendered;
}

async function runSync(taskRef: string, values: Record<string, string | boolean>, cwd: string): Promise<void> {
  const request = validateSyncRequest(values);
  if (!request) return;
  const { kind, normalizedAgent } = request;
  const body = prepareSyncBody(kind, values, taskRef, cwd);
  if (!body.ok) { fail(body.message); return; }
  finish(await syncPlatformComment(taskRef, { kind, agent: normalizedAgent,
    artifact: typeof values.artifact === 'string' ? values.artifact : undefined, body: body.value,
    backfill: values.backfill === true, cwd }));
}

function validateSyncRequest(values: Record<string, string | boolean>): { kind: CommentKind; normalizedAgent: string } | null {
  const kind = values.kind;
  const agent = values.agent;
  if (!['task', 'artifact', 'summary', 'cancel'].includes(String(kind))) { fail('sync requires a valid --kind'); return null; }
  if (typeof agent !== 'string' || !agent) { fail('sync requires --agent'); return null; }
  const normalizedAgent = normalizeAgentToken(agent);
  if (!normalizedAgent) { fail(`invalid --agent '${agent}': ${AGENT_USAGE_HINT}`); return null; }
  if (kind === 'artifact' && typeof values.artifact !== 'string') { fail('artifact sync requires --artifact'); return null; }
  if ((kind === 'summary' || kind === 'cancel') && typeof values.bodyFile !== 'string') { fail(`${kind} sync requires --body-file`); return null; }
  return { kind: kind as CommentKind, normalizedAgent };
}

function prepareSyncBody(
  kind: CommentKind,
  values: Record<string, string | boolean>,
  taskRef: string,
  cwd: string
): { ok: true; value?: string } | { ok: false; message: string } {
  let body: string | undefined;
  try {
    if (typeof values.bodyFile === 'string') body = readBodyFile(values.bodyFile, cwd);
    if ((kind === 'summary' || kind === 'cancel') && body !== undefined) body = renderSyncBody(kind, body, taskRef, cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: body === undefined ? `unable to read body file: ${message}` : `invalid ${kind} summary structure: ${message}` };
  }
  return { ok: true, value: body };
}

function isPlatformCommentOperation(operation: string | undefined): operation is string {
  return Boolean(operation && [
    internalHandlerRoute('platform-comment', 'list', operation),
    internalHandlerRoute('platform-comment', 'recover', operation),
    internalHandlerRoute('platform-comment', 'owner', operation),
    internalHandlerRoute('platform-comment', 'backfill', operation),
    internalHandlerRoute('platform-comment', 'stage-summary', operation),
    internalHandlerRoute('platform-comment', 'sync', operation)
  ].some(Boolean));
}

async function dispatchPlatformComment(
  operation: string,
  taskRef: string | undefined,
  values: Record<string, string | boolean>,
  cwd: string
): Promise<void> {
  if (operation === 'list') return runList(values, cwd);
  if (operation === 'recover') return runRecover(values, cwd);
  if (!taskRef) { fail(`${operation} requires a task ref`); return; }
  if (operation === 'owner') return runOwner(taskRef, values, cwd);
  if (operation === 'backfill') return runBackfill(taskRef, values, cwd);
  if (operation === 'stage-summary') return runStageSummary(taskRef, values, cwd);
  if (operation === 'sync') return runSync(taskRef, values, cwd);
  fail('operation is not registered');
}

async function platformComment(args: string[] = []): Promise<void> {
  if (!ensureInternalHandlerRoute('platform-comment', args)) return;
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  const operation = args[0];
  if (!isPlatformCommentOperation(operation)) { fail('a valid operation is required'); return; }
  const hasTaskRef = operation !== 'list' && operation !== 'recover';
  const taskRef = hasTaskRef ? args[1] : undefined;
  if (hasTaskRef && (!taskRef || taskRef.startsWith('--'))) { fail(`${operation} requires a task ref`); return; }
  const parsed = parseFlags(args, hasTaskRef ? 2 : 1);
  if (parsed.error) { fail(parsed.error); return; }
  const cwd = path.resolve(typeof parsed.values.cwd === 'string' ? parsed.values.cwd : process.cwd());
  return dispatchPlatformComment(operation, taskRef, parsed.values, cwd);
}

export { platformComment };
