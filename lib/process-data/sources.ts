import fs from 'node:fs';
import path from 'node:path';

import { createGitHubClient } from '../platform/github-client.ts';
import { enumerateAllTaskDirs } from '../task/resolve-ref.ts';
import { captureText, inspectPrivacy, redactExcerpt } from './privacy.ts';
import { canonicalJsonBytes, sha256 } from './store.ts';

import type { GitHubClient } from '../platform/github-client.ts';
import type {
  CapturedObject,
  EndpointQueryMode,
  ProcessResult,
  RestCollectionEvidence,
  RestPageEvidence
} from './types.ts';

type RestPage = { evidence: RestPageEvidence; bytes: Buffer };
type RestCollection<T> = { items: T[]; evidence: RestCollectionEvidence; pageObjects: CapturedObject[] };

type FetchRestCollectionOptions<T> = {
  client: GitHubClient;
  endpoint: string;
  identify: (item: T) => string;
  select?: (item: T) => T;
  perPage?: number;
};

type GitHubCapture = {
  repository: string;
  objects: CapturedObject[];
  endpoints: RestCollectionEvidence[];
};

type GitHubBoundaryCapture = {
  repository: string;
  preflightDate: string;
  watermark: string;
  objects: CapturedObject[];
  endpoints: RestCollectionEvidence[];
  responseDates: string[];
  deferred: string[];
  unavailable: string[];
};

type BoundaryCaptureOptions = {
  client?: GitHubClient;
  fromInclusive?: string | null;
  reconciliation?: 'incremental' | 'full';
};

type EndpointDescriptor = {
  path: string;
  queryMode: EndpointQueryMode;
  eventTime: (item: unknown) => string | undefined;
  identity: (item: unknown) => string;
  parentIdentity?: string;
  maxItems?: number;
  includeResource?: (item: unknown) => boolean;
};

function endpointForPage(endpoint: string, page: number, perPage: number): string {
  const parsed = new URL(endpoint, 'https://api.github.invalid/');
  if (parsed.searchParams.has('page') || parsed.searchParams.has('per_page')) {
    throw new Error('endpoint must not predefine page or per_page');
  }
  parsed.searchParams.set('per_page', String(perPage));
  parsed.searchParams.set('page', String(page));
  return `${parsed.pathname.replace(/^\//, '')}${parsed.search}`;
}

function fetchRestCollection<T>(options: FetchRestCollectionOptions<T>): ProcessResult<RestCollection<T>> {
  const perPage = options.perPage ?? 100;
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) {
    return { ok: false, error: { code: 'PAGINATION_INVALID', message: 'perPage must be between 1 and 100' } };
  }
  let pageIndex = 1;
  let previousHash: string | null = null;
  const identities = new Set<string>();
  const items: T[] = [];
  const pages: RestPage[] = [];

  while (true) {
    let url: string;
    try {
      url = endpointForPage(options.endpoint, pageIndex, perPage);
    } catch (error) {
      return { ok: false, error: { code: 'PAGINATION_INVALID', message: String(error) } };
    }
    const response = options.client.json<unknown>(['api', url]);
    if (!response.ok) return { ok: false, error: response.error };
    if (!Array.isArray(response.value) || response.value.length > perPage) {
      return {
        ok: false,
        error: { code: 'INVALID_PLATFORM_RESPONSE', message: `GitHub page ${pageIndex} is not a valid array page` }
      };
    }
    let selected: T[];
    try {
      selected = (response.value as T[]).map((entry) => options.select ? options.select(entry) : entry);
    } catch (error) {
      return { ok: false, error: { code: 'INVALID_PLATFORM_RESPONSE', message: String(error) } };
    }
    let bytes: Buffer;
    try {
      bytes = canonicalJsonBytes(selected);
    } catch (error) {
      return { ok: false, error: { code: 'INVALID_PLATFORM_RESPONSE', message: String(error) } };
    }
    const canonicalSha256 = sha256(bytes);
    if (previousHash === canonicalSha256 && response.value.length > 0) {
      return {
        ok: false,
        error: { code: 'PAGINATION_UNSTABLE', message: `GitHub page ${pageIndex} repeats the previous page` }
      };
    }
    for (const entry of selected) {
      const identity = options.identify(entry);
      if (!identity || identities.has(identity)) {
        return {
          ok: false,
          error: { code: 'PAGINATION_UNSTABLE', message: `duplicate or empty identity on page ${pageIndex}` }
        };
      }
      identities.add(identity);
      items.push(entry);
    }
    pages.push({ evidence: { index: pageIndex, itemCount: response.value.length, canonicalSha256 }, bytes });
    previousHash = canonicalSha256;
    if (response.value.length < perPage) break;
    pageIndex += 1;
  }

  const evidence: RestCollectionEvidence = {
    endpoint: options.endpoint,
    requestCount: pages.length,
    dataPageCount: pages.filter((page) => page.evidence.itemCount > 0).length,
    itemCount: items.length,
    termination: 'short-page',
    pages: pages.map((page) => page.evidence)
  };
  return {
    ok: true,
    value: {
      items,
      evidence,
      pageObjects: pages.map((page) => ({
        sourceKind: 'github-rest',
        sourceIdentity: `${options.endpoint}#page=${page.evidence.index}`,
        sha256: page.evidence.canonicalSha256,
        bytes: page.bytes.length,
        content: page.bytes.toString('utf8'),
        disposition: { state: 'included' }
      }))
    }
  };
}

