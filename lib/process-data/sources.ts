import fs from 'node:fs';
import path from 'node:path';

import { createGitHubClient } from '../platform/github-client.ts';
import { enumerateAllTaskDirs } from '../task/resolve-ref.ts';
import { captureText, inspectPrivacy, redactExcerpt } from './privacy.ts';
import { canonicalJsonBytes, sha256 } from './store.ts';

import type { GitHubClient } from '../platform/github-client.ts';
import type {
  CapturedObject,
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

export { collectGitHubObjects, collectLocalObjects, fetchRestCollection, projectGitHubItem };
export type { FetchRestCollectionOptions, GitHubCapture, RestCollection };
