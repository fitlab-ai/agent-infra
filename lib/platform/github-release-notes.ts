import type { GitHubClient } from './github-client.ts';
import { createGitHubClient } from './github-client.ts';

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

function failure(error: { code: string; message: string; retryable: boolean }) {
  return {
    status: error.retryable ? 'blocked' as const : 'failed' as const,
    changed: false,
    operation: null,
    url: null,
    error
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

function fetchGitHubReleaseNoteData(
  input: { repository: string; commitOids: string[]; branch: string; historyLimit: number; fromTime: string; toTime: string },
  options: GitHubReleaseNoteOptions = {}
) {
  const client = options.client ?? createGitHubClient();
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
  const prs = client.json<Array<Record<string, unknown>>>(
    ['pr', 'list', '--repo', input.repository, '--state', 'merged', '--base', input.branch, '--limit', '1000', '--json', 'number,title,body,url,mergedAt,labels,author'],
    { cwd: options.cwd }
  );
  if (!prs.ok) return failure(prs.error);
  const authors = new Map<string, ReleaseNoteActor[]>();
  for (const oid of input.commitOids) {
    const query = `query($owner:String!,$name:String!,$oid:GitObjectID!){repository(owner:$owner,name:$name){object(oid:$oid){... on Commit{authors(first:100){nodes{name email user{login}} pageInfo{hasNextPage}}}}}}`;
    const [owner, name] = input.repository.split('/');
    const result = client.json<{
      data?: { repository?: { object?: { authors?: { nodes?: GitHubActorInput[]; pageInfo?: { hasNextPage?: boolean } } } } };
    }>([
      'api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `oid=${oid}`
    ], { cwd: options.cwd });
    if (!result.ok) return failure(result.error);
    const connection = result.value.data?.repository?.object?.authors;
    if (connection?.pageInfo?.hasNextPage) {
      return failure({ code: 'RELEASE_NOTES_AUTHORS_TRUNCATED', message: `Commit authors exceeded the supported page size for ${oid}`, retryable: false });
    }
    authors.set(oid, (connection?.nodes || []).map(normalizeGitHubActor));
  }
  const fromTime = Date.parse(input.fromTime);
  const toTime = Date.parse(input.toTime);
  const pullRequests = prs.value.filter((item) => {
    const mergedAt = Date.parse(String(item.mergedAt || ''));
    return Number.isFinite(mergedAt) && mergedAt > fromTime && mergedAt <= toTime;
  });
  const resolvedPullRequests = [];
  const [owner, name] = input.repository.split('/');
  const closingIssuesQuery = 'query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:100,after:$cursor){nodes{number title url author{login}} pageInfo{hasNextPage endCursor}}}}}';
  const pullRequestCommitsQuery = 'query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){commits(first:100,after:$cursor){nodes{commit{oid}} pageInfo{hasNextPage endCursor}}}}}';
  const pullRequestNumbersByCommit = new Map<string, number[]>();
  for (const item of pullRequests) {
    const commitShas: string[] = [];
    let commitCursor: string | null = null;
    for (;;) {
      const args = ['api', 'graphql', '-f', `query=${pullRequestCommitsQuery}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${String(item.number)}`];
      if (commitCursor) args.push('-F', `cursor=${commitCursor}`);
      const response = client.json<{
        data?: { repository?: { pullRequest?: { commits?: {
          nodes?: Array<{ commit?: { oid?: string } }>;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        } } } };
      }>(args, { cwd: options.cwd });
      if (!response.ok) return failure(response.error);
      const connection = response.value.data?.repository?.pullRequest?.commits;
      if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo || typeof connection.pageInfo.hasNextPage !== 'boolean') {
        return failure({ code: 'INVALID_PLATFORM_RESPONSE', message: `Pull request commit data is incomplete for ${String(item.number)}`, retryable: false });
      }
      for (const node of connection.nodes) {
        const oid = node.commit?.oid;
        if (!oid) return failure({ code: 'INVALID_PLATFORM_RESPONSE', message: `Pull request commit identity is incomplete for ${String(item.number)}`, retryable: false });
        commitShas.push(oid);
      }
      if (!connection.pageInfo.hasNextPage) break;
      if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === commitCursor) {
        return failure({ code: 'PAGINATION_INVALID', message: `Pull request commit pagination is incomplete for ${String(item.number)}`, retryable: false });
      }
      commitCursor = connection.pageInfo.endCursor;
    }
    for (const sha of commitShas) {
      const numbers = pullRequestNumbersByCommit.get(sha) || [];
      numbers.push(Number(item.number));
      pullRequestNumbersByCommit.set(sha, numbers);
    }
    const closingIssues = [];
    let cursor: string | null = null;
    for (;;) {
      const args = ['api', 'graphql', '-f', `query=${closingIssuesQuery}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${String(item.number)}`];
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
        return failure({ code: 'INVALID_PLATFORM_RESPONSE', message: `Closing Issue data is incomplete for pull request ${String(item.number)}`, retryable: false });
      }
      closingIssues.push(...connection.nodes.map((issue) => ({
        number: Number(issue.number), title: String(issue.title || ''), url: String(issue.url || ''),
        author: normalizePlatformAuthor(issue.author)
      })));
      if (!connection.pageInfo.hasNextPage) break;
      if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === cursor) {
        return failure({ code: 'PAGINATION_INVALID', message: `Closing Issue pagination is incomplete for pull request ${String(item.number)}`, retryable: false });
      }
      cursor = connection.pageInfo.endCursor;
    }
    resolvedPullRequests.push({
      ...item,
      commitShas,
      author: normalizePlatformAuthor((item.author as { login?: string | null } | null) || null),
      closingIssues
    });
  }
  const commits = input.commitOids.map((sha) => ({
    sha,
    url: `https://github.com/${input.repository}/commit/${sha}`,
    pullRequestNumbers: pullRequestNumbersByCommit.get(sha) || [],
    authors: authors.get(sha) || []
  }));
  return { status: 'no-op' as const, changed: false, history, pullRequests: resolvedPullRequests, commits, error: null };
}

export { fetchGitHubReleaseNoteData, normalizeGitHubActor, publishGitHubReleaseNotes };
export type { ReleaseNoteActor };
