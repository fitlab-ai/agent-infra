import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

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
import { taskIssueIdentity, taskIssueIdentityError } from './task-identities.ts';
import {
  recordForArtifact,
  recordForCancel,
  recordForSummary,
  recordForTask,
  renderActivityRecoveryMetadata
} from './activity-recovery.ts';
import { projectTaskComment } from './task-comment-projection.ts';
import {
  canonicalizeCommentBody,
  escapeHtmlText,
  fenceRanges,
  renderSafeCodeFence
} from './comment-safety.ts';
import type { FenceRange } from './comment-safety.ts';

type RemoteComment = {
  id: number | string;
  body: string;
  user?: { login?: string };
  createdSequence?: number | null;
};
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
  runtimeVersion?: string;
  summaryAuthorization?: { sha256: string };
  verifyOnly?: boolean;
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
  cancel: (taskId: string) => `<!-- sync-issue:${taskId}:cancel -->`,
};
const COMMENT_BYTE_LIMIT = 60_000;

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

function sanitizeCommentBody(value: string, label: string): string {
  const result = canonicalizeCommentBody(value);
  if (!result.ok) throw new Error(`${result.error.code}: ${label}: ${result.error.message} at offset ${result.error.offset}`);
  return result.value;
}

function footer(agent: string, taskId: string): string {
  return `---\n*由 ${agent} 自动生成 · 内部追踪：${taskId}*`;
}

function taskFrontmatterSummary(language = ''): string {
  return language === 'en' || language === 'en-US'
    ? 'Metadata (frontmatter)'
    : '元数据 (frontmatter)';
}

function renderTaskCommentResult(content: string, taskId: string, language = ''): { body: string; byteLength: number; sha256: string } {
  const split = splitFrontmatter(content);
  const projectedContent = split.frontmatter === null ? content : projectTaskComment(content).content;
  const projected = splitFrontmatter(projectedContent);
  const safeBody = sanitizeCommentBody(projected.body, 'task body');
  const taskBody = projected.frontmatter === null
    ? safeBody
    : `<details><summary>${taskFrontmatterSummary(language)}</summary>\n\n${renderSafeCodeFence(`---\n${projected.frontmatter}\n---`, 'yaml')}\n\n</details>\n\n${safeBody}`;
  const recoveryMetadata = renderActivityRecoveryMetadata(recordForTask(taskId, content));
  const body = normalizeCommentContent([
    MARKERS.task(taskId),
    '## 任务文件',
    '',
    `> 任务同步 · ${taskId}`,
    '',
    ...(recoveryMetadata ? [recoveryMetadata.replace(/\n+$/, ''), ''] : []),
    taskBody.replace(/\n+$/, ''),
    '',
    '---',
    `*由 agent-infra 自动生成 · 内部追踪：${taskId}*`
  ].join('\n'));
  return {
    body,
    byteLength: Buffer.byteLength(body, 'utf8'),
    sha256: createHash('sha256').update(body, 'utf8').digest('hex')
  };
}

function renderTaskComment(content: string, taskId: string, _agent: string, language = ''): string {
  return renderTaskCommentResult(content, taskId, language).body;
}

function isTaskCommentTooLarge(content: string, taskId = 'TASK-UNKNOWN', _agent = 'codex'): boolean {
  return renderTaskCommentResult(content, taskId).byteLength > COMMENT_BYTE_LIMIT;
}

function taskCommentLanguage(repoRoot: string): string {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(repoRoot, '.agents', '.airc.json'), 'utf8')) as { language?: unknown };
    return typeof config.language === 'string' ? config.language.trim() : '';
  } catch {
    return '';
  }
}

function artifactIdentity(artifact: string): { stem: string; title: string } {
  const stem = path.basename(artifact, '.md');
  const match = stem.match(/^(analysis|review-analysis|plan|review-plan|code|review-code|manual-validation|validation-run|pr-review)(?:-r(\d+))?$/);
  if (!match) throw new Error(`unsupported artifact '${artifact}'`);
  const base = ARTIFACT_TITLES[match[1]!]!;
  const round = match[2] ? Number(match[2]) : 1;
  return { stem, title: `${base}（Round ${round}）` };
}

