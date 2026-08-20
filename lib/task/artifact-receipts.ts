import fs from 'node:fs';
import { createHash } from 'node:crypto';

import { extractSection, findSectionHeading, parseTable } from './sections.ts';

const RECEIPT_SECTION_ALIASES = ['产物生命周期收据', 'Artifact Lifecycle Receipts'] as const;
const RECEIPT_COLUMNS = ['event', 'output', 'input', 'input_sha256', 'completed_at'] as const;
const RECEIPT_EVENTS = new Set([
  'review-analysis.completed',
  'review-plan.completed',
  'review-code.completed',
  'code.completed'
]);
const SHA256_RE = /^[a-f0-9]{64}$/;
const ARTIFACT_NAME_RE = /^(analysis|review-analysis|plan|review-plan|code|review-code|manual-validation|validation-run|pr-review)(?:-r([2-9]|[1-9]\d+))?\.md$/;
const RECEIPT_SHAPES = {
  'review-analysis.completed': { output: 'review-analysis', input: 'analysis' },
  'review-plan.completed': { output: 'review-plan', input: 'plan' },
  'review-code.completed': { output: 'review-code', input: 'code' },
  'code.completed': { output: 'code', input: 'plan' }
} as const;

type ArtifactReceiptEvent =
  | 'review-analysis.completed'
  | 'review-plan.completed'
  | 'review-code.completed'
  | 'code.completed';
type ArtifactReceipt = {
  event: ArtifactReceiptEvent;
  output: string;
  input: string;
  inputSha256: string;
  completedAt: string;
};
type ArtifactReceiptParseResult = {
  present: boolean;
  rows: readonly ArtifactReceipt[];
};
type ReceiptSectionMutation = {
  aliases: readonly string[];
  heading: string;
  body: string;
};

class ArtifactReceiptError extends Error {
  readonly code = 'ARTIFACT_RECEIPT_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'ArtifactReceiptError';
  }
}

function sha256Bytes(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath: string): string {
  return sha256Bytes(fs.readFileSync(filePath));
}

function parseReceiptArtifactName(name: string): { family: string } | null {
  const match = ARTIFACT_NAME_RE.exec(name);
  if (!match) return null;
  const roundText = match[2];
  if (roundText !== undefined) {
    const round = Number(roundText);
    if (!Number.isSafeInteger(round) || String(round) !== roundText) return null;
  }
  return { family: match[1]! };
}

function validateReceiptShape(event: ArtifactReceiptEvent, output: string, input: string): void {
  const outputIdentity = parseReceiptArtifactName(output);
  const inputIdentity = parseReceiptArtifactName(input);
  if (!outputIdentity || !inputIdentity) throw new ArtifactReceiptError(`receipt artifact identity is invalid: ${output} -> ${input}`);
  const shape = RECEIPT_SHAPES[event];
  if (outputIdentity.family !== shape.output || inputIdentity.family !== shape.input) {
    throw new ArtifactReceiptError(`receipt event '${event}' does not match ${output} -> ${input}`);
  }
}

function parseArtifactReceipts(content: string): ArtifactReceiptParseResult {
  const section = extractSection(content, [...RECEIPT_SECTION_ALIASES]);
  if (!section) return { present: false, rows: [] };

  let table;
  try {
    table = parseTable(content, {
      sectionAliases: [...RECEIPT_SECTION_ALIASES],
      columns: [...RECEIPT_COLUMNS],
      keyColumn: 'output'
    });
  } catch (error) {
    throw new ArtifactReceiptError(error instanceof Error ? error.message : String(error));
  }
  if (!table) throw new ArtifactReceiptError('receipt section has no receipt table');

  const rows = table.rows.map((row) => {
    const event = row.values.event ?? '';
    const output = row.values.output ?? '';
    const input = row.values.input ?? '';
    const inputSha256 = row.values.input_sha256 ?? '';
    const completedAt = row.values.completed_at ?? '';
    if (!RECEIPT_EVENTS.has(event)) throw new ArtifactReceiptError(`unknown receipt event '${event}'`);
    if (!output || !input) throw new ArtifactReceiptError('receipt output and input are required');
    validateReceiptShape(event as ArtifactReceiptEvent, output, input);
    if (!SHA256_RE.test(inputSha256)) throw new ArtifactReceiptError(`receipt digest for '${output}' is invalid`);
    if (!completedAt || Number.isNaN(Date.parse(completedAt.replace(' ', 'T')))) {
      throw new ArtifactReceiptError(`receipt completion time for '${output}' is invalid`);
    }
    return {
      event: event as ArtifactReceiptEvent,
      output,
      input,
      inputSha256,
      completedAt
    };
  });
  return { present: true, rows };
}

function receiptForOutput(content: string, output: string): ArtifactReceipt | null {
  const parsed = parseArtifactReceipts(content);
  return parsed.rows.find((row) => row.output === output) ?? null;
}

function upsertArtifactReceipt(content: string, receipt: ArtifactReceipt): ReceiptSectionMutation {
  if (!RECEIPT_EVENTS.has(receipt.event)) throw new ArtifactReceiptError(`unknown receipt event '${receipt.event}'`);
  if (!receipt.output || !receipt.input) throw new ArtifactReceiptError('receipt output and input are required');
  validateReceiptShape(receipt.event, receipt.output, receipt.input);
  if (!SHA256_RE.test(receipt.inputSha256)) throw new ArtifactReceiptError(`receipt digest for '${receipt.output}' is invalid`);
  if (!receipt.completedAt || Number.isNaN(Date.parse(receipt.completedAt.replace(' ', 'T')))) {
    throw new ArtifactReceiptError(`receipt completion time for '${receipt.output}' is invalid`);
  }

  const existing = parseArtifactReceipts(content).rows;
  const previous = existing.find((row) => row.output === receipt.output);
  if (previous && JSON.stringify(previous) !== JSON.stringify(receipt)) {
    throw new ArtifactReceiptError(`receipt for '${receipt.output}' already exists with different evidence`);
  }
  const rows = previous ? existing : [...existing, receipt];
  const heading = findSectionHeading(content, [...RECEIPT_SECTION_ALIASES]);
  const body = [
    `| ${RECEIPT_COLUMNS.join(' | ')} |`,
    `| ${RECEIPT_COLUMNS.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.event} | ${row.output} | ${row.input} | ${row.inputSha256} | ${row.completedAt} |`)
  ].join('\n');
  return { aliases: [...RECEIPT_SECTION_ALIASES], heading, body };
}

export {
  ArtifactReceiptError,
  RECEIPT_SECTION_ALIASES,
  parseArtifactReceipts,
  receiptForOutput,
  sha256Bytes,
  sha256File,
  upsertArtifactReceipt
};
export type { ArtifactReceipt, ArtifactReceiptEvent, ArtifactReceiptParseResult, ReceiptSectionMutation };
