import fs from 'node:fs';
import path from 'node:path';
import { formatTable } from '../../table.ts';
import { parseTaskScope } from '../command-options.ts';
import { resolveTaskContext } from '../resolve-ref.ts';
import { isReviewStage, parseLedger, type LedgerRow, type ReviewStage } from '../ledger.ts';
import { listDecisionItems, selectDecisionItem } from '../decision-items.ts';
import { extractSubSection } from '../sections.ts';

const USAGE = `Usage: ai task decisions [--task <ref> | -t <ref>] [--item <selector> | -i <selector>] [options]
       ai task decisions <ref> [selector] [options]

Shows what still needs a maintainer's decision. Without a selector, it lists
the choices. With a selector, it shows the explanation and how to respond.
Read-only.

  Omit <ref>     Resolve the unique active task for the current branch.
  <ref>          Legacy positional task ref.
  [selector]     Ordinal (1-based) or ledger id (e.g. 'PL-3') to show one item's detail.

Options:
  -i, --item <s>    Select an item when task scope is implicit or flag-based.
  --all              Include already-decided (human-decided) items, not just pending.
  --stage <s>        Filter to one stage: analysis | plan | code.
  --format <fmt>     Output format: text (default) | markdown.
  -h, --help         Show this help.

Aliased as 'ai task d'.
`;

const FORMATS = new Set(['text', 'markdown']);

function fail(message: string): void {
  process.stderr.write(`ai task decisions: ${message}\n`);
  process.exitCode = 1;
}

type ParsedArgs = {
  positionals: string[];
  item?: string;
  all: boolean;
  stage?: string;
  format: string;
};

// Returns null and sets the exit code when an option is malformed.
function parseArgs(args: string[]): ParsedArgs | null {
  const out: ParsedArgs = { positionals: [], all: false, format: 'text' };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === '--all') {
      out.all = true;
    } else if (a === '--item' || a === '-i') {
      const v = args[i + 1];
      if (v === undefined) { fail(`${a} requires a value`); return null; }
      if (out.item !== undefined) { fail("duplicate option '--item'"); return null; }
      out.item = v; i += 1;
    } else if (a.startsWith('--item=')) {
      if (out.item !== undefined) { fail("duplicate option '--item'"); return null; }
      out.item = a.slice('--item='.length);
      if (out.item === '') { fail('--item requires a value'); return null; }
    } else if (a === '--stage') {
      const v = args[i + 1];
      if (v === undefined) {
        fail('--stage requires a value (analysis|plan|code)');
        return null;
      }
      out.stage = v;
      i += 1;
    } else if (a.startsWith('--stage=')) {
      out.stage = a.slice('--stage='.length);
    } else if (a === '--format') {
      const v = args[i + 1];
      if (v === undefined) {
        fail('--format requires a value (text|markdown)');
        return null;
      }
      out.format = v;
      i += 1;
    } else if (a.startsWith('--format=')) {
      out.format = a.slice('--format='.length);
    } else if (a.startsWith('-')) {
      fail(`unknown option '${a}'`);
      return null;
    } else {
      out.positionals.push(a);
    }
  }
  return out;
}

// Parse `<file>.md#anchor` evidence into its filename, when present.
function evidenceFile(evidence: string): string | null {
  const m = /([\w.-]+\.md)#/.exec(evidence);
  return m ? m[1]! : null;
}

function roundOf(file: string): number {
  const m = /-r(\d+)\.md$/.exec(file);
  return m ? Number.parseInt(m[1]!, 10) : 1;
}

// Locate the `### {ledger-id}` detail block for a row. Prefer the artifact named by the
// row's evidence anchor; otherwise scan analysis/plan/code artifacts and return
// the block from the highest-round file that contains it. Returns '' when none
// is found (caller degrades gracefully — plan B3).
function findDetailBlock(row: LedgerRow, taskDir: string): string {
  const hinted = evidenceFile(row.evidence);
  if (hinted) {
    const p = path.join(taskDir, hinted);
    if (fs.existsSync(p)) {
      const block = extractSubSection(fs.readFileSync(p, 'utf8'), row.id);
      if (block) return block;
    }
  }
  let best = '';
  let bestRound = -1;
  let entries: string[];
  try {
    entries = fs.readdirSync(taskDir);
  } catch {
    return '';
  }
  for (const file of entries) {
    if (!/^(analysis|plan|code)(-r\d+)?\.md$/.test(file)) continue;
    const block = extractSubSection(fs.readFileSync(path.join(taskDir, file), 'utf8'), row.id);
    if (block && roundOf(file) > bestRound) {
      best = block;
      bestRound = roundOf(file);
    }
  }
  return best;
}

