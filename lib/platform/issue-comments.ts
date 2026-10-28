import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { parseTaskFrontmatter } from '../task/frontmatter.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { coordinatePlatformWrite } from './operation-coordinator.ts';
import type { PlatformOperation as JournalOperation, RecordOperationInput } from '../task/platform-operation-journal.ts';
import { resolvePlatformProviderContext } from './context.ts';
import type { LoadedContext, PlatformClient } from './context.ts';
import { providerErrorRetryable } from './provider-validation.ts';
import { platformResult } from './types.ts';
import type { PlatformOperation, PlatformResult } from './types.ts';
import type { ResourceIdentity } from './resource-identity.ts';
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

function isRetryable(error: { code: string; retryable?: boolean }): boolean {
  return error.retryable ?? providerErrorRetryable(error.code);
}

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
  dependency?: 'deferred' | 'required';
  queuedOperation?: JournalOperation;
  taskProjection?: { content: string; sha256: string };
};
type CommentPlanStrategy = Readonly<{
  taskId: string;
  cwd: string;
  agent: string;
  parentKind: 'issue' | 'pull-request';
  kind: CommentKind;
  client?: PlatformClient;
  resolved?: { loaded: LoadedContext; context: PlatformResult };
  backfill?: boolean;
  markerPrefix: string;
  prepare: () => Promise<{ parent: ResourceIdentity; items: RenderedChunk[] }>;
  validate?: () => Promise<{ code: string; message: string; retryable: boolean } | null>;
  summaryPosition?: boolean;
  authorizeReposition?: (comment: RemoteComment, currentUser: string | null) => { code: string; message: string; retryable: boolean } | null;
  verifyReadback?: boolean;
  dryRun?: boolean;
}>;

async function syncCommentPlan(
  strategy: CommentPlanStrategy,
  operation: Omit<RecordOperationInput, 'state' | 'lastCode'>,
  queuedOperation?: JournalOperation
): Promise<PlatformResult> {
  const execute = () => executeCommentPlan(strategy, strategy.client);
  if (strategy.dryRun) return execute();
  if (queuedOperation) return execute();
  return coordinatePlatformWrite({ operation, agent: strategy.agent, client: strategy.client, execute,
    block: (error) => platformResult('blocked', { error }),
    persistenceFailure: (error) => platformResult('failed', { error }) });
}

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
  'manual-validation': '人工验证',
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

async function listedComments(provider: any, loaded: any, parent: ResourceIdentity): Promise<any> {
  return provider.comments?.list
    ? provider.comments.list({ context: providerOperationContext(loaded), parent }).then((response: any) => response.ok
      ? { ok: true as const, value: response.value.map((comment: any) => parentComment(comment, provider)) }
      : { ...response, error: { ...response.error, retryable: isRetryable(response.error) } })
    : unsupportedProviderOperation(provider, 'comments.list');
}

type CommentPlanSelection = Readonly<{
  existing: RemoteComment[];
  byMarker: Map<string, RemoteComment>;
  reposition: boolean;
}>;

function markerSetError(strategy: CommentPlanStrategy, context: PlatformResult, resource: PlatformResult['resource'], existing: RemoteComment[]): PlatformResult | null {
  if (validateRelatedMarkerSet(existing, strategy.markerPrefix).ok) return null;
  return platformResult('failed', { ...contextFields(context), resource, error: {
    code: strategy.parentKind === 'pull-request' ? 'PR_SUMMARY_MARKER_AMBIGUOUS' : 'COMMENT_MARKER_CONFLICT',
    message: strategy.parentKind === 'pull-request' ? 'Multiple PR comments contain the summary marker' : 'Multiple comments use the same registered marker', retryable: false
  } });
}

