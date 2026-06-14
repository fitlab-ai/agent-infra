import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { formatTable } from '../../table.ts';
import { parseTaskFrontmatter, extractTitle } from '../frontmatter.ts';
import { loadShortIdByTaskId } from '../short-id.ts';

const USAGE = `Usage: ai task ls [--all | --blocked | --completed]

Lists tasks under .agents/workspace/. Defaults to active tasks only.
  --all         Include active + blocked + completed (excludes archive)
  --blocked     Only blocked tasks
  --completed   Only completed tasks

Columns: # (display-only row number) / SHORT (task short id, usable as an argument) / type / status / current_step / branch / title
`;

const TASK_ID_RE = /^TASK-\d{8}-\d{6}$/;
const TABLE_HEADERS = ['#', 'SHORT', 'TYPE', 'STATUS', 'STEP', 'BRANCH', 'TITLE'] as const;

type Selection = ('active' | 'blocked' | 'completed')[];

function detectRepoRoot(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch {
    throw new Error('ai task: current directory is not inside a git repository');
  }
}

type ParseResult =
  | { ok: true; selection: Selection }
  | { ok: false; message: string };

function parseSelection(args: string[]): ParseResult {
  const positional = args.filter((a) => !a.startsWith('--'));
  if (positional.length > 0) {
    return {
      ok: false,
      message: `ai task ls: unexpected positional argument(s): ${positional.join(' ')}`
    };
  }
  const flags = args.filter((a) => a.startsWith('--'));
  if (flags.length === 0) return { ok: true, selection: ['active'] };
  if (flags.length > 1) {
    return {
      ok: false,
      message: 'ai task ls: pass at most one of --all / --blocked / --completed'
    };
  }
  switch (flags[0]) {
    case '--all':
      return { ok: true, selection: ['active', 'blocked', 'completed'] };
    case '--blocked':
      return { ok: true, selection: ['blocked'] };
    case '--completed':
      return { ok: true, selection: ['completed'] };
    default:
      return { ok: false, message: `ai task ls: unknown flag: ${flags[0]}` };
  }
}

type TaskRow = {
  shortId: string;
  type: string;
  status: string;
  step: string;
  branch: string;
  title: string;
};

function collectTasks(repoRoot: string, state: 'active' | 'blocked' | 'completed'): TaskRow[] {
  const dir = path.join(repoRoot, '.agents', 'workspace', state);
  if (!fs.existsSync(dir)) return [];
  // Short ids live only in the registry and only for active tasks; archived
  // (blocked/completed) tasks have released their short id and render '-'.
  const shortIdByTaskId = state === 'active' ? loadShortIdByTaskId(repoRoot) : new Map<string, string>();
  const rows: TaskRow[] = [];
  for (const entry of fs.readdirSync(dir).sort()) {
    if (!TASK_ID_RE.test(entry)) continue;
    const taskMdPath = path.join(dir, entry, 'task.md');
    if (!fs.existsSync(taskMdPath)) continue;
    const content = fs.readFileSync(taskMdPath, 'utf8');
    const fm = parseTaskFrontmatter(content);
    const title = extractTitle(content);
    const shortId = shortIdByTaskId.get(entry) ?? '-';
    rows.push({
      shortId,
      type: fm.type ?? '-',
      status: fm.status ?? state,
      step: fm.current_step ?? '-',
      branch: fm.branch ?? '-',
      title: title || fm.id || entry
    });
  }
  return rows;
}

function ls(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    return;
  }
  const result = parseSelection(args);
  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    process.exitCode = 1;
    return;
  }
  const { selection } = result;
  const repoRoot = detectRepoRoot();
  const rows: TaskRow[] = [];
  for (const state of selection) {
    rows.push(...collectTasks(repoRoot, state));
  }
  if (rows.length === 0) {
    process.stdout.write(`No tasks under .agents/workspace/${selection.join('|')}\n`);
    return;
  }
  const tableRows = rows.map((r, i) => [
    String(i + 1),
    r.shortId,
    r.type,
    r.status,
    r.step,
    r.branch,
    r.title
  ]);
  for (const line of formatTable(TABLE_HEADERS, tableRows)) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write(`Total: ${rows.length} tasks\n`);
}

export { ls };
