import { createGitHubClient } from './github-client.ts';
import type { GitHubClient } from './github-client.ts';
import { resolvePlatformContext } from './context.ts';
import { platformResult } from './types.ts';

type ReleaseSnapshot = { tag: string; published: boolean; draft: boolean; url: string | null };
type ReleaseOptions = { cwd?: string; client?: GitHubClient };

function flattenPages(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => Array.isArray(entry) ? entry : [entry]).filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object');
}

function inspectPlatformRelease(tag: string, options: ReleaseOptions = {}) {
  const client = options.client ?? createGitHubClient();
  const context = resolvePlatformContext({ cwd: options.cwd, client });
  if (!context.platform.repository) return { ...platformResult(context.status), platform: context.platform, release: null, workflows: [], error: context.error };
  const result = client.json<Record<string, unknown>>(['release', 'view', tag, '--repo', context.platform.repository, '--json', 'tagName,isDraft,url'], { cwd: options.cwd });
  if (!result.ok) {
    if (result.error.code === 'RESOURCE_NOT_FOUND') return { ...platformResult('no-op'), platform: context.platform, release: null, workflows: [], error: null };
    return { ...platformResult(result.error.retryable ? 'blocked' : 'failed'), platform: context.platform, release: null, workflows: [], error: result.error };
  }
  const release: ReleaseSnapshot = { tag: String(result.value.tagName || tag), published: !Boolean(result.value.isDraft), draft: Boolean(result.value.isDraft), url: result.value.url ? String(result.value.url) : null };
  const runs = client.json<unknown[]>(['run', 'list', '--repo', context.platform.repository, '--limit', '100', '--json', 'name,workflowName,displayTitle,event,headBranch,headSha,status,conclusion,createdAt,databaseId,attempt,url'], { cwd: options.cwd });
  return { ...platformResult(runs.ok ? 'no-op' : runs.error.retryable ? 'blocked' : 'degraded'), platform: context.platform, release, workflows: runs.ok ? runs.value : [], error: runs.ok ? null : runs.error };
}

function upsertPlatformRelease(input: { tag: string; title?: string; notesFile?: string }, options: ReleaseOptions = {}) {
  const inspected = inspectPlatformRelease(input.tag, options);
  if (inspected.release?.published) return { ...inspected, status: 'no-op' as const, changed: false, operations: [] };
  if (inspected.status === 'blocked' || inspected.status === 'failed') return { ...inspected, changed: false, operations: [] };
  if (!inspected.platform.repository) return { ...inspected, status: 'no-op' as const, changed: false, operations: [] };
  const client = options.client ?? createGitHubClient();
  const args = ['release', 'create', input.tag, '--repo', inspected.platform.repository!, '--title', input.title ?? input.tag];
  if (input.notesFile) args.push('--notes-file', input.notesFile); else args.push('--generate-notes');
  const created = client.text(args, { cwd: options.cwd, method: 'POST' });
  if (!created.ok) return { ...inspected, status: created.error.retryable ? 'blocked' as const : 'failed' as const, changed: false, operations: [{ name: 'create-release', status: 'failed' }], error: created.error };
  return { ...inspectPlatformRelease(input.tag, options), status: 'applied' as const, changed: true, operations: [{ name: 'create-release', status: 'applied' }] };
}

function reconcileReleaseMilestones(version: string, options: ReleaseOptions = {}) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return { status: 'failed' as const, changed: false, operations: [], error: { code: 'RELEASE_VERSION_INVALID', message: `Invalid version '${version}'` } };
  const client = options.client ?? createGitHubClient();
  const context = resolvePlatformContext({ cwd: options.cwd, client });
  if (!context.platform.repository) return { ...platformResult(context.status), changed: false, operations: [], error: context.error };
  const listed = client.json<unknown>(['api', '--paginate', '--slurp', `repos/${context.platform.repository}/milestones?state=all&per_page=100`], { cwd: options.cwd });
  if (!listed.ok) return { ...platformResult(listed.error.retryable ? 'blocked' : 'failed'), changed: false, operations: [], error: listed.error };
  const milestones = flattenPages(listed.value).map((item) => ({ title: String(item.title || ''), number: Number(item.number), state: String(item.state || '') }));
  const major = Number(match[1]); const minor = Number(match[2]); const patch = Number(match[3]);
  const nextPatch = `${major}.${minor}.${patch + 1}`;
  const currentLine = `${major}.${minor}.x`;
  const ensure = [
    { title: nextPatch, description: `Issues that we want to release in v${nextPatch}.` },
    { title: currentLine, description: `Issues that we want to resolve in ${major}.${minor} line.` }
  ];
  if (patch === 0) {
    const nextMinor = `${major}.${minor + 1}.0`;
    const nextLine = `${major}.${minor + 1}.x`;
    ensure.push(
      { title: nextMinor, description: `Issues that we want to release in v${nextMinor}.` },
      { title: nextLine, description: `Issues that we want to resolve in ${major}.${minor + 1} line.` }
    );
  }
  const operations: Array<{ name: string; title: string; status: 'applied' | 'no-op' | 'failed' }> = [];
  const current = milestones.find((item) => item.title === version);
  if (current && current.state !== 'closed') {
    const closed = client.json(['api', '--method', 'PATCH', `repos/${context.platform.repository}/milestones/${current.number}`, '-f', 'state=closed'], { cwd: options.cwd });
    operations.push({ name: 'close-milestone', title: version, status: closed.ok ? 'applied' : 'failed' });
  } else operations.push({ name: 'close-milestone', title: version, status: 'no-op' });
  for (const { title, description } of ensure) {
    if (milestones.some((item) => item.title === title)) operations.push({ name: 'ensure-milestone', title, status: 'no-op' });
    else {
      const created = client.json(['api', '--method', 'POST', `repos/${context.platform.repository}/milestones`, '-f', `title=${title}`, '-f', `description=${description}`], { cwd: options.cwd });
      operations.push({ name: 'ensure-milestone', title, status: created.ok ? 'applied' : 'failed' });
    }
  }
  const failed = operations.some((operation) => operation.status === 'failed');
  const changed = operations.some((operation) => operation.status === 'applied');
  return { status: failed ? 'failed' as const : changed ? 'applied' as const : 'no-op' as const, changed, operations, error: failed ? { code: 'MILESTONE_RECONCILE_FAILED', message: 'One or more milestone operations failed' } : null };
}

export { inspectPlatformRelease, reconcileReleaseMilestones, upsertPlatformRelease };
