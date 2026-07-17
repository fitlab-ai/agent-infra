import fs from 'node:fs';

import { appendActivityEntry, locateActivityLog, pairEntries } from './activity-log.ts';
import { parseTypedTaskFrontmatter } from './frontmatter.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { captureTaskWriteMetadata, writeTask } from './write.ts';
import type { TaskOperationSummary, TaskWriteErrorCode, TaskWriteOptions } from './write.ts';

const eventCatalog = [
  'analyze.started', 'analyze.awaiting-input', 'analyze.completed',
  'review-analysis.started', 'review-analysis.completed',
  'plan.started', 'plan.completed',
  'review-plan.started', 'review-plan.completed',
  'code.started', 'code.completed',
  'review-code.started', 'review-code.completed'
] as const;
type TaskEventName = (typeof eventCatalog)[number];
type Verdict = 'approved' | 'changes-requested' | 'rejected';
type TaskEventErrorCode =
  | 'EVENT_UNKNOWN' | 'EVENT_PAYLOAD_INVALID' | 'EVENT_TRANSITION_INVALID'
  | 'EVENT_LOG_MISSING' | 'EVENT_START_MISSING' | 'EVENT_ALREADY_COMPLETED'
  | 'EVENT_LOG_CONFLICT' | TaskWriteErrorCode;
type TaskEventRequest = {
  taskRef: string; event: TaskEventName | string; agent: string; dryRun?: boolean;
  round?: number; question?: number; artifact?: string; fixFor?: string;
  verdict?: Verdict; blockers?: number; major?: number; minor?: number;
  manualValidation?: number; filesModified?: number; testsPassed?: number;
};
type TaskEventError = { code: TaskEventErrorCode; message: string };
type TaskEventResult = {
  status: 'planned' | 'applied' | 'no-op' | 'failed'; changed: boolean;
  event: string; requestRef: string; taskId: string | null; taskMdPath: string | null;
  fromStep: string | null; toStep: string | null; action: string | null;
  phase: 'started' | 'waiting' | 'completed' | null; round: number | null;
  fixFor: string | null; timestamp: string | null; agentInfraVersion: string | null;
  operations: readonly TaskOperationSummary[]; error: TaskEventError | null;
};

const BASE_FIELDS = new Set(['taskRef', 'event', 'agent', 'dryRun']);
const SCHEMAS: Record<TaskEventName, { required: string[]; optional?: string[] }> = {
  'analyze.started': { required: ['round'] },
  'analyze.awaiting-input': { required: ['question'] },
  'analyze.completed': { required: ['round', 'artifact'] },
  'review-analysis.started': { required: ['round'] },
  'review-analysis.completed': { required: ['round', 'artifact', 'verdict', 'blockers', 'major', 'minor', 'manualValidation'] },
  'plan.started': { required: ['round'] },
  'plan.completed': { required: ['round', 'artifact'] },
  'review-plan.started': { required: ['round'] },
  'review-plan.completed': { required: ['round', 'artifact', 'verdict', 'blockers', 'major', 'minor', 'manualValidation'] },
  'code.started': { required: ['round'], optional: ['fixFor'] },
  'code.completed': { required: ['round', 'artifact'], optional: ['fixFor', 'filesModified', 'testsPassed', 'blockers', 'major', 'minor', 'manualValidation'] },
  'review-code.started': { required: ['round'] },
  'review-code.completed': { required: ['round', 'artifact', 'verdict', 'blockers', 'major', 'minor', 'manualValidation'] }
};

function validateTaskEventRequest(request: TaskEventRequest): TaskEventError | null {
  if (!eventCatalog.includes(request.event as TaskEventName)) return { code: 'EVENT_UNKNOWN', message: `unknown task event '${request.event}'` };
  if (!request.taskRef || !request.agent) return { code: 'EVENT_PAYLOAD_INVALID', message: 'taskRef and agent are required' };
  const schema = SCHEMAS[request.event as TaskEventName];
  const allowed = new Set([...BASE_FIELDS, ...schema.required, ...(schema.optional ?? [])]);
  for (const [key, value] of Object.entries(request)) {
    if (value !== undefined && !allowed.has(key)) return { code: 'EVENT_PAYLOAD_INVALID', message: `${request.event} does not accept '${key}'` };
  }
  for (const key of schema.required) if (request[key as keyof TaskEventRequest] === undefined) return { code: 'EVENT_PAYLOAD_INVALID', message: `${request.event} requires '${key}'` };
  for (const key of ['round', 'question', 'blockers', 'major', 'minor', 'manualValidation', 'filesModified', 'testsPassed'] as const) {
    const value = request[key];
    if (value !== undefined && (!Number.isInteger(value) || value < (key === 'round' || key === 'question' ? 1 : 0))) return { code: 'EVENT_PAYLOAD_INVALID', message: `'${key}' must be a ${key === 'round' || key === 'question' ? 'positive' : 'non-negative'} integer` };
  }
  if (request.verdict && !['approved', 'changes-requested', 'rejected'].includes(request.verdict)) return { code: 'EVENT_PAYLOAD_INVALID', message: 'verdict is invalid' };
  if (request.event === 'code.completed') {
    const fix = request.fixFor !== undefined || ['blockers', 'major', 'minor', 'manualValidation'].some((key) => request[key as keyof TaskEventRequest] !== undefined);
    const required = fix ? ['fixFor', 'blockers', 'major', 'minor', 'manualValidation'] : ['filesModified', 'testsPassed'];
    const forbidden = fix ? ['filesModified', 'testsPassed'] : ['fixFor', 'blockers', 'major', 'minor', 'manualValidation'];
    if (required.some((key) => request[key as keyof TaskEventRequest] === undefined) || forbidden.some((key) => request[key as keyof TaskEventRequest] !== undefined)) return { code: 'EVENT_PAYLOAD_INVALID', message: 'code.completed requires either initial or fix completion payload' };
  }
  if (request.fixFor && !/^review-code(?:-r\d+)?\.md$/.test(request.fixFor)) return { code: 'EVENT_PAYLOAD_INVALID', message: 'fixFor must reference a review-code artifact' };
  return null;
}

