import { parseActivityRecoveryMetadata } from './activity-recovery.ts';

type RecoveryRemoteComment = { body: string; user?: { login?: string } };

function normalized(body: string): string {
  return body.replace(/\r\n/g, '\n').replace(/\n+$/, '\n');
}

function decodeRenderedText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function taskSnapshot(taskId: string, body: string): string {
  const marker = `<!-- sync-issue:${taskId}:task -->`;
  if (normalized(body).split('\n', 1)[0] !== marker) throw new Error('RECOVERY_EVIDENCE_MISSING: task snapshot marker is invalid');
  const frontmatter = body.match(/<details><summary>[^<]*<\/summary>\n\n```yaml\n---\n([\s\S]*?)\n---\n```\n\n<\/details>/);
  if (!frontmatter) throw new Error('RECOVERY_EVIDENCE_MISSING: task snapshot frontmatter is invalid');
  const afterDetails = (frontmatter.index ?? 0) + frontmatter[0].length;
  const footer = body.lastIndexOf('\n\n---\n*由 ');
  if (footer <= afterDetails) throw new Error('RECOVERY_EVIDENCE_MISSING: task snapshot envelope is invalid');
  const projectedBody = body.slice(afterDetails, footer).replace(/^\n+|\n+$/g, '');
  return `---\n${decodeRenderedText(frontmatter[1]!)}\n---\n\n${decodeRenderedText(projectedBody)}\n`;
}

function activityLine(entry: { time: string; step: string; agent: string; note: string }): string {
  return `- ${entry.time} — **${entry.step}** by ${entry.agent} — ${entry.note}`;
}

function recoverTaskFromComments(input: { taskId: string; comments: readonly RecoveryRemoteComment[] }): string {
  const marker = `<!-- sync-issue:${input.taskId}:task -->`;
  const snapshots = input.comments.filter((comment) => normalized(comment.body).split('\n', 1)[0] === marker);
  if (snapshots.length !== 1) throw new Error('RECOVERY_EVIDENCE_MISSING: exactly one task snapshot comment is required');
  const author = snapshots[0]!.user?.login;
  if (!author) throw new Error('RECOVERY_EVIDENCE_MISSING: task snapshot author is unavailable');
  const content = taskSnapshot(input.taskId, normalized(snapshots[0]!.body));
  const entries = new Map<string, { time: string; step: string; agent: string; note: string }>();
  for (const comment of input.comments) {
    if (comment.user?.login !== author) continue;
    const record = parseActivityRecoveryMetadata(comment.body);
    if (!record) continue;
    if (record.taskId !== input.taskId) throw new Error('RECOVERY_EVIDENCE_MISSING: activity metadata task identity is invalid');
    for (const entry of record.entries) entries.set(JSON.stringify(entry), entry);
  }
  const restored = [...entries.values()].sort((left, right) => left.time.localeCompare(right.time));
  return `${content.replace(/\n+$/, '')}\n\n## 活动日志\n\n${restored.map(activityLine).join('\n')}\n`;
}

export { recoverTaskFromComments };
export type { RecoveryRemoteComment };