function taskCommentOwnerError(
  strategy: CommentPlanStrategy,
  context: PlatformResult,
  resource: PlatformResult['resource'],
  existing: RemoteComment[]
): PlatformResult | null {
  if (strategy.kind !== 'task' || existing.length !== 1) return null;
  const owner = existing[0]!.user?.login;
  return owner && context.platform.currentUser && owner === context.platform.currentUser ? null : platformResult('blocked', {
    ...contextFields(context), resource, error: {
      code: 'COMMENT_OWNER_CONFLICT', message: owner ? `Task comment is owned by '${owner}'` : 'Task comment owner is unavailable', retryable: false
    }
  });
}

async function strategyValidationError(
  strategy: CommentPlanStrategy,
  context: PlatformResult,
  resource: PlatformResult['resource']
): Promise<PlatformResult | null> {
  const error = strategy.validate ? await strategy.validate() : null;
  if (!error) return null;
  return platformResult(error.retryable ? 'blocked' : 'failed', { ...contextFields(context), resource, error });
}

function artifactBackfillResult(
  strategy: CommentPlanStrategy,
  context: PlatformResult,
  resource: PlatformResult['resource'],
  existing: RemoteComment[],
  desired: RenderedChunk[]
): PlatformResult | null {
  if (!strategy.backfill || strategy.kind !== 'artifact' || existing.length === 0) return null;
  const operations = existing.map((comment): PlatformOperation => ({
    name: `comment:${normalizeCommentContent(comment.body).split('\n', 1)[0]}`,
    status: 'no-op',
    reasonCode: 'BACKFILL_ALREADY_PRESENT'
  }));
  return platformResult('no-op', {
    ...contextFields(context),
    resource,
    operations,
    comment: {
      kind: strategy.kind,
      marker: desired[0]?.marker ?? strategy.markerPrefix,
      ids: existing.map((item) => item.id),
      parts: existing.length
    },
    error: null
  });
}

function repositionAuthorizationError(
  strategy: CommentPlanStrategy,
  context: PlatformResult,
  resource: PlatformResult['resource'],
  comments: RemoteComment[],
  byMarker: Map<string, RemoteComment>,
  desired: RenderedChunk[]
): { error: PlatformResult | null; reposition: boolean } {
  const marker = desired[0]?.marker;
  const current = marker ? byMarker.get(marker) : undefined;
  const position = strategy.summaryPosition && current
    ? issueSummaryPosition(strategy.taskId, comments, marker!)
    : true;
  if (position === null) return {
    error: platformResult('blocked', { ...contextFields(context), resource, error: {
      code: 'SUMMARY_POSITION_UNVERIFIED', message: 'Summary comment ordering cannot be proven from the provider snapshot', retryable: true
    } }),
    reposition: false
  };
  const reposition = Boolean(strategy.summaryPosition && current && !position);
  if (!reposition || !current) return { error: null, reposition: false };
  const error = strategy.authorizeReposition
    ? strategy.authorizeReposition(current, context.platform.currentUser ?? null)
    : { code: 'SUMMARY_REPOSITION_UNAUTHORIZED', message: 'summary reposition requires current authorization and an owned summary comment', retryable: false };
  return {
    error: error ? platformResult(error.retryable ? 'blocked' : 'failed', { ...contextFields(context), resource, error }) : null,
    reposition: true
  };
}

async function inspectCommentPlan(
  strategy: CommentPlanStrategy,
  context: PlatformResult,
  resource: PlatformResult['resource'],
  comments: RemoteComment[],
  desired: RenderedChunk[]
): Promise<{ ok: true; value: CommentPlanSelection; result?: PlatformResult } | { ok: false; result: PlatformResult }> {
  const existing = relatedComments(comments, strategy.markerPrefix);
  const markerError = markerSetError(strategy, context, resource, existing);
  if (markerError) return { ok: false, result: markerError };
  const ownerError = taskCommentOwnerError(strategy, context, resource, existing);
  if (ownerError) return { ok: false, result: ownerError };
  const validationError = await strategyValidationError(strategy, context, resource);
  if (validationError) return { ok: false, result: validationError };
  const backfill = artifactBackfillResult(strategy, context, resource, existing, desired);
  if (backfill) return { ok: true, value: { existing, byMarker: new Map(), reposition: false }, result: backfill };
  const byMarker = new Map(existing.map((comment) => [normalizeCommentContent(comment.body).split('\n', 1)[0]!, comment]));
  const reposition = repositionAuthorizationError(strategy, context, resource, comments, byMarker, desired);
  if (reposition.error) return { ok: false, result: reposition.error };
  return { ok: true, value: { existing, byMarker, reposition: reposition.reposition } };
}

