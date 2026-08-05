import fs from 'node:fs';
import path from 'node:path';

import { parseTaskFrontmatter } from '../task/frontmatter.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { createGitHubClient } from './github-client.ts';
import type { GitHubClient } from './github-client.ts';
import { resolvePlatformContext } from './context.ts';
import { platformResult } from './types.ts';
import type { PlatformOperation, PlatformResult } from './types.ts';

type RemoteComment = { id: number; body: string; user?: { login?: string } };
type RenderedChunk = { marker: string; body: string; content: string; part: number; total: number };
type CommentKind = 'task' | 'artifact' | 'summary' | 'cancel';
type SyncOptions = {
  kind: CommentKind;
  agent: string;
  artifact?: string;
  body?: string;
  cwd?: string;
  backfill?: boolean;
  client?: GitHubClient;
};

const MARKERS = {
  task: (taskId: string) => `<!-- sync-issue:${taskId}:task -->`,
  artifact: (taskId: string, stem: string) => `<!-- sync-issue:${taskId}:${stem} -->`,
  artifactChunk: (taskId: string, stem: string, part: number, total: number) =>
    `<!-- sync-issue:${taskId}:${stem}:${part}/${total} -->`,
  summary: (taskId: string) => `<!-- sync-issue:${taskId}:summary -->`,
  cancel: (taskId: string) => `<!-- sync-issue:${taskId}:cancel -->`
};

const ARTIFACT_TITLES: Record<string, string> = {
  analysis: '需求分析',
  'review-analysis': '需求分析审查',
  plan: '技术方案',
  'review-plan': '技术方案审查',
  code: '实现报告',
  'review-code': '代码审查',
  'manual-validation': '人工验证报告',
  'pr-review': 'PR 审查报告'
};

function normalizeCommentContent(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\n+$/, '\n');
}

function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { frontmatter: null, body: content };
  return { frontmatter: match[1]!, body: content.slice(match[0].length).replace(/^\r?\n/, '') };
}

function footer(agent: string, taskId: string): string {
  return `---\n*由 ${agent} 自动生成 · 内部追踪：${taskId}*`;
}

function renderTaskComment(content: string, taskId: string, agent: string): string {
  const split = splitFrontmatter(content);
  const taskBody = split.frontmatter === null
    ? split.body
    : `<details><summary>元数据 (frontmatter)</summary>\n\n\`\`\`yaml\n---\n${split.frontmatter}\n---\n\`\`\`\n\n</details>\n\n${split.body}`;
  return normalizeCommentContent([
    MARKERS.task(taskId),
    '## 任务文件',
    '',
    `> **${agent}** · ${taskId}`,
    '',
    taskBody.replace(/\n+$/, ''),
    '',
    footer(agent, taskId)
  ].join('\n'));
}

function artifactIdentity(artifact: string): { stem: string; title: string } {
  const stem = path.basename(artifact, '.md');
  const match = stem.match(/^(analysis|review-analysis|plan|review-plan|code|review-code|manual-validation|pr-review)(?:-r(\d+))?$/);
  if (!match) throw new Error(`unsupported artifact '${artifact}'`);
  const base = ARTIFACT_TITLES[match[1]!]!;
  const round = match[2] ? Number(match[2]) : 1;
  return { stem, title: `${base}（Round ${round}）` };
}

