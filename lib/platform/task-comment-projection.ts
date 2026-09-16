import { createHash } from 'node:crypto';

const SNAPSHOT_FRONTMATTER = new Set([
  'id', 'type', 'branch', 'workflow', 'status', 'created_at', 'updated_at',
  'priority', 'effort', 'start_date', 'target_date', 'current_step', 'assigned_to',
  'platform_issue_identity', 'delivery_remote', 'delivery_base_ref', 'pr_delivery_fact'
]);

type TaskCommentProjection = {
  content: string;
  byteLength: number;
  sha256: string;
};

const PROCESS_SECTION_ALIASES = new Set([
  '活动日志', 'activity log',
  '产物生命周期收据', 'artifact lifecycle receipts',
  '审查分歧账本', 'review dispute ledger', 'review disagreement ledger',
  '人工裁决', '人工裁决待办', 'human decisions', 'human decision pending', 'human decisions pending',
  '实现输入', 'implementation input', 'implementation inputs',
  '工作流告警', 'workflow warning', 'workflow warnings', 'warnings',
  '返工意图', 'rework intent', 'rework intents',
  '产物失效记录', 'artifact invalidation', 'artifact invalidation records',
  '实现备注', 'implementation notes',
  '审查反馈', 'review feedback'
]);

function normalize(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\n+$/, '\n');
}

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error('task comment projection requires task frontmatter');
  return { frontmatter: match[1]!, body: content.slice(match[0].length) };
}

function projectFrontmatter(frontmatter: string): string {
  const lines = frontmatter.replace(/\r\n/g, '\n').split('\n');
  const selected = lines.filter((line) => {
    if (!line.trim() || line.trimStart().startsWith('#')) return false;
    const match = /^([^:\s][^:]*):/.exec(line);
    return Boolean(match && SNAPSHOT_FRONTMATTER.has(match[1]!.trim()));
  });
  if (!selected.some((line) => /^id:/.test(line))) throw new Error('task comment projection requires frontmatter id');
  return selected.join('\n');
}

function projectBody(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  let excludedLevel: number | null = null;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      if (excludedLevel !== null && level <= excludedLevel) excludedLevel = null;
      if (PROCESS_SECTION_ALIASES.has(heading[2]!.trim().toLowerCase())) {
        excludedLevel = level;
        continue;
      }
    }
    if (excludedLevel === null) kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function projectTaskComment(content: string): TaskCommentProjection {
  const split = splitFrontmatter(content);
  const projected = normalize(`---\n${projectFrontmatter(split.frontmatter)}\n---\n\n${projectBody(split.body)}`);
  return {
    content: projected,
    byteLength: Buffer.byteLength(projected, 'utf8'),
    sha256: createHash('sha256').update(projected, 'utf8').digest('hex')
  };
}

export { projectTaskComment };
export type { TaskCommentProjection };