const FAMILY = {
  analyze: { started: ['requirement-analysis', 'requirement-analysis-review'], completed: ['requirement-analysis', 'requirement-analysis-review'], target: 'requirement-analysis', label: 'Analyze Task' },
  'review-analysis': { started: ['requirement-analysis'], completed: ['requirement-analysis'], target: 'requirement-analysis-review', label: 'Review Analysis' },
  plan: { started: ['requirement-analysis-review', 'technical-design-review'], completed: ['requirement-analysis-review', 'technical-design-review'], target: 'technical-design', label: 'Plan Task' },
  'review-plan': { started: ['technical-design'], completed: ['technical-design'], target: 'technical-design-review', label: 'Review Plan' },
  code: { started: ['technical-design-review', 'code-review'], completed: ['technical-design-review', 'code-review'], target: 'code', label: 'Code Task' },
  'review-code': { started: ['code'], completed: ['code'], target: 'code-review', label: 'Review Code' }
} as const;

function identity(request: TaskEventRequest) {
  const [family, suffix] = request.event.split('.') as [keyof typeof FAMILY, string];
  const phase = suffix === 'started' ? 'started' : suffix === 'awaiting-input' ? 'waiting' : 'completed';
  if (phase === 'waiting') return { family, phase, action: 'Analyze Task (Brainstorming)', note: `Asked Q${request.question}, awaiting answer`, target: FAMILY.analyze.target } as const;
  const fix = request.fixFor ? `, fix for ${request.fixFor}` : '';
  const action = `${FAMILY[family].label} (Round ${request.round}${fix})`;
  if (phase === 'started') return { family, phase, action, note: 'started', target: null } as const;
  let note = '';
  if (family === 'analyze') note = `Analysis completed → ${request.artifact}`;
  else if (family === 'plan') note = `Plan completed, awaiting human review → ${request.artifact}`;
  else if (family === 'code' && request.fixFor) note = `Fixed ${request.blockers} blockers, ${request.major} major, ${request.minor} minor issues${request.manualValidation ? `, skipped ${request.manualValidation} manual-validation` : ''} → ${request.artifact}`;
  else if (family === 'code') note = `Code implemented, ${request.filesModified} files modified, ${request.testsPassed} tests passed → ${request.artifact}`;
  else {
    const verdict = request.verdict === 'approved' ? 'Approved' : request.verdict === 'changes-requested' ? 'Changes Requested' : 'Rejected';
    note = `Verdict: ${verdict}, blockers: ${request.blockers}, major: ${request.major}, minor: ${request.minor}, Manual-validation: ${request.manualValidation} → ${request.artifact}`;
  }
  return { family, phase, action, note, target: FAMILY[family].target } as const;
}

function failed(request: TaskEventRequest, error: TaskEventError, extra: Partial<TaskEventResult> = {}): TaskEventResult {
  return { status: 'failed', changed: false, event: request.event, requestRef: request.taskRef, taskId: null, taskMdPath: null, fromStep: null, toStep: null, action: null, phase: null, round: request.round ?? null, fixFor: request.fixFor ?? null, timestamp: null, agentInfraVersion: null, operations: [], error, ...extra };
}