function relativeIdentity(repoRoot: string, filePath: string): string {
  const relative = path.relative(repoRoot, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`path escapes repository: ${filePath}`);
  return relative.split(path.sep).join('/');
}

function readStableFile(repoRoot: string, filePath: string, sourceKind: CapturedObject['sourceKind']): CapturedObject {
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`unsafe source file: ${filePath}`);
  const content = fs.readFileSync(filePath, 'utf8');
  const after = fs.lstatSync(filePath);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`source changed while reading: ${filePath}`);
  }
  return captureText(sourceKind, relativeIdentity(repoRoot, filePath), content);
}

function listFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const output: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlink source is not allowed: ${candidate}`);
      if (entry.isDirectory()) walk(candidate);
      else if (entry.isFile()) output.push(candidate);
    }
  };
  walk(directory);
  return output;
}

function structuredReceipt(repoRoot: string, filePath: string): CapturedObject {
  const raw = readStableFile(repoRoot, filePath, 'structured-telemetry');
  if (!raw.content) return raw;
  try {
    const parsed = JSON.parse(raw.content) as Record<string, unknown>;
    const fields = ['client', 'model', 'reasoning', 'stage', 'toolCategory', 'time', 'status', 'retry', 'error', 'fallback'];
    const selected = Object.fromEntries(
      fields.filter((field) => parsed[field] !== undefined).map((field) => [field, jsonClone(parsed[field])])
    );
    selected.sourceSha256 = raw.sha256;
    return captureText('structured-telemetry', raw.sourceIdentity, canonicalJsonBytes(selected).toString('utf8'));
  } catch {
    return { ...raw, content: undefined, disposition: { state: 'unavailable', reason: 'invalid receipt JSON' } };
  }
}

function unavailableLog(repoRoot: string, filePath: string, includeExcerpts: boolean): CapturedObject {
  const raw = readStableFile(repoRoot, filePath, 'local-file');
  if (raw.disposition?.state === 'excluded-sensitive') return raw;
  const recognizedBody = /\/(?:sessions?|tools?)(?:\/|[-_])/i.test(raw.sourceIdentity);
  if (includeExcerpts && recognizedBody && raw.content) {
    const excerpt = redactExcerpt(raw.content);
    if (excerpt !== null) return captureText('local-file', `${raw.sourceIdentity}#excerpt`, excerpt);
  }
  return {
    sourceKind: 'local-file',
    sourceIdentity: raw.sourceIdentity,
    sha256: raw.sha256,
    bytes: raw.bytes,
    disposition: { state: 'unavailable', reason: recognizedBody ? 'body-excerpts-disabled' : 'unknown-log-format' }
  };
}

function collectLocalObjects(repoRoot: string, options: { includeExcerpts?: boolean } = {}): ProcessResult<CapturedObject[]> {
  try {
    const objects: CapturedObject[] = [];
    for (const task of enumerateAllTaskDirs(repoRoot)) {
      for (const filePath of listFiles(task.taskDir)) {
        if (!/\.(?:md|json)$/i.test(filePath)) continue;
        objects.push(readStableFile(repoRoot, filePath, 'local-file'));
      }
    }
    const logsRoot = path.join(repoRoot, '.agents', 'workspace', 'logs');
    for (const filePath of listFiles(logsRoot)) {
      if (!/\.(?:md|json)$/i.test(filePath)) continue;
      const identity = relativeIdentity(repoRoot, filePath);
      if (/\/entropy-check\/.*\.md$/i.test(identity)) {
        objects.push(readStableFile(repoRoot, filePath, 'operational-report'));
      } else if (/\/(?:delegation|orchestration)(?:\/|[-_]).*\.json$/i.test(identity)) {
        objects.push(structuredReceipt(repoRoot, filePath));
      } else {
        objects.push(unavailableLog(repoRoot, filePath, options.includeExcerpts === true));
      }
    }
    return { ok: true, value: objects.sort((a, b) => a.sourceIdentity.localeCompare(b.sourceIdentity)) };
  } catch (error) {
    return { ok: false, error: { code: 'LOCAL_SOURCE_UNSTABLE', message: error instanceof Error ? error.message : String(error) } };
  }
}

