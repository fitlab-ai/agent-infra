import { createHash } from 'node:crypto';

import { parseTable } from './sections.ts';

const TASK_CONSTRAINT_HEADINGS = ['约束', 'Constraints'] as const;
const TASK_CANDIDATE_HEADINGS = ['候选与否决方案', 'Candidate and Rejected Options', 'Candidates and Rejected Options', 'Candidates and Rejected Alternatives'] as const;
const AUDIT_HEADINGS = ['资格审计', 'Qualification Audit'] as const;
const CONFIRMATION_HEADINGS = ['资格确认记录', 'Qualification Confirmations'] as const;
const AUDIT_SUBSECTIONS = ['约束依赖', '候选资格', '分类结果', '上游关系', '依赖快照'] as const;
const AUDIT_SUBSECTION_HEADINGS: Record<(typeof AUDIT_SUBSECTIONS)[number], readonly string[]> = {
  '约束依赖': ['约束依赖', 'Constraint Dependencies'],
  '候选资格': ['候选资格', 'Candidate Qualification'],
  '分类结果': ['分类结果', 'Classification Results'],
  '上游关系': ['上游关系', 'Upstream Relations'],
  '依赖快照': ['依赖快照', 'Dependency Snapshot']
};

const CONSTRAINT_COLUMNS = ['constraint_id', 'statement', 'status', 'authority', 'source', 'evidence', 'derived_from', 'approval_evidence'] as const;
const CANDIDATE_COLUMNS = ['candidate_id', 'statement', 'status', 'constraint_ids', 'impact', 'evidence'] as const;
const DEPENDENCY_COLUMNS = ['constraint_id', 'constraint_digest', 'role', 'evidence'] as const;
const QUALIFICATION_COLUMNS = ['candidate_id', 'status', 'impact', 'constraint_ids', 'evidence'] as const;
const CLASSIFICATION_COLUMNS = ['decision_id', 'classification', 'evidence'] as const;
const RELATION_COLUMNS = ['upstream_family', 'upstream_artifact', 'upstream_round', 'upstream_sha256', 'relation'] as const;
const SNAPSHOT_COLUMNS = ['task_input_digest', 'non_constraint_input_digest', 'upstream_artifact_digest'] as const;
const CONFIRMATION_COLUMNS = ['qcr_id', 'constraint_id', 'actor', 'entrypoint', 'request_id', 'approved_digest', 'confirmed_at', 'rationale'] as const;

const ARTIFACT_FAMILIES = ['analysis', 'review-analysis', 'plan', 'review-plan', 'code', 'review-code'] as const;
const RELATIONS = ['required-input', 'reviewed-input', 'review-context', 'approval-context'] as const;
const CONSTRAINT_STATUSES = ['confirmed', 'derived', 'assumption', 'open', 'conflicted', 'superseded'] as const;
const CANDIDATE_STATUSES = ['qualified', 'rejected', 'pending', 'needs-human-decision', 'confirmed', 'excluded'] as const;
const CLASSIFICATIONS = ['deterministic', 'qualified', 'rejected', 'needs-human-decision', 'not-applicable'] as const;
const ROLES = ['required', 'inherited', 'context', 'filter'] as const;

type ConstraintStatus = (typeof CONSTRAINT_STATUSES)[number];
type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];
type QualificationClassification = (typeof CLASSIFICATIONS)[number];
type ArtifactFamily = (typeof ARTIFACT_FAMILIES)[number];
type QualificationRelation = (typeof RELATIONS)[number];
type QualificationRole = (typeof ROLES)[number];

