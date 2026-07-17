import { isReviewStage, type LedgerRow, type ReviewStage } from './ledger.ts';

type DecisionSelectorErrorCode =
  | 'invalid-selector'
  | 'not-found'
  | 'ambiguous'
  | 'ordinal-out-of-range';

type DecisionSelectorResult =
  | { ok: true; row: LedgerRow }
  | { ok: false; code: DecisionSelectorErrorCode; message: string };

function isDecisionItem(row: LedgerRow): boolean {
  if (!isReviewStage(row.stage)) return false;
  if (/^HD-\d+$/i.test(row.id)) return true;
  if (row.stage === 'analysis') return /^AN-\d+$/i.test(row.id);
  if (row.stage === 'plan') return /^PL-\d+$/i.test(row.id);
  return /^CD-\d+$/i.test(row.id);
}

function listDecisionItems(
  rows: readonly LedgerRow[],
  options: { includeDecided?: boolean; stage?: ReviewStage } = {}
): LedgerRow[] {
  return rows.filter((row) => {
    if (!isDecisionItem(row)) return false;
    if (options.stage !== undefined && row.stage !== options.stage) return false;
    return options.includeDecided
      ? row.status === 'needs-human-decision' || row.status === 'human-decided'
      : row.status === 'needs-human-decision';
  });
}

function selectDecisionItem(rows: readonly LedgerRow[], selector: string): DecisionSelectorResult {
  if (/^-?\d+$/.test(selector)) {
    const ordinal = Number.parseInt(selector, 10);
    if (ordinal < 1 || ordinal > rows.length) {
      return {
        ok: false,
        code: 'ordinal-out-of-range',
        message: `ordinal '${selector}' out of range (1..${rows.length})`
      };
    }
    return { ok: true, row: rows[ordinal - 1]! };
  }
  if (!/^[A-Za-z]+-\d+$/.test(selector)) {
    return { ok: false, code: 'invalid-selector', message: `invalid selector '${selector}'` };
  }
  const matches = rows.filter((row) => row.id.toUpperCase() === selector.toUpperCase());
  if (matches.length === 0) {
    return { ok: false, code: 'not-found', message: `no decision item matches '${selector}'` };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      code: 'ambiguous',
      message: `duplicate id '${selector}' in ledger; select by ordinal instead`
    };
  }
  return { ok: true, row: matches[0]! };
}

export { isDecisionItem, listDecisionItems, selectDecisionItem };
export type { DecisionSelectorErrorCode, DecisionSelectorResult };
