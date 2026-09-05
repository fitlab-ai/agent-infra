import fs from 'node:fs';

import { CONSTRAINT_COLUMNS, CANDIDATE_COLUMNS, parseTaskQualification } from './qualification-audit.ts';
import type { CandidateStatus, ConstraintStatus } from './qualification-audit.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { captureTaskWriteMetadata, writeTask } from './write.ts';
import type { TaskOperationSummary, TaskWriteOptions } from './write.ts';

type QualificationConstraintProposal = {
  constraintId: string;
  statement: string;
  status: Exclude<ConstraintStatus, 'confirmed'>;
  authority: string;
  source: string;
  evidence: string;
  derivedFrom: readonly string[];
  approvalEvidence: string;
};
type QualificationCandidateProposal = {
  candidateId: string;
  statement: string;
  status: Extract<CandidateStatus, 'pending'>;
  constraintIds: readonly string[];
  impact: string;
  evidence: string;
};
type QualificationProposalRequest = {
  taskRef: string;
  expectedTaskInputDigest: string;
  constraints?: readonly QualificationConstraintProposal[];
  candidates?: readonly QualificationCandidateProposal[];
  dryRun?: boolean;
};
type QualificationProposalResult = {
  status: 'planned' | 'applied' | 'no-op' | 'failed';
  changed: boolean;
  taskId: string | null;
  operations: readonly TaskOperationSummary[];
  error: { code: string; message: string } | null;
};

function failed(code: string, message: string, taskId: string | null = null): QualificationProposalResult {
  return { status: 'failed', changed: false, taskId, operations: [], error: { code, message } };
}

function validSingleLine(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && !/[\r\n]/.test(value);
}

function assertProposalKeys(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  const unexpected = Object.keys(record).find((key) => !keys.includes(key));
  if (unexpected) throw new Error(`${label} does not accept '${unexpected}'`);
  return record;
}

function parseConstraintProposal(value: unknown): QualificationConstraintProposal {
  const row = assertProposalKeys(value, ['constraintId', 'statement', 'status', 'authority', 'source', 'evidence', 'derivedFrom', 'approvalEvidence'], 'constraint proposal');
  for (const key of ['constraintId', 'statement', 'status', 'authority', 'source', 'evidence', 'approvalEvidence']) {
    if (typeof row[key] !== 'string' || /[\r\n]/.test(row[key] as string)) throw new Error(`constraint proposal '${key}' must be a single-line string`);
  }
  if (!/^C-[1-9]\d*$/.test(row.constraintId as string)) throw new Error(`constraint proposal id '${row.constraintId as string}' is invalid`);
  if (row.status === 'confirmed' || !['derived', 'assumption', 'open', 'conflicted', 'superseded'].includes(row.status as string)) throw new Error('proposal cannot write confirmed constraint status');
  if ((row.approvalEvidence as string) !== '') throw new Error('proposal cannot write approval_evidence');
  if (!Array.isArray(row.derivedFrom) || row.derivedFrom.some((item) => typeof item !== 'string' || !/^C-[1-9]\d*$/.test(item))) throw new Error('constraint proposal derivedFrom is invalid');
  return {
    constraintId: row.constraintId as string, statement: row.statement as string, status: row.status as Exclude<ConstraintStatus, 'confirmed'>,
    authority: row.authority as string, source: row.source as string, evidence: row.evidence as string,
    derivedFrom: [...row.derivedFrom as string[]], approvalEvidence: ''
  };
}

function parseCandidateProposal(value: unknown): QualificationCandidateProposal {
  const row = assertProposalKeys(value, ['candidateId', 'statement', 'status', 'constraintIds', 'impact', 'evidence'], 'candidate proposal');
  for (const key of ['candidateId', 'statement', 'status', 'impact', 'evidence']) if (!validSingleLine(row[key])) throw new Error(`candidate proposal '${key}' must be a non-empty single-line string`);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(row.candidateId as string)) throw new Error(`candidate proposal id '${row.candidateId as string}' is invalid`);
  if (row.status !== 'pending') throw new Error('proposal can only write pending candidate status');
  if (!Array.isArray(row.constraintIds) || row.constraintIds.some((item) => typeof item !== 'string' || !/^C-[1-9]\d*$/.test(item))) throw new Error('candidate proposal constraintIds is invalid');
  return row as unknown as QualificationCandidateProposal;
}

function proposalValues(request: QualificationProposalRequest): { constraints: QualificationConstraintProposal[]; candidates: QualificationCandidateProposal[] } {
  if (!/^[a-f0-9]{64}$/i.test(request.expectedTaskInputDigest)) throw new Error('expectedTaskInputDigest must be a sha256 digest');
  if (Object.keys(request).some((key) => !['taskRef', 'expectedTaskInputDigest', 'constraints', 'candidates', 'dryRun'].includes(key))) throw new Error('proposal contains an unsupported field');
  if (!Array.isArray(request.constraints) && request.constraints !== undefined) throw new Error('constraints must be an array');
  if (!Array.isArray(request.candidates) && request.candidates !== undefined) throw new Error('candidates must be an array');
  return {
    constraints: (request.constraints ?? []).map(parseConstraintProposal),
    candidates: (request.candidates ?? []).map(parseCandidateProposal)
  };
}

