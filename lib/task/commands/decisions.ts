import fs from 'node:fs';
import path from 'node:path';
import { formatTable } from '../../table.ts';
import { resolveTaskRef } from '../resolve-ref.ts';
import { parseLedger, HUMAN_DECISION_STATUSES, type LedgerRow } from '../ledger.ts';
import { extractSubSection } from '../sections.ts';

const USAGE = `Usage: ai task decisions <N | #N | TASK-id> [selector] [options]

Lists the human-decision (HD-) items recorded in a task's review disagreement
ledger, or prints the full detail block for a single item. Read-only.

  <ref>          Bare numeric / '#N' short id, or a full TASK-YYYYMMDD-HHMMSS id.
  [selector]     Ordinal (1-based) or HD id (e.g. 'HD-3') to show one item's detail.

Options:
  --all              Include already-decided (human-decided) items, not just pending.
  --stage <s>        Filter to one stage: analysis | plan | code.
  --format <fmt>     Output format: text (default) | markdown.
  -h, --help         Show this help.

Aliased as 'ai task d'.
`;

const STAGES = new Set(['analysis', 'plan', 'code']);
const FORMATS = new Set(['text', 'markdown']);
const HD_ID_RE = /^HD-\d+$/;

function fail(message: string): void {
  process.stderr.write(`ai task decisions: ${message}\n`);
  process.exitCode = 1;
}

type ParsedArgs = {
  positionals: string[];
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

// Locate the `### HD-N` detail block for a row. Prefer the artifact named by the
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

// Pull the `## 人工裁决` record lines that mention this HD id, so a decided item
// shows the human's recorded ruling alongside its detail block.
function findDecisionRecord(id: string, content: string): string[] {
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length && !/^##\s+(人工裁决|Human Decisions?)\s*$/.test(lines[i]!)) i += 1;
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
    return block
      .split('\n')[0]!
      .replace(/^###\s+/, '')
      .replace(/\s*\[needs-human-decision\]\s*$/, '')
      .trim();
  }
  return row.evidence || '(无详情)';
}

function renderList(rows: LedgerRow[], format: string, taskDir: string): void {
  if (rows.length === 0) {
    process.stdout.write('无待裁决项。\n');
    return;
  }
  const headers = ['#', 'ID', 'STAGE', 'SEVERITY', 'STATUS', 'EVIDENCE', 'TITLE'];
  const data = rows.map((r, i) => [
    String(i + 1),
    r.id,
    r.stage,
    r.severity,
    r.status,
    r.evidence,
    titleOf(r, taskDir)
  ]);
  if (format === 'markdown') {
    const sep = headers.map(() => '---');
    const md = [
      `| ${headers.join(' | ')} |`,
      `| ${sep.join(' | ')} |`,
      ...data.map((row) => `| ${row.join(' | ')} |`)
    ];
    process.stdout.write(`${md.join('\n')}\n`);
    return;
  }
  process.stdout.write(`${formatTable(headers, data).join('\n')}\n`);
}

function renderDetail(
  rows: LedgerRow[],
  selector: string,
  format: string,
  taskDir: string,
  content: string
): void {
  let row: LedgerRow | undefined;
  if (/^\d+$/.test(selector)) {
    const idx = Number.parseInt(selector, 10) - 1;
    if (idx < 0 || idx >= rows.length) {
      fail(`ordinal '${selector}' out of range (1..${rows.length})`);
      return;
    }
    row = rows[idx];
  } else {
    const want = selector.toUpperCase();
    const matches = rows.filter((r) => r.id.toUpperCase() === want);
    if (matches.length === 0) {
      fail(`no decision item matches '${selector}'`);
      return;
    }
    if (matches.length > 1) {
      fail(`duplicate id '${selector}' in ledger; select by ordinal instead`);
      return;
    }
    row = matches[0];
  }

  const r = row!;
  const block = findDetailBlock(r, taskDir);
  const lines: string[] = [];
  if (format === 'markdown') {
    lines.push(`**${r.id}** (${r.stage}/${r.severity}) · status=\`${r.status}\` · evidence: \`${r.evidence}\``, '');
  } else {
    lines.push(`${r.id} (${r.stage}/${r.severity}) status=${r.status}`, `evidence: ${r.evidence}`, '');
  }
  if (block) {
    lines.push(block);
  } else {
    lines.push(
      `（详情块未找到：未在任务产物中定位到 \`### ${r.id}\` 锚点，可能为历史产物或尚未写入；evidence 指向 ${r.evidence}）`
    );
  }
  if (r.status === 'human-decided') {
    const record = findDecisionRecord(r.id, content);
    if (record.length) {
      lines.push('', '人工裁定：', ...record);
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function decisions(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    return;
  }
  const parsed = parseArgs(args);
  if (!parsed) return;
  if (parsed.positionals.length === 0) {
    process.stdout.write(USAGE);
    process.exitCode = 1;
    return;
  }
  if (parsed.stage !== undefined && !STAGES.has(parsed.stage)) {
    fail(`invalid --stage '${parsed.stage}' (expected analysis|plan|code)`);
    return;
  }
  if (!FORMATS.has(parsed.format)) {
    fail(`invalid --format '${parsed.format}' (expected text|markdown)`);
    return;
  }

  const resolved = resolveTaskRef(parsed.positionals[0]!);
  if (!resolved.ok) {
    fail(resolved.message);
    return;
  }

  const content = fs.readFileSync(resolved.taskMdPath, 'utf8');
  let rows = parseLedger(content).filter((r) => HD_ID_RE.test(r.id));
  rows = rows.filter((r) =>
    parsed.all ? HUMAN_DECISION_STATUSES.has(r.status) : r.status === 'needs-human-decision'
  );
  if (parsed.stage !== undefined) rows = rows.filter((r) => r.stage === parsed.stage);

  const selector = parsed.positionals[1];
  if (selector === undefined) {
    renderList(rows, parsed.format, resolved.taskDir);
  } else {
    renderDetail(rows, selector, parsed.format, resolved.taskDir, content);
  }
}

export { decisions };
