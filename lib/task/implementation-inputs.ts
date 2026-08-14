import { parseTable } from './sections.ts';

const SECTION_ALIASES = ['实现输入', 'Implementation Inputs'] as const;
const COLUMNS = [
  'id', 'ledger_id', 'decision_evidence', 'stage', 'needs_implementation',
  'decided_at', 'status', 'consumed_by'
] as const;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
const ARTIFACT_RE = /^code(?:-r(?:[2-9]|[1-9]\d+))?\.md$/;

type ImplementationInputStatus = 'declared' | 'pending' | 'not-required' | 'consumed';
type ImplementationInput = {
  id: string;
  ledgerId: string;
  decisionEvidence: string;
  stage: 'code';
  needsImplementation: boolean;
  decidedAt: string;
  status: ImplementationInputStatus;
  consumedBy: string;
};
type ImplementationInputDraft = {
  ledgerId: string;
  decisionEvidence: string;
  needsImplementation: boolean;
  decidedAt: string;
};
type ImplementationInputDeclaration = Omit<ImplementationInputDraft, 'decidedAt'>;

function validateInput(row: ImplementationInput): void {
  if (!/^II-[1-9]\d*$/.test(row.id)) throw new Error(`implementation input id '${row.id}' is invalid`);
  if (!row.ledgerId || !row.decisionEvidence || /[\r\n]/.test(row.ledgerId) || /[\r\n]/.test(row.decisionEvidence)) throw new Error(`implementation input ${row.id} has incomplete decision identity`);
  if (row.stage !== 'code') throw new Error(`implementation input ${row.id} has invalid stage`);
  const hasValidTimestamp = TIMESTAMP_RE.test(row.decidedAt) && Number.isFinite(Date.parse(row.decidedAt.replace(' ', 'T')));
  const valid =
    (row.status === 'declared' && row.decidedAt === '' && row.consumedBy === '') ||
    (hasValidTimestamp && row.needsImplementation && row.status === 'pending' && row.consumedBy === '') ||
    (hasValidTimestamp && !row.needsImplementation && row.status === 'not-required' && row.consumedBy === '') ||
    (hasValidTimestamp && row.needsImplementation && row.status === 'consumed' && ARTIFACT_RE.test(row.consumedBy));
  if (!valid) throw new Error(`implementation input ${row.id} has an invalid state combination`);
}

function parseImplementationInputs(content: string): { sectionFound: boolean; rows: ImplementationInput[] } {
  const table = parseTable(content, { sectionAliases: SECTION_ALIASES, columns: COLUMNS });
  if (!table) return { sectionFound: false, rows: [] };
  const rows: ImplementationInput[] = [];
  const seen = new Set<string>();
  for (const { values } of table.rows) {
    const id = values.id; const ledgerId = values.ledger_id; const decisionEvidence = values.decision_evidence;
    const stage = values.stage; const needs = values.needs_implementation; const decidedAt = values.decided_at;
    const status = values.status; const consumedBy = values.consumed_by;
    if (needs !== 'true' && needs !== 'false') throw new Error(`implementation input ${id} has invalid needs_implementation`);
    const row: ImplementationInput = {
      id: id!, ledgerId: ledgerId!, decisionEvidence: decisionEvidence!, stage: stage as 'code',
      needsImplementation: needs === 'true', decidedAt: decidedAt!,
      status: status as ImplementationInputStatus, consumedBy: consumedBy!
    };
    validateInput(row);
    if (seen.has(row.id)) throw new Error(`duplicate implementation input id '${row.id}'`);
    seen.add(row.id);
    rows.push(row);
  }
  return { sectionFound: true, rows };
}

function nextId(rows: readonly ImplementationInput[]): string {
  let max = 0;
  for (const row of rows) max = Math.max(max, Number.parseInt(row.id.slice(3), 10));
  return `II-${max + 1}`;
}

function createImplementationInput(rows: readonly ImplementationInput[], draft: ImplementationInputDraft): ImplementationInput {
  const row: ImplementationInput = {
    id: nextId(rows), ledgerId: draft.ledgerId, decisionEvidence: draft.decisionEvidence,
    stage: 'code', needsImplementation: draft.needsImplementation, decidedAt: draft.decidedAt,
    status: draft.needsImplementation ? 'pending' : 'not-required', consumedBy: ''
  };
  validateInput(row);
  return row;
}