type Constraint = {
  constraintId: string;
  statement: string;
  status: ConstraintStatus;
  authority: string;
  source: string;
  evidence: string;
  derivedFrom: readonly string[];
  approvalEvidence: string;
  digest: string;
};
type Candidate = {
  candidateId: string;
  statement: string;
  status: CandidateStatus;
  constraintIds: readonly string[];
  impact: string;
  evidence: string;
};
type TaskQualification = {
  present: boolean;
  constraints: readonly Constraint[];
  candidates: readonly Candidate[];
  constraintDigest: string;
  taskInputDigest: string;
  nonConstraintInputDigest: string;
};
type ConstraintDependency = {
  constraintId: string;
  constraintDigest: string;
  role: QualificationRole;
  evidence: string;
};
type CandidateQualification = {
  candidateId: string;
  status: CandidateStatus;
  impact: string;
  constraintIds: readonly string[];
  evidence: string;
};
type QualificationClassificationRow = {
  decisionId: string;
  classification: QualificationClassification;
  evidence: string;
};
type UpstreamRelation = {
  upstreamFamily: ArtifactFamily;
  upstreamArtifact: string;
  upstreamRound: number;
  upstreamSha256: string;
  relation: QualificationRelation;
};
type DependencySnapshot = {
  taskInputDigest: string;
  nonConstraintInputDigest: string;
  upstreamArtifactDigest: string;
};
type QualificationAudit = {
  present: boolean;
  constraintDependencies: readonly ConstraintDependency[];
  candidateQualifications: readonly CandidateQualification[];
  classifications: readonly QualificationClassificationRow[];
  upstreamRelations: readonly UpstreamRelation[];
  snapshot: DependencySnapshot | null;
};
type QualificationConfirmation = {
  qcrId: string;
  constraintId: string;
  actor: 'human-declared';
  entrypoint: 'ai qualify';
  requestId: string;
  approvedDigest: string;
  confirmedAt: string;
  rationale: string;
};
type QualificationValidationError = { code: string; message: string };
type QualificationValidationResult =
  | { ok: true; qualification: TaskQualification; audit: QualificationAudit }
  | { ok: false; code: string; message: string };

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function normalizeText(value: string): string {
  return value.normalize('NFC').replace(/\r\n?/g, '\n').trim();
}

function canonicalList(value: string): string[] {
  return normalizeText(value)
    .split(/[,\s]+/u)
    .map((item) => item.trim())
    .filter(Boolean)
    .sort();
}

function canonicalConstraintShape(row: Omit<Constraint, 'digest'>): Record<string, unknown> {
  return {
    constraintId: row.constraintId,
    statement: normalizeText(row.statement),
    status: row.status,
    authority: normalizeText(row.authority),
    source: normalizeText(row.source),
    evidence: normalizeText(row.evidence),
    derivedFrom: [...row.derivedFrom].sort(),
    approvalEvidence: normalizeText(row.approvalEvidence)
  };
}

function constraintDigest(row: Omit<Constraint, 'digest'>): string {
  return digest(canonicalConstraintShape(row));
}

function canonicalTaskInput(qualification: Pick<TaskQualification, 'constraints' | 'candidates'>): Record<string, unknown> {
  return {
    constraints: [...qualification.constraints].map(({ digest: _digest, ...row }) => canonicalConstraintShape(row)).sort((a, b) => String(a.constraintId).localeCompare(String(b.constraintId))),
    candidates: [...qualification.candidates].map((row) => ({
      candidateId: row.candidateId,
      statement: normalizeText(row.statement),
      status: row.status,
      constraintIds: [...row.constraintIds].sort(),
      impact: normalizeText(row.impact),
      evidence: normalizeText(row.evidence)
    })).sort((a, b) => a.candidateId.localeCompare(b.candidateId))
  };
}

function taskInputDigest(qualification: Pick<TaskQualification, 'constraints' | 'candidates'>): string {
  return digest(canonicalTaskInput(qualification));
}

function sectionBody(content: string, aliases: readonly string[], level = 2): string | null {
  const heading = aliases.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const marker = '#'.repeat(level);
  const match = new RegExp(`^${marker}\\s+(${heading})\\s*$`, 'm').exec(content);
  if (!match) return null;
  const rest = content.slice((match.index ?? 0) + match[0].length);
  const end = rest.search(new RegExp(`^#{2,${level}}\\s+`, 'm'));
  return rest.slice(0, end < 0 ? rest.length : end);
}

