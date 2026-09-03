import fs from 'node:fs';
import path from 'node:path';

import { parseTaskFrontmatter } from '../task/frontmatter.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { resolvePlatformProviderContext } from './context.ts';
import type { PlatformClient } from './context.ts';
import { platformResult } from './types.ts';
import type { PlatformOperation, PlatformResult } from './types.ts';
import {
  providerError,
  providerOperationContext,
  providerStatus,
  providerResourceToken,
  unsupportedProviderOperation
} from './provider-bridge.ts';
import { resourceIdentityNumber } from './resource-identity.ts';
import { taskIssueIdentity } from './task-identities.ts';

type RemoteComment = { id: number | string; body: string; user?: { login?: string } };
type RenderedChunk = { marker: string; body: string; content: string; part: number; total: number };
type CommentKind = 'task' | 'artifact' | 'summary' | 'cancel';
type SyncOptions = {
  kind: CommentKind;
  agent: string;
  artifact?: string;
  body?: string;
  cwd?: string;
  backfill?: boolean;
  client?: PlatformClient;
};

function providerCommentId(id: string, provider: { identity?: { comment?: string } }): number | string {
  return provider.identity?.comment === 'number' && /^\d+$/.test(id) ? Number(id) : id;
}

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
  'validation-run': '验证运行证据',
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
  const match = stem.match(/^(analysis|review-analysis|plan|review-plan|code|review-code|manual-validation|validation-run|pr-review)(?:-r(\d+))?$/);
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
    Boolean(entry && typeof entry === 'object' && (typeof entry.id === 'number' || typeof entry.id === 'string') && typeof entry.body === 'string')
  );
}