async function repositionSummaryComment(
  strategy: CommentPlanStrategy,
  loaded: LoadedContext,
  context: PlatformResult,
  parent: ResourceIdentity,
  resource: PlatformResult['resource'],
  current: RemoteComment | undefined,
  operations: PlatformOperation[]
): Promise<PlatformResult | null> {
  if (!current) return null;
  const deleted = loaded.provider.comments?.delete
    ? await loaded.provider.comments.delete({ context: providerOperationContext(loaded), parent,
      comment: providerResourceToken(loaded.provider, 'comment', String(current.id)),
      mutation: { idempotencyKey: `comment-reposition-delete:${strategy.taskId}:${current.id}` } })
    : unsupportedProviderOperation(loaded.provider, 'comments.delete');
  if (!deleted.ok) return platformResult(isRetryable(deleted.error) ? 'blocked' : 'failed', {
    ...contextFields(context), resource, error: deleted.error
  });
  operations.push({
    name: `comment:${current.id}`,
    status: 'applied',
    reasonCode: 'SUMMARY_REPOSITIONED'
  });
  return null;
}

async function observeCommentWrite(
  strategy: CommentPlanStrategy,
  loaded: LoadedContext,
  parent: ResourceIdentity,
  item: RenderedChunk
): Promise<{ valid: true } | { valid: false; error: PlatformResult['error'] }> {
  const after = await listedComments(loaded.provider, loaded, parent);
  const comments = after.ok ? after.value as RemoteComment[] : [];
  const found = comments.filter((comment) => normalizeCommentContent(comment.body).split('\n', 1)[0] === item.marker);
  const positionOk = !strategy.summaryPosition || issueSummaryPosition(strategy.taskId, comments, item.marker) === true;
  const validation = strategy.validate ? await strategy.validate() : null;
  if (after.ok
    && found.length === 1
    && normalizeCommentContent(found[0]!.body) === normalizeCommentContent(item.body)
    && positionOk
    && !validation) return { valid: true };
  const error = validation ?? {
    code: strategy.kind === 'summary' || strategy.kind === 'cancel' ? 'SUMMARY_BODY_READBACK_FAILED' : 'COMMENT_READBACK_FAILED',
    message: after.ok ? 'Remote comment did not match the requested body' : after.error.message,
    retryable: after.ok || isRetryable(after.error)
  };
  return { valid: false, error };
}

async function verifyIssueSummaryReadback(
  strategy: CommentPlanStrategy,
  loaded: LoadedContext,
  context: PlatformResult,
  parent: ResourceIdentity,
  resource: PlatformResult['resource'],
  desired: RenderedChunk[],
  operations: PlatformOperation[]
): Promise<PlatformResult | null> {
  if (strategy.parentKind !== 'issue' || (strategy.kind !== 'summary' && strategy.kind !== 'cancel')) return null;
  const after = await listedComments(loaded.provider, loaded, parent);
  if (!after.ok) return platformResult(isRetryable(after.error) ? 'blocked' : 'failed', {
    ...contextFields(context), resource, operations, error: after.error
  });
  const item = desired[0];
  const matching = item
    ? after.value.filter((comment: RemoteComment) => normalizeCommentContent(comment.body).split('\n', 1)[0] === item.marker)
    : [];
  if (!item || matching.length !== 1 || normalizeCommentContent(matching[0]!.body) !== normalizeCommentContent(item.body)) {
    return platformResult('blocked', { ...contextFields(context), resource, operations, error: {
      code: 'SUMMARY_BODY_READBACK_FAILED',
      message: strategy.kind === 'cancel' ? 'Remote cancellation body did not match the rendered cancellation summary' : 'Remote summary body did not match the rendered delivery summary',
      retryable: true
    } });
  }
  if (strategy.summaryPosition && issueSummaryPosition(strategy.taskId, after.value, item.marker) !== true) {
    return platformResult('blocked', { ...contextFields(context), resource, operations, error: {
      code: 'SUMMARY_POSITION_UNVERIFIED', message: 'Summary comment is not provably last among task-managed comments', retryable: true
    } });
  }
  return null;
}

