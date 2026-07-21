import fs from 'node:fs';

import { appendActivityEntry, locateActivityLog, pairEntries } from './activity-log.ts';
import {
  buildArtifactLinkSection,
  artifactName,
  parseArtifactName,
  resolveArtifactContext,
  validateCompletedArtifact
} from './artifact-lifecycle.ts';
import type { ArtifactContextResult, ArtifactErrorCode, ArtifactFamily, ArtifactIdentity } from './artifact-lifecycle.ts';
import { parseTypedTaskFrontmatter } from './frontmatter.ts';
import {
  consumeImplementationInput,
  IMPLEMENTATION_INPUT_ALIASES,
  parseImplementationInputs,
  renderImplementationInputs
} from './implementation-inputs.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { findSectionHeading } from './sections.ts';
import { captureTaskWriteMetadata, writeTask } from './write.ts';
import type { TaskOperationSummary, TaskWriteErrorCode, TaskWriteOptions } from './write.ts';

const eventCatalog = [
  'analyze.started', 'analyze.awaiting-input', 'analyze.completed',
  'review-analysis.started', 'review-analysis.completed',
  'plan.started', 'plan.completed',
  'review-plan.started', 'review-plan.completed',
  'code.started', 'code.completed',
  'review-code.started', 'review-code.completed',
  'manual-validation.started', 'manual-validation.completed'
] as const;
type TaskEventName = (typeof eventCatalog)[number];
type Verdict = 'approved' | 'changes-requested' | 'rejected';
type TaskEventErrorCode =
  | 'EVENT_UNKNOWN' | 'EVENT_PAYLOAD_INVALID' | 'EVENT_TRANSITION_INVALID'
  | 'EVENT_LOG_MISSING' | 'EVENT_START_MISSING' | 'EVENT_ALREADY_COMPLETED'
  | 'EVENT_LOG_CONFLICT' | 'EVENT_ARTIFACT_CONFLICT' | ArtifactErrorCode | TaskWriteErrorCode;
type TaskEventRequest = {
  taskRef: string; event: TaskEventName | string; agent: string; dryRun?: boolean;
  round?: number; question?: number; artifact?: string; fixFor?: string; implementationInput?: string;
  verdict?: Verdict; blockers?: number; major?: number; minor?: number;
  manualValidation?: number; filesModified?: number; testsPassed?: number;
  summaryResult?: string;
};
type TaskEventError = { code: TaskEventErrorCode; message: string };
type TaskEventResult = {
  status: 'planned' | 'applied' | 'no-op' | 'failed'; changed: boolean;
  event: string; requestRef: string; taskId: string | null; taskMdPath: string | null;
  fromStep: string | null; toStep: string | null; action: string | null;
  phase: 'started' | 'waiting' | 'completed' | null; round: number | null;
  artifact: string | null; fixFor: string | null; implementationInput: string | null;
  artifactContext: ArtifactContextResult | null;
  timestamp: string | null; agentInfraVersion: string | null;
  operations: readonly TaskOperationSummary[]; error: TaskEventError | null;
};

const BASE_FIELDS = new Set(['taskRef', 'event', 'agent', 'dryRun']);
const SCHEMAS: Record<TaskEventName, { required?: string[]; optional?: string[] }> = {
  'analyze.started': { optional: ['round'] },
  'analyze.awaiting-input': { required: ['question'] },
  'analyze.completed': { required: ['artifact'], optional: ['round'] },
  'review-analysis.started': { optional: ['round'] },
  'review-analysis.completed': { required: ['artifact', 'verdict', 'blockers', 'major', 'minor', 'manualValidation'], optional: ['round'] },
  'plan.started': { optional: ['round'] },
  'plan.completed': { required: ['artifact'], optional: ['round'] },
  'review-plan.started': { optional: ['round'] },
  'review-plan.completed': { required: ['artifact', 'verdict', 'blockers', 'major', 'minor', 'manualValidation'], optional: ['round'] },
  'code.started': { optional: ['round', 'fixFor', 'implementationInput'] },
  'code.completed': { required: ['artifact'], optional: ['round', 'fixFor', 'implementationInput', 'filesModified', 'testsPassed', 'blockers', 'major', 'minor', 'manualValidation'] },
  'review-code.started': { optional: ['round'] },
  'review-code.completed': { required: ['artifact', 'verdict', 'blockers', 'major', 'minor', 'manualValidation'], optional: ['round'] },
  'manual-validation.started': { optional: ['round'] },
  'manual-validation.completed': { required: ['artifact', 'summaryResult'], optional: ['round'] }
};

