import fs from 'node:fs';
import { VERSION } from './version.ts';
import { isDecisionItem, listDecisionItems, selectDecisionItem } from './task/decision-items.ts';
import { parseLedger, type LedgerRow } from './task/ledger.ts';
import { extractSection, findSectionHeading } from './task/sections.ts';
import { resolveTaskRef } from './task/resolve-ref.ts';
import { writeTask } from './task/write.ts';
import type { SectionMutation } from './task/write.ts';

type DecideOptions = {
  repoRoot?: string;
  now?: () => string;
  version?: string;
};

const LEDGER_ALIASES = ['审查分歧账本', 'Review Disagreement Ledger'];
const DECISION_ALIASES = ['人工裁决', 'Human Rulings', 'Human Decisions', 'Human Decision'];
const ACTIVITY_ALIASES = ['活动日志', 'Activity Log'];

function defaultNow(): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZoneName: 'longOffset',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
    .format(new Date())
    .replace(' GMT', '');
}

function nextDecisionRecordId(content: string): string {
  let max = 0;
  for (const match of content.matchAll(/^###\s+HDR-(\d+)\s*$/gm)) {
    max = Math.max(max, Number.parseInt(match[1]!, 10));
  }
  return `HDR-${max + 1}`;
}

function classifyMissingTarget(rows: LedgerRow[], selector: string): string {
  const matches = rows.filter((row) => row.id.toUpperCase() === selector.toUpperCase());
  const valid = matches.filter(isDecisionItem);
  if (valid.some((row) => row.status === 'human-decided')) return `${selector} is already decided`;
  if (valid.length > 0) return `${selector} is not a pending review decision`;
  if (matches.length > 0 || !/^(AN|PL|CD|HD)-\d+$/i.test(selector)) {
    return `${selector} is an invalid decision item`;
  }
  return `${selector} not found in review ledger`;
}

function updatedLedgerBody(content: string, row: LedgerRow, recordId: string): string {
  const body = extractSection(content, LEDGER_ALIASES);
  if (!body) throw new Error('review disagreement ledger section is missing or empty');
  const lines = body.split('\n');
  const source = lines[row.sourceLine];
  if (!source?.trim().startsWith('|')) throw new Error(`ledger source line for ${row.id} is invalid`);
  const cells = source.split('|').slice(1, -1).map((cell) => cell.trim());
  if (cells.length < 6 || cells[0] !== row.id || cells[4] !== 'needs-human-decision') {
    throw new Error(`ledger source line for ${row.id} no longer matches the selected item`);
  }
  cells[4] = 'human-decided';
  cells[5] = `task.md#${recordId}`;
  lines[row.sourceLine] = `| ${cells.join(' | ')} |`;
  return lines.join('\n');
}

function prependBlock(body: string, block: string): string {
  return body ? `${block}\n\n${body}` : block;
}

function appendLine(body: string, line: string): string {
  return body ? `${body}\n${line}` : line;
}

export async function decide(args: string[], options: DecideOptions = {}): Promise<number> {
  const [taskRef, selector, ...decisionParts] = args;
  if (!taskRef || !selector || decisionParts.length === 0) {
    process.stderr.write('Usage: ai decide <task-ref> <ordinal|ledger-id> <decision>\n');
    return 1;
  }
  try {
    const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
    if (!resolved.ok) throw new Error(resolved.message);
    if (resolved.state !== 'active') throw new Error(`task ${resolved.taskId} is not active`);

    const content = fs.readFileSync(resolved.taskMdPath, 'utf8');
    const allRows = parseLedger(content);
    const candidates = listDecisionItems(allRows);
    const selected = selectDecisionItem(candidates, selector);
    if (!selected.ok) {
      if (selected.code === 'not-found' && !/^-?\d+$/.test(selector)) {
        throw new Error(classifyMissingTarget(allRows, selector));
      }
      throw new Error(selected.message);
    }

    const now = (options.now ?? defaultNow)();
    const recordId = nextDecisionRecordId(content);
    const ledgerBody = updatedLedgerBody(content, selected.row, recordId);
    const decisionBody = extractSection(content, DECISION_ALIASES);
    const activityBody = extractSection(content, ACTIVITY_ALIASES);
    if (!activityBody && !ACTIVITY_ALIASES.some((heading) => content.includes(`## ${heading}`))) {
      throw new Error('activity log section is missing');
    }
    const decision = decisionParts.join(' ');
    const record = `### ${recordId}\n\n- **原账本 ID**：${selected.row.id}\n- **裁决时间**：${now}\n- **裁决结果**：${decision}`;
    const mutations: SectionMutation[] = [
      {
        kind: 'section',
        aliases: LEDGER_ALIASES,
        heading: findSectionHeading(content, LEDGER_ALIASES),
        body: ledgerBody
      },
      {
        kind: 'section',
        aliases: DECISION_ALIASES,
        heading: findSectionHeading(content, DECISION_ALIASES),
        body: prependBlock(decisionBody, record)
      },
      {
        kind: 'section',
        aliases: ACTIVITY_ALIASES,
        heading: findSectionHeading(content, ACTIVITY_ALIASES),
        body: appendLine(
          activityBody,
          `- ${now} — **Human Decision** by human — ${selected.row.id} decided → ${recordId}`
        )
      }
    ];
    const result = writeTask(
      { taskRef, expectedState: 'active', mutations },
      {
        repoRoot: options.repoRoot,
        metadataProvider: () => ({
          timestamp: now,
          agentInfraVersion: options.version ?? VERSION
        })
      }
    );
    if (result.status === 'failed') throw new Error(result.error.message);
    return 0;
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function cmdDecide(args: string[]): Promise<void> {
  process.exitCode = await decide(args);
}