// Pull the `## 人工裁决` record lines that mention this ledger id, so a decided item
// shows the human's recorded ruling alongside its detail block.
function findDecisionRecord(id: string, content: string): string[] {
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length && !/^##\s+(人工裁决|Human Rulings|Human Decisions?)\s*$/.test(lines[i]!)) i += 1;
  if (i >= lines.length) return [];
  const idRe = new RegExp(`(^|[^\\w-])${id}(?![\\w-])`);
  const out: string[] = [];
  for (let j = i + 1; j < lines.length; j += 1) {
    if (/^##\s/.test(lines[j]!)) break;
    if (lines[j]!.trim().startsWith('-') && idRe.test(lines[j]!)) out.push(lines[j]!);
  }
  return out;
}

function titleOf(row: LedgerRow, taskDir: string): string {
  const block = findDetailBlock(row, taskDir);
  if (block) {
    const title = block
      .split('\n')[0]!
      .replace(/^###\s+/, '')
      .replace(/\s*\[needs-human-decision\]\s*$/, '')
      .trim();
    return title.replace(new RegExp(`^${row.id}\\s*[:：]\\s*`, 'i'), '').trim();
  }
  return '(explanation unavailable)';
}

function trackingOf(row: LedgerRow): string {
  return `stage=${row.stage} · severity=${row.severity} · status=${row.status} · evidence=${row.evidence}`;
}

function renderList(rows: LedgerRow[], format: string, taskDir: string): void {
  if (rows.length === 0) {
    process.stdout.write('No pending decisions.\n');
    return;
  }
  const headers = ['#', 'CHOICE', 'WHAT NEEDS A DECISION', 'TRACKING'];
  const data = rows.map((r, i) => [
    String(i + 1),
    r.id,
    titleOf(r, taskDir),
    trackingOf(r)
  ]);
  if (format === 'markdown') {
    const sep = headers.map(() => '---');
    const md = [
      `| ${headers.join(' | ')} |`,
      `| ${sep.join(' | ')} |`,
      ...data.map((row) => `| ${row.join(' | ')} |`)
    ];
    process.stdout.write(`${md.join('\n')}\n\nView one item: ai task decisions <task-ref> <ordinal|ledger-id>\n`);
    return;
  }
  process.stdout.write(`${formatTable(headers, data).join('\n')}\n\nView one item: ai task decisions <task-ref> <ordinal|ledger-id>\n`);
}

function renderTracking(row: LedgerRow, format: string): string[] {
  if (format === 'markdown') {
    return [
      '**Tracking**',
      `- stage: \`${row.stage}\``,
      `- severity: \`${row.severity}\``,
      `- status: \`${row.status}\``,
      `- evidence: \`${row.evidence}\``
    ];
  }
  return [
    'Tracking:',
    `stage: ${row.stage}`,
    `severity: ${row.severity}`,
    `status: ${row.status}`,
    `evidence: ${row.evidence}`
  ];
}

function renderDetail(
  rows: LedgerRow[],
  selector: string,
  format: string,
  taskDir: string,
  content: string
): void {
  const selected = selectDecisionItem(rows, selector);
  if (!selected.ok) {
    fail(selected.message);
    return;
  }
  const r = selected.row;
  const block = findDetailBlock(r, taskDir);
  const title = titleOf(r, taskDir);
  const lines: string[] = [];
  const decided = r.status === 'human-decided';
  if (format === 'markdown') {
    lines.push(`## ${decided ? 'Decision already recorded' : 'Decision needed'}: ${title}`, '');
    if (!decided) {
      lines.push('**How to record your choice**', `\`ai decide <task-ref> ${r.id} <your choice and rationale>\``, '');
    }
    lines.push('**Original context**', '');
  } else {
    lines.push(`${decided ? 'Decision already recorded' : 'Decision needed'}: ${title}`, '');
    if (!decided) {
      lines.push('How to record your choice:', `ai decide <task-ref> ${r.id} <your choice and rationale>`, '');
    }
    lines.push('Original context:');
  }
  if (block) {
    lines.push(block);
  } else {
    lines.push(
      `This older task does not include a full explanation for ${r.id}.`,
      'Use the tracking reference below to find the original context.'
    );
  }
  if (decided) {
    const record = findDecisionRecord(r.id, content);
    lines.push('', format === 'markdown' ? '**Recorded choice**' : 'Recorded choice:');
    lines.push(...(record.length ? record : ['No separate ruling record was found.']));
  }
  lines.push('', ...renderTracking(r, format));
  process.stdout.write(`${lines.join('\n')}\n`);
}

function decisions(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    return;
  }
  let scope;
  try { scope = parseTaskScope(args); } catch (error) { fail(error instanceof Error ? error.message : String(error)); return; }
  const parsed = parseArgs(scope.positionals);
  if (!parsed) return;
  if (parsed.stage !== undefined && !isReviewStage(parsed.stage)) {
    fail(`invalid --stage '${parsed.stage}' (expected analysis|plan|code)`);
    return;
  }
  if (!FORMATS.has(parsed.format)) {
    fail(`invalid --format '${parsed.format}' (expected text|markdown)`);
    return;
  }

  let taskRef = scope.taskRef;
  let selector = parsed.item;
  if (parsed.item !== undefined) {
    if (parsed.positionals.length > 0) { fail('positional task ref/selector cannot be combined with --item'); return; }
  } else if (scope.explicit) {
    if (parsed.positionals.length > 0) { fail('positional task ref/selector cannot be combined with --task'); return; }
  } else {
    if (parsed.positionals.length > 2) { fail('too many positional arguments'); return; }
    taskRef = parsed.positionals[0];
    selector = parsed.positionals[1];
  }
  const resolved = resolveTaskContext(taskRef);
  if (!resolved.ok) {
    fail(resolved.message);
    return;
  }

  const content = fs.readFileSync(resolved.taskMdPath, 'utf8');
  const rows = listDecisionItems(parseLedger(content), {
    includeDecided: parsed.all,
    stage: parsed.stage as ReviewStage | undefined
  });

  if (selector === undefined) {
    renderList(rows, parsed.format, resolved.taskDir);
  } else {
    renderDetail(rows, selector, parsed.format, resolved.taskDir, content);
  }
}

export { decisions };
