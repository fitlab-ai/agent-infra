import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { VERSION } from './version.ts';
import { resolveTaskRef } from './task/resolve-ref.ts';

const TASK_ID_RE = /^TASK-\d{8}-\d{6}$/;

type DecideOptions = {
  repoRoot?: string;
  now?: () => string;
  version?: string;
};

function detectRepoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim();
}

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

function taskPath(repoRoot: string, ref: string): string {
  if (!TASK_ID_RE.test(ref)) {
    const resolved = resolveTaskRef(ref);
    if (!resolved.ok) throw new Error(resolved.message);
    if (!resolved.taskDir.includes(`${path.join('.agents', 'workspace', 'active')}${path.sep}`)) {
      throw new Error(`task ${resolved.taskId} is not active`);
    }
    return resolved.taskMdPath;
  }
  const candidate = path.join(repoRoot, '.agents', 'workspace', 'active', ref, 'task.md');
  if (!fs.existsSync(candidate)) throw new Error(`active task not found: ${ref}`);
  return candidate;
}

function replaceFrontmatterField(content: string, field: string, value: string): string {
  const re = new RegExp(`^${field}:.*$`, 'm');
  if (re.test(content)) return content.replace(re, `${field}: ${value}`);
  return content.replace(/^---\n/, `---\n${field}: ${value}\n`);
}

function replaceLedgerRow(content: string, hdId: string): { content: string; found: boolean; pending: boolean } {
  const lines = content.split('\n');
  let found = false;
  let pending = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (!line.trim().startsWith(`| ${hdId} |`)) continue;
    found = true;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells[4] !== 'needs-human-decision') break;
    pending = true;
    cells[4] = 'human-decided';
    cells[5] = `task.md#${hdId}`;
    lines[i] = `| ${cells.join(' | ')} |`;
    break;
  }
  return { content: lines.join('\n'), found, pending };
}

function appendUnderHeading(content: string, heading: string, block: string): string {
  if (!content.includes(`${heading}\n`)) {
    return `${content.trimEnd()}\n\n${heading}\n\n${block}\n`;
  }
  const idx = content.indexOf(`${heading}\n`) + heading.length + 1;
  const before = content.slice(0, idx);
  const after = content.slice(idx);
  return `${before}\n${block}\n${after.replace(/^\n/, '')}`;
}

export async function decide(args: string[], options: DecideOptions = {}): Promise<number> {
  const [taskRef, hdId, ...decisionParts] = args;
  if (!taskRef || !hdId || decisionParts.length === 0) {
    process.stderr.write('Usage: ai decide <task-ref> <HD-id> <decision>\n');
    return 1;
  }
  try {
    const repoRoot = options.repoRoot ?? detectRepoRoot();
    const file = taskPath(repoRoot, taskRef);
    let content = fs.readFileSync(file, 'utf8');
    const replaced = replaceLedgerRow(content, hdId);
    if (!replaced.found) throw new Error(`${hdId} not found in review ledger`);
    if (!replaced.pending) throw new Error(`${hdId} is not needs-human-decision`);
    content = replaced.content;
    const now = (options.now ?? defaultNow)();
    content = replaceFrontmatterField(content, 'updated_at', now);
    content = replaceFrontmatterField(content, 'agent_infra_version', options.version ?? VERSION);
    const decision = decisionParts.join(' ');
    content = appendUnderHeading(
      content,
      '## 人工裁决',
      `### ${hdId}\n\n- **裁决时间**：${now}\n- **裁决结果**：${decision}`
    );
    content = appendUnderHeading(
      content,
      '## 活动日志',
      `- ${now} — **Human Decision** by human — ${hdId} decided`
    );
    fs.writeFileSync(file, content);
    return 0;
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function cmdDecide(args: string[]): Promise<void> {
  process.exitCode = await decide(args);
}