function githubIdentity(item: unknown): string {
  if (!item || typeof item !== 'object') return '';
  const record = item as Record<string, unknown>;
  for (const key of ['id', 'node_id', 'sha', 'number']) {
    if (typeof record[key] === 'string' || typeof record[key] === 'number') return `${key}:${String(record[key])}`;
  }
  return '';
}

function jsonClone(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function projectFields(value: unknown, fields: string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    fields.filter((field) => record[field] !== undefined).map((field) => [field, jsonClone(record[field])])
  );
}

function projectSensitiveText(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  const disposition = inspectPrivacy(value);
  return disposition.state === 'included'
    ? value
    : { state: 'unavailable', reason: 'privacy-excluded', ruleId: disposition.ruleId, sha256: sha256(value) };
}

function projectGitHubItem(item: unknown): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('GitHub item must be an object');
  const source = item as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const scalarFields = [
    'id', 'node_id', 'number', 'html_url', 'url', 'state', 'title', 'created_at', 'updated_at', 'closed_at',
    'merged_at', 'review_state', 'commit_id', 'sha', 'merge_commit_sha', 'milestone'
  ];
  for (const field of scalarFields) {
    if (source[field] !== undefined) output[field] = jsonClone(source[field]);
  }
  for (const field of ['user', 'head', 'base', 'author', 'committer']) {
    const projected = projectFields(source[field], ['id', 'login', 'sha', 'ref']);
    if (projected) output[field] = projected;
  }
  for (const field of ['labels', 'assignees']) {
    if (Array.isArray(source[field])) output[field] = jsonClone(source[field]);
  }
  for (const field of ['body', 'message']) {
    const projected = projectSensitiveText(source[field]);
    if (projected !== undefined) output[field] = projected;
  }
  if (Array.isArray(source.parents)) {
    output.parents = source.parents.flatMap((parent) => {
      const projected = projectFields(parent, ['sha']);
      return projected ? [projected] : [];
    });
  }
  const commit = projectFields(source.commit, []);
  if (commit) {
    const sourceCommit = source.commit as Record<string, unknown>;
    const projectedCommit: Record<string, unknown> = {};
    const message = projectSensitiveText(sourceCommit.message);
    if (message !== undefined) projectedCommit.message = message;
    const tree = projectFields(sourceCommit.tree, ['sha']);
    if (tree) projectedCommit.tree = tree;
    for (const field of ['author', 'committer']) {
      const actor = projectFields(sourceCommit[field], ['name', 'email', 'date']);
      if (actor) projectedCommit[field] = actor;
    }
    output.commit = projectedCommit;
  }
  return output;
}

function projectGitHubTimelineItem(item: unknown): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('GitHub timeline item must be an object');
  const source = item as Record<string, unknown>;
  if (typeof source.event !== 'string' || source.event.length === 0) throw new Error('GitHub timeline event type is missing');
  const output: Record<string, unknown> = {};
  for (const field of [
    'id', 'node_id', 'event', 'created_at', 'updated_at', 'submitted_at', 'commit_id', 'sha', 'state',
    'lock_reason', 'ref', 'ref_type'
  ]) {
    if (source[field] !== undefined) output[field] = jsonClone(source[field]);
  }
  for (const field of ['actor', 'user', 'assignee', 'assigner', 'reviewer', 'requested_reviewer']) {
    const projected = projectFields(source[field], ['id', 'login', 'name']);
    if (projected) output[field] = projected;
  }
  const nestedFields: Record<string, string[]> = {
    label: ['id', 'name', 'color'],
    milestone: ['id', 'number', 'title', 'state'],
    rename: ['from', 'to'],
    source: ['id', 'node_id', 'number', 'title', 'ref', 'sha'],
    dismissed_review: ['state', 'review_id', 'dismissal_commit_id'],
    project_card: ['id', 'project_id', 'column_name']
  };
  for (const [field, fields] of Object.entries(nestedFields)) {
    const projected = projectFields(source[field], fields);
    if (projected) output[field] = projected;
  }
  const body = projectSensitiveText(source.body);
  if (body !== undefined) output.body = body;
  return output;
}

