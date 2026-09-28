import fs from 'node:fs';
import { createHash } from 'node:crypto';

import { parseArtifactName } from './artifact-name.ts';
import { extractSection, findSectionHeading, parseTable } from './sections.ts';

const RECEIPT_SECTION_ALIASES = ['产物生命周期收据', 'Artifact Lifecycle Receipts'] as const;
const RECEIPT_COLUMNS = ['event', 'output', 'input', 'input_sha256', 'completed_at'] as const;
const RECEIPT_EVENTS = new Set([
  'analysis.completed',
  'plan.completed',
  'review-analysis.completed',
  'review-plan.completed',
  'code.completed',
  'review-code.completed',
]);
const SHA256_RE = /^[a-f0-9]{64}$/;
const RECEIPT_SHAPES = {
  'analysis.completed': { output: 'analysis', input: 'review-analysis' },
  'plan.completed': { output: 'plan', input: 'analysis' },
  'review-analysis.completed': { output: 'review-analysis', input: 'analysis' },
  'review-plan.completed': { output: 'review-plan', input: 'plan' },
  'code.completed': { output: 'code', input: 'plan' },
  'review-code.completed': { output: 'review-code', input: 'code' }
} as const;

type ArtifactReceiptEvent =
  | 'analysis.completed'
  | 'plan.completed'
  | 'review-analysis.completed'
  | 'review-plan.completed'
  | 'code.completed'
  | 'review-code.completed';
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

function validateReceiptShape(event: ArtifactReceiptEvent, output: string, input: string): void {
  const outputIdentity = parseArtifactName(output);
  const inputIdentity = parseArtifactName(input);
  if (!outputIdentity || !inputIdentity) throw new ArtifactReceiptError(`receipt artifact identity is invalid: ${output} -> ${input}`);
  const shape = RECEIPT_SHAPES[event];
  const inputMatches = event === 'code.completed'
    ? inputIdentity.family === 'analysis' || inputIdentity.family === 'plan' || inputIdentity.family === 'review-analysis' || inputIdentity.family === 'review-plan' || inputIdentity.family === 'review-code'
    : event === 'plan.completed'
      ? inputIdentity.family === 'analysis' || inputIdentity.family === 'review-analysis' || inputIdentity.family === 'review-plan'
      : event === 'analysis.completed'
        ? inputIdentity.family === 'review-analysis'
        : event === 'review-plan.completed'
          ? inputIdentity.family === 'plan' || inputIdentity.family === 'review-analysis'
          : event === 'review-code.completed'
            ? inputIdentity.family === 'code' || inputIdentity.family === 'plan' || inputIdentity.family === 'review-plan'
        : inputIdentity.family === shape.input;
  if (outputIdentity.family !== shape.output || !inputMatches) {
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
      // A completed artifact can have multiple lifecycle inputs. Pair
      // uniqueness is checked below because the table parser supports one key.
      keyColumn: null
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
  const edges = new Set<string>();
  for (const row of rows) {
    const edge = `${row.output}\0${row.input}`;
    if (edges.has(edge)) throw new ArtifactReceiptError(`duplicate receipt edge '${row.output}' <- '${row.input}'`);
    edges.add(edge);
  }
  return { present: true, rows };
}

function receiptsForOutput(content: string, output: string): readonly ArtifactReceipt[] {
  return parseArtifactReceipts(content).rows.filter((row) => row.output === output);
}

function receiptForOutput(content: string, output: string): ArtifactReceipt | null {
  return receiptsForOutput(content, output)[0] ?? null;
}

function upsertArtifactReceipt(content: string, receipt: ArtifactReceipt): ReceiptSectionMutation {
  return upsertArtifactReceipts(content, [receipt]);
}

function upsertArtifactReceipts(content: string, receiptsToAdd: readonly ArtifactReceipt[]): ReceiptSectionMutation {
  if (receiptsToAdd.length === 0) throw new ArtifactReceiptError('at least one receipt is required');
  const additions = new Map<string, ArtifactReceipt>();
  for (const receipt of receiptsToAdd) {
  if (!RECEIPT_EVENTS.has(receipt.event)) throw new ArtifactReceiptError(`unknown receipt event '${receipt.event}'`);
  if (!receipt.output || !receipt.input) throw new ArtifactReceiptError('receipt output and input are required');
  validateReceiptShape(receipt.event, receipt.output, receipt.input);
  if (!SHA256_RE.test(receipt.inputSha256)) throw new ArtifactReceiptError(`receipt digest for '${receipt.output}' is invalid`);
  if (!receipt.completedAt || Number.isNaN(Date.parse(receipt.completedAt.replace(' ', 'T')))) {
    throw new ArtifactReceiptError(`receipt completion time for '${receipt.output}' is invalid`);
  }

    const key = `${receipt.output}\0${receipt.input}`;
    const duplicate = additions.get(key);
    if (duplicate && JSON.stringify(duplicate) !== JSON.stringify(receipt)) throw new ArtifactReceiptError(`receipt for '${receipt.output}' from '${receipt.input}' has conflicting evidence`);
    additions.set(key, receipt);
  }
  const existing = parseArtifactReceipts(content).rows;
  for (const receipt of additions.values()) {
    const previous = existing.find((row) => row.output === receipt.output && row.input === receipt.input);
    if (previous && JSON.stringify(previous) !== JSON.stringify(receipt)) throw new ArtifactReceiptError(`receipt for '${receipt.output}' from '${receipt.input}' already exists with different evidence`);
  }
  const rows = [...existing];
  for (const receipt of additions.values()) if (!rows.some((row) => row.output === receipt.output && row.input === receipt.input)) rows.push(receipt);
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
  receiptsForOutput,
  sha256Bytes,
  sha256File,
  upsertArtifactReceipt,
  upsertArtifactReceipts
};
export type { ArtifactReceipt, ArtifactReceiptEvent, ArtifactReceiptParseResult, ReceiptSectionMutation };