function declareImplementationInput(
  rows: readonly ImplementationInput[], draft: ImplementationInputDeclaration
): ImplementationInput {
  const existing = rows.filter((row) => row.ledgerId === draft.ledgerId && row.status === 'declared');
  if (existing.length > 1) throw new Error(`implementation input declaration for '${draft.ledgerId}' conflicts with existing rows`);
  if (existing.length === 1) {
    const row = existing[0]!;
    if (row.decisionEvidence !== draft.decisionEvidence || row.needsImplementation !== draft.needsImplementation) {
      throw new Error(`implementation input declaration for '${draft.ledgerId}' conflicts with the existing row`);
    }
    return row;
  }
  const row: ImplementationInput = {
    id: nextId(rows), ledgerId: draft.ledgerId, decisionEvidence: draft.decisionEvidence,
    stage: 'code', needsImplementation: draft.needsImplementation, decidedAt: '',
    status: 'declared', consumedBy: ''
  };
  validateInput(row);
  return row;
}

function selectDeclaredImplementationInput(
  rows: readonly ImplementationInput[], ledgerId: string, decisionEvidence: string
): ImplementationInput | null {
  const forLedger = rows.filter((row) => row.ledgerId === ledgerId && row.status === 'declared');
  if (forLedger.length > 1) throw new Error(`implementation input declaration for '${ledgerId}' is ambiguous`);
  if (forLedger.length === 0) return null;
  if (forLedger[0]!.decisionEvidence !== decisionEvidence) {
    throw new Error(`implementation input declaration for '${ledgerId}' has conflicting evidence`);
  }
  return forLedger[0]!;
}

function finalizeImplementationInput(
  rows: readonly ImplementationInput[], id: string, decisionEvidence: string, decidedAt: string
): ImplementationInput[] {
  let found = false;
  const next = rows.map((row) => {
    if (row.id !== id) return row;
    found = true;
    if (row.status !== 'declared') throw new Error(`implementation input ${id} is not declared`);
    return {
      ...row, decisionEvidence, decidedAt,
      status: row.needsImplementation ? 'pending' as const : 'not-required' as const
    };
  });
  if (!found) throw new Error(`implementation input ${id} was not found`);
  next.forEach(validateInput);
  return next;
}

function selectPendingImplementationInput(
  rows: readonly ImplementationInput[]
): ImplementationInput | null {
  const pending = rows.filter((row) => row.needsImplementation && row.status === 'pending');
  return [...pending].sort((left, right) => {
    const time = Date.parse(left.decidedAt.replace(' ', 'T')) - Date.parse(right.decidedAt.replace(' ', 'T'));
    return time || Number.parseInt(left.id.slice(3), 10) - Number.parseInt(right.id.slice(3), 10);
  })[0] ?? null;
}

function consumeImplementationInput(
  rows: readonly ImplementationInput[], id: string, artifact: string
): ImplementationInput[] {
  if (!ARTIFACT_RE.test(artifact)) throw new Error(`implementation input artifact '${artifact}' is invalid`);
  let found = false;
  const next = rows.map((row) => {
    if (row.id !== id) return row;
    found = true;
    if (row.status !== 'pending' || !row.needsImplementation) {
      throw new Error(`implementation input ${id} is not pending`);
    }
    return { ...row, status: 'consumed' as const, consumedBy: artifact };
  });
  if (!found) throw new Error(`implementation input ${id} was not found`);
  next.forEach(validateInput);
  return next;
}

function renderImplementationInputs(rows: readonly ImplementationInput[]): string {
  rows.forEach(validateInput);
  const ids = new Set(rows.map((row) => row.id));
  if (ids.size !== rows.length) throw new Error('implementation input ids must be unique');
  return [
    `| ${COLUMNS.join(' | ')} |`,
    '|----|-----------|-------------------|-------|----------------------|------------|--------|-------------|',
    ...rows.map((row) => {
      const cells = [row.id, row.ledgerId, row.decisionEvidence, 'code', String(row.needsImplementation), row.decidedAt, row.status, row.consumedBy]
        .map((value) => value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|'));
      return `| ${cells.join(' | ')} |`;
    })
  ].join('\n');
}

export {
  SECTION_ALIASES as IMPLEMENTATION_INPUT_ALIASES,
  createImplementationInput,
  consumeImplementationInput,
  declareImplementationInput,
  finalizeImplementationInput,
  parseImplementationInputs,
  renderImplementationInputs,
  selectDeclaredImplementationInput,
  selectPendingImplementationInput
};
export type { ImplementationInput, ImplementationInputDeclaration, ImplementationInputDraft, ImplementationInputStatus };
