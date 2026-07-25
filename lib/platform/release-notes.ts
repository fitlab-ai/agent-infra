import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { resolvePlatformContext } from './context.ts';
import {
  fetchGitHubReleaseNoteData,
  publishGitHubReleaseNotes
} from './github-release-notes.ts';
import type { ReleaseNoteActor } from './github-release-notes.ts';
import type { GitHubClient } from './github-client.ts';

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

function releaseNoteContext(
  input: { fromTag: string; toTag: string; branch: string; historyLimit?: number },
  options: ReleaseNoteOptions = {}
) {
  const historyLimit = input.historyLimit ?? 3;
  if (!input.fromTag || !input.toTag || !input.branch || !Number.isInteger(historyLimit) || historyLimit < 1 || historyLimit > 20) {
    return { ...baseResult('failed'), error: { code: 'RELEASE_NOTES_INPUT_INVALID', message: 'from-tag, to-tag, branch, and a history limit from 1 to 20 are required', retryable: false } };
  }
  const cwd = path.resolve(options.cwd || process.cwd());
  const platformType = options.platformType ?? configuredPlatform(cwd);
  if (platformType !== 'github') return baseResult('no-op');
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
  const context = resolvePlatformContext({ cwd, platformType, client: options.client });
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

function publishReleaseNotes(
  input: { tag: string; title: string; notesFile: string; dryRun?: boolean },
  options: ReleaseNoteOptions = {}
) {
  if (!input.tag || !input.title || !input.notesFile) {
    return { status: 'failed' as const, changed: false, operation: null, url: null, error: { code: 'RELEASE_NOTES_INPUT_INVALID', message: 'tag, title, and notes-file are required', retryable: false } };
  }
  const cwd = path.resolve(options.cwd || process.cwd());
  const platformType = options.platformType ?? configuredPlatform(cwd);
  if (platformType !== 'github') return { status: 'no-op' as const, changed: false, operation: null, url: null, error: unsupportedError };
  const context = resolvePlatformContext({ cwd, platformType, client: options.client });
  if (!context.platform.repository) {
    return { status: context.status === 'blocked' ? 'blocked' as const : 'failed' as const, changed: false, operation: null, url: null, error: context.error };
  }
  return publishGitHubReleaseNotes({ ...input, repository: context.platform.repository }, { cwd, client: options.client });
}

export { publishReleaseNotes, releaseNoteContext };