function validateTaskEventRequest(request: TaskEventRequest): TaskEventError | null {
  if (!eventCatalog.includes(request.event as TaskEventName)) return { code: 'EVENT_UNKNOWN', message: `unknown task event '${request.event}'` };
  if (!request.taskRef || !request.agent) return { code: 'EVENT_PAYLOAD_INVALID', message: 'taskRef and agent are required' };
  const schema = SCHEMAS[request.event as TaskEventName];
  const required = schema.required ?? [];
  const allowed = new Set([...BASE_FIELDS, ...required, ...(schema.optional ?? [])]);
  for (const [key, value] of Object.entries(request)) {
    if (value !== undefined && !allowed.has(key)) return { code: 'EVENT_PAYLOAD_INVALID', message: `${request.event} does not accept '${key}'` };
  }
  for (const key of required) if (request[key as keyof TaskEventRequest] === undefined) return { code: 'EVENT_PAYLOAD_INVALID', message: `${request.event} requires '${key}'` };
  for (const key of ['round', 'question', 'blockers', 'major', 'minor', 'manualValidation', 'filesModified', 'testsPassed'] as const) {
    const value = request[key];
    if (value !== undefined && (!Number.isInteger(value) || value < (key === 'round' || key === 'question' ? 1 : 0))) return { code: 'EVENT_PAYLOAD_INVALID', message: `'${key}' must be a ${key === 'round' || key === 'question' ? 'positive' : 'non-negative'} integer` };
  }
  if (request.verdict && !['approved', 'changes-requested', 'rejected'].includes(request.verdict)) return { code: 'EVENT_PAYLOAD_INVALID', message: 'verdict is invalid' };
  if (request.event === 'code.completed') {
    const fix = request.fixFor !== undefined || ['blockers', 'major', 'minor', 'manualValidation'].some((key) => request[key as keyof TaskEventRequest] !== undefined);
    const modeRequired = fix ? ['fixFor', 'blockers', 'major', 'minor', 'manualValidation'] : ['filesModified', 'testsPassed'];
    const forbidden = fix ? ['filesModified', 'testsPassed'] : ['fixFor', 'blockers', 'major', 'minor', 'manualValidation'];
    if (modeRequired.some((key) => request[key as keyof TaskEventRequest] === undefined) || forbidden.some((key) => request[key as keyof TaskEventRequest] !== undefined)) return { code: 'EVENT_PAYLOAD_INVALID', message: 'code.completed requires either initial or fix completion payload' };
  }
  if (request.fixFor && !/^review-code(?:-r(?:[2-9]|[1-9]\d+))?\.md$/.test(request.fixFor)) return { code: 'EVENT_PAYLOAD_INVALID', message: 'fixFor must reference a canonical review-code artifact' };
  if (request.implementationInput && !/^II-[1-9]\d*$/.test(request.implementationInput)) return { code: 'EVENT_PAYLOAD_INVALID', message: 'implementationInput must be a canonical II-N id' };
  if (request.fixFor && request.implementationInput) return { code: 'EVENT_PAYLOAD_INVALID', message: 'fixFor and implementationInput are mutually exclusive' };
  if (request.summaryResult !== undefined && (!request.summaryResult.trim() || /[\r\n]/.test(request.summaryResult))) return { code: 'EVENT_PAYLOAD_INVALID', message: 'summaryResult must be a non-empty single line' };
  return null;
}