function issueNumberFromTask(content: string): number | null {
  const value = parseTaskFrontmatter(content).issue_number;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function listRemoteComments(client: PlatformClient, repo: string, issue: number, cwd: string) {
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
  client: PlatformClient,
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

async function syncPlatformComment(taskRef: string, options: SyncOptions): Promise<PlatformResult> {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) {
    return platformResult('failed', {
      error: { code: resolved.code, message: resolved.message, retryable: false }
    });
  }
  const taskContent = fs.readFileSync(resolved.taskMdPath, 'utf8');
  const issueIdentityFromTask = taskIssueIdentity(parseTaskFrontmatter(taskContent));
  if (!issueIdentityFromTask) {
    return platformResult('no-op', {
      error: { code: 'ISSUE_NOT_LINKED', message: 'Task has no valid issue_number', retryable: false }
    });
  }
  const loaded = await resolvePlatformProviderContext({ cwd: resolved.repoRoot, client: options.client });
  const context = loaded.ok ? loaded.value.context : loaded.context;
  if (!hasResolvedPlatformContext(context) || !loaded.ok) return context;
  const issue = resourceIdentityNumber(issueIdentityFromTask);
  const listed = loaded.value.provider.comments?.list
      ? await loaded.value.provider.comments.list({
        context: providerOperationContext(loaded.value),
        parent: issueIdentityFromTask
      }).then((response) => response.ok
        ? { ok: true as const, value: response.value.map((comment) => ({
          id: providerCommentId(comment.id, loaded.value.provider),
          body: comment.body,
          user: comment.author?.name ? { login: comment.author.name } : undefined
        })) }
        : response)
      : unsupportedProviderOperation(loaded.value.provider, 'comments.list');
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

  const operations: PlatformOperation[] = [];
  const ids: Array<number | string> = [];
  for (const item of desired) {
    const current = existing.find((comment) => normalizeCommentContent(comment.body).split('\n', 1)[0] === item.marker);
    if (current && normalizeCommentContent(current.body) === normalizeCommentContent(item.body)) {
      ids.push(current.id);
      operations.push({ name: `comment:${item.marker}`, status: 'no-op', reasonCode: null });
      continue;
    }
    const written = loaded.value.provider.comments?.write
        ? await loaded.value.provider.comments.write({
          context: providerOperationContext(loaded.value),
          parent: issueIdentityFromTask,
          body: item.body,
          ...(current ? { existingComment: { kind: 'id' as const, value: String(current.id) } } : {}),
          mutation: { idempotencyKey: `comment:${resolved.taskId}:${item.marker}` }
        })
        : unsupportedProviderOperation(loaded.value.provider, 'comments.write');
    if (!written.ok) {
      if (!current && written.error.retryable) {
        // A provider owns reconciliation because only it knows how to address the resource.
      }
      return platformResult(written.error.retryable ? 'blocked' : 'failed', {
        ...contextFields(context),
        resource: { kind: 'issue', number: issue },
        operations,
        error: written.error
      });
    }
    ids.push(providerCommentId((written.value as { remoteId: string }).remoteId, loaded.value.provider));
    operations.push({ name: `comment:${item.marker}`, status: 'applied', reasonCode: null });
  }

  const desiredMarkers = new Set(desired.map((item) => item.marker));
  const stale = existing.filter((comment) => !desiredMarkers.has(normalizeCommentContent(comment.body).split('\n', 1)[0]!));
  for (const comment of stale) {
    const deleted = loaded.value.provider.comments?.delete
        ? await loaded.value.provider.comments.delete({
          context: providerOperationContext(loaded.value),
          parent: issueIdentityFromTask,
          comment: { kind: 'id', value: String(comment.id) },
          mutation: { idempotencyKey: `comment-delete:${resolved.taskId}:${comment.id}` }
        })
        : unsupportedProviderOperation(loaded.value.provider, 'comments.delete');
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

async function listPlatformComments(issue: string | number, cwd = process.cwd(), client?: PlatformClient): Promise<PlatformResult & { comments?: RemoteComment[] }> {
  const loaded = await resolvePlatformProviderContext({ cwd, client });
  const context = loaded.ok ? loaded.value.context : loaded.context;
  if (!hasResolvedPlatformContext(context) || !loaded.ok) return context;
  let identity;
  try { identity = loaded.ok ? providerResourceToken(loaded.value.provider, 'issue', String(issue)) : null; }
  catch (error) {
    return platformResult('failed', { ...contextFields(context), error: { code: 'PLATFORM_IDENTITY_TOKEN_INVALID', message: error instanceof Error ? error.message : String(error), retryable: false } });
  }
  if (!loaded.ok || !identity) return context;
  const listed = loaded.value.provider.comments?.list
      ? await loaded.value.provider.comments.list({ context: providerOperationContext(loaded.value), parent: identity }).then((response) => response.ok
        ? { ok: true as const, value: response.value.map((comment) => ({ id: comment.id, body: comment.body, user: comment.author?.name ? { login: comment.author.name } : undefined })) }
        : response)
      : unsupportedProviderOperation(loaded.value.provider, 'comments.list');
  if (!listed.ok) {
    return platformResult(providerStatus(listed.error), {
      ...contextFields(context), resource: { kind: 'issue', number: resourceIdentityNumber(identity), identity }, error: providerError(listed.error, 'PLATFORM_PROVIDER_OPERATION_FAILED')
    });
  }
  return { ...platformResult('no-op', { ...contextFields(context), resource: { kind: 'issue', number: resourceIdentityNumber(identity), identity }, error: null }), comments: listed.value };
}

async function checkPlatformCommentOwner(taskRef: string, options: { cwd?: string; client?: PlatformClient } = {}): Promise<PlatformResult> {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return platformResult('failed', { error: { code: resolved.code, message: resolved.message, retryable: false } });
  const content = fs.readFileSync(resolved.taskMdPath, 'utf8');
  const issueIdentity = taskIssueIdentity(parseTaskFrontmatter(content));
  if (!issueIdentity) return platformResult('no-op', { error: { code: 'ISSUE_NOT_LINKED', message: 'Task has no valid platform issue identity', retryable: false } });
  const loaded = await resolvePlatformProviderContext({ cwd: resolved.repoRoot, client: options.client });
  const context = loaded.ok ? loaded.value.context : loaded.context;
  if (!hasResolvedPlatformContext(context) || !loaded.ok) return context;
  const listed = loaded.value.provider.comments?.list
      ? await loaded.value.provider.comments.list({ context: providerOperationContext(loaded.value), parent: issueIdentity }).then((response) => response.ok
        ? { ok: true as const, value: response.value.map((comment) => ({ id: comment.id, body: comment.body, user: comment.author?.name ? { login: comment.author.name } : undefined })) }
        : response)
      : unsupportedProviderOperation(loaded.value.provider, 'comments.list');
  if (!listed.ok) return platformResult(listed.error.retryable ? 'blocked' : 'failed', { ...contextFields(context), error: listed.error });
  const matches = findMarkerComments(listed.value, MARKERS.task(resolved.taskId));
  if (matches.length > 1) return platformResult('failed', { ...contextFields(context), error: { code: 'COMMENT_MARKER_CONFLICT', message: 'Multiple task comments use the registered marker', retryable: false } });
  const owner = matches[0]?.user?.login;
  if (owner && owner !== context.platform.currentUser && !context.capabilities.triage) {
    return platformResult('blocked', {
      ...contextFields(context),
      resource: { kind: 'issue', number: resourceIdentityNumber(issueIdentity), identity: issueIdentity },
      error: { code: 'COMMENT_OWNER_CONFLICT', message: `Task comment is owned by '${owner}'`, retryable: false }
    });
  }
  return platformResult('no-op', { ...contextFields(context), resource: { kind: 'issue', number: resourceIdentityNumber(issueIdentity), identity: issueIdentity }, error: null });
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
