import crypto from 'node:crypto';

type ReleasePhase = 'unprepared' | 'prepared' | 'partially-published' | 'published' | 'post-pending' | 'post-prepared' | 'complete';
type PostReleaseFacts = {
  commit: string | null;
  isHead: boolean;
  published: boolean;
  branch: string;
  upstream: string | null;
  remoteHead: string | null;
  newVersion: string | null;
  changedPaths: string[];
  demoInputSha256: string | null;
  worktree: string[];
  staged: string[];
};
type ReleaseFacts = {
  localTag: boolean;
  localTagAncestor?: boolean;
  localTagConflict?: boolean;
  remoteBranch: boolean;
  remoteTag: boolean;
  githubRelease: boolean | null;
  npm: boolean | null;
  homebrew: boolean | null;
  smoke: 'success' | 'pending' | 'failed' | null;
  post: PostReleaseFacts;
};
type PostConfirmation = {
  version: string;
  commit: string;
  branch: string;
  upstream: string | null;
  remoteHead: string | null;
  newVersion: string | null;
  changedPaths: string[];
  demoInputSha256: string | null;
  worktree: string[];
  staged: string[];
  sha256: string;
};

function byteSort(values: readonly string[]): string[] {
  return [...values].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

function deriveReleasePhase(facts: ReleaseFacts): ReleasePhase {
  if (!facts.localTag && !facts.localTagAncestor) return 'unprepared';
  if (facts.post.commit) return facts.post.published ? 'complete' : 'post-prepared';
  if (!facts.remoteBranch && !facts.remoteTag) return 'prepared';
  if (!facts.remoteBranch || !facts.remoteTag) return 'partially-published';
  if (facts.githubRelease !== true || facts.npm !== true || facts.homebrew !== true) return 'published';
  return 'post-pending';
}

function createPostConfirmation(version: string, post: PostReleaseFacts): PostConfirmation | null {
  if (!post.commit || !post.isHead || post.worktree.length || post.staged.length) return null;
  const canonical = {
    version,
    commit: post.commit,
    branch: post.branch,
    upstream: post.upstream,
    remoteHead: post.remoteHead,
    newVersion: post.newVersion,
    changedPaths: byteSort(post.changedPaths),
    demoInputSha256: post.demoInputSha256,
    worktree: byteSort(post.worktree),
    staged: byteSort(post.staged)
  };
  const sha256 = `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex')}`;
  return { ...canonical, sha256 };
}

function releaseSnapshot(version: string, facts: ReleaseFacts) {
  const snapshot = { version, tag: `v${version.replace(/^v/, '')}`, phase: deriveReleasePhase(facts), facts };
  const postConfirmation = createPostConfirmation(version, facts.post);
  return postConfirmation ? { ...snapshot, postConfirmation } : snapshot;
}

export { createPostConfirmation, deriveReleasePhase, releaseSnapshot };
export type { PostConfirmation, PostReleaseFacts, ReleaseFacts, ReleasePhase };