const FAMILY = {
  analyze: { artifact: 'analysis', started: ['requirement-analysis', 'requirement-analysis-review', 'code'], completed: ['requirement-analysis', 'requirement-analysis-review', 'code'], target: 'requirement-analysis', label: 'Analyze Task' },
  'review-analysis': { artifact: 'review-analysis', started: ['requirement-analysis'], completed: ['requirement-analysis'], target: 'requirement-analysis-review', label: 'Review Analysis' },
  plan: { artifact: 'plan', started: ['requirement-analysis-review', 'technical-design-review'], completed: ['requirement-analysis-review', 'technical-design-review'], target: 'technical-design', label: 'Plan Task' },
  'review-plan': { artifact: 'review-plan', started: ['technical-design'], completed: ['technical-design'], target: 'technical-design-review', label: 'Review Plan' },
  code: { artifact: 'code', started: ['technical-design-review', 'code-review'], completed: ['technical-design-review', 'code-review'], target: 'code', label: 'Code Task' },
  'review-code': { artifact: 'review-code', started: ['code', 'code-review'], completed: ['code', 'code-review'], target: 'code-review', label: 'Review Code' },
  'manual-validation': { artifact: 'manual-validation', started: ['code-review'], completed: ['code-review'], target: null, label: 'Complete Manual Validation' }
} as const;
type EventFamily = keyof typeof FAMILY;

function eventParts(event: string): { family: EventFamily; phase: 'started' | 'waiting' | 'completed' } {
  const [family, suffix] = event.split('.') as [EventFamily, string];
  return { family, phase: suffix === 'started' ? 'started' : suffix === 'awaiting-input' ? 'waiting' : 'completed' };
}

function identity(request: TaskEventRequest) {
  const { family, phase } = eventParts(request.event);
  if (phase === 'waiting') return { family, phase, action: 'Analyze Task (Brainstorming)', note: `Asked Q${request.question}, awaiting answer`, target: FAMILY.analyze.target } as const;
  const spec = FAMILY[family];
  if (family === 'manual-validation') {
    return {
      family, phase, action: spec.label,
      note: phase === 'started' ? 'started' : `Manual validation passed → ${request.artifact}; ${request.summaryResult}`,
      target: null
    } as const;
  }
  const qualifier = request.fixFor
    ? `, fix for ${request.fixFor}`
    : request.implementationInput ? `, decision ${request.implementationInput}` : '';
  const action = `${spec.label} (Round ${request.round}${qualifier})`;
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
  return { family, phase, action, note, target: spec.target } as const;
}

function failed(request: TaskEventRequest, error: TaskEventError, extra: Partial<TaskEventResult> = {}): TaskEventResult {
  return {
    status: 'failed', changed: false, event: request.event, requestRef: request.taskRef,
    taskId: null, taskMdPath: null, fromStep: null, toStep: null, action: null,
    phase: null, round: request.round ?? null, artifact: request.artifact ?? null,
    fixFor: request.fixFor ?? null, implementationInput: request.implementationInput ?? null,
    artifactContext: null, timestamp: null,
    agentInfraVersion: null, operations: [], error, ...extra
  };
}

function normalizeStarted(request: TaskEventRequest, repoRoot: string): { request: TaskEventRequest; context: ArtifactContextResult } | { error: TaskEventError; context: ArtifactContextResult } {
  const family = eventParts(request.event).family;
  const context = resolveArtifactContext(request.taskRef, FAMILY[family].artifact, { repoRoot });
  if (context.status !== 'ready' || !context.next) {
    return { error: { code: context.error?.code ?? 'EVENT_ARTIFACT_CONFLICT', message: context.error?.message ?? context.codeMode?.message ?? 'artifact context is not writable' }, context };
  }
  const round = context.next.round;
  if (request.round !== undefined && request.round !== round) return { error: { code: 'EVENT_ARTIFACT_CONFLICT', message: `round ${request.round} conflicts with expected round ${round}` }, context };
  const expectedFix = family === 'code' && context.codeMode?.mode === 'fix' ? context.codeMode.reviewArtifact ?? undefined : undefined;
  const expectedImplementation = family === 'code' && context.codeMode?.mode === 'decision'
    ? context.codeMode.implementationInput ?? undefined : undefined;
  if (request.fixFor !== undefined && request.fixFor !== expectedFix) return { error: { code: 'EVENT_ARTIFACT_CONFLICT', message: `fixFor '${request.fixFor}' conflicts with artifact context` }, context };
  if (request.implementationInput !== expectedImplementation) return { error: { code: 'EVENT_ARTIFACT_CONFLICT', message: `implementationInput '${request.implementationInput ?? ''}' conflicts with artifact context` }, context };
  return { request: { ...request, round, artifact: context.next.name, fixFor: expectedFix, implementationInput: expectedImplementation }, context };
}