function stripSection(content: string, aliases: readonly string[]): string {
  const body = sectionBody(content, aliases);
  if (body === null) return normalizeText(content);
  const heading = aliases.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return normalizeText(content.replace(new RegExp(`^##\\s+(?:${heading})\\s*$[\\s\\S]*?(?=^##\\s+|$)`, 'm'), ''));
}

function nonConstraintInputDigest(content: string): string {
  let projection = stripTaskInputSection(content, TASK_CONSTRAINT_HEADINGS);
  projection = stripTaskInputSection(projection, TASK_CANDIDATE_HEADINGS);
  projection = [
    ['活动日志', 'Activity Log'],
    ['产物生命周期收据', 'Artifact Lifecycle Receipts'],
    ['产物失效记录', 'Artifact Invalidation'],
    ['账本', 'Ledger'],
    ['决策记录', 'Decision Records'],
    ['实现输入', 'Implementation Inputs'],
    ['警告', 'Warnings'],
    ['返工意图', 'Rework Intents'],
    CONFIRMATION_HEADINGS
  ].reduce((value, aliases) => stripSection(value, aliases), projection);
  return digest(projection);
}

function taskInputSection(content: string, aliases: readonly string[]): string | null {
  return sectionBody(content, aliases, 3) ?? sectionBody(content, aliases, 2);
}

function stripTaskInputSection(content: string, aliases: readonly string[]): string {
  let result = stripSectionAtLevel(content, aliases, 3);
  return stripSectionAtLevel(result, aliases, 2);
}

function stripSectionAtLevel(content: string, aliases: readonly string[], level: number): string {
  const body = sectionBody(content, aliases, level);
  if (body === null) return normalizeText(content);
  const heading = aliases.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const marker = '#'.repeat(level);
  return normalizeText(content.replace(new RegExp(`^${marker}\\s+(?:${heading})\\s*$[\\s\\S]*?(?=^#{2,${level}}\\s+|$)`, 'm'), ''));
}