function collectGitHubObjects(repoRoot: string, client: GitHubClient = createGitHubClient()): ProcessResult<GitHubCapture> {
  const repoResult = client.json<{ nameWithOwner?: string }>(['repo', 'view', '--json', 'nameWithOwner'], { cwd: repoRoot });
  if (!repoResult.ok) return { ok: false, error: repoResult.error };
  const repository = repoResult.value.nameWithOwner;
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
    return { ok: false, error: { code: 'INVALID_PLATFORM_RESPONSE', message: 'GitHub repository identity is missing' } };
  }
  const objects: CapturedObject[] = [];
  const evidence: RestCollectionEvidence[] = [];
  const captureEndpoint = (endpoint: string) => {
    const result = fetchRestCollection({
      client,
      endpoint,
      identify: githubIdentity,
      select: (item) => projectGitHubItem(item) as unknown
    });
    if (!result.ok) return result;
    objects.push(...result.value.pageObjects);
    evidence.push(result.value.evidence);
    return result;
  };

  const issues = captureEndpoint(`repos/${repository}/issues?state=all&sort=created&direction=asc`);
  if (!issues.ok) return issues;
  const pulls = captureEndpoint(`repos/${repository}/pulls?state=all&sort=created&direction=asc`);
  if (!pulls.ok) return pulls;

  for (const issue of issues.value.items) {
    const number = (issue as Record<string, unknown>).number;
    if (typeof number !== 'number') return { ok: false, error: { code: 'INVALID_PLATFORM_RESPONSE', message: 'Issue number is missing' } };
    const comments = captureEndpoint(`repos/${repository}/issues/${number}/comments`);
    if (!comments.ok) return comments;
  }
  for (const pull of pulls.value.items) {
    const record = pull as Record<string, unknown>;
    const number = record.number;
    const head = record.head as Record<string, unknown> | undefined;
    const headSha = head?.sha;
    if (typeof number !== 'number' || typeof headSha !== 'string') {
      return { ok: false, error: { code: 'INVALID_PLATFORM_RESPONSE', message: 'Pull request identity or head SHA is missing' } };
    }
    for (const suffix of ['comments', 'reviews', 'commits']) {
      const nested = captureEndpoint(`repos/${repository}/pulls/${number}/${suffix}`);
      if (!nested.ok) return nested;
    }
    const current = client.json<unknown>(['api', `repos/${repository}/pulls/${number}`]);
    if (!current.ok) return { ok: false, error: current.error };
    const projected = projectGitHubItem(current.value) as Record<string, unknown>;
    const currentHead = projected.head as Record<string, unknown> | undefined;
    if (currentHead?.sha !== headSha) {
      return { ok: false, error: { code: 'SOURCE_DRIFT', message: `Pull request ${number} head changed during capture` } };
    }
  }
  return { ok: true, value: { repository, objects, endpoints: evidence } };
}

function resolveGitHubRepository(repoRoot: string, client: GitHubClient = createGitHubClient()): ProcessResult<string> {
  const result = client.json<{ nameWithOwner?: string }>(['repo', 'view', '--json', 'nameWithOwner'], { cwd: repoRoot });
  if (!result.ok) return { ok: false, error: result.error };
  if (!result.value.nameWithOwner || !/^[^/]+\/[^/]+$/.test(result.value.nameWithOwner)) {
    return { ok: false, error: { code: 'INVALID_PLATFORM_RESPONSE', message: 'GitHub repository identity is missing' } };
  }
  return { ok: true, value: result.value.nameWithOwner };
}

function truncateSecond(date: Date): string {
  return new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString();
}

function validDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function queryEndpoint(endpoint: string, page: number, perPage: number, queryMode: EndpointQueryMode, queryAfter: string | null): string {
  const parsed = new URL(endpoint, 'https://api.github.invalid/');
  parsed.searchParams.set('per_page', String(perPage));
  parsed.searchParams.set('page', String(page));
  if (queryMode === 'strict-since' && queryAfter) parsed.searchParams.set('since', queryAfter);
  return `${parsed.pathname.replace(/^\//, '')}${parsed.search}`;
}

