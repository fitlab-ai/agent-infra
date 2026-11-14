import type { GitHubClient } from './github-client.ts';
import { createGitHubClient } from './github-client.ts';
import { providerErrorRetryable } from './provider-validation.ts';

type GitHubActorInput = {
  name?: string | null;
  email?: string | null;
  user?: { login?: string | null } | null;
};

type ReleaseNoteActor = {
  name: string;
  login: string | null;
  bot: boolean;
  resolution: 'platform-user' | 'platform-noreply' | 'unresolved';
};

type GitHubReleaseNoteOptions = { cwd?: string; client?: GitHubClient };

function normalizeGitHubActor(actor: GitHubActorInput): ReleaseNoteActor {
  const name = String(actor.name || '').trim();
  const email = actor.email ? String(actor.email).trim() : null;
  const platformLogin = actor.user?.login?.trim().toLowerCase() || null;
  const noReplyLogin = email
    ? /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(email)?.[1]?.toLowerCase() || null
    : null;
  const login = platformLogin || noReplyLogin;
  return {
    name,
    login,
    bot: Boolean(login?.endsWith('[bot]')),
    resolution: platformLogin ? 'platform-user' : noReplyLogin ? 'platform-noreply' : 'unresolved'
  };
}

function normalizePlatformAuthor(author: { login?: string | null } | null | undefined): ReleaseNoteActor | null {
  if (!author) return null;
  const login = author.login?.trim().toLowerCase() || null;
  return {
    name: login || '',
    login,
    bot: Boolean(login?.endsWith('[bot]')),
    resolution: login ? 'platform-user' : 'unresolved'
  };
}

function failure(error: { code: string; message: string; retryable?: boolean }) {
  const retryable = error.retryable ?? providerErrorRetryable(error.code);
  return {
    status: retryable ? 'blocked' as const : 'failed' as const,
    changed: false,
    operation: null,
    url: null,
    error: { code: error.code, message: error.message }
  };
}

function publishGitHubReleaseNotes(
  input: { repository: string; tag: string; title: string; notesFile: string; dryRun?: boolean },
  options: GitHubReleaseNoteOptions = {}
) {
  const client = options.client ?? createGitHubClient();
  const inspected = client.json<{ url?: string }>(
    ['release', 'view', input.tag, '--repo', input.repository, '--json', 'url'],
    { cwd: options.cwd }
  );
  if (!inspected.ok && inspected.error.code !== 'RESOURCE_NOT_FOUND') return failure(inspected.error);
  const exists = inspected.ok;
  const operation = exists ? 'release:update-notes' as const : 'release:create' as const;
  if (input.dryRun) {
    return {
      status: 'planned' as const,
      changed: false,
      operation,
      url: inspected.ok ? inspected.value.url || null : null,
      error: null
    };
  }
  const args = exists
    ? ['release', 'edit', input.tag, '--repo', input.repository, '--notes-file', input.notesFile]
    : ['release', 'create', input.tag, '--repo', input.repository, '--title', input.title, '--notes-file', input.notesFile];
  const written = client.text(args, { cwd: options.cwd, method: exists ? 'PATCH' : 'POST' });
  if (!written.ok) return failure(written.error);
  return {
    status: 'applied' as const,
    changed: true,
    operation,
    url: written.value || (inspected.ok ? inspected.value.url || null : null),
    error: null
  };
}

function collectReleaseHistory(
  client: GitHubClient,
  input: { repository: string; historyLimit: number },
  options: GitHubReleaseNoteOptions
): Array<{ tag: string; body: string; url: string | null }> | ReturnType<typeof failure> {
  const releases = client.json<Array<{ tagName?: string; isDraft?: boolean; isPrerelease?: boolean }>>(
    ['release', 'list', '--repo', input.repository, '--limit', String(input.historyLimit + 10), '--json', 'tagName,isDraft,isPrerelease'],
    { cwd: options.cwd }
  );
  if (!releases.ok) return failure(releases.error);
  const history: Array<{ tag: string; body: string; url: string | null }> = [];
  for (const item of releases.value.filter((entry) => !entry.isDraft && !entry.isPrerelease).slice(0, input.historyLimit)) {
    const viewed = client.json<{ body?: string; url?: string }>(
      ['release', 'view', String(item.tagName), '--repo', input.repository, '--json', 'body,url'],
      { cwd: options.cwd }
    );
    if (!viewed.ok) return failure(viewed.error);
    history.push({ tag: String(item.tagName), body: String(viewed.value.body || ''), url: viewed.value.url || null });
  }
  return history;
}