function parseTaskQualification(content: string): { ok: true; qualification: TaskQualification } | { ok: false; code: string; message: string } {
  const hasConstraintHeading = taskInputSection(content, TASK_CONSTRAINT_HEADINGS) !== null;
  const hasCandidateHeading = taskInputSection(content, TASK_CANDIDATE_HEADINGS) !== null;
  if (!hasConstraintHeading && !hasCandidateHeading) {
    return { ok: true, qualification: { present: false, constraints: [], candidates: [], constraintDigest: digest([]), taskInputDigest: digest({ constraints: [], candidates: [] }), nonConstraintInputDigest: nonConstraintInputDigest(content) } };
  }
  if (!hasConstraintHeading || !hasCandidateHeading) {
    const hasCanonicalTable = new RegExp(`\\|\\s*${CONSTRAINT_COLUMNS.join('\\s*\\|\\s*')}\\s*\\|`).test(content)
      || new RegExp(`\\|\\s*${CANDIDATE_COLUMNS.join('\\s*\\|\\s*')}\\s*\\|`).test(content);
    if (hasCanonicalTable) return { ok: false, code: 'QUALIFICATION_TASK_CONTRACT_INVALID', message: 'task qualification requires both constraints and candidates sections' };
    return { ok: true, qualification: { present: false, constraints: [], candidates: [], constraintDigest: digest([]), taskInputDigest: digest({ constraints: [], candidates: [] }), nonConstraintInputDigest: nonConstraintInputDigest(content) } };
  }
  try {
    const constraintBody = taskInputSection(content, TASK_CONSTRAINT_HEADINGS);
    const candidateBody = taskInputSection(content, TASK_CANDIDATE_HEADINGS);
    const constraintTable = constraintBody === null ? null : parseTable(`## 约束\n${constraintBody}`, { sectionAliases: ['约束'], columns: CONSTRAINT_COLUMNS });
    const candidateTable = candidateBody === null ? null : parseTable(`## 候选与否决方案\n${candidateBody}`, { sectionAliases: ['候选与否决方案'], columns: CANDIDATE_COLUMNS });
    if (!constraintTable || !candidateTable) return { ok: false, code: 'QUALIFICATION_TASK_CONTRACT_INVALID', message: 'task qualification requires canonical constraints and candidates tables' };
    const constraints = constraintTable.rows.map(({ values }) => {
      const row = {
        constraintId: values.constraint_id ?? '', statement: values.statement ?? '', status: values.status as ConstraintStatus,
        authority: values.authority ?? '', source: values.source ?? '', evidence: values.evidence ?? '',
        derivedFrom: canonicalList(values.derived_from ?? ''), approvalEvidence: values.approval_evidence ?? ''
      } satisfies Omit<Constraint, 'digest'>;
      validateConstraint(row);
      return { ...row, digest: constraintDigest(row) };
    });
    const ids = new Set(constraints.map((row) => row.constraintId));
    for (const row of constraints) for (const parent of row.derivedFrom) if (!ids.has(parent)) throw new Error(`constraint '${row.constraintId}' references unknown derived constraint '${parent}'`);
    const candidates = candidateTable.rows.map(({ values }) => {
      const row: Candidate = {
        candidateId: values.candidate_id ?? '', statement: values.statement ?? '', status: values.status as CandidateStatus,
        constraintIds: canonicalList(values.constraint_ids ?? ''), impact: values.impact ?? '', evidence: values.evidence ?? ''
      };
      validateCandidate(row);
      for (const id of row.constraintIds) if (!ids.has(id)) throw new Error(`candidate '${row.candidateId}' references unknown constraint '${id}'`);
      return row;
    });
    const qualification: TaskQualification = {
      present: true, constraints, candidates,
      constraintDigest: digest(constraints.map((row) => canonicalConstraintShape(row)).sort((a, b) => String(a.constraintId).localeCompare(String(b.constraintId)))),
      taskInputDigest: taskInputDigest({ constraints, candidates }),
      nonConstraintInputDigest: nonConstraintInputDigest(content)
    };
    return { ok: true, qualification };
  } catch (error) {
    return { ok: false, code: 'QUALIFICATION_TASK_CONTRACT_INVALID', message: error instanceof Error ? error.message : String(error) };
  }
}

function validateConstraint(row: Omit<Constraint, 'digest'>): void {
  if (!/^C-[1-9]\d*$/.test(row.constraintId)) throw new Error(`constraint id '${row.constraintId}' is invalid`);
  if (!normalizeText(row.statement)) throw new Error(`constraint '${row.constraintId}' statement is required`);
  if (!CONSTRAINT_STATUSES.includes(row.status)) throw new Error(`constraint '${row.constraintId}' status is invalid`);
  if (!normalizeText(row.authority) || !normalizeText(row.source) || !normalizeText(row.evidence)) throw new Error(`constraint '${row.constraintId}' authority, source, and evidence are required`);
  if (row.status === 'confirmed' && !normalizeText(row.approvalEvidence)) throw new Error(`confirmed constraint '${row.constraintId}' requires approval_evidence`);
}

function validateCandidate(row: Pick<Candidate, 'candidateId' | 'status' | 'impact' | 'evidence'> & Partial<Pick<Candidate, 'statement'>>): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(row.candidateId)) throw new Error(`candidate id '${row.candidateId}' is invalid`);
  if ('statement' in row && !normalizeText(row.statement ?? '')) throw new Error(`candidate '${row.candidateId}' statement is required`);
  if (!CANDIDATE_STATUSES.includes(row.status)) throw new Error(`candidate '${row.candidateId}' status is invalid`);
  if (!normalizeText(row.impact) || !normalizeText(row.evidence)) throw new Error(`candidate '${row.candidateId}' impact and evidence are required`);
}