function resourceIdentity(prefix: string, item: unknown): string {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
  const value = item as Record<string, unknown>;
  if (typeof value.id === 'number' || typeof value.id === 'string') return `${prefix}:${String(value.id)}`;
  if (typeof value.node_id === 'string') return `${prefix}:${value.node_id}`;
  if (typeof value.sha === 'string') return `${prefix}:${value.sha}`;
  if (typeof value.number === 'number') return `${prefix}:${value.number}`;
  return '';
}

function issueOrPullIdentity(item: unknown): string {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
  const value = item as Record<string, unknown>;
  const prefix = value.pull_request ? 'pr' : 'issue';
  return resourceIdentity(prefix, item);
}

function isPullRequestIssue(item: unknown): boolean {
  return Boolean(item && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>).pull_request);
}

function itemEventTime(item: unknown): string | undefined {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
  const value = item as Record<string, unknown>;
  for (const key of ['updated_at', 'created_at', 'submitted_at']) {
    if (typeof value[key] === 'string') return value[key];
  }
  const commit = value.commit as Record<string, unknown> | undefined;
  const author = commit?.author as Record<string, unknown> | undefined;
  const committer = commit?.committer as Record<string, unknown> | undefined;
  if (typeof author?.date === 'string') return author.date;
  if (typeof committer?.date === 'string') return committer.date;
  return undefined;
}

function timelineIdentity(item: unknown, parentNumber?: string): string {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
  const value = item as Record<string, unknown>;
  if (typeof value.id === 'number' || typeof value.id === 'string') return `timeline:${String(value.id)}`;
  const actor = value.actor as Record<string, unknown> | undefined;
  const target = value.issue as Record<string, unknown> | undefined;
  const tuple = [parentNumber, value.event, value.created_at ?? value.updated_at, actor?.id ?? actor?.login, target?.id ?? value.commit_id];
  return tuple.every((part) => part !== undefined && part !== null && String(part) !== '') ? `timeline:${tuple.join(':')}` : '';
}

function descriptor(
  pathname: string,
  queryMode: EndpointQueryMode,
  prefix: string,
  identity?: (item: unknown) => string,
  options: Pick<EndpointDescriptor, 'parentIdentity' | 'maxItems' | 'includeResource'> = {}
): EndpointDescriptor {
  return {
    path: pathname,
    queryMode,
    eventTime: itemEventTime,
    identity: identity ?? ((item) => resourceIdentity(prefix, item)),
    ...options
  };
}

function responseDateOrError(value: string | undefined): ProcessResult<{ date: Date; iso: string }> {
  const date = validDate(value);
  if (!date) return { ok: false, error: { code: 'OBSERVATION_BOUNDARY_INVALID', message: 'GitHub response Date is missing or invalid' } };
  return { ok: true, value: { date, iso: date.toISOString() } };
}