function collectEligiblePullRequests(
  client: GitHubClient,
  input: { repository: string; branch: string; fromTime: string; toTime: string },
  options: GitHubReleaseNoteOptions
): Array<Record<string, unknown>> | ReturnType<typeof failure> {
  const prs = client.json<Array<Record<string, unknown>>>(
    ['pr', 'list', '--repo', input.repository, '--state', 'merged', '--base', input.branch, '--limit', '1000', '--json', 'number,title,body,url,mergedAt,labels,author'],
    { cwd: options.cwd }
  );
  if (!prs.ok) return failure(prs.error);
  const fromTime = Date.parse(input.fromTime);
  const toTime = Date.parse(input.toTime);
  return prs.value.filter((item) => {
    const mergedAt = Date.parse(String(item.mergedAt || ''));
    return Number.isFinite(mergedAt) && mergedAt > fromTime && mergedAt <= toTime;
  });
}

function collectCommitAuthors(
  oid: string,
  connection: { nodes?: GitHubActorInput[]; pageInfo?: { hasNextPage?: boolean } } | undefined
): ReleaseNoteActor[] | ReturnType<typeof failure> {
  if (connection?.pageInfo?.hasNextPage) {
    return failure({ code: 'RELEASE_NOTES_AUTHORS_TRUNCATED', message: `Commit authors exceeded the supported page size for ${oid}`, retryable: false });
  }
  return (connection?.nodes || []).map(normalizeGitHubActor);
}

function collectAssociatedPullRequestNumbers(
  oid: string,
  associatedPullRequests: {
    nodes?: Array<{ number?: number | null }>;
    pageInfo?: { hasNextPage?: boolean };
  } | undefined,
  eligiblePullRequestNumbers: Set<number>
): number[] | ReturnType<typeof failure> {
  if (!associatedPullRequests || !Array.isArray(associatedPullRequests.nodes) || !associatedPullRequests.pageInfo || typeof associatedPullRequests.pageInfo.hasNextPage !== 'boolean') {
    return failure({ code: 'INVALID_PLATFORM_RESPONSE', message: `Associated pull request data is incomplete for commit ${oid}`, retryable: false });
  }
  if (associatedPullRequests.pageInfo.hasNextPage) {
    return failure({ code: 'RELEASE_NOTES_ASSOCIATED_PULL_REQUESTS_TRUNCATED', message: `Associated pull requests exceeded the supported page size for ${oid}`, retryable: false });
  }
  const numbers: number[] = [];
  for (const association of associatedPullRequests.nodes) {
    if (typeof association?.number !== 'number' || !Number.isSafeInteger(association.number)) {
      return failure({ code: 'INVALID_PLATFORM_RESPONSE', message: `Associated pull request identity is incomplete for commit ${oid}`, retryable: false });
    }
    if (eligiblePullRequestNumbers.has(association.number)) numbers.push(association.number);
  }
  return [...new Set(numbers)];
}

function collectCommitFact(
  client: GitHubClient,
  repository: string,
  oid: string,
  eligiblePullRequestNumbers: Set<number>,
  options: GitHubReleaseNoteOptions
): { authors: ReleaseNoteActor[]; pullRequestNumbers: number[] } | ReturnType<typeof failure> {
  const query = `query($owner:String!,$name:String!,$oid:GitObjectID!){repository(owner:$owner,name:$name){object(oid:$oid){... on Commit{authors(first:100){nodes{name email user{login}} pageInfo{hasNextPage}} associatedPullRequests(first:100){nodes{number} pageInfo{hasNextPage}}}}}}`;
  const [owner, name] = repository.split('/');
  const result = client.json<{
    data?: { repository?: { object?: {
      authors?: { nodes?: GitHubActorInput[]; pageInfo?: { hasNextPage?: boolean } };
      associatedPullRequests?: {
        nodes?: Array<{ number?: number | null }>;
        pageInfo?: { hasNextPage?: boolean };
      };
    } } };
  }>([
    'api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `oid=${oid}`
  ], { cwd: options.cwd });
  if (!result.ok) return failure(result.error);
  const object = result.value.data?.repository?.object;
  const authors = collectCommitAuthors(oid, object?.authors);
  if (!Array.isArray(authors)) return authors;
  const pullRequestNumbers = collectAssociatedPullRequestNumbers(oid, object?.associatedPullRequests, eligiblePullRequestNumbers);
  if (!Array.isArray(pullRequestNumbers)) return pullRequestNumbers;
  return { authors, pullRequestNumbers };
}