function parseAuditTable(content: string, heading: (typeof AUDIT_SUBSECTIONS)[number], columns: readonly string[]): Record<string, string>[] | null {
  const body = sectionBody(content, AUDIT_HEADINGS);
  if (body === null) return null;
  const subsection = sectionBody(body, AUDIT_SUBSECTION_HEADINGS[heading], 3);
  if (subsection === null) return null;
  const table = parseTable(`## Qualification Audit Body\n${subsection}`, { sectionAliases: ['Qualification Audit Body'], columns });
  return table?.rows.map((row) => ({ ...row.values })) ?? null;
}

function parseArtifactName(value: string): { family: ArtifactFamily; round: number } | null {
  const match = /^(analysis|review-analysis|plan|review-plan|code|review-code)(?:-r([2-9]|[1-9]\d+))?\.md$/.exec(value);
  if (!match) return null;
  return { family: match[1] as ArtifactFamily, round: match[2] ? Number(match[2]) : 1 };
}

function upstreamArtifactDigest(rows: readonly UpstreamRelation[]): string {
  return digest([...rows].map((row) => ({ ...row })).sort((a, b) =>
    `${a.upstreamFamily}/${a.upstreamArtifact}/${a.relation}`.localeCompare(`${b.upstreamFamily}/${b.upstreamArtifact}/${b.relation}`)));
}

function parseQualificationAudit(content: string): { ok: true; audit: QualificationAudit } | { ok: false; code: string; message: string } {
  if (sectionBody(content, AUDIT_HEADINGS) === null) return { ok: true, audit: { present: false, constraintDependencies: [], candidateQualifications: [], classifications: [], upstreamRelations: [], snapshot: null } };
  try {
    const dependencies = parseAuditTable(content, '约束依赖', DEPENDENCY_COLUMNS);
    const qualifications = parseAuditTable(content, '候选资格', QUALIFICATION_COLUMNS);
    const classifications = parseAuditTable(content, '分类结果', CLASSIFICATION_COLUMNS);
    const relations = parseAuditTable(content, '上游关系', RELATION_COLUMNS);
    const snapshots = parseAuditTable(content, '依赖快照', SNAPSHOT_COLUMNS);
    if (!dependencies || !qualifications || !classifications || !relations || !snapshots || snapshots.length !== 1) {
      throw new Error('qualification audit requires all five canonical tables and exactly one dependency snapshot');
    }
    const constraintDependencies = dependencies.map((row) => {
      if (!/^C-[1-9]\d*$/.test(row.constraint_id ?? '') || !/^[a-f0-9]{64}$/i.test(row.constraint_digest ?? '') || !ROLES.includes(row.role as QualificationRole) || !row.evidence?.trim()) throw new Error(`invalid qualification constraint dependency '${row.constraint_id ?? ''}'`);
      return { constraintId: row.constraint_id!, constraintDigest: row.constraint_digest!, role: row.role as QualificationRole, evidence: row.evidence! };
    });
    const candidateQualifications = qualifications.map((row) => {
      const parsed: CandidateQualification = { candidateId: row.candidate_id ?? '', status: row.status as CandidateStatus, impact: row.impact ?? '', constraintIds: canonicalList(row.constraint_ids ?? ''), evidence: row.evidence ?? '' };
      validateCandidate(parsed);
      return parsed;
    });
    const classificationRows = classifications.map((row) => {
      if (!row.decision_id?.trim() || !CLASSIFICATIONS.includes(row.classification as QualificationClassification) || !row.evidence?.trim()) throw new Error(`invalid qualification classification '${row.decision_id ?? ''}'`);
      return { decisionId: row.decision_id, classification: row.classification as QualificationClassification, evidence: row.evidence };
    });
    const upstreamRelations = relations.map((row) => {
      const identity = parseArtifactName(row.upstream_artifact ?? '');
      const round = Number(row.upstream_round);
      if (!ARTIFACT_FAMILIES.includes(row.upstream_family as ArtifactFamily) || !identity || identity.family !== row.upstream_family || identity.round !== round || !Number.isSafeInteger(round) || !/^[a-f0-9]{64}$/i.test(row.upstream_sha256 ?? '') || !RELATIONS.includes(row.relation as QualificationRelation)) throw new Error(`invalid qualification upstream relation '${row.upstream_artifact ?? ''}'`);
      return { upstreamFamily: row.upstream_family as ArtifactFamily, upstreamArtifact: row.upstream_artifact!, upstreamRound: round, upstreamSha256: row.upstream_sha256!, relation: row.relation as QualificationRelation };
    });
    const snapshotRow = snapshots[0]!;
    if (!/^[a-f0-9]{64}$/i.test(snapshotRow.task_input_digest ?? '') || !/^[a-f0-9]{64}$/i.test(snapshotRow.non_constraint_input_digest ?? '') || !/^[a-f0-9]{64}$/i.test(snapshotRow.upstream_artifact_digest ?? '')) throw new Error('qualification dependency snapshot has invalid digest');
    return {
      ok: true,
      audit: {
        present: true, constraintDependencies, candidateQualifications,
        classifications: classificationRows, upstreamRelations,
        snapshot: { taskInputDigest: snapshotRow.task_input_digest!, nonConstraintInputDigest: snapshotRow.non_constraint_input_digest!, upstreamArtifactDigest: snapshotRow.upstream_artifact_digest! }
      }
    };
  } catch (error) {
    return { ok: false, code: 'QUALIFICATION_AUDIT_INVALID', message: error instanceof Error ? error.message : String(error) };
  }
}