function applyTaskEvent(request: TaskEventRequest, options: TaskWriteOptions = {}): TaskEventResult {
  const invalid = validateTaskEventRequest(request);
  if (invalid) return failed(request, invalid);
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(request, { code: resolved.code, message: resolved.message }, { taskId: resolved.taskId });
  if (resolved.state !== 'active') return failed(request, { code: 'TASK_STATE_MISMATCH', message: `task ${resolved.taskId} is ${resolved.state}, expected active` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
  let content: string;
  try { content = fs.readFileSync(resolved.taskMdPath, 'utf8'); } catch (error) { return failed(request, { code: 'TASK_READ_FAILED', message: String(error) }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath }); }
  let frontmatter;
  try { frontmatter = parseTypedTaskFrontmatter(content); } catch (error) { return failed(request, { code: 'TASK_DOCUMENT_INVALID', message: error instanceof Error ? error.message : String(error) }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath }); }
  const section = locateActivityLog(content);
  if (!section) return failed(request, { code: 'EVENT_LOG_MISSING', message: 'task has no unique Activity Log section' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
  const eventIdentity = identity(request);
  const currentStep = typeof frontmatter.current_step === 'string' ? frontmatter.current_step : '';
  const rows = pairEntries(section.entries);
  const matchingRows = rows.filter((item) => item.step === eventIdentity.action);
  if (matchingRows.length > 1) return failed(request, { code: 'EVENT_LOG_CONFLICT', message: 'event identity appears more than once' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
  const row = matchingRows[0];
  if (eventIdentity.phase === 'started' && row) {
    if (row.done) return failed(request, { code: 'EVENT_ALREADY_COMPLETED', message: 'event identity is already completed' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
    if (row.agent !== request.agent) return failed(request, { code: 'EVENT_LOG_CONFLICT', message: 'open started event has a different agent' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
    return { ...failed(request, { code: 'EVENT_LOG_CONFLICT', message: '' }), status: 'no-op', error: null, taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase, timestamp: row.started, agentInfraVersion: typeof frontmatter.agent_infra_version === 'string' ? frontmatter.agent_infra_version : null };
  }
  if (eventIdentity.phase === 'completed' && row?.done) {
    if (row.note !== eventIdentity.note) return failed(request, { code: 'EVENT_LOG_CONFLICT', message: 'completed event has different payload' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
    return { ...failed(request, { code: 'EVENT_LOG_CONFLICT', message: '' }), status: 'no-op', error: null, taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase, timestamp: row.done, agentInfraVersion: typeof frontmatter.agent_infra_version === 'string' ? frontmatter.agent_infra_version : null };
  }
  if (eventIdentity.phase === 'completed' && !row?.started) return failed(request, { code: 'EVENT_START_MISSING', message: 'completion requires one open matching started event' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
  if (eventIdentity.phase === 'waiting' && section.entries.some((entry) => entry.step === eventIdentity.action && entry.note === eventIdentity.note)) {
    const existing = section.entries.find((entry) => entry.step === eventIdentity.action && entry.note === eventIdentity.note)!;
    return { ...failed(request, { code: 'EVENT_LOG_CONFLICT', message: '' }), status: 'no-op', error: null, taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase, timestamp: existing.time, agentInfraVersion: typeof frontmatter.agent_infra_version === 'string' ? frontmatter.agent_infra_version : null };
  }
  const allowed = FAMILY[eventIdentity.family][eventIdentity.phase === 'started' ? 'started' : 'completed'];
  if (!(allowed as readonly string[]).includes(currentStep)) return failed(request, { code: 'EVENT_TRANSITION_INVALID', message: `${request.event} is not allowed from '${currentStep}'` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
  let metadata;
  try { metadata = (options.metadataProvider ?? captureTaskWriteMetadata)(); } catch (error) { return failed(request, { code: 'METADATA_CAPTURE_FAILED', message: String(error) }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath }); }
  const step = eventIdentity.phase === 'started' ? currentStep : eventIdentity.target!;
  const logStep = eventIdentity.phase === 'started' ? `${eventIdentity.action} [started]` : eventIdentity.action;
  const body = appendActivityEntry(section, { time: metadata.timestamp, step: logStep, agent: request.agent, note: eventIdentity.note });
  const result = writeTask({ taskRef: request.taskRef, expectedState: 'active', dryRun: request.dryRun, mutations: [
    { kind: 'frontmatter', set: { current_step: step, assigned_to: request.agent } },
    { kind: 'section', aliases: ['活动日志', 'Activity Log'], heading: section.heading, body }
  ] }, { ...options, metadataProvider: () => metadata });
  if (result.status === 'failed') return failed(request, result.error, { taskId: result.taskId, taskMdPath: result.taskMdPath, fromStep: currentStep, toStep: step, action: eventIdentity.action, phase: eventIdentity.phase, timestamp: result.timestamp, agentInfraVersion: result.agentInfraVersion, operations: result.operations });
  return { status: result.status, changed: result.changed, event: request.event, requestRef: request.taskRef, taskId: result.taskId, taskMdPath: result.taskMdPath, fromStep: currentStep, toStep: step, action: eventIdentity.action, phase: eventIdentity.phase, round: request.round ?? null, fixFor: request.fixFor ?? null, timestamp: result.timestamp, agentInfraVersion: result.agentInfraVersion, operations: result.operations, error: null };
}

export { eventCatalog, validateTaskEventRequest, applyTaskEvent };
export type { TaskEventName, TaskEventRequest, TaskEventResult, TaskEventError, TaskEventErrorCode, Verdict };