function collectCommitFacts(
  client: GitHubClient,
  input: { repository: string; commitOids: string[] },
  eligiblePullRequestNumbers: Set<number>,
  options: GitHubReleaseNoteOptions
): { authorsByCommit: Map<string, ReleaseNoteActor[]>; pullRequestNumbersByCommit: Map<string, number[]> } | ReturnType<typeof failure> {
  const authorsByCommit = new Map<string, ReleaseNoteActor[]>();
  const pullRequestNumbersByCommit = new Map<string, number[]>();
  for (const oid of input.commitOids) {
    const fact = collectCommitFact(client, input.repository, oid, eligiblePullRequestNumbers, options);
    if ('status' in fact) return fact;
    authorsByCommit.set(oid, fact.authors);
    pullRequestNumbersByCommit.set(oid, fact.pullRequestNumbers);
  }
  return { authorsByCommit, pullRequestNumbersByCommit };
}

function collectClosingIssues(
  client: GitHubClient,
  repository: string,
  pullRequestNumber: unknown,
  options: GitHubReleaseNoteOptions
): Array<{ number: number; title: string; url: string; author: ReleaseNoteActor | null }> | ReturnType<typeof failure> {
  const [owner, name] = repository.split('/');
  const query = 'query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:100,after:$cursor){nodes{number title url author{login}} pageInfo{hasNextPage endCursor}}}}}';
  const issues: Array<{ number: number; title: string; url: string; author: ReleaseNoteActor | null }> = [];
  let cursor: string | null = null;
  for (;;) {
    const args = ['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${String(pullRequestNumber)}`];
    if (cursor) args.push('-F', `cursor=${cursor}`);
    const response = client.json<{
      data?: { repository?: { pullRequest?: { closingIssuesReferences?: {
        nodes?: Array<{ number?: number; title?: string; url?: string; author?: { login?: string | null } | null }>;
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      } } } };
    }>(args, { cwd: options.cwd });
    if (!response.ok) return failure(response.error);
    const connection = response.value.data?.repository?.pullRequest?.closingIssuesReferences;
    if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo || typeof connection.pageInfo.hasNextPage !== 'boolean') {
      return failure({ code: 'INVALID_PLATFORM_RESPONSE', message: `Closing Issue data is incomplete for pull request ${String(pullRequestNumber)}`, retryable: false });
    }
    issues.push(...connection.nodes.map((issue) => ({
      number: Number(issue.number), title: String(issue.title || ''), url: String(issue.url || ''),
      author: normalizePlatformAuthor(issue.author)
    })));
    if (!connection.pageInfo.hasNextPage) return issues;
    if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === cursor) {
      return failure({ code: 'PAGINATION_INVALID', message: `Closing Issue pagination is incomplete for pull request ${String(pullRequestNumber)}`, retryable: false });
    }
    cursor = connection.pageInfo.endCursor;
  }
}

function fetchGitHubReleaseNoteData(
  input: { repository: string; commitOids: string[]; branch: string; historyLimit: number; fromTime: string; toTime: string },
  options: GitHubReleaseNoteOptions = {}
) {
  const client = options.client ?? createGitHubClient();
  const history = collectReleaseHistory(client, input, options);
  if (!Array.isArray(history)) return history;
  const pullRequests = collectEligiblePullRequests(client, input, options);
  if (!Array.isArray(pullRequests)) return pullRequests;
  const eligiblePullRequestNumbers = new Set(pullRequests.map((item) => Number(item.number)));
  const commitFacts = collectCommitFacts(client, input, eligiblePullRequestNumbers, options);
  if (!('authorsByCommit' in commitFacts)) return commitFacts;
  const resolvedPullRequests = [];
  for (const item of pullRequests) {
    const closingIssues = collectClosingIssues(client, input.repository, item.number, options);
    if (!Array.isArray(closingIssues)) return closingIssues;
    resolvedPullRequests.push({
      ...item,
      author: normalizePlatformAuthor((item.author as { login?: string | null } | null) || null),
      closingIssues
    });
  }
  const commits = input.commitOids.map((sha) => ({
    sha,
    url: `https://github.com/${input.repository}/commit/${sha}`,
    pullRequestNumbers: commitFacts.pullRequestNumbersByCommit.get(sha) || [],
    authors: commitFacts.authorsByCommit.get(sha) || []
  }));
  return { status: 'no-op' as const, changed: false, history, pullRequests: resolvedPullRequests, commits, error: null };
}

export { fetchGitHubReleaseNoteData, normalizeGitHubActor, publishGitHubReleaseNotes };
export type { ReleaseNoteActor };