function parseQualificationConfirmations(content: string): { ok: true; confirmations: readonly QualificationConfirmation[] } | { ok: false; code: string; message: string } {
  const body = sectionBody(content, CONFIRMATION_HEADINGS);
  if (body === null) return { ok: true, confirmations: [] };
  try {
    const table = parseTable(content, { sectionAliases: CONFIRMATION_HEADINGS, columns: CONFIRMATION_COLUMNS });
    if (!table) throw new Error('qualification confirmation section requires a canonical table');
    const seen = new Set<string>();
    const confirmations = table.rows.map(({ values }) => {
      const row: QualificationConfirmation = {
        qcrId: values.qcr_id ?? '', constraintId: values.constraint_id ?? '', actor: values.actor as 'human-declared',
        entrypoint: values.entrypoint as 'ai qualify', requestId: values.request_id ?? '', approvedDigest: values.approved_digest ?? '',
        confirmedAt: values.confirmed_at ?? '', rationale: values.rationale ?? ''
      };
      if (!/^QCR-[1-9]\d*$/.test(row.qcrId) || !/^C-[1-9]\d*$/.test(row.constraintId) || row.actor !== 'human-declared' || row.entrypoint !== 'ai qualify' || !row.requestId || !/^[a-f0-9]{64}$/.test(row.approvedDigest) || !row.confirmedAt || Number.isNaN(Date.parse(row.confirmedAt.replace(' ', 'T'))) || !row.rationale || /[\r\n]/.test(row.rationale)) throw new Error(`qualification confirmation '${row.qcrId}' is invalid`);
      if (seen.has(row.qcrId)) throw new Error(`duplicate qualification confirmation '${row.qcrId}'`);
      seen.add(row.qcrId);
      return row;
    });
    return { ok: true, confirmations };
  } catch (error) {
    return { ok: false, code: 'QUALIFICATION_CONFIRMATION_INVALID', message: error instanceof Error ? error.message : String(error) };
  }
}

