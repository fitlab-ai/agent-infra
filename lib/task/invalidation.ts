import { createHash } from 'node:crypto';

const INVALIDATION_HEADINGS = ['产物失效记录', 'Artifact Invalidation'] as const;
const OPERATION_COLUMNS = [
  'operation_id', 'source_family', 'source_artifact', 'source_round', 'source_sha256',
  'status', 'processed', 'total', 'created_at', 'updated_at', 'completed_at', 'error'
] as const;
const TARGET_COLUMNS = [
  'target_id', 'operation_id', 'target_kind', 'target_family', 'target_artifact',
  'target_round', 'target_sha256', 'status', 'reason_code', 'updated_at'
] as const;

type InvalidationStatus = 'pending' | 'in-progress' | 'completed';
type InvalidationTargetKind = 'artifact' | 'receipt' | 'approval' | 'reviewed-snapshot';
type InvalidationOperation = {
  operationId: string;
  sourceFamily: string;
  sourceArtifact: string;
  sourceRound: number;
  sourceSha256: string;
  status: InvalidationStatus;
  processed: number;
  total: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
  error: string;
};
type InvalidationTarget = {
  targetId: string;
  operationId: string;
  targetKind: InvalidationTargetKind;
  targetFamily: string;
  targetArtifact: string;
  targetRound: number;
  targetSha256: string;
  status: InvalidationStatus;
  reasonCode: string;
  updatedAt: string;
};
type InvalidationDocument = {
  operations: readonly InvalidationOperation[];
  targets: readonly InvalidationTarget[];
};
type InvalidationParseResult =
  | { ok: true; present: boolean; document: InvalidationDocument }
  | { ok: false; code: 'TASK_INVALIDATION_INVALID'; message: string };
type InvalidationMutationResult = {
  ok: true;
  changed: boolean;
  document: InvalidationDocument;
} | {
  ok: false;
  code: 'TASK_INVALIDATION_INVALID' | 'INVALIDATION_IDENTITY_CONFLICT';
  message: string;
};

function invalid(message: string): InvalidationParseResult {
  return { ok: false, code: 'TASK_INVALIDATION_INVALID', message };
}

function hashIdentity(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function operationIdFor(source: Pick<InvalidationOperation, 'sourceFamily' | 'sourceArtifact' | 'sourceRound' | 'sourceSha256'>): string {
  return `INV-${hashIdentity([source.sourceFamily, source.sourceArtifact, source.sourceRound, source.sourceSha256])}`;
}

function targetIdFor(operationId: string, target: Pick<InvalidationTarget, 'targetKind' | 'targetFamily' | 'targetArtifact' | 'targetRound' | 'targetSha256'>): string {
  return `INV-T-${hashIdentity([operationId, target.targetKind, target.targetFamily, target.targetArtifact, target.targetRound, target.targetSha256])}`;
}

function createInvalidationOperation(
  source: Partial<Pick<InvalidationOperation, 'operationId'>> & Omit<InvalidationOperation, 'operationId' | 'status' | 'processed' | 'total' | 'completedAt' | 'error'>,
  targets: readonly InvalidationTarget[] = []
): InvalidationOperation {
  const operationId = source.operationId ?? operationIdFor(source);
  return {
    operationId, sourceFamily: source.sourceFamily, sourceArtifact: source.sourceArtifact,
    sourceRound: source.sourceRound, sourceSha256: source.sourceSha256,
    status: 'pending', processed: 0, total: targets.length,
    createdAt: source.createdAt, updatedAt: source.updatedAt, completedAt: '', error: ''
  };
}

function lineCells(line: string): string[] | null {
  const first = line.indexOf('|');
  const last = line.lastIndexOf('|');
  if (first < 0 || first === last || line.slice(0, first).trim() || line.slice(last + 1).trim()) return null;
  const inner = line.slice(first + 1, last);
  const cells: string[] = [];
  let start = 0;
  let escaped = false;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]!;
    if (char === '|' && !escaped) {
      cells.push(inner.slice(start, index));
      start = index + 1;
    }
    escaped = char === '\\' && !escaped;
    if (char !== '\\') escaped = false;
  }
  cells.push(inner.slice(start));
  return cells.map((cell) => cell.replace(/\\([\\|])/g, '$1').trim());
}