type SourceChunk = { content: string; start: number; end: number };

function chunkByUtf8(content: string, maxBytes: number): SourceChunk[] {
  if (maxBytes <= 0) throw new Error('comment byte limit is too small');
  const chunks: SourceChunk[] = [];
  let start = 0;
  while (start < content.length) {
    const remaining = content.slice(start);
    if (Buffer.byteLength(remaining, 'utf8') <= maxBytes) {
      chunks.push({ content: remaining, start, end: content.length });
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
    chunks.push({ content: remaining.slice(0, cut), start, end: start + cut });
    start += cut;
  }
  return chunks.length > 0 ? chunks : [{ content: '', start: 0, end: 0 }];
}

function longestFenceLineRun(content: string, character: '`' | '~'): number {
  const pattern = new RegExp(`^ {0,3}(${character}+)[ \\t]*(?:\\n|$)`, 'gm');
  let longest = 0;
  for (const match of content.matchAll(pattern)) longest = Math.max(longest, match[1]!.length);
  return longest;
}

function boundedFence(content: string, sourceCharacter: '`' | '~', maxBytes: number): { opening: string; closing: string } | null {
  const candidates: Array<'`' | '~'> = sourceCharacter === '`' ? ['~', '`'] : ['`', '~'];
  for (const character of candidates) {
    const length = Math.max(3, longestFenceLineRun(content, character) + 1);
    const delimiter = character.repeat(length);
    if (Buffer.byteLength(delimiter, 'utf8') * 2 + 2 <= maxBytes) return { opening: `${delimiter}\n`, closing: `${delimiter}\n` };
  }
  return null;
}

function sourceSlice(piece: SourceChunk, start: number, end: number): string {
  return piece.content.slice(Math.max(0, start - piece.start), Math.max(0, end - piece.start));
}

function renderOversizedFenceChunk(piece: SourceChunk, fences: readonly FenceRange[], maxBytes: number): string {
  const insertions = new Map<number, Array<{ value: string; ensureLineStart: boolean }>>();
  const omitted: Array<{ start: number; end: number }> = [];
  const insert = (position: number, value: string, ensureLineStart = false) => {
    const values = insertions.get(position) || [];
    values.push({ value, ensureLineStart });
    insertions.set(position, values);
  };

  for (const fence of fences) {
    if (piece.end <= fence.start || piece.start >= fence.end) continue;
    const oversized = Buffer.byteLength(fence.opening, 'utf8') > maxBytes
      || Buffer.byteLength(fence.closing, 'utf8') > maxBytes;
    if (!oversized) {
      if (piece.start > fence.start && piece.start < fence.end) insert(piece.start, fence.opening);
      if (piece.end > fence.start && piece.end < fence.end) insert(piece.end, fence.closing, true);
      continue;
    }

    const code = sourceSlice(piece, Math.max(piece.start, fence.openingEnd), Math.min(piece.end, fence.closingStart));
    const delimiter = boundedFence(code, fence.character, maxBytes);
    if (!delimiter) return escapeHtmlText(piece.content);
    insert(Math.max(piece.start, fence.start), delimiter.opening);
    insert(Math.min(piece.end, fence.end), delimiter.closing, true);
    const openingStart = Math.max(piece.start, fence.start);
    const openingEnd = Math.min(piece.end, fence.openingEnd);
    if (openingStart < openingEnd) omitted.push({ start: openingStart, end: openingEnd });
    const closingStart = Math.max(piece.start, fence.closingStart);
    const closingEnd = Math.min(piece.end, fence.end);
    if (closingStart < closingEnd) omitted.push({ start: closingStart, end: closingEnd });
  }

  const boundaries = new Set<number>([piece.start, piece.end]);
  for (const position of insertions.keys()) boundaries.add(position);
  for (const range of omitted) {
    boundaries.add(range.start);
    boundaries.add(range.end);
  }
  const points = [...boundaries].sort((left, right) => left - right);
  let content = '';
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    for (const insertion of insertions.get(point) || []) {
      if (insertion.ensureLineStart && content.length > 0 && !content.endsWith('\n')) content += '\n';
      content += insertion.value;
    }
    const next = points[index + 1];
    if (next === undefined) continue;
    const skipped = omitted.some((range) => range.start <= point && next <= range.end);
    if (!skipped) content += sourceSlice(piece, point, next);
  }
  return content;
}