function applyQualificationProposal(request: QualificationProposalRequest, options: TaskWriteOptions = {}): QualificationProposalResult {
  if (!request || typeof request !== 'object' || !validSingleLine(request.taskRef)) return failed('QUALIFICATION_PROPOSAL_INVALID', 'taskRef is required');
  let values: ReturnType<typeof proposalValues>;
  try { values = proposalValues(request); }
  catch (error) { return failed('QUALIFICATION_PROPOSAL_INVALID', error instanceof Error ? error.message : String(error)); }
  if (values.constraints.length === 0 && values.candidates.length === 0) return failed('QUALIFICATION_PROPOSAL_INVALID', 'proposal must contain a constraint or candidate');
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message, resolved.taskId);
  if (resolved.state !== 'active') return failed('TASK_STATE_MISMATCH', `task ${resolved.taskId} is ${resolved.state}, expected active`, resolved.taskId);
  let content: string;
  try { content = fs.readFileSync(resolved.taskMdPath, 'utf8'); }
  catch (error) { return failed('TASK_READ_FAILED', error instanceof Error ? error.message : String(error), resolved.taskId); }
  const parsed = parseTaskQualification(content);
  if (!parsed.ok) return failed(parsed.code, parsed.message, resolved.taskId);
  if (!parsed.qualification.present) return failed('QUALIFICATION_TASK_CONTRACT_MISSING', 'task qualification contract is missing', resolved.taskId);
  const currentConstraintMap = new Map(parsed.qualification.constraints.map((row) => [row.constraintId, row]));
  const currentCandidateMap = new Map(parsed.qualification.candidates.map((row) => [row.candidateId, row]));
  const proposalAlreadyApplied = values.constraints.every((row) => {
    const current = currentConstraintMap.get(row.constraintId);
    return current && current.statement === row.statement && current.status === row.status && current.authority === row.authority
      && current.source === row.source && current.evidence === row.evidence && current.derivedFrom.join(',') === row.derivedFrom.join(',') && current.approvalEvidence === '';
  }) && values.candidates.every((row) => {
    const current = currentCandidateMap.get(row.candidateId);
    return current && current.statement === row.statement && current.status === row.status && current.constraintIds.join(',') === row.constraintIds.join(',')
      && current.impact === row.impact && current.evidence === row.evidence;
  });
  if (parsed.qualification.taskInputDigest !== request.expectedTaskInputDigest) {
    return proposalAlreadyApplied
      ? { status: 'no-op', changed: false, taskId: resolved.taskId, operations: [], error: null }
      : failed('QUALIFICATION_DIGEST_CONFLICT', 'task qualification input changed before proposal was applied', resolved.taskId);
  }
  for (const row of values.constraints) {
    const current = currentConstraintMap.get(row.constraintId);
    if (current?.status === 'confirmed') return failed('QUALIFICATION_CONFIRMATION_REQUIRED', `confirmed constraint '${row.constraintId}' must be superseded or revoked through task-qualification`, resolved.taskId);
  }
  const knownConstraintIds = new Set([...parsed.qualification.constraints.map((row) => row.constraintId), ...values.constraints.map((row) => row.constraintId)]);
  for (const row of values.constraints) for (const parent of row.derivedFrom) if (!knownConstraintIds.has(parent)) return failed('QUALIFICATION_CONSTRAINT_UNKNOWN', `constraint proposal '${row.constraintId}' references unknown '${parent}'`, resolved.taskId);
  for (const row of values.candidates) for (const id of row.constraintIds) if (!knownConstraintIds.has(id)) return failed('QUALIFICATION_CONSTRAINT_UNKNOWN', `candidate proposal '${row.candidateId}' references unknown '${id}'`, resolved.taskId);
  const mutations: Parameters<typeof writeTask>[0]['mutations'][number][] = [];
  for (const row of values.constraints) {
    mutations.push({ kind: 'table-row', action: 'upsert', sectionAliases: ['约束', 'Constraints'], columns: CONSTRAINT_COLUMNS, keyColumn: 'constraint_id', key: row.constraintId, values: { statement: row.statement, status: row.status, authority: row.authority, source: row.source, evidence: row.evidence, derived_from: row.derivedFrom.join(','), approval_evidence: '' } });
  }
  for (const row of values.candidates) {
    mutations.push({ kind: 'table-row', action: 'upsert', sectionAliases: ['候选与否决方案', 'Candidate and Rejected Options', 'Candidates and Rejected Options', 'Candidates and Rejected Alternatives'], columns: CANDIDATE_COLUMNS, keyColumn: 'candidate_id', key: row.candidateId, values: { statement: row.statement, status: row.status, constraint_ids: row.constraintIds.join(','), impact: row.impact, evidence: row.evidence } });
  }
  // Only the submitted rows are mutated; no actor, confirmation, or QCR fields
  // can be smuggled into this internal proposal operation.
  let metadata;
  try { metadata = (options.metadataProvider ?? captureTaskWriteMetadata)(); }
  catch (error) { return failed('METADATA_CAPTURE_FAILED', error instanceof Error ? error.message : String(error), resolved.taskId); }
  const result = writeTask({ taskRef: resolved.taskId, expectedState: 'active', mutations, dryRun: request.dryRun }, { ...options, taskLocation: { repoRoot: resolved.repoRoot, taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, state: resolved.state }, metadataProvider: () => metadata });
  if (result.status === 'failed') return failed(result.error.code, result.error.message, result.taskId);
  return { status: result.status, changed: result.changed, taskId: result.taskId, operations: result.operations, error: null };
}

export { applyQualificationProposal };
export type { QualificationCandidateProposal, QualificationConstraintProposal, QualificationProposalRequest, QualificationProposalResult };