async function compensatePullRequestComment(
  strategy: CommentPlanStrategy,
  loaded: LoadedContext,
  parent: ResourceIdentity,
  current: RemoteComment | undefined,
  id: number | string,
  cause: PlatformResult['error']
): Promise<PlatformResult['error']> {
  const compensation = current
    ? await loaded.provider.comments?.write?.({ context: providerOperationContext(loaded), parent, body: current.body,
      existingComment: providerResourceToken(loaded.provider, 'comment', String(current.id)),
      mutation: { idempotencyKey: `pr-summary-restore:${strategy.taskId}` } })
    : await loaded.provider.comments?.delete?.({ context: providerOperationContext(loaded), parent,
      comment: providerResourceToken(loaded.provider, 'comment', String(id)),
      mutation: { idempotencyKey: `pr-summary-delete:${strategy.taskId}:${id}` } });
  if (!compensation?.ok) return {
    code: 'PR_SUMMARY_RACE_COMPENSATION_FAILED',
    message: compensation?.error?.message ?? 'Provider does not support comment compensation',
    retryable: true
  };
  if (cause?.code === 'PR_SUMMARY_HEAD_RACE') return cause;
  return {
    code: 'PR_SUMMARY_POSTWRITE_VERIFY_FAILED',
    message: cause?.message ?? 'Post-write summary verification failed',
    retryable: true
  };
}

async function verifyCommentWrite(
  strategy: CommentPlanStrategy,
  loaded: LoadedContext,
  parent: ResourceIdentity,
  item: RenderedChunk,
  current: RemoteComment | undefined,
  id: number | string
): Promise<PlatformResult['error']> {
  if (!strategy.verifyReadback || strategy.parentKind === 'issue') return null;
  const observed = await observeCommentWrite(strategy, loaded, parent, item);
  if (observed.valid) return null;
  if (strategy.parentKind === 'pull-request') {
    return compensatePullRequestComment(strategy, loaded, parent, current, id, observed.error);
  }
  return observed.error;
}

async function writeDesiredComments(
  strategy: CommentPlanStrategy,
  loaded: LoadedContext,
  context: PlatformResult,
  parent: ResourceIdentity,
  resource: PlatformResult['resource'],
  desired: RenderedChunk[],
  selection: CommentPlanSelection,
  operations: PlatformOperation[]
): Promise<{ ok: true; ids: Array<number | string> } | { ok: false; result: PlatformResult }> {
  const ids: Array<number | string> = [];
  for (const item of desired) {
    const current = selection.reposition && item === desired[0] ? undefined : selection.byMarker.get(item.marker);
    if (current && normalizeCommentContent(current.body) === normalizeCommentContent(item.body)) {
      ids.push(current.id);
      operations.push({ name: `comment:${item.marker}`, status: 'no-op', reasonCode: null });
      continue;
    }
    const written = loaded.provider.comments?.write
      ? await loaded.provider.comments.write({ context: providerOperationContext(loaded), parent, body: item.body,
        ...(current ? { existingComment: providerResourceToken(loaded.provider, 'comment', String(current.id)) } : {}),
        mutation: { idempotencyKey: `comment:${strategy.taskId}:${item.marker}` } })
      : unsupportedProviderOperation(loaded.provider, 'comments.write');
    if (!written.ok) return { ok: false, result: platformResult(isRetryable(written.error) ? 'blocked' : 'failed', {
      ...contextFields(context), resource, operations, error: written.error
    }) };
    const id = providerCommentId(written.value.remoteId, loaded.provider);
    ids.push(id);
    operations.push({ name: `comment:${item.marker}`, status: 'applied', reasonCode: null });
    const error = await verifyCommentWrite(strategy, loaded, parent, item, current, id);
    if (error) return { ok: false, result: platformResult(error.retryable ? 'blocked' : 'failed', {
      ...contextFields(context), resource, operations, error
    }) };
  }
  return { ok: true, ids };
}