function chunkByUtf8(content: string, maxBytes: number): string[] {
  if (maxBytes <= 0) throw new Error('comment byte limit is too small');
  const chunks: string[] = [];
  let remaining = content;
  while (remaining) {
    if (Buffer.byteLength(remaining, 'utf8') <= maxBytes) {
      chunks.push(remaining);
      break;
    }
    let bytes = 0;
    let index = 0;
    let newlineIndex = -1;
    for (const character of remaining) {
      const size = Buffer.byteLength(character, 'utf8');
      if (bytes + size > maxBytes) break;
      bytes += size;
      index += character.length;
      if (character === '\n') newlineIndex = index;
    }
    const cut = newlineIndex > 0 ? newlineIndex : index;
    if (cut === 0) throw new Error('comment byte limit cannot fit one Unicode code point');
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  return chunks.length > 0 ? chunks : [''];
}

function buildArtifactChunk(
  taskId: string,
  stem: string,
  title: string,
  agent: string,
  content: string,
  part: number,
  total: number,
  chunked: boolean,
  backfill: boolean
): RenderedChunk {
  const marker = chunked ? MARKERS.artifactChunk(taskId, stem, part, total) : MARKERS.artifact(taskId, stem);
  const heading = chunked ? `## ${title}（${part}/${total}）` : `## ${title}`;
  const timelineHint = backfill ? '> 历史产物补发' : null;
  const body = normalizeCommentContent([
    marker,
    heading,
    ...(timelineHint ? ['', timelineHint] : []),
    '',
    `> **${agent}** · ${taskId}`,
    '',
    content,
    '',
    footer(agent, taskId)
  ].join('\n'));
  return { marker, body, content, part, total };
}

function chunkArtifactComment(input: {
  taskId: string;
  artifact: string;
  agent: string;
  body: string;
  byteLimit?: number;
  backfill?: boolean;
}): RenderedChunk[] {
  const byteLimit = input.byteLimit || 60_000;
  const identity = artifactIdentity(input.artifact);
  const single = buildArtifactChunk(
    input.taskId, identity.stem, identity.title, input.agent, input.body, 1, 1, false, Boolean(input.backfill)
  );
  if (Buffer.byteLength(single.body, 'utf8') <= byteLimit) return [single];

  let total = 2;
  let pieces: string[] = [];
  for (;;) {
    const probe = buildArtifactChunk(
      input.taskId, identity.stem, identity.title, input.agent, '', total, total, true, Boolean(input.backfill)
    );
    const available = byteLimit - Buffer.byteLength(probe.body, 'utf8');
    pieces = chunkByUtf8(input.body, available);
    if (pieces.length === total) break;
    total = pieces.length;
  }
  return pieces.map((content, index) => {
    const chunk = buildArtifactChunk(
      input.taskId, identity.stem, identity.title, input.agent, content, index + 1, total, true, Boolean(input.backfill)
    );
    if (Buffer.byteLength(chunk.body, 'utf8') > byteLimit) throw new Error('rendered comment exceeds byte limit');
    return chunk;
  });
}

function findMarkerComments(comments: RemoteComment[], marker: string): RemoteComment[] {
  return comments.filter((comment) => normalizeCommentContent(String(comment.body || '')).split('\n', 1)[0] === marker);
}

function flattenComments(value: unknown): RemoteComment[] {
  if (!Array.isArray(value)) return [];
  const flattened = value.flatMap((entry) => Array.isArray(entry) ? entry : [entry]);
  return flattened.filter((entry): entry is RemoteComment =>
    Boolean(entry && typeof entry === 'object' && typeof entry.id === 'number' && typeof entry.body === 'string')
  );
}

function issueNumberFromTask(content: string): number | null {
  const value = parseTaskFrontmatter(content).issue_number;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function listRemoteComments(client: GitHubClient, repo: string, issue: number, cwd: string) {
  const result = client.json<unknown>([
    'api', '--paginate', '--slurp', `repos/${repo}/issues/${issue}/comments?per_page=100`
  ], { cwd });
  return result.ok ? { ok: true as const, value: flattenComments(result.value) } : result;
}

function contextFields(context: PlatformResult): Partial<PlatformResult> {
  return {
    platform: context.platform,
    capabilities: context.capabilities
  };
}

function hasResolvedPlatformContext(context: PlatformResult): boolean {
  return context.status === 'degraded' || (context.status === 'no-op' && context.error === null);
}

function bodyEnvelope(marker: string, title: string, taskId: string, agent: string, body: string): string {
  return normalizeCommentContent([
    marker, `## ${title}`, '', `> **${agent}** · ${taskId}`, '', body.replace(/\n+$/, ''), '', footer(agent, taskId)
  ].join('\n'));
}

function resolveArtifactBody(taskDir: string, artifact: string): string {
  if (path.basename(artifact) !== artifact || !artifact.endsWith('.md')) throw new Error('artifact must be a canonical markdown filename');
  artifactIdentity(artifact);
  const artifactPath = path.join(taskDir, artifact);
  const stat = fs.lstatSync(artifactPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('artifact must be a regular file');
  const realTaskDir = fs.realpathSync(taskDir);
  const realArtifact = fs.realpathSync(artifactPath);
  if (path.dirname(realArtifact) !== realTaskDir) throw new Error('artifact must stay inside the task directory');
  return fs.readFileSync(realArtifact, 'utf8');
}

function expectedComments(
  taskId: string,
  taskContent: string,
  taskDir: string,
  options: SyncOptions
): RenderedChunk[] {
  if (options.kind === 'task') {
    const body = renderTaskComment(taskContent, taskId, options.agent);
    return [{ marker: MARKERS.task(taskId), body, content: taskContent, part: 1, total: 1 }];
  }
  if (options.kind === 'artifact') {
    if (!options.artifact) throw new Error('artifact sync requires an artifact filename');
    return chunkArtifactComment({
      taskId,
      artifact: options.artifact,
      agent: options.agent,
      body: resolveArtifactBody(taskDir, options.artifact),
      backfill: options.backfill
    });
  }
  if (options.body === undefined) throw new Error(`${options.kind} sync requires a body`);
  const marker = options.kind === 'summary' ? MARKERS.summary(taskId) : MARKERS.cancel(taskId);
  const title = options.kind === 'summary' ? '交付摘要' : '任务取消';
  const body = bodyEnvelope(marker, title, taskId, options.agent, options.body);
  return [{ marker, body, content: options.body, part: 1, total: 1 }];
}

function markerPrefix(taskId: string, options: SyncOptions): string {
  if (options.kind === 'task') return `<!-- sync-issue:${taskId}:task`;
  if (options.kind === 'summary') return `<!-- sync-issue:${taskId}:summary`;
  if (options.kind === 'cancel') return `<!-- sync-issue:${taskId}:cancel`;
  const stem = path.basename(options.artifact || '', '.md');
  return `<!-- sync-issue:${taskId}:${stem}`;
}

function relatedComments(comments: RemoteComment[], prefix: string): RemoteComment[] {
  const base = `${prefix} -->`;
  const chunkNamespace = `${prefix}:`;
  return comments.filter((comment) => {
    const first = normalizeCommentContent(comment.body).split('\n', 1)[0] || '';
    return first === base || (first.startsWith(chunkNamespace) && first.endsWith(' -->'));
  });
}

function validateRelatedMarkerSet(comments: RemoteComment[], prefix: string): { ok: boolean; code: string | null } {
  const markers = comments.map((comment) => normalizeCommentContent(comment.body).split('\n', 1)[0] || '');
  if (new Set(markers).size !== markers.length) return { ok: false, code: 'COMMENT_MARKER_CONFLICT' };
  const base = `${prefix} -->`;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const chunkPattern = new RegExp(`^${escaped}:(\\d+)\\/(\\d+) -->$`);
  const hasBase = markers.includes(base);
  const chunks = markers.map((marker) => marker.match(chunkPattern)).filter((match): match is RegExpMatchArray => Boolean(match));
  if (markers.some((marker) => marker !== base && !chunkPattern.test(marker))) return { ok: false, code: 'COMMENT_MARKER_CONFLICT' };
  if (hasBase && chunks.length > 0) return { ok: false, code: 'COMMENT_MARKER_CONFLICT' };
  if (chunks.length === 0) return { ok: true, code: null };
  const totals = new Set(chunks.map((match) => Number(match[2])));
  if (totals.size !== 1) return { ok: false, code: 'COMMENT_MARKER_CONFLICT' };
  const total = Number(chunks[0]![2]);
  const parts = chunks.map((match) => Number(match[1])).sort((left, right) => left - right);
  const complete = total > 0 && parts.length === total && parts.every((part, index) => part === index + 1);
  return complete ? { ok: true, code: null } : { ok: false, code: 'COMMENT_MARKER_CONFLICT' };
}

function writeComment(
  client: GitHubClient,
  repo: string,
  issue: number,
  cwd: string,
  body: string,
  id?: number
) {
  const endpoint = id ? `repos/${repo}/issues/comments/${id}` : `repos/${repo}/issues/${issue}/comments`;
  return client.json<{ id?: number }>(
    ['api', endpoint, '-X', id ? 'PATCH' : 'POST', '--input', '-'],
    { cwd, method: id ? 'PATCH' : 'POST', input: JSON.stringify({ body }) }
  );
}

function syncPlatformComment(taskRef: string, options: SyncOptions): PlatformResult {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) {
    return platformResult('failed', {
      error: { code: resolved.code, message: resolved.message, retryable: false }
    });
  }
  const taskContent = fs.readFileSync(resolved.taskMdPath, 'utf8');
  const issue = issueNumberFromTask(taskContent);
  if (!issue) {
    return platformResult('no-op', {
      error: { code: 'ISSUE_NOT_LINKED', message: 'Task has no valid issue_number', retryable: false }
    });
  }
  const context = resolvePlatformContext({ cwd: resolved.repoRoot, client: options.client });
  if (!hasResolvedPlatformContext(context)) return context;
  const client = options.client || createGitHubClient();
  const listed = listRemoteComments(client, context.platform.repository!, issue, resolved.repoRoot);
  if (!listed.ok) {
    return platformResult(listed.error.retryable ? 'blocked' : 'failed', {
      ...contextFields(context), resource: { kind: 'issue', number: issue }, error: listed.error
    });
  }

  let desired: RenderedChunk[];
  try {
    desired = expectedComments(resolved.taskId, taskContent, resolved.taskDir, options);
  } catch (error) {
    return platformResult('failed', {
      ...contextFields(context),
      resource: { kind: 'issue', number: issue },
      error: { code: 'COMMENT_PAYLOAD_INVALID', message: error instanceof Error ? error.message : String(error), retryable: false }
    });
  }
  const existing = relatedComments(listed.value, markerPrefix(resolved.taskId, options));
  if (!validateRelatedMarkerSet(existing, markerPrefix(resolved.taskId, options)).ok) {
    return platformResult('failed', {
      ...contextFields(context),
      resource: { kind: 'issue', number: issue },
      error: { code: 'COMMENT_MARKER_CONFLICT', message: 'Multiple comments use the same registered marker', retryable: false }
    });
  }

  // Backfill only supplies missing artifact comments; valid existing marker sets stay untouched.
  if (options.kind === 'artifact' && options.backfill && existing.length > 0) {
    const operations = existing.map((comment): PlatformOperation => ({
      name: `comment:${normalizeCommentContent(comment.body).split('\n', 1)[0]}`,
      status: 'no-op',
      reasonCode: 'BACKFILL_ALREADY_PRESENT'
    }));
    return platformResult('no-op', {
      ...contextFields(context),
      changed: false,
      resource: { kind: 'issue', number: issue },
      operations,
      comment: {
        kind: options.kind,
        marker: desired[0]!.marker,
        ids: existing.map((comment) => comment.id),
        parts: existing.length
      },
      error: null
    });
  }

  const repo = context.platform.repository!;
  const operations: PlatformOperation[] = [];
  const ids: number[] = [];
  for (const item of desired) {
    const current = existing.find((comment) => normalizeCommentContent(comment.body).split('\n', 1)[0] === item.marker);
    if (current && normalizeCommentContent(current.body) === normalizeCommentContent(item.body)) {
      ids.push(current.id);
      operations.push({ name: `comment:${item.marker}`, status: 'no-op', reasonCode: null });
      continue;
    }
    const written = writeComment(client, repo, issue, resolved.repoRoot, item.body, current?.id);
    if (!written.ok) {
      if (!current && written.error.retryable) {
        const reconciled = listRemoteComments(client, repo, issue, resolved.repoRoot);
        const found = reconciled.ok ? findMarkerComments(reconciled.value, item.marker) : [];
        if (found.length === 1) {
          ids.push(found[0]!.id);
          operations.push({ name: `comment:${item.marker}`, status: 'applied', reasonCode: 'CREATE_RECONCILED' });
          continue;
        }
      }
      return platformResult(written.error.retryable ? 'blocked' : 'failed', {
        ...contextFields(context),
        resource: { kind: 'issue', number: issue },
        operations,
        error: written.error
      });
    }
    ids.push(current?.id || written.value.id || 0);
    operations.push({ name: `comment:${item.marker}`, status: 'applied', reasonCode: null });
  }

  const desiredMarkers = new Set(desired.map((item) => item.marker));
  const stale = existing.filter((comment) => !desiredMarkers.has(normalizeCommentContent(comment.body).split('\n', 1)[0]!));
  for (const comment of stale) {
    const deleted = client.text(['api', `repos/${repo}/issues/comments/${comment.id}`, '-X', 'DELETE'], {
      cwd: resolved.repoRoot, method: 'DELETE'
    });
    if (!deleted.ok) {
      return platformResult(deleted.error.retryable ? 'blocked' : 'failed', {
        ...contextFields(context),
        resource: { kind: 'issue', number: issue },
        operations,
        error: deleted.error
      });
    }
    operations.push({ name: `comment:${comment.id}`, status: 'applied', reasonCode: 'STALE_CHUNK_DELETED' });
  }
  const changed = operations.some((operation) => operation.status === 'applied');
  return platformResult(changed ? 'applied' : 'no-op', {
    ...contextFields(context),
    changed,
    resource: { kind: 'issue', number: issue },
    operations,
    comment: { kind: options.kind, marker: desired[0]!.marker, ids, parts: desired.length },
    error: null
  });
}

function listPlatformComments(issue: number, cwd = process.cwd(), client: GitHubClient = createGitHubClient()): PlatformResult & { comments?: RemoteComment[] } {
  const context = resolvePlatformContext({ cwd, client });
  if (!hasResolvedPlatformContext(context)) return context;
  const result = listRemoteComments(client, context.platform.repository!, issue, cwd);
  if (!result.ok) {
    return platformResult(result.error.retryable ? 'blocked' : 'failed', {
      ...contextFields(context), resource: { kind: 'issue', number: issue }, error: result.error
    });
  }
  return { ...platformResult('no-op', { ...contextFields(context), resource: { kind: 'issue', number: issue }, error: null }), comments: result.value };
}

function checkPlatformCommentOwner(taskRef: string, options: { cwd?: string; client?: GitHubClient } = {}): PlatformResult {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return platformResult('failed', { error: { code: resolved.code, message: resolved.message, retryable: false } });
  const content = fs.readFileSync(resolved.taskMdPath, 'utf8');
  const issue = issueNumberFromTask(content);
  if (!issue) return platformResult('no-op', { error: { code: 'ISSUE_NOT_LINKED', message: 'Task has no valid issue_number', retryable: false } });
  const client = options.client || createGitHubClient();
  const context = resolvePlatformContext({ cwd: resolved.repoRoot, client });
  if (!hasResolvedPlatformContext(context)) return context;
  const listed = listRemoteComments(client, context.platform.repository!, issue, resolved.repoRoot);
  if (!listed.ok) return platformResult(listed.error.retryable ? 'blocked' : 'failed', { ...contextFields(context), error: listed.error });
  const matches = findMarkerComments(listed.value, MARKERS.task(resolved.taskId));
  if (matches.length > 1) return platformResult('failed', { ...contextFields(context), error: { code: 'COMMENT_MARKER_CONFLICT', message: 'Multiple task comments use the registered marker', retryable: false } });
  const owner = matches[0]?.user?.login;
  if (owner && owner !== context.platform.currentUser && !context.capabilities.triage) {
    return platformResult('blocked', {
      ...contextFields(context),
      resource: { kind: 'issue', number: issue },
      error: { code: 'COMMENT_OWNER_CONFLICT', message: `Task comment is owned by '${owner}'`, retryable: false }
    });
  }
  return platformResult('no-op', { ...contextFields(context), resource: { kind: 'issue', number: issue }, error: null });
}

export {
  MARKERS,
  chunkArtifactComment,
  findMarkerComments,
  listRemoteComments,
  checkPlatformCommentOwner,
  listPlatformComments,
  normalizeCommentContent,
  renderTaskComment,
  syncPlatformComment,
  validateRelatedMarkerSet,
  writeComment
};
export type { CommentKind, RemoteComment, RenderedChunk, SyncOptions };