function openStartedIdentity(rows: ReturnType<typeof pairEntries>, family: EventFamily) {
  const spec = FAMILY[family];
  if (family === 'manual-validation') {
    const row = rows.filter((item) => item.step === spec.label && item.started && !item.done).at(-1);
    const completed = rows.filter((item) => item.step === spec.label && item.done).length;
    return row ? { row, round: completed + 1, fixFor: undefined, implementationInput: undefined } : null;
  }
  const escaped = spec.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped} \\(Round (\\d+)(?:(?:, fix for (review-code(?:-r\\d+)?\\.md))|(?:, decision (II-[1-9]\\d*)))?\\)$`);
  const matches = rows.flatMap((row) => {
    if (!row.started || row.done) return [];
    const match = pattern.exec(row.step);
    return match ? [{ row, round: Number(match[1]), fixFor: match[2], implementationInput: match[3] }] : [];
  });
  return matches.length === 1 ? matches[0] : matches.length > 1 ? { conflict: true as const } : null;
}

function applyTaskEvent(request: TaskEventRequest, options: TaskWriteOptions = {}): TaskEventResult {
  const invalid = validateTaskEventRequest(request);
  if (invalid) return failed(request, invalid);
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(request, { code: resolved.code, message: resolved.message }, { taskId: resolved.taskId });
  if (resolved.state !== 'active') return failed(request, { code: 'TASK_STATE_MISMATCH', message: `task ${resolved.taskId} is ${resolved.state}, expected active` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
  let content: string;
  try { content = fs.readFileSync(resolved.taskMdPath, 'utf8'); }
  catch (error) { return failed(request, { code: 'TASK_READ_FAILED', message: String(error) }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath }); }
  let frontmatter;
  try { frontmatter = parseTypedTaskFrontmatter(content); }
  catch (error) { return failed(request, { code: 'TASK_DOCUMENT_INVALID', message: error instanceof Error ? error.message : String(error) }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath }); }
  const section = locateActivityLog(content);
  if (!section) return failed(request, { code: 'EVENT_LOG_MISSING', message: 'task has no unique Activity Log section' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
  const rows = pairEntries(section.entries);
  let normalized = request;
  let artifactContext: ArtifactContextResult | null = null;
  const initialParts = eventParts(request.event);
  if (initialParts.phase === 'started') {
    const openIdentity = openStartedIdentity(rows, initialParts.family);
    if (openIdentity && 'conflict' in openIdentity) return failed(request, { code: 'EVENT_LOG_CONFLICT', message: 'artifact family has more than one open started event' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
    if (openIdentity) {
      if (openIdentity.row.agent !== request.agent) return failed(request, { code: 'EVENT_LOG_CONFLICT', message: 'open started event has a different agent' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
      if (request.round !== undefined && request.round !== openIdentity.round) return failed(request, { code: 'EVENT_ARTIFACT_CONFLICT', message: `round ${request.round} conflicts with open round ${openIdentity.round}` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
      if (request.fixFor !== undefined && request.fixFor !== openIdentity.fixFor) return failed(request, { code: 'EVENT_ARTIFACT_CONFLICT', message: `fixFor '${request.fixFor}' conflicts with open event` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
      if (request.implementationInput !== openIdentity.implementationInput) return failed(request, { code: 'EVENT_ARTIFACT_CONFLICT', message: `implementationInput '${request.implementationInput ?? ''}' conflicts with open event` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
      normalized = { ...request, round: openIdentity.round, artifact: artifactName(FAMILY[initialParts.family].artifact, openIdentity.round), fixFor: openIdentity.fixFor, implementationInput: openIdentity.implementationInput };
      return successNoOp(normalized, resolved.taskId, resolved.taskMdPath, typeof frontmatter.current_step === 'string' ? frontmatter.current_step : '', identity(normalized), openIdentity.row.started, frontmatter, null);
    }
    const result = normalizeStarted(request, resolved.repoRoot);
    artifactContext = result.context;
    if ('error' in result) return failed(request, result.error, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, artifactContext });
    normalized = result.request;
  } else if (initialParts.phase === 'completed') {
    const identity = request.artifact ? parseArtifactName(request.artifact) : null;
    if (identity?.family === FAMILY[initialParts.family].artifact) normalized = { ...request, round: identity.round };
  }
  const eventIdentity = identity(normalized);
  const currentStep = typeof frontmatter.current_step === 'string' ? frontmatter.current_step : '';
  const matchingRows = rows.filter((item) => item.step === eventIdentity.action);
  const manual = eventIdentity.family === 'manual-validation';
  if (!manual && matchingRows.length > 1) return failed(normalized, { code: 'EVENT_LOG_CONFLICT', message: 'event identity appears more than once' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase, artifactContext });
  const openRows = matchingRows.filter((item) => item.started && !item.done);
  const completedRows = matchingRows.filter((item) => item.done);
  const row = manual ? openRows.at(-1) : matchingRows[0];
  let completedArtifact: ArtifactIdentity | null = null;
  if (eventIdentity.phase === 'started' && row) {
    if (row.agent !== normalized.agent) return failed(normalized, { code: 'EVENT_LOG_CONFLICT', message: 'open started event has a different agent' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
    return successNoOp(normalized, resolved.taskId, resolved.taskMdPath, currentStep, eventIdentity, row.started, frontmatter, artifactContext);
  }
  if (eventIdentity.phase === 'started' && !manual && completedRows.length > 0) return failed(normalized, { code: 'EVENT_ALREADY_COMPLETED', message: 'event identity is already completed' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
  const done = completedRows.find((item) => item.note === eventIdentity.note);
  if (eventIdentity.phase === 'completed' && done) return successNoOp(normalized, resolved.taskId, resolved.taskMdPath, currentStep, eventIdentity, done.done, frontmatter, artifactContext);
  if (eventIdentity.phase === 'completed' && completedRows.length > 0 && openRows.length === 0) return failed(normalized, { code: 'EVENT_LOG_CONFLICT', message: 'event identity is already completed with a different payload' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
  if (eventIdentity.phase === 'completed' && !row?.started) return failed(normalized, { code: 'EVENT_START_MISSING', message: 'completion requires one open matching started event' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
  if (eventIdentity.phase === 'completed') {
    const validated = validateCompletedArtifact(resolved.taskDir, FAMILY[eventIdentity.family].artifact, normalized.artifact!, normalized.round);
    if (!validated.ok) return failed(normalized, validated.error, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
    completedArtifact = validated.artifact;
  }
  if (eventIdentity.phase === 'waiting' && section.entries.some((entry) => entry.step === eventIdentity.action && entry.note === eventIdentity.note)) {
    const existing = section.entries.find((entry) => entry.step === eventIdentity.action && entry.note === eventIdentity.note)!;
    return successNoOp(normalized, resolved.taskId, resolved.taskMdPath, currentStep, eventIdentity, existing.time, frontmatter, artifactContext);
  }
  const allowed = FAMILY[eventIdentity.family][eventIdentity.phase === 'started' ? 'started' : 'completed'];
  if (!(allowed as readonly string[]).includes(currentStep)) return failed(normalized, { code: 'EVENT_TRANSITION_INVALID', message: `${normalized.event} is not allowed from '${currentStep}'` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
  let metadata;
  try { metadata = (options.metadataProvider ?? captureTaskWriteMetadata)(); }
  catch (error) { return failed(normalized, { code: 'METADATA_CAPTURE_FAILED', message: String(error) }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath }); }
  const step = eventIdentity.phase === 'started' || eventIdentity.target === null ? currentStep : eventIdentity.target;
  const logStep = eventIdentity.phase === 'started' ? `${eventIdentity.action} [started]` : eventIdentity.action;
  const body = appendActivityEntry(section, { time: metadata.timestamp, step: logStep, agent: normalized.agent, note: eventIdentity.note });
  const frontmatterSet: Record<string, string> = { current_step: step, assigned_to: normalized.agent };
  if (eventIdentity.phase === 'started' && normalized.implementationInput) frontmatterSet.last_reviewed_commit = '';
  const mutations: Parameters<typeof writeTask>[0]['mutations'][number][] = [
    { kind: 'frontmatter', set: frontmatterSet }
  ];
  if (completedArtifact) {
    const link = buildArtifactLinkSection(content, completedArtifact);
    mutations.push({ kind: 'section', aliases: link.aliases, heading: link.heading, body: link.body });
  }
  if (eventIdentity.phase === 'completed' && normalized.implementationInput) {
    let implementationRows;
    try {
      implementationRows = consumeImplementationInput(
        parseImplementationInputs(content).rows,
        normalized.implementationInput,
        normalized.artifact!
      );
    } catch (error) {
      return failed(normalized, { code: 'EVENT_ARTIFACT_CONFLICT', message: error instanceof Error ? error.message : String(error) }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
    }
    mutations.push({
      kind: 'section', aliases: IMPLEMENTATION_INPUT_ALIASES,
      heading: findSectionHeading(content, [...IMPLEMENTATION_INPUT_ALIASES]),
      body: renderImplementationInputs(implementationRows)
    });
  }
  mutations.push({ kind: 'section', aliases: ['活动日志', 'Activity Log'], heading: section.heading, body });
  const result = writeTask({ taskRef: normalized.taskRef, expectedState: 'active', dryRun: normalized.dryRun, mutations }, { ...options, metadataProvider: () => metadata });
  if (result.status === 'failed') return failed(normalized, result.error, { taskId: result.taskId, taskMdPath: result.taskMdPath, fromStep: currentStep, toStep: step, action: eventIdentity.action, phase: eventIdentity.phase, timestamp: result.timestamp, agentInfraVersion: result.agentInfraVersion, operations: result.operations, artifactContext });
  return {
    status: result.status, changed: result.changed, event: normalized.event,
    requestRef: normalized.taskRef, taskId: result.taskId, taskMdPath: result.taskMdPath,
    fromStep: currentStep, toStep: step, action: eventIdentity.action, phase: eventIdentity.phase,
    round: normalized.round ?? null, artifact: normalized.artifact ?? null,
    fixFor: normalized.fixFor ?? null, implementationInput: normalized.implementationInput ?? null,
    artifactContext, timestamp: result.timestamp,
    agentInfraVersion: result.agentInfraVersion, operations: result.operations, error: null
  };
}

function successNoOp(
  request: TaskEventRequest, taskId: string, taskMdPath: string, currentStep: string,
  eventIdentity: ReturnType<typeof identity>, timestamp: string,
  frontmatter: Record<string, unknown>, artifactContext: ArtifactContextResult | null
): TaskEventResult {
  return {
    ...failed(request, { code: 'EVENT_LOG_CONFLICT', message: '' }), status: 'no-op', error: null,
    taskId, taskMdPath, fromStep: currentStep, toStep: currentStep,
    action: eventIdentity.action, phase: eventIdentity.phase, timestamp,
    agentInfraVersion: typeof frontmatter.agent_infra_version === 'string' ? frontmatter.agent_infra_version : null,
    artifactContext
  };
}

export { eventCatalog, validateTaskEventRequest, applyTaskEvent };
export type { TaskEventName, TaskEventRequest, TaskEventResult, TaskEventError, TaskEventErrorCode, Verdict };