async function deleteStaleComments(
  strategy: CommentPlanStrategy,
  loaded: LoadedContext,
  context: PlatformResult,
  parent: ResourceIdentity,
  resource: PlatformResult['resource'],
  existing: RemoteComment[],
  desired: RenderedChunk[],
  operations: PlatformOperation[]
): Promise<PlatformResult | null> {
  const markers = new Set(desired.map((item) => item.marker));
  for (const stale of existing.filter((comment) => !markers.has(normalizeCommentContent(comment.body).split('\n', 1)[0]!))) {
    const deleted = loaded.provider.comments?.delete
      ? await loaded.provider.comments.delete({ context: providerOperationContext(loaded), parent,
        comment: providerResourceToken(loaded.provider, 'comment', String(stale.id)),
        mutation: { idempotencyKey: `comment-delete:${strategy.taskId}:${stale.id}` } })
      : unsupportedProviderOperation(loaded.provider, 'comments.delete');
    if (!deleted.ok) return platformResult(isRetryable(deleted.error) ? 'blocked' : 'failed', {
      ...contextFields(context), resource, operations, error: deleted.error
    });
    operations.push({ name: `comment:${stale.id}`, status: 'applied', reasonCode: 'STALE_CHUNK_DELETED' });
  }
  return null;
}

type PreparedCommentExecution = Readonly<{
  loaded: LoadedContext;
  context: PlatformResult;
  parent: ResourceIdentity;
  desired: RenderedChunk[];
  resource: PlatformResult['resource'];
  selection: CommentPlanSelection;
  result?: PlatformResult;
}>;