function collectBoundaryCollection(
  client: GitHubClient,
  endpoint: EndpointDescriptor,
  preflight: Date,
  fromInclusive: Date | null,
  watermark: Date,
  reconciliation: 'incremental' | 'full',
  addResource: (object: CapturedObject, identity: string, eventTime: string) => ProcessResult<void>,
  deferred: Set<string>,
  responseDates: string[]
): ProcessResult<RestCollectionEvidence> {
  const perPage = 100;
  const queryMode = reconciliation === 'full' ? 'full-enumeration' : (fromInclusive ? endpoint.queryMode : 'full-enumeration');
  const queryAfter = queryMode === 'strict-since' && fromInclusive
    ? new Date(fromInclusive.getTime() - 1000).toISOString()
    : null;
  const pages: RestPageEvidence[] = [];
  const objects: CapturedObject[] = [];
  const identities = new Set<string>();
  let previousHash: string | null = null;

  for (let page = 1; ; page += 1) {
    const url = queryEndpoint(endpoint.path, page, perPage, queryMode, queryAfter);
    if (!client.jsonWithMetadata) {
      return { ok: false, error: { code: 'PLATFORM_METADATA_UNAVAILABLE', message: 'GitHub response metadata boundary is unavailable' } };
    }
    const response = client.jsonWithMetadata<unknown>(['api', url]);
    if (!response.ok) return { ok: false, error: response.error };
    const dateResult = responseDateOrError(response.value.metadata.date);
    if (!dateResult.ok) return dateResult;
    if (dateResult.value.date.getTime() < preflight.getTime()) {
      return { ok: false, error: { code: 'OBSERVATION_BOUNDARY_INVALID', message: `Response Date precedes preflight for ${endpoint.path}` } };
    }
    responseDates.push(dateResult.value.iso);
    const actualUrl = response.value.metadata.requestUrl;
    if (queryAfter && (!actualUrl.includes(`since=${encodeURIComponent(queryAfter)}`) && !actualUrl.includes(`since=${queryAfter}`))) {
      return { ok: false, error: { code: 'QUERY_BOUNDARY_INVALID', message: `GitHub request did not include since=${queryAfter}` } };
    }
    if (!Array.isArray(response.value.value) || response.value.value.length > perPage) {
      return { ok: false, error: { code: 'INVALID_PLATFORM_RESPONSE', message: `GitHub page ${page} is not a valid array page` } };
    }
    const selected = (response.value.value as unknown[]).map((item) => endpoint.path.includes('/timeline')
      ? projectGitHubTimelineItem(item)
      : projectGitHubItem(item));
    const bytes = canonicalJsonBytes(selected);
    const pageHash = sha256(bytes);
    if (previousHash === pageHash && selected.length > 0) {
      return { ok: false, error: { code: 'PAGINATION_UNSTABLE', message: `GitHub page ${page} repeats the previous page` } };
    }
    let overlapItemCount = 0;
    let acceptedItemCount = 0;
    let deferredItemCount = 0;
    for (let index = 0; index < response.value.value.length; index += 1) {
      const raw = response.value.value[index];
      const projected = selected[index];
      const identity = endpoint.identity(raw);
      const eventTime = endpoint.eventTime(raw);
      if (!identity) return { ok: false, error: { code: endpoint.path.includes('/timeline') ? 'TIMELINE_IDENTITY_UNAVAILABLE' : 'RESOURCE_IDENTITY_UNAVAILABLE', message: `Stable identity is missing for ${endpoint.path}` } };
      if (!eventTime || !validDate(eventTime)) return { ok: false, error: { code: 'RESOURCE_TIME_UNAVAILABLE', message: `Event time is missing for ${identity}` } };
      if (identities.has(identity)) return { ok: false, error: { code: 'PAGINATION_UNSTABLE', message: `duplicate identity on ${endpoint.path}` } };
      identities.add(identity);
      const observed = validDate(eventTime)!;
      if (fromInclusive && observed.getTime() < fromInclusive.getTime()) {
        overlapItemCount += 1;
      } else if (observed.getTime() >= watermark.getTime()) {
        deferredItemCount += 1;
        if (endpoint.includeResource?.(raw) !== false) deferred.add(identity);
      } else {
        acceptedItemCount += 1;
        if (endpoint.includeResource?.(raw) === false) continue;
        const resourceBytes = canonicalJsonBytes(projected);
        const rawRecord = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
        const routeNumber = typeof rawRecord.number === 'number' ? rawRecord.number : undefined;
        const added = addResource({
          sourceKind: 'github-rest',
          sourceIdentity: identity,
          resourceIdentity: identity,
          sha256: sha256(resourceBytes),
          bytes: resourceBytes.length,
          content: resourceBytes.toString('utf8'),
          disposition: { state: 'included' },
          role: 'resource',
          eventTime,
          ...(routeNumber !== undefined ? { routeNumber } : {}),
          ...(endpoint.parentIdentity ? { parentIdentity: endpoint.parentIdentity } : {}),
          pageSha256: pageHash
        }, identity, eventTime);
        if (!added.ok) return added;
      }
    }
    const pageEvidence: RestPageEvidence = {
      index: page,
      itemCount: response.value.value.length,
      canonicalSha256: pageHash,
      queryMode,
      ...(queryAfter ? { requestedSince: queryAfter } : {}),
      responseDate: dateResult.value.iso,
      overlapItemCount,
      acceptedItemCount,
      deferredItemCount
    };
    pages.push(pageEvidence);
    objects.push({
      sourceKind: 'github-rest',
      sourceIdentity: `${endpoint.path}#page=${page}`,
      sha256: pageHash,
      bytes: bytes.length,
      content: bytes.toString('utf8'),
      disposition: { state: 'included' },
      role: 'page-evidence',
      endpoint: endpoint.path,
      page,
      queryMode,
      ...(queryAfter ? { requestedSince: queryAfter } : {}),
      responseDate: dateResult.value.iso
    });
    previousHash = pageHash;
    const links = response.value.metadata.links.join(' ');
    if (response.value.value.length < perPage) {
      if (/rel=["']next["']/.test(links)) return { ok: false, error: { code: 'PAGINATION_UNSTABLE', message: `short page ${page} has a next link` } };
      break;
    }
  }
  const accepted = pages.reduce((sum, page) => sum + (page.acceptedItemCount ?? 0), 0);
  const observed = pages.reduce((sum, page) => sum + page.itemCount, 0);
  if (endpoint.maxItems !== undefined && observed >= endpoint.maxItems) {
    return { ok: false, error: { code: 'PLATFORM_LIMIT_REACHED', message: `GitHub endpoint ${endpoint.path} reached its documented ${endpoint.maxItems}-item limit` } };
  }
  const evidence: RestCollectionEvidence = {
    endpoint: endpoint.path,
    requestCount: pages.length,
    dataPageCount: pages.filter((page) => page.itemCount > 0).length,
    itemCount: accepted,
    termination: 'short-page',
    pages,
    queryMode,
    ...(queryAfter ? { requestedSince: queryAfter } : {})
  };
  // The caller adds these after all resources are known so page evidence stays separate from resource hashes.
  for (const object of objects) {
    const added = addResource(object, object.sourceIdentity, object.eventTime ?? watermark.toISOString());
    if (!added.ok) return added;
  }
  return { ok: true, value: evidence };
}

function collectGitHubBoundary(repoRoot: string, options: BoundaryCaptureOptions = {}): ProcessResult<GitHubBoundaryCapture> {
  const client = options.client ?? createGitHubClient();
  const repoResult = client.json<{ nameWithOwner?: string }>(['repo', 'view', '--json', 'nameWithOwner'], { cwd: repoRoot });
  if (!repoResult.ok) return { ok: false, error: repoResult.error };
  const repository = repoResult.value.nameWithOwner;
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository) || !client.jsonWithMetadata) {
    return { ok: false, error: { code: 'INVALID_PLATFORM_RESPONSE', message: 'GitHub repository identity or response metadata is missing' } };
  }
  const preflightResult = client.jsonWithMetadata<unknown>(['api', `repos/${repository}`]);
  if (!preflightResult.ok) return { ok: false, error: preflightResult.error };
  const preflightDate = responseDateOrError(preflightResult.value.metadata.date);
  if (!preflightDate.ok) return preflightDate;
  const watermark = new Date(truncateSecond(preflightDate.value.date));
  const fromInclusive = options.fromInclusive ? validDate(options.fromInclusive) : null;
  if (options.fromInclusive && !fromInclusive) return { ok: false, error: { code: 'CHECKPOINT_INVALID', message: 'Checkpoint watermark is invalid' } };
  if (fromInclusive && watermark.getTime() <= fromInclusive.getTime()) {
    return { ok: false, error: { code: 'OBSERVATION_BOUNDARY_INVALID', message: 'Observation cutoff is not after checkpoint watermark' } };
  }
  const reconciliation = options.reconciliation ?? 'incremental';
  const allObjects: CapturedObject[] = [];
  const resources = new Map<string, CapturedObject>();
  const pageObjects: CapturedObject[] = [];
  const endpoints: RestCollectionEvidence[] = [];
  const deferred = new Set<string>();
  const unavailable = new Set<string>();
  const responseDates = [preflightDate.value.iso];
  const addResource = (object: CapturedObject, identity: string): ProcessResult<void> => {
    if (object.role === 'page-evidence') {
      pageObjects.push(object);
      return { ok: true, value: undefined };
    }
    if (identity) {
      const existing = resources.get(identity);
      if (existing && (existing.sha256 !== object.sha256 || existing.parentIdentity !== object.parentIdentity)) {
        return { ok: false, error: { code: 'RESOURCE_IDENTITY_COLLISION', message: `Conflicting GitHub resources share identity ${identity}` } };
      }
      if (!existing) resources.set(identity, object);
    }
    return { ok: true, value: undefined };
  };
  const collect = (endpoint: EndpointDescriptor): ProcessResult<void> => {
    const result = collectBoundaryCollection(client, endpoint, preflightDate.value.date, fromInclusive, watermark, reconciliation, addResource, deferred, responseDates);
    if (!result.ok) return result;
    endpoints.push(result.value);
    return { ok: true, value: undefined };
  };
  const issueEndpoint = `repos/${repository}/issues?state=all&sort=created&direction=asc`;
  const pullEndpoint = `repos/${repository}/pulls?state=all&sort=created&direction=asc`;
  for (const endpoint of [
    descriptor(issueEndpoint, 'strict-since', 'issue', issueOrPullIdentity, { includeResource: (item) => !isPullRequestIssue(item) }),
    descriptor(pullEndpoint, 'full-enumeration', 'pr')
  ]) {
    const result = collect(endpoint);
    if (!result.ok) return result;
  }
  const issueNumbers = new Set<string>();
  const pullNumbers = new Set<string>();
  const issueRoots = new Map<string, CapturedObject>();
  const pullRoots = new Map<string, CapturedObject>();
  for (const resource of resources.values()) {
    if (resource.routeNumber === undefined || !resource.resourceIdentity) continue;
    if (resource.resourceIdentity.startsWith('pr:')) {
      const number = String(resource.routeNumber);
      pullNumbers.add(number);
      pullRoots.set(number, resource);
    } else if (resource.resourceIdentity.startsWith('issue:')) {
      const number = String(resource.routeNumber);
      issueNumbers.add(number);
      issueRoots.set(number, resource);
    }
  }
  for (const number of issueNumbers) {
    const parentIdentity = issueRoots.get(number)?.resourceIdentity;
    const result = collect(descriptor(`repos/${repository}/issues/${number}/comments`, 'strict-since', 'comment', undefined, { parentIdentity }));
    if (!result.ok) return result;
    const timeline = collect(descriptor(
      `repos/${repository}/issues/${number}/timeline`,
      'full-enumeration',
      'timeline',
      (item) => timelineIdentity(item, number),
      { parentIdentity }
    ));
    if (!timeline.ok) return timeline;
  }
  for (const number of pullNumbers) {
    const expected = pullRoots.get(number);
    let expectedHead: string | undefined;
    if (expected?.content) {
      try {
        expectedHead = ((JSON.parse(expected.content) as Record<string, unknown>).head as Record<string, unknown> | undefined)?.sha as string | undefined;
      } catch {
        expectedHead = undefined;
      }
    }
    const current = client.jsonWithMetadata<unknown>(['api', `repos/${repository}/pulls/${number}`]);
    if (!current.ok) return { ok: false, error: current.error };
    const currentDate = responseDateOrError(current.value.metadata.date);
    if (!currentDate.ok) return currentDate;
    if (currentDate.value.date.getTime() < preflightDate.value.date.getTime()) {
      return { ok: false, error: { code: 'OBSERVATION_BOUNDARY_INVALID', message: `Response Date precedes preflight for pull request ${number}` } };
    }
    responseDates.push(currentDate.value.iso);
    const currentProjected = projectGitHubItem(current.value.value) as Record<string, unknown>;
    const currentHead = (currentProjected.head as Record<string, unknown> | undefined)?.sha;
    if (expectedHead && currentHead !== expectedHead) {
      return { ok: false, error: { code: 'SOURCE_DRIFT', message: `Pull request ${number} head changed during capture` } };
    }
    const parentIdentity = expected?.resourceIdentity;
    const conversationComments = collect(descriptor(`repos/${repository}/issues/${number}/comments`, 'strict-since', 'comment', undefined, { parentIdentity }));
    if (!conversationComments.ok) return conversationComments;
    for (const suffix of ['comments', 'reviews', 'commits']) {
      const mode: EndpointQueryMode = suffix === 'reviews' || suffix === 'commits' ? 'full-enumeration' : 'strict-since';
      const prefix = suffix === 'comments' ? 'review-comment' : suffix === 'reviews' ? 'review' : 'commit';
      const result = collect(descriptor(
        `repos/${repository}/pulls/${number}/${suffix}`,
        mode,
        prefix,
        undefined,
        { parentIdentity, ...(suffix === 'commits' ? { maxItems: 250 } : {}) }
      ));
      if (!result.ok) return result;
    }
    const timeline = collect(descriptor(
      `repos/${repository}/issues/${number}/timeline`,
      'full-enumeration',
      'timeline',
      (item) => timelineIdentity(item, number),
      { parentIdentity }
    ));
    if (!timeline.ok) return timeline;
  }
  allObjects.push(...pageObjects, ...resources.values());
  return {
    ok: true,
    value: {
      repository,
      preflightDate: preflightDate.value.iso,
      watermark: watermark.toISOString(),
      objects: allObjects,
      endpoints,
      responseDates: [...new Set(responseDates)].sort(),
      deferred: [...deferred].sort(),
      unavailable: [...unavailable].sort()
    }
  };
}

export { collectGitHubBoundary, collectGitHubObjects, collectLocalObjects, fetchRestCollection, projectGitHubItem, projectGitHubTimelineItem, resolveGitHubRepository };
export type { BoundaryCaptureOptions, FetchRestCollectionOptions, GitHubBoundaryCapture, GitHubCapture, RestCollection };
