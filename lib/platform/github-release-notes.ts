import type { GitHubClient } from './github-client.ts';
import { createGitHubClient } from './github-client.ts';

type GitHubActorInput = {
  name?: string | null;
  email?: string | null;
  user?: { login?: string | null } | null;
};

type ReleaseNoteActor = {
  name: string;
  email: string | null;
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
    email,
    login,
    bot: Boolean(login?.endsWith('[bot]')),
    resolution: platformLogin ? 'platform-user' : noReplyLogin ? 'platform-noreply' : 'unresolved'
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
  const history = [];
  for (const item of releases.value.filter((entry) => !entry.isDraft && !entry.isPrerelease).slice(0, input.historyLimit)) {
    const viewed = client.json<{ body?: string; url?: string }>(
      ['release', 'view', String(item.tagName), '--repo', input.repository, '--json', 'body,url'],
      { cwd: options.cwd }
    );
    if (!viewed.ok) return failure(viewed.error);
    history.push({ tag: String(item.tagName), body: String(viewed.value.body || ''), url: viewed.value.url || null });
  }
  const prs = client.json<Array<Record<string, unknown>>>(
    ['pr', 'list', '--repo', input.repository, '--state', 'merged', '--base', input.branch, '--limit', '1000', '--json', 'number,title,body,url,mergedAt,labels,author,closingIssuesReferences'],
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
  return { status: 'no-op' as const, changed: false, history, pullRequests, authors, error: null };
}

export { fetchGitHubReleaseNoteData, normalizeGitHubActor, publishGitHubReleaseNotes };
export type { ReleaseNoteActor };