function isSeparator(cells: readonly string[], count: number): boolean {
  return cells.length === count && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function sectionBody(content: string): string | null {
  const heading = INVALIDATION_HEADINGS.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const match = new RegExp(`^##\\s+(${heading})\\s*$`, 'm').exec(content);
  if (!match) return null;
  const start = (match.index ?? 0) + match[0].length;
  const rest = content.slice(start);
  const end = rest.search(/^##\s+/m);
  return rest.slice(0, end < 0 ? rest.length : end);
}

function parseTable(body: string, heading: string, columns: readonly string[]): Record<string, string>[] | null | false {
  const marker = new RegExp(`^###\\s+${heading}\\s*$`, 'm').exec(body);
  if (!marker) return null;
  const start = (marker.index ?? 0) + marker[0].length;
  const rest = body.slice(start);
  const end = rest.search(/^###\s+/m);
  const lines = rest.slice(0, end < 0 ? rest.length : end).split(/\r?\n/).filter((line) => line.trim());
  const header = lines.length > 0 ? lineCells(lines[0]!) : null;
  const separator = lines.length > 1 ? lineCells(lines[1]!) : null;
  if (!header || !separator || header.length !== columns.length || !header.every((value, index) => value === columns[index]) || !isSeparator(separator, columns.length)) return false;
  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(2)) {
    const cells = lineCells(line);
    if (!cells || cells.length !== columns.length) return false;
    rows.push(Object.fromEntries(columns.map((column, index) => [column, cells[index]!])));
  }
  return rows;
}

function required(value: string, field: string): string {
  if (!value) throw new Error(`${field} is required`);
  return value;
}

function status(value: string, field: string): InvalidationStatus {
  if (value !== 'pending' && value !== 'in-progress' && value !== 'completed') throw new Error(`${field} has an invalid status`);
  return value;
}

function numberValue(value: string, field: string, allowZero = true): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || (allowZero ? parsed < 0 : parsed < 1)) throw new Error(`${field} must be an integer`);
  return parsed;
}