function independentChunkContent(piece: SourceChunk, fences: readonly FenceRange[], maxBytes: number): string {
  const oversizedFence = fences.some((fence) =>
    piece.end > fence.start && piece.start < fence.end
    && (Buffer.byteLength(fence.opening, 'utf8') > maxBytes || Buffer.byteLength(fence.closing, 'utf8') > maxBytes)
  );
  if (oversizedFence) return renderOversizedFenceChunk(piece, fences, maxBytes);
  const openingFence = fences.find((fence) => piece.start > fence.start && piece.start < fence.end);
  const closingFence = fences.find((fence) => piece.end > fence.start && piece.end < fence.end);
  let content = piece.content;
  if (openingFence) content = openingFence.opening + content;
  if (closingFence) {
    if (!content.endsWith('\n')) content += '\n';
    content += closingFence.closing;
  }
  return content;
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
  backfill: boolean,
  renderedContent = content,
  recoveryMetadata = ''
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
    ...(recoveryMetadata ? [recoveryMetadata] : []),
    renderedContent,
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
  recoveryMetadata?: string;
}): RenderedChunk[] {
  const byteLimit = input.byteLimit || COMMENT_BYTE_LIMIT;
  const identity = artifactIdentity(input.artifact);
  const safeBody = sanitizeCommentBody(input.body, 'artifact body');
  const single = buildArtifactChunk(
    input.taskId, identity.stem, identity.title, input.agent, safeBody, 1, 1, false, Boolean(input.backfill), safeBody, input.recoveryMetadata
  );
  if (Buffer.byteLength(single.body, 'utf8') <= byteLimit) return [single];

  let total = 2;
  let payloadLimit = Number.POSITIVE_INFINITY;
  const ranges = fenceRanges(safeBody);
  if (!ranges.ok) throw new Error(`${ranges.error.code}: artifact body: ${ranges.error.message} at offset ${ranges.error.offset}`);
  for (;;) {
    const probe = buildArtifactChunk(
      input.taskId, identity.stem, identity.title, input.agent, '', 1, total, true, Boolean(input.backfill), '', input.recoveryMetadata
    );
    const available = byteLimit - Buffer.byteLength(probe.body, 'utf8');
    const sourceLimit = Math.min(available, payloadLimit);
    if (sourceLimit <= 0) throw new Error('comment byte limit is too small for an artifact chunk');
    const pieces = chunkByUtf8(safeBody, sourceLimit);
    if (pieces.length !== total) {
      total = pieces.length;
      continue;
    }
    const chunks = pieces.map((piece, index) => buildArtifactChunk(
      input.taskId,
      identity.stem,
      identity.title,
      input.agent,
      piece.content,
      index + 1,
      total,
      true,
      Boolean(input.backfill),
      independentChunkContent(piece, ranges.value, sourceLimit),
      index === 0 ? input.recoveryMetadata : ''
    ));
    const overflow = Math.max(...chunks.map((chunk) => Buffer.byteLength(chunk.body, 'utf8') - byteLimit));
    if (overflow <= 0) return chunks;
    payloadLimit = sourceLimit - overflow;
  }
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

function bodyEnvelope(marker: string, title: string, taskId: string, agent: string, body: string, recoveryMetadata = ''): string {
  return normalizeCommentContent([
    marker, `## ${title}`, '', `> **${agent}** · ${taskId}`, '',
    ...(recoveryMetadata ? [recoveryMetadata.replace(/\n+$/, ''), ''] : []),
    sanitizeCommentBody(body, `${title} body`).replace(/\n+$/, ''), '', footer(agent, taskId)
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
  repoRoot: string,
  options: SyncOptions
): RenderedChunk[] {
  if (options.kind === 'task') {
    const body = renderTaskComment(taskContent, taskId, options.agent, taskCommentLanguage(repoRoot));
    return [{ marker: MARKERS.task(taskId), body, content: taskContent, part: 1, total: 1 }];
  }
  if (options.kind === 'artifact') {
    if (!options.artifact) throw new Error('artifact sync requires an artifact filename');
    return chunkArtifactComment({
      taskId,
      artifact: options.artifact,
      agent: options.agent,
      body: resolveArtifactBody(taskDir, options.artifact),
      backfill: options.backfill,
      recoveryMetadata: renderActivityRecoveryMetadata(recordForArtifact(taskId, taskContent, options.artifact))
    });
  }
  if (options.body === undefined) throw new Error(`${options.kind} sync requires a body`);
  const marker = options.kind === 'summary' ? MARKERS.summary(taskId) : MARKERS.cancel(taskId);
  const title = options.kind === 'summary' ? '交付摘要' : '任务取消';
  const recoveryMetadata = options.kind === 'summary'
    ? renderActivityRecoveryMetadata(recordForSummary(taskId, taskContent))
    : renderActivityRecoveryMetadata(recordForCancel(taskId, taskContent));
  const body = bodyEnvelope(marker, title, taskId, options.agent, options.body, recoveryMetadata);
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

function taskManagedComment(comment: RemoteComment, taskId: string): boolean {
  const marker = normalizeCommentContent(comment.body).split('\n', 1)[0] || '';
  return marker === MARKERS.task(taskId)
    || marker === MARKERS.summary(taskId)
    || marker.startsWith(`<!-- sync-issue:${taskId}:`);
}

function summaryPosition(comments: RemoteComment[], taskId: string): { ok: boolean; known: boolean; summary: RemoteComment | null } {
  const managed = comments.filter((comment) => taskManagedComment(comment, taskId));
  const summary = managed.filter((comment) => normalizeCommentContent(comment.body).split('\n', 1)[0] === MARKERS.summary(taskId));
  if (summary.length !== 1) return { ok: false, known: false, summary: null };
  if (managed.some((comment) => !Number.isSafeInteger(comment.createdSequence) || Number(comment.createdSequence) < 1)) {
    return { ok: false, known: false, summary: summary[0]! };
  }
  const sequence = summary[0]!.createdSequence!;
  return { ok: managed.every((comment) => sequence >= comment.createdSequence!), known: true, summary: summary[0]! };
}

function summaryDigest(comment: RemoteComment): string {
  const body = normalizeCommentContent(comment.body)
    .replace(/^<!-- sync-issue:[^\n]+:summary -->\n## [^\n]+\n\n> [^\n]+\n\n/u, '')
    .replace(/^<details><summary>恢复元数据<\/summary>[\s\S]*?<\/details>\n\n/u, '')
    .replace(/\n---\n\*[^\n]*\*$/u, '');
  return createHash('sha256').update(body).digest('hex');
}

async function listedComments(provider: any, loaded: any, parent: ReturnType<typeof taskIssueIdentity>): Promise<any> {
  return provider.comments?.list
    ? provider.comments.list({ context: providerOperationContext(loaded), parent }).then((response: any) => response.ok
      ? {
          ok: true as const,
          value: response.value.map((comment: any) => ({
            id: providerCommentId(comment.id, provider),
            body: comment.body,
            user: comment.author?.name ? { login: comment.author.name } : undefined,
            createdSequence: comment.createdSequence
          }))
        }
      : response)
    : unsupportedProviderOperation(provider, 'comments.list');
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
  let issueIdentityFromTask: ReturnType<typeof taskIssueIdentity>;
  try { issueIdentityFromTask = taskIssueIdentity(parseTaskFrontmatter(taskContent)); }
  catch (error) { return platformResult('failed', { error: { ...taskIssueIdentityError(error), retryable: false } }); }
  if (!issueIdentityFromTask) {
    return platformResult('no-op', {
      error: { code: 'ISSUE_NOT_LINKED', message: 'Task has no valid platform issue identity', retryable: false }
    });
  }
  let desired: RenderedChunk[];
  try {
    desired = expectedComments(resolved.taskId, taskContent, resolved.taskDir, resolved.repoRoot, options);
  } catch (error) {
    return platformResult('failed', {
      resource: { kind: 'issue', number: resourceIdentityNumber(issueIdentityFromTask) },
      error: { code: 'COMMENT_PAYLOAD_INVALID', message: error instanceof Error ? error.message : String(error), retryable: false }
    });
  }
  if (options.kind === 'task' && Buffer.byteLength(desired[0]!.body, 'utf8') > COMMENT_BYTE_LIMIT) {
    return platformResult('failed', {
      resource: { kind: 'issue', number: resourceIdentityNumber(issueIdentityFromTask), identity: issueIdentityFromTask },
      operations: [{ name: `comment:${MARKERS.task(resolved.taskId)}`, status: 'skipped', reasonCode: 'COMMENT_PAYLOAD_TOO_LARGE' }],
      error: { code: 'COMMENT_PAYLOAD_TOO_LARGE', message: 'Projected task comment exceeds the platform byte limit', retryable: false }
    });
  }
  const loaded = await resolvePlatformProviderContext({ cwd: resolved.repoRoot, client: options.client });
  const context = loaded.ok ? loaded.value.context : loaded.context;
  if (!hasResolvedPlatformContext(context) || !loaded.ok) return context;
  const issue = resourceIdentityNumber(issueIdentityFromTask);
  const listed = await listedComments(loaded.value.provider, loaded.value, issueIdentityFromTask);
  if (!listed.ok) {
    return platformResult(listed.error.retryable ? 'blocked' : 'failed', {
      ...contextFields(context), resource: { kind: 'issue', number: issue }, error: listed.error
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

  if (options.kind === 'task' && existing.length === 1) {
    const owner = existing[0]!.user?.login;
    if (!owner || !context.platform.currentUser || owner !== context.platform.currentUser) {
      return platformResult('blocked', {
        ...contextFields(context),
        resource: { kind: 'issue', number: issue, identity: issueIdentityFromTask },
        error: {
          code: 'COMMENT_OWNER_CONFLICT',
          message: owner ? `Task comment is owned by '${owner}'` : 'Task comment owner is unavailable',
          retryable: false
        }
      });
    }
  }

  if (options.verifyOnly) {
    if (options.kind !== 'summary' || !options.summaryAuthorization) {
      return platformResult('failed', {
        ...contextFields(context), resource: { kind: 'issue', number: issue },
        error: { code: 'SUMMARY_VERIFICATION_INVALID', message: 'summary verification requires durable authorization', retryable: false }
      });
    }
    const position = summaryPosition(listed.value, resolved.taskId);
    if (!position.ok || !position.summary || summaryDigest(position.summary) !== options.summaryAuthorization.sha256) {
      return platformResult('failed', {
        ...contextFields(context), resource: { kind: 'issue', number: issue },
        error: { code: 'SUMMARY_VERIFICATION_FAILED', message: 'summary marker, body digest, or managed comment order is invalid', retryable: true }
      });
    }
    return platformResult('no-op', {
      ...contextFields(context), changed: false, resource: { kind: 'issue', number: issue },
      comment: { kind: options.kind, marker: desired[0]!.marker, ids: [position.summary.id], parts: 1 }, error: null
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
  if (options.kind === 'summary') {
    const refreshed = await listedComments(loaded.value.provider, loaded.value, issueIdentityFromTask);
    if (!refreshed.ok) {
      return platformResult(refreshed.error.retryable ? 'blocked' : 'failed', {
        ...contextFields(context), resource: { kind: 'issue', number: issue }, operations, error: refreshed.error
      });
    }
    const position = summaryPosition(refreshed.value, resolved.taskId);
    if (!position.ok && !position.known) {
      return platformResult('blocked', {
        ...contextFields(context), resource: { kind: 'issue', number: issue }, operations,
        error: { code: 'SUMMARY_POSITION_UNVERIFIED', message: 'Summary comment ordering cannot be proven from the provider snapshot', retryable: true }
      });
    }
    if (!position.ok && position.summary) {
      const owner = position.summary.user?.login;
      if (!options.summaryAuthorization || options.summaryAuthorization.sha256 !== createHash('sha256').update(options.body ?? '').digest('hex')
        || !owner || owner !== context.platform.currentUser) {
        return platformResult('failed', {
          ...contextFields(context), resource: { kind: 'issue', number: issue }, operations,
          error: { code: 'SUMMARY_REPOSITION_UNAUTHORIZED', message: 'summary reposition requires current finalization authorization and an owned durable summary', retryable: false }
        });
      }
      const deleted = loaded.value.provider.comments?.delete
        ? await loaded.value.provider.comments.delete({
          context: providerOperationContext(loaded.value), parent: issueIdentityFromTask,
          comment: { kind: 'id', value: String(position.summary.id) },
          mutation: { idempotencyKey: `summary-reposition-delete:${resolved.taskId}:${position.summary.id}` }
        })
        : unsupportedProviderOperation(loaded.value.provider, 'comments.delete');
      if (!deleted.ok) {
        return platformResult(deleted.error.retryable ? 'blocked' : 'failed', {
          ...contextFields(context), resource: { kind: 'issue', number: issue }, operations, error: deleted.error
        });
      }
      const written = loaded.value.provider.comments?.write
        ? await loaded.value.provider.comments.write({
          context: providerOperationContext(loaded.value), parent: issueIdentityFromTask, body: desired[0]!.body,
          mutation: { idempotencyKey: `summary-reposition-write:${resolved.taskId}` }
        })
        : unsupportedProviderOperation(loaded.value.provider, 'comments.write');
      if (!written.ok) {
        return platformResult(written.error.retryable ? 'blocked' : 'failed', {
          ...contextFields(context), resource: { kind: 'issue', number: issue }, operations, error: written.error
        });
      }
      ids.splice(0, ids.length, providerCommentId((written.value as { remoteId: string }).remoteId, loaded.value.provider));
      operations.push({ name: `comment:${desired[0]!.marker}`, status: 'applied', reasonCode: 'SUMMARY_REPOSITIONED' });
      const reconciled = await listedComments(loaded.value.provider, loaded.value, issueIdentityFromTask);
      if (!reconciled.ok || !summaryPosition(reconciled.value, resolved.taskId).ok) {
        const error = reconciled.ok
          ? { code: 'SUMMARY_POSITION_UNVERIFIED', message: 'Summary comment is not provably last among task-managed comments', retryable: true }
          : reconciled.error;
        return platformResult(error.retryable ? 'blocked' : 'failed', {
          ...contextFields(context), resource: { kind: 'issue', number: issue }, operations, error
        });
      }
    }
  }
  const changed = operations.some((operation) => operation.status === 'applied');
  const result = platformResult(changed ? 'applied' : 'no-op', {
    ...contextFields(context),
    changed,
    resource: { kind: 'issue', number: issue },
    operations,
    comment: { kind: options.kind, marker: desired[0]?.marker ?? markerPrefix(resolved.taskId, options), ids, parts: desired.length },
    error: null
  });
  return result;
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

async function checkPlatformCommentOwner(taskRef: string, options: { cwd?: string; client?: PlatformClient; runtimeVersion?: string } = {}): Promise<PlatformResult> {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return platformResult('failed', { error: { code: resolved.code, message: resolved.message, retryable: false } });
  const content = fs.readFileSync(resolved.taskMdPath, 'utf8');
  let issueIdentity: ReturnType<typeof taskIssueIdentity>;
  try { issueIdentity = taskIssueIdentity(parseTaskFrontmatter(content)); }
  catch (error) { return platformResult('failed', { error: { ...taskIssueIdentityError(error), retryable: false } }); }
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
  COMMENT_BYTE_LIMIT,
  MARKERS,
  chunkArtifactComment,
  findMarkerComments,
  listRemoteComments,
  checkPlatformCommentOwner,
  listPlatformComments,
  normalizeCommentContent,
  renderTaskComment,
  renderTaskCommentResult,
  isTaskCommentTooLarge,
  syncPlatformComment,
  validateRelatedMarkerSet,
  writeComment
};
export type { CommentKind, RemoteComment, RenderedChunk, SyncOptions };
