import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { resolvePlatformContext, resolvePlatformProviderContext } from './context.ts';
import {
  fetchGitHubReleaseNoteData,
  publishGitHubReleaseNotes
} from './github-release-notes.ts';
import type { ReleaseNoteActor } from './github-release-notes.ts';
import type { GitHubClient } from './github-client.ts';
import { providerError, providerOperationContext, providerStatus, unsupportedProviderOperation } from './provider-bridge.ts';

type ReleaseNoteOptions = {
  cwd?: string;
  platformType?: string;
  client?: GitHubClient;
};

type ReleaseNoteCommit = { oid: string; title: string; authors: ReleaseNoteActor[] };

const unsupportedError = {
  code: 'PLATFORM_RELEASE_NOTES_UNSUPPORTED',
  message: 'Release notes are not supported for the configured platform',
  retryable: false
};

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

function releaseNoteFailure(code: string, message: string) {
  return {
    status: 'failed' as const,
    changed: false,
    operation: null,
    url: null,
    error: { code, message, retryable: false }
  };
}

function normalizeReleaseNoteBytes(input: Uint8Array): Buffer {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(input);
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\n*$/, '') + '\n';
  return Buffer.from(normalized, 'utf8');
}

function releaseNoteSha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function stageReleaseNotes(
  input: { notesFile: string },
  options: Pick<ReleaseNoteOptions, 'cwd'> = {}
) {
  if (!input.notesFile || input.notesFile === '-') {
    return { status: 'failed' as const, changed: false, notesFile: null, sha256: null, byteLength: null, error: { code: 'RELEASE_NOTES_INPUT_INVALID', message: 'notes-file must identify an existing external file', retryable: false } };
  }
  const requestedPath = path.resolve(input.notesFile);
  let notesFile: string;
  let sourceStat: fs.Stats;
  try {
    if (fs.lstatSync(requestedPath).isSymbolicLink()) throw new Error('symbolic links are not allowed');
    notesFile = fs.realpathSync(requestedPath);
    sourceStat = fs.statSync(notesFile);
    const worktree = fs.realpathSync(path.resolve(options.cwd || process.cwd()));
    if (!sourceStat.isFile() || isWithin(worktree, notesFile)) throw new Error('path is not an external regular file');
  } catch {
    return { status: 'failed' as const, changed: false, notesFile: null, sha256: null, byteLength: null, error: { code: 'RELEASE_NOTES_PATH_INVALID', message: 'notes-file must be a regular file outside the current worktree and must not be a symbolic link', retryable: false } };
  }

  let original: Buffer;
  let normalized: Buffer;
  try {
    original = fs.readFileSync(notesFile);
    normalized = normalizeReleaseNoteBytes(original);
  } catch {
    return { status: 'failed' as const, changed: false, notesFile, sha256: null, byteLength: null, error: { code: 'RELEASE_NOTES_CONTENT_INVALID', message: 'notes-file must contain valid UTF-8', retryable: false } };
  }

  const changed = !original.equals(normalized);
  if (changed) {
    const temporary = path.join(
      path.dirname(notesFile),
      `.${path.basename(notesFile)}.${process.pid}.${Date.now()}.tmp`
    );
    try {
      fs.writeFileSync(temporary, normalized, { flag: 'wx', mode: sourceStat.mode });
      fs.renameSync(temporary, notesFile);
    } catch {
      fs.rmSync(temporary, { force: true });
      return { status: 'failed' as const, changed: false, notesFile, sha256: null, byteLength: null, error: { code: 'RELEASE_NOTES_STAGE_FAILED', message: 'notes-file could not be staged atomically', retryable: false } };
    }
  }
  return {
    status: changed ? 'applied' as const : 'no-op' as const,
    changed,
    notesFile,
    sha256: releaseNoteSha256(normalized),
    byteLength: normalized.byteLength,
    error: null
  };
}

function baseResult(status: 'no-op' | 'failed' | 'blocked') {
  return {
    status,
    changed: false,
    range: null,
    history: [],
    pullRequests: [],
    commits: [] as ReleaseNoteCommit[],
    error: status === 'no-op' ? unsupportedError : null
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function configuredPlatform(cwd: string): string | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(cwd, '.agents', '.airc.json'), 'utf8'));
    return typeof value?.platform?.type === 'string' ? value.platform.type : null;
  } catch {
    return null;
  }
}