function validateQualificationAudit(
  taskContent: string,
  artifactContent: string,
  options: { family?: ArtifactFamily; artifact?: string; require?: boolean } = {}
): QualificationValidationResult {
  const task = parseTaskQualification(taskContent);
  if (!task.ok) return task;
  const audit = parseQualificationAudit(artifactContent);
  if (!audit.ok) return audit;
  if (!task.qualification.present && !options.require) return { ok: true, qualification: task.qualification, audit: audit.audit };
  if (!task.qualification.present) return { ok: false, code: 'QUALIFICATION_TASK_CONTRACT_MISSING', message: 'task qualification contract is missing' };
  if (!audit.audit.present) return { ok: false, code: 'QUALIFICATION_AUDIT_MISSING', message: 'artifact qualification audit is missing' };
  const constraintMap = new Map(task.qualification.constraints.map((row) => [row.constraintId, row]));
  const confirmations = parseQualificationConfirmations(taskContent);
  if (!confirmations.ok) return confirmations;
  const confirmationMap = new Map(confirmations.confirmations.map((row) => [row.constraintId, row]));
  for (const constraint of task.qualification.constraints) {
    if (constraint.status !== 'confirmed') continue;
    const confirmation = confirmationMap.get(constraint.constraintId);
    if (!confirmation || constraint.approvalEvidence !== confirmation.qcrId) return { ok: false, code: 'QUALIFICATION_CONFIRMATION_MISSING', message: `confirmed constraint '${constraint.constraintId}' has no matching QCR` };
  }
  for (const row of audit.audit.constraintDependencies) {
    const constraint = constraintMap.get(row.constraintId);
    if (!constraint) return { ok: false, code: 'QUALIFICATION_CONSTRAINT_UNKNOWN', message: `qualification audit references unknown constraint '${row.constraintId}'` };
    if (constraint.digest !== row.constraintDigest) return { ok: false, code: 'QUALIFICATION_CONSTRAINT_DIGEST_MISMATCH', message: `qualification audit digest does not match '${row.constraintId}'` };
  }
  const candidateMap = new Map(task.qualification.candidates.map((row) => [row.candidateId, row]));
  for (const row of audit.audit.candidateQualifications) {
    if (!candidateMap.has(row.candidateId)) return { ok: false, code: 'QUALIFICATION_CANDIDATE_UNKNOWN', message: `qualification audit references unknown candidate '${row.candidateId}'` };
    if (row.constraintIds.some((id) => !constraintMap.has(id))) return { ok: false, code: 'QUALIFICATION_CONSTRAINT_UNKNOWN', message: `candidate '${row.candidateId}' references unknown qualification constraint` };
  }
  const snapshot = audit.audit.snapshot!;
  if (snapshot.taskInputDigest !== task.qualification.taskInputDigest) return { ok: false, code: 'QUALIFICATION_TASK_DIGEST_MISMATCH', message: 'qualification audit task input digest is stale' };
  if (snapshot.nonConstraintInputDigest !== task.qualification.nonConstraintInputDigest) return { ok: false, code: 'QUALIFICATION_NON_CONSTRAINT_DIGEST_MISMATCH', message: 'qualification audit non-constraint input digest is stale' };
  if (snapshot.upstreamArtifactDigest !== upstreamArtifactDigest(audit.audit.upstreamRelations)) return { ok: false, code: 'QUALIFICATION_UPSTREAM_DIGEST_MISMATCH', message: 'qualification audit upstream digest does not match its relation rows' };
  if (options.family && options.artifact) {
    const identity = parseArtifactName(options.artifact);
    if (!identity || identity.family !== options.family) return { ok: false, code: 'QUALIFICATION_ARTIFACT_IDENTITY_INVALID', message: `artifact '${options.artifact}' is not canonical for '${options.family}'` };
  }
  return { ok: true, qualification: task.qualification, audit: audit.audit };
}