async function prepareCommentExecution(
  strategy: CommentPlanStrategy,
  client?: PlatformClient
): Promise<{ ok: true; value: PreparedCommentExecution } | { ok: false; result: PlatformResult }> {
  const resolved = strategy.resolved
    ? { ok: true as const, value: strategy.resolved.loaded }
    : await resolvePlatformProviderContext({ cwd: strategy.cwd, client });
  const loaded = resolved;
  const context = strategy.resolved?.context ?? (loaded.ok ? loaded.value.context : loaded.context);
  if (!loaded.ok || !hasResolvedPlatformContext(context)) return { ok: false, result: context };
  let parent: ResourceIdentity;
  let desired: RenderedChunk[];
  try { ({ parent, items: desired } = await strategy.prepare()); }
  catch (error) {
    const value = error as { code?: string; message?: string };
    return { ok: false, result: platformResult('failed', { ...contextFields(context), error: {
      code: value.code || 'COMMENT_PAYLOAD_INVALID', message: value.message || String(error), retryable: false
    } }) };
  }
  const resource = { kind: strategy.parentKind, number: resourceIdentityNumber(parent), identity: parent } as const;
  const listed = await listedComments(loaded.value.provider, loaded.value, parent);
  if (!listed.ok) return { ok: false, result: platformResult(isRetryable(listed.error) ? 'blocked' : 'failed', {
    ...contextFields(context), resource, error: listed.error
  }) };
  const selection = await inspectCommentPlan(strategy, context, resource, listed.value, desired);
  if (!selection.ok) return selection;
  return {
    ok: true,
    value: {
      loaded: loaded.value,
      context,
      parent,
      desired,
      resource,
      selection: selection.value,
      result: selection.result
    }
  };
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

function parentComment(comment: any, provider: any): RemoteComment {
  return {
    id: providerCommentId(comment.id, provider), body: comment.body,
    user: comment.author?.name ? { login: comment.author.name } : undefined,
    createdSequence: comment.createdSequence
  };
}

function issueSummaryPosition(taskId: string, comments: readonly RemoteComment[], marker: string): boolean | null {
  const managed = comments.filter((comment) => comment.body.split('\n', 1)[0]?.startsWith(`<!-- sync-issue:${taskId}:`));
  const summary = managed.filter((comment) => comment.body.split('\n', 1)[0] === marker);
  if (summary.length !== 1 || managed.some((comment) => !Number.isSafeInteger(comment.createdSequence) || comment.createdSequence === null)) return null;
  return managed.every((comment) => summary[0]!.createdSequence! >= comment.createdSequence!);
}

async function executeCommentPlan(
  strategy: CommentPlanStrategy,
  client?: PlatformClient
): Promise<PlatformResult> {
  const prepared = await prepareCommentExecution(strategy, client);
  if (!prepared.ok) return prepared.result;
  const { loaded, context, parent, desired, resource, selection, result } = prepared.value;
  if (result) return result;
  if (strategy.dryRun) return platformResult('planned', {
    ...contextFields(context), resource,
    operations: desired.map((item) => ({ name: `comment:${item.marker}`, status: 'planned', reasonCode: null })), error: null
  });
  const operations: PlatformOperation[] = [];
  const currentSummary = desired[0] ? selection.byMarker.get(desired[0].marker) : undefined;
  if (selection.reposition) {
    const repositioned = await repositionSummaryComment(strategy, loaded, context, parent, resource, currentSummary, operations);
    if (repositioned) return repositioned;
  }
  const written = await writeDesiredComments(strategy, loaded, context, parent, resource, desired, selection, operations);
  if (!written.ok) return written.result;
  const deleted = await deleteStaleComments(strategy, loaded, context, parent, resource, selection.existing, desired, operations);
  if (deleted) return deleted;
  const readback = await verifyIssueSummaryReadback(strategy, loaded, context, parent, resource, desired, operations);
  if (readback) return readback;
  const changed = operations.some((operation) => operation.status === 'applied');
  return platformResult(changed ? 'applied' : 'no-op', {
    ...contextFields(context), changed, resource, operations,
    comment: {
      kind: strategy.kind,
      marker: desired[0]?.marker ?? strategy.markerPrefix,
      ids: written.ids,
      parts: desired.length
    },
    error: null
  });
}

function syncPlatformComment(taskRef: string, options: SyncOptions): Promise<PlatformResult> {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return Promise.resolve(platformResult('failed', { error: { code: resolved.code, message: resolved.message, retryable: false } }));
  const readStrategy = (): CommentPlanStrategy => {
    const prefix = markerPrefix(resolved.taskId, options);
    return {
      taskId: resolved.taskId, cwd: resolved.repoRoot, agent: options.agent, client: options.client,
      parentKind: 'issue', kind: options.kind, markerPrefix: prefix,
      backfill: options.backfill,
      prepare: async () => {
        const taskContent = fs.readFileSync(resolved.taskMdPath, 'utf8');
        const parent = taskIssueIdentity(parseTaskFrontmatter(taskContent));
        if (!parent) throw Object.assign(new Error('Task has no valid platform issue identity'), { code: 'ISSUE_NOT_LINKED' });
        const source = options.kind === 'task' && options.taskProjection ? options.taskProjection.content : taskContent;
        if (options.kind === 'task' && options.taskProjection && createHash('sha256').update(source).digest('hex') !== options.taskProjection.sha256) {
          throw Object.assign(new Error('finalization task projection digest does not match content'), { code: 'FINALIZATION_PROJECTION_INVALID' });
        }
        const items = expectedComments(resolved.taskId, source, resolved.taskDir, resolved.repoRoot, options);
        if (options.kind === 'task' && Buffer.byteLength(items[0]!.body, 'utf8') > COMMENT_BYTE_LIMIT) throw Object.assign(new Error('Projected task comment exceeds the platform byte limit'), { code: 'COMMENT_PAYLOAD_TOO_LARGE' });
        return { parent, items };
      },
      summaryPosition: options.kind === 'summary',
      verifyReadback: options.kind === 'summary' || options.kind === 'cancel',
      authorizeReposition: (comment, currentUser) => options.summaryAuthorization
        && options.summaryAuthorization.sha256 === createHash('sha256').update(options.body ?? '').digest('hex')
        && comment.user?.login && currentUser && comment.user.login === currentUser
        ? null : { code: 'SUMMARY_REPOSITION_UNAUTHORIZED', message: 'summary reposition requires current finalization authorization and an owned durable summary', retryable: false }
    };
  };
  let strategy: CommentPlanStrategy;
  let operation: Omit<RecordOperationInput, 'state' | 'lastCode'>;
  try {
    strategy = readStrategy();
    const source = options.kind === 'task' && options.taskProjection ? options.taskProjection.content : fs.readFileSync(resolved.taskMdPath, 'utf8');
    const expected = expectedComments(resolved.taskId, source, resolved.taskDir, resolved.repoRoot, options);
    const digest = createHash('sha256').update(expected.map((item) => item.content).join('\0')).digest('hex');
    const kind: JournalOperation['kind'] = options.kind === 'task' ? 'task-comment' : options.kind === 'artifact' ? 'artifact-comment' : options.kind === 'summary' ? 'summary-comment' : 'cancel-comment';
    const target = options.kind === 'artifact' ? options.artifact! : options.kind;
    operation = { taskRef: resolved.taskId, cwd: resolved.repoRoot, kind, target, expectedDigest: digest, dependency: options.dependency ?? 'deferred' };
  } catch (error) {
    const value = error as { code?: string; message?: string };
    return Promise.resolve(platformResult('failed', { error: { code: value.code || 'COMMENT_PAYLOAD_INVALID', message: value.message || String(error), retryable: false } }));
  }
  return syncCommentPlan(strategy, operation, options.queuedOperation);
}

function inspectPlatformCommentOperation(taskRef: string, options: SyncOptions): { kind: 'task-comment' | 'artifact-comment' | 'summary-comment' | 'cancel-comment'; target: string; expectedDigest: string; id: string } | null {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return null;
  const taskContent = fs.readFileSync(resolved.taskMdPath, 'utf8');
  if (!taskIssueIdentity(parseTaskFrontmatter(taskContent))) return null;
  const sourceContent = options.kind === 'task' && options.taskProjection ? options.taskProjection.content : taskContent;
  const desired = expectedComments(resolved.taskId, sourceContent, resolved.taskDir, resolved.repoRoot, options);
  const kind = options.kind === 'task' ? 'task-comment' : options.kind === 'summary' ? 'summary-comment'
    : options.kind === 'cancel' ? 'cancel-comment' : 'artifact-comment';
  const target = options.kind === 'artifact' ? options.artifact! : options.kind;
  const expectedDigest = createHash('sha256').update(desired.map((chunk) => chunk.content).join('\0')).digest('hex');
  return { kind, target, expectedDigest, id: createHash('sha256').update(`${kind}\0${target}\0${expectedDigest}`).digest('hex') };
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
  if (!listed.ok) return platformResult(isRetryable(listed.error) ? 'blocked' : 'failed', { ...contextFields(context), error: listed.error });
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
  inspectPlatformCommentOperation,
  findMarkerComments,
  checkPlatformCommentOwner,
  listPlatformComments,
  normalizeCommentContent,
  renderTaskComment,
  renderTaskCommentResult,
  syncCommentPlan,
  syncPlatformComment,
  validateRelatedMarkerSet
};
export type { CommentKind, CommentPlanStrategy, RemoteComment, RenderedChunk, SyncOptions };