function parseInvalidationDocument(content: string): InvalidationParseResult {
  const body = sectionBody(content);
  if (body === null) return { ok: true, present: false, document: { operations: [], targets: [] } };
  try {
    const operationRows = parseTable(body, 'Operations', OPERATION_COLUMNS);
    const targetRows = parseTable(body, 'Targets', TARGET_COLUMNS);
    if (operationRows === null || targetRows === null || operationRows === false || targetRows === false) {
      return invalid('invalidation section must contain Operations and Targets tables');
    }
    const operations = operationRows.map((row) => ({
      operationId: required(row.operation_id!, 'operation_id'), sourceFamily: required(row.source_family!, 'source_family'),
      sourceArtifact: required(row.source_artifact!, 'source_artifact'), sourceRound: numberValue(row.source_round!, 'source_round', false),
      sourceSha256: required(row.source_sha256!, 'source_sha256'), status: status(row.status!, 'operation status'),
      processed: numberValue(row.processed!, 'processed'), total: numberValue(row.total!, 'total'),
      createdAt: required(row.created_at!, 'created_at'), updatedAt: required(row.updated_at!, 'updated_at'),
      completedAt: row.completed_at ?? '', error: row.error ?? ''
    } satisfies InvalidationOperation));
    const targets = targetRows.map((row) => ({
      targetId: required(row.target_id!, 'target_id'), operationId: required(row.operation_id!, 'operation_id'),
      targetKind: row.target_kind as InvalidationTargetKind, targetFamily: required(row.target_family!, 'target_family'),
      targetArtifact: required(row.target_artifact!, 'target_artifact'), targetRound: numberValue(row.target_round!, 'target_round', false),
      targetSha256: required(row.target_sha256!, 'target_sha256'), status: status(row.status!, 'target status'),
      reasonCode: required(row.reason_code!, 'reason_code'), updatedAt: required(row.updated_at!, 'updated_at')
    } satisfies InvalidationTarget));
    const operationIds = new Set<string>();
    for (const operation of operations) {
      if (operationIds.has(operation.operationId)) throw new Error(`duplicate operation '${operation.operationId}'`);
      operationIds.add(operation.operationId);
      if (operation.operationId !== operationIdFor(operation)) throw new Error(`operation '${operation.operationId}' has a non-canonical identity`);
      if (operation.processed > operation.total) throw new Error(`operation '${operation.operationId}' progress is invalid`);
      if (!/^[a-f0-9]{64}$/.test(operation.sourceSha256)) throw new Error(`operation '${operation.operationId}' source hash is invalid`);
    }
    const targetIds = new Set<string>();
    for (const target of targets) {
      if (!['artifact', 'receipt', 'approval', 'reviewed-snapshot'].includes(target.targetKind)) throw new Error(`target '${target.targetId}' kind is invalid`);
      if (targetIds.has(target.targetId)) throw new Error(`duplicate target '${target.targetId}'`);
      targetIds.add(target.targetId);
      if (!operationIds.has(target.operationId)) throw new Error(`target '${target.targetId}' references an unknown operation`);
      if (target.targetId !== targetIdFor(target.operationId, target)) throw new Error(`target '${target.targetId}' has a non-canonical identity`);
      if (!/^[a-f0-9]{64}$/.test(target.targetSha256)) throw new Error(`target '${target.targetId}' hash is invalid`);
    }
    for (const operation of operations) {
      const scoped = targets.filter((target) => target.operationId === operation.operationId);
      const completed = scoped.filter((target) => target.status === 'completed').length;
      if (operation.total !== scoped.length || operation.processed !== completed) throw new Error(`operation '${operation.operationId}' progress does not match its targets`);
      if (operation.status === 'completed' && (completed !== scoped.length || !operation.completedAt)) throw new Error(`completed operation '${operation.operationId}' has incomplete targets`);
      if (operation.status === 'pending' && completed !== 0) throw new Error(`pending operation '${operation.operationId}' has completed targets`);
      if (operation.status === 'in-progress' && (completed === scoped.length || (completed === 0 && !scoped.some((target) => target.status === 'in-progress')))) throw new Error(`in-progress operation '${operation.operationId}' has invalid progress`);
    }
    return { ok: true, present: true, document: { operations, targets } };
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
}

function cell(value: string | number): string {
  return String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
}

function table(columns: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  const header = `| ${columns.join(' | ')} |`;
  const separator = `| ${columns.map(() => '---').join(' | ')} |`;
  return [header, separator, ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`)].join('\n');
}

function renderInvalidation(document: InvalidationDocument): string {
  const operations = [...document.operations].sort((left, right) => left.operationId.localeCompare(right.operationId));
  const targets = [...document.targets].sort((left, right) => left.targetId.localeCompare(right.targetId));
  return [
    '### Operations', '',
    table(OPERATION_COLUMNS, operations.map((row) => [
      row.operationId, row.sourceFamily, row.sourceArtifact, row.sourceRound, row.sourceSha256,
      row.status, row.processed, row.total, row.createdAt, row.updatedAt, row.completedAt, row.error
    ])), '',
    '### Targets', '',
    table(TARGET_COLUMNS, targets.map((row) => [
      row.targetId, row.operationId, row.targetKind, row.targetFamily, row.targetArtifact,
      row.targetRound, row.targetSha256, row.status, row.reasonCode, row.updatedAt
    ]))
  ].join('\n');
}

function reconcileInvalidation(document: InvalidationDocument, now: string, maxTargets = Number.POSITIVE_INFINITY): InvalidationMutationResult {
  const nextTargets = document.targets.map((target) => {
    if (target.status === 'completed' || maxTargets <= 0) return target;
    maxTargets -= 1;
    return { ...target, status: 'completed' as const, updatedAt: now };
  });
  const changed = nextTargets.some((target, index) => target !== document.targets[index]);
  const nextOperations = document.operations.map((operation) => {
    const scoped = nextTargets.filter((target) => target.operationId === operation.operationId);
    const processed = scoped.filter((target) => target.status === 'completed').length;
    const total = scoped.length;
    const complete = total === processed;
    const nextStatus: InvalidationStatus = complete ? 'completed' : processed > 0 ? 'in-progress' : 'pending';
    if (operation.status === nextStatus && operation.processed === processed && operation.total === total && (!complete || operation.completedAt)) return operation;
    return {
      ...operation, status: nextStatus, processed, total, updatedAt: changed ? now : operation.updatedAt,
      completedAt: complete ? (operation.completedAt || now) : ''
    };
  });
  const operationChanged = nextOperations.some((operation, index) => operation !== document.operations[index]);
  return { ok: true, changed: changed || operationChanged, document: { operations: nextOperations, targets: nextTargets } };
}

function upsertInvalidation(
  document: InvalidationDocument,
  operation: InvalidationOperation,
  targets: readonly InvalidationTarget[]
): InvalidationMutationResult {
  const existing = document.operations.find((candidate) => candidate.operationId === operation.operationId);
  if (existing && JSON.stringify(existing) !== JSON.stringify(operation)) {
    return { ok: false, code: 'INVALIDATION_IDENTITY_CONFLICT', message: `operation '${operation.operationId}' identity conflicts with existing state` };
  }
  const existingTargets = document.targets.filter((target) => target.operationId === operation.operationId);
  for (const target of targets) {
    const old = existingTargets.find((candidate) => candidate.targetId === target.targetId);
    if (old && JSON.stringify(old) !== JSON.stringify(target)) {
      return { ok: false, code: 'INVALIDATION_IDENTITY_CONFLICT', message: `target '${target.targetId}' identity conflicts with existing state` };
    }
  }
  if (existing) return { ok: true, changed: false, document };
  return {
    ok: true, changed: true,
    document: { operations: [...document.operations, operation], targets: [...document.targets, ...targets] }
  };
}

function invalidationBlocks(document: InvalidationDocument): boolean {
  return document.operations.some((operation) => operation.status !== 'completed')
    || document.targets.some((target) => target.status !== 'completed');
}

function invalidationMutation(content: string, document: InvalidationDocument) {
  const existing = sectionBody(content) !== null;
  return {
    kind: 'section' as const,
    aliases: INVALIDATION_HEADINGS,
    heading: existing && /^##\s+Artifact Invalidation\s*$/m.test(content) ? INVALIDATION_HEADINGS[1] : INVALIDATION_HEADINGS[0],
    body: renderInvalidation(document)
  };
}

export {
  INVALIDATION_HEADINGS,
  OPERATION_COLUMNS,
  TARGET_COLUMNS,
  createInvalidationOperation,
  invalidationBlocks,
  invalidationMutation,
  operationIdFor,
  parseInvalidationDocument,
  reconcileInvalidation,
  renderInvalidation,
  targetIdFor,
  upsertInvalidation
};
export type {
  InvalidationDocument,
  InvalidationMutationResult,
  InvalidationOperation,
  InvalidationParseResult,
  InvalidationStatus,
  InvalidationTarget,
  InvalidationTargetKind
};