function renderQualificationAudit(audit: QualificationAudit): string {
  const table = (columns: readonly string[], rows: readonly (readonly string[])[]) => [
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map((value) => value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ')).join(' | ')} |`)
  ].join('\n');
  const list = (values: readonly string[]) => values.join(',');
  const snapshot = audit.snapshot ?? { taskInputDigest: '', nonConstraintInputDigest: '', upstreamArtifactDigest: upstreamArtifactDigest(audit.upstreamRelations) };
  return [
    '### 约束依赖', '', table(DEPENDENCY_COLUMNS, audit.constraintDependencies.map((row) => [row.constraintId, row.constraintDigest, row.role, row.evidence])), '',
    '### 候选资格', '', table(QUALIFICATION_COLUMNS, audit.candidateQualifications.map((row) => [row.candidateId, row.status, row.impact, list(row.constraintIds), row.evidence])), '',
    '### 分类结果', '', table(CLASSIFICATION_COLUMNS, audit.classifications.map((row) => [row.decisionId, row.classification, row.evidence])), '',
    '### 上游关系', '', table(RELATION_COLUMNS, audit.upstreamRelations.map((row) => [row.upstreamFamily, row.upstreamArtifact, String(row.upstreamRound), row.upstreamSha256, row.relation])), '',
    '### 依赖快照', '', table(SNAPSHOT_COLUMNS, [[snapshot.taskInputDigest, snapshot.nonConstraintInputDigest, snapshot.upstreamArtifactDigest]])
  ].join('\n');
}

function buildQualificationAudit(
  taskContent: string,
  input: { constraints?: readonly string[]; candidates?: readonly string[]; classifications?: readonly QualificationClassificationRow[]; upstreamRelations?: readonly UpstreamRelation[] } = {}
): { ok: true; audit: QualificationAudit } | { ok: false; code: string; message: string } {
  const parsed = parseTaskQualification(taskContent);
  if (!parsed.ok) return parsed;
  if (!parsed.qualification.present) return { ok: false, code: 'QUALIFICATION_TASK_CONTRACT_MISSING', message: 'task qualification contract is missing' };
  const ids = new Set(input.constraints ?? parsed.qualification.constraints.map((row) => row.constraintId));
  const candidates = input.candidates ?? parsed.qualification.candidates.map((row) => row.candidateId);
  const constraintDependencies = parsed.qualification.constraints.filter((row) => ids.has(row.constraintId)).map((row) => ({ constraintId: row.constraintId, constraintDigest: row.digest, role: 'required' as const, evidence: row.evidence }));
  const candidateQualifications = parsed.qualification.candidates.filter((row) => candidates.includes(row.candidateId)).map((row) => ({ candidateId: row.candidateId, status: row.status, impact: row.impact, constraintIds: row.constraintIds, evidence: row.evidence }));
  const upstreamRelations = [...(input.upstreamRelations ?? [])];
  return {
    ok: true,
    audit: {
      present: true, constraintDependencies, candidateQualifications,
      classifications: input.classifications ?? [], upstreamRelations,
      snapshot: { taskInputDigest: parsed.qualification.taskInputDigest, nonConstraintInputDigest: parsed.qualification.nonConstraintInputDigest, upstreamArtifactDigest: upstreamArtifactDigest(upstreamRelations) }
    }
  };
}

export {
  ARTIFACT_FAMILIES,
  AUDIT_HEADINGS,
  AUDIT_SUBSECTIONS,
  CONFIRMATION_COLUMNS,
  CONFIRMATION_HEADINGS,
  CANDIDATE_COLUMNS,
  CONSTRAINT_COLUMNS,
  DEPENDENCY_COLUMNS,
  QUALIFICATION_COLUMNS,
  CLASSIFICATION_COLUMNS,
  RELATION_COLUMNS,
  SNAPSHOT_COLUMNS,
  constraintDigest,
  buildQualificationAudit,
  nonConstraintInputDigest,
  parseQualificationAudit,
  parseQualificationConfirmations,
  parseTaskQualification,
  renderQualificationAudit,
  taskInputDigest,
  upstreamArtifactDigest,
  validateQualificationAudit
};
export type {
  Candidate,
  CandidateQualification,
  CandidateStatus,
  Constraint,
  ConstraintDependency,
  ConstraintStatus,
  DependencySnapshot,
  QualificationAudit,
  QualificationConfirmation,
  QualificationClassification,
  QualificationClassificationRow,
  QualificationRelation,
  QualificationRole,
  QualificationValidationError,
  QualificationValidationResult,
  TaskQualification,
  UpstreamRelation,
  ArtifactFamily
};