async function releaseNoteContext(
  input: { fromTag: string; toTag: string; branch: string; historyLimit?: number },
  options: ReleaseNoteOptions = {}
) {
  const historyLimit = input.historyLimit ?? 3;
  if (!input.fromTag || !input.toTag || !input.branch || !Number.isInteger(historyLimit) || historyLimit < 1 || historyLimit > 20) {
    return { ...baseResult('failed'), error: { code: 'RELEASE_NOTES_INPUT_INVALID', message: 'from-tag, to-tag, branch, and a history limit from 1 to 20 are required', retryable: false } };
  }
  const cwd = path.resolve(options.cwd || process.cwd());
  const platformType = options.platformType ?? configuredPlatform(cwd);
  if (platformType !== 'github') {
    const loaded = await resolvePlatformProviderContext({ cwd, platformType: platformType || undefined, client: options.client });
    if (!loaded.ok) {
      if (loaded.context.status === 'no-op') return baseResult('no-op');
      const status = loaded.context.status === 'blocked'
        ? 'blocked'
        : 'failed';
      return { ...baseResult(status), error: loaded.context.error };
    }
    return loaded.value.providerType !== 'github'
      ? { ...baseResult('no-op'), error: { ...unsupportedError, message: `Platform '${loaded.value.providerType}' does not provide release-note collection` } }
      : baseResult('no-op');
  }
  let fromOid: string;
  let toOid: string;
  let fromTime: string;
  let toTime: string;
  let commitFacts: Array<{ oid: string; title: string }>;
  try {
    fromOid = git(cwd, ['rev-parse', '--verify', `${input.fromTag}^{commit}`]);
    toOid = git(cwd, ['rev-parse', '--verify', `${input.toTag}^{commit}`]);
    git(cwd, ['merge-base', '--is-ancestor', fromOid, toOid]);
    fromTime = git(cwd, ['show', '-s', '--format=%cI', fromOid]);
    toTime = git(cwd, ['show', '-s', '--format=%cI', toOid]);
    const raw = git(cwd, ['log', '--reverse', '--no-merges', '--format=%H%x00%s', `${fromOid}..${toOid}`]);
    commitFacts = raw ? raw.split('\n').map((line) => {
      const [oid = '', title = ''] = line.split('\0');
      return { oid, title };
    }) : [];
  } catch {
    return { ...baseResult('failed'), error: { code: 'RELEASE_NOTES_RANGE_INVALID', message: 'The release tag range is missing or is not ancestral', retryable: false } };
  }
  const context = await resolvePlatformContext({ cwd, platformType, client: options.client });
  if (!context.platform.repository) {
    return {
      ...baseResult(context.status === 'blocked' ? 'blocked' : 'failed'),
      error: context.error || { code: 'PLATFORM_CONTEXT_UNAVAILABLE', message: 'Platform repository is unavailable', retryable: context.status === 'blocked' }
    };
  }
  const platform = fetchGitHubReleaseNoteData(
    {
      repository: context.platform.repository,
      commitOids: commitFacts.map((item) => item.oid),
      branch: input.branch,
      historyLimit,
      fromTime,
      toTime
    },
    { cwd, client: options.client }
  );
  if (platform.status === 'blocked' || platform.status === 'failed' || !('authors' in platform)) {
    return { ...baseResult(platform.status), error: platform.error };
  }
  const commits = commitFacts.map((commit) => {
    const seen = new Set<string>();
    const authors = (platform.authors.get(commit.oid) || []).filter((actor) => {
      const key = actor.login || actor.email?.toLowerCase() || actor.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { ...commit, authors };
  });
  const pullRequests = platform.pullRequests
    .map((item) => ({
      number: Number(item.number),
      title: String(item.title || ''),
      body: String(item.body || ''),
      url: String(item.url || ''),
      mergedAt: String(item.mergedAt || ''),
      labels: Array.isArray(item.labels) ? item.labels.map((label) => String((label as { name?: string }).name || label)) : [],
      author: item.author && typeof item.author === 'object'
        ? { login: String((item.author as { login?: string }).login || '').toLowerCase(), bot: String((item.author as { login?: string }).login || '').endsWith('[bot]') }
        : null,
      closingIssues: Array.isArray(item.closingIssuesReferences)
        ? item.closingIssuesReferences.map((issue) => {
          const value = issue as Record<string, unknown>;
          return {
            number: Number(value.number),
            title: String(value.title || ''),
            url: String(value.url || ''),
            labels: Array.isArray(value.labels) ? value.labels.map((label) => String((label as { name?: string }).name || label)) : [],
            author: value.author && typeof value.author === 'object'
              ? { login: String((value.author as { login?: string }).login || '').toLowerCase(), bot: String((value.author as { login?: string }).login || '').endsWith('[bot]') }
              : null
          };
        }) : []
    }))
    .sort((left, right) => left.number - right.number);
  return {
    status: 'no-op' as const,
    changed: false,
    range: { fromTag: input.fromTag, toTag: input.toTag, fromOid, toOid },
    history: platform.history,
    pullRequests,
    commits,
    error: null
  };
}

async function publishReleaseNotes(
  input: { tag: string; title: string; notesFile: string; expectedSha256: string; dryRun?: boolean },
  options: ReleaseNoteOptions = {}
) {
  if (!input.tag || !input.title || !input.notesFile || !SHA256_PATTERN.test(input.expectedSha256)) {
    return releaseNoteFailure('RELEASE_NOTES_INPUT_INVALID', 'tag, title, notes-file, and expected-sha256 are required');
  }
  let actualSha256: string;
  try {
    actualSha256 = releaseNoteSha256(fs.readFileSync(input.notesFile));
  } catch {
    return releaseNoteFailure('RELEASE_NOTES_FILE_UNREADABLE', 'notes-file could not be read');
  }
  if (actualSha256 !== input.expectedSha256) {
    return releaseNoteFailure('RELEASE_NOTES_DIGEST_MISMATCH', 'notes-file does not match the confirmed SHA-256 digest');
  }
  const cwd = path.resolve(options.cwd || process.cwd());
  const platformType = options.platformType ?? configuredPlatform(cwd);
  const loaded = await resolvePlatformProviderContext({ cwd, platformType: platformType || undefined, client: options.client });
  if (!loaded.ok) {
    const status = loaded.context.status === 'blocked'
      ? 'blocked'
      : loaded.context.status === 'no-op' ? 'no-op' : 'failed';
    return {
      ...baseResult(status),
      error: loaded.context.error || { code: 'PLATFORM_PROVIDER_LOAD_FAILED', message: 'Selected provider failed to load', retryable: false }
    };
  }
  if (loaded.ok) {
    const context = loaded.value.context;
    if (!context.platform.repository) return { status: context.status === 'blocked' ? 'blocked' as const : 'failed' as const, changed: false, operation: null, url: null, error: context.error };
    const published = loaded.value.provider.releases?.publishNotes
      ? await loaded.value.provider.releases.publishNotes({
        context: providerOperationContext(loaded.value),
        release: { key: input.tag },
        title: input.title,
        notes: {
          text: fs.readFileSync(input.notesFile, 'utf8'),
          sha256: actualSha256,
          byteLength: fs.statSync(input.notesFile).size
        },
        mutation: { idempotencyKey: `release-notes:publish:${input.tag}` }
      })
      : unsupportedProviderOperation(loaded.value.provider, 'releases.publishNotes');
    if (!published.ok) return { status: providerStatus(published.error), changed: false, operation: null, url: null, error: providerError(published.error, 'PLATFORM_PROVIDER_OPERATION_FAILED') };
    return { status: 'applied' as const, changed: published.value.changed, operation: 'publish-notes', url: null, error: null };
  }
  return { status: 'failed' as const, changed: false, operation: null, url: null, error: { code: 'PLATFORM_PROVIDER_LOAD_FAILED', message: 'Selected provider failed to load', retryable: false } };
}

export {
  normalizeReleaseNoteBytes,
  publishReleaseNotes,
  releaseNoteContext,
  releaseNoteSha256,
  stageReleaseNotes
};
