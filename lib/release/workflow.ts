type ReleasePhase = 'unprepared' | 'prepared' | 'partially-published' | 'published' | 'post-pending' | 'complete';
type ReleaseFacts = { localTag: boolean; localTagAncestor?: boolean; localTagConflict?: boolean; remoteBranch: boolean; remoteTag: boolean; githubRelease: boolean | null; npm: boolean | null; homebrew: boolean | null; smoke: 'success' | 'pending' | 'failed' | null; postCommit: boolean };

function deriveReleasePhase(facts: ReleaseFacts): ReleasePhase {
  if (!facts.localTag && !facts.localTagAncestor) return 'unprepared';
  if (!facts.remoteBranch && !facts.remoteTag) return 'prepared';
  if (!facts.remoteBranch || !facts.remoteTag) return 'partially-published';
  if (facts.githubRelease !== true || facts.npm !== true || facts.homebrew !== true) return 'published';
  if (facts.smoke !== 'success' || !facts.postCommit) return 'post-pending';
  return 'complete';
}

function releaseSnapshot(version: string, facts: ReleaseFacts) {
  return { version, tag: `v${version.replace(/^v/, '')}`, phase: deriveReleasePhase(facts), facts };
}

async function runReleaseAction(input: { version: string; action: 'inspect' | 'prepare' | 'publish' | 'post'; inspect: () => Promise<ReleaseFacts>; prepare?: () => Promise<void>; publish?: () => Promise<void>; post?: () => Promise<void> }) {
  const before = releaseSnapshot(input.version, await input.inspect());
  if (input.action === 'inspect') return { status: 'no-op' as const, changed: false, before, snapshot: before, error: null };
  if (before.facts.localTagConflict) return { status: 'failed' as const, changed: false, before, snapshot: before, error: { code: 'GIT_TAG_CONFLICT', message: `Tag ${before.tag} is not reachable from HEAD` } };
  const allowed = input.action === 'prepare' ? before.phase === 'unprepared'
    : input.action === 'publish' ? before.facts.localTag && ['prepared', 'partially-published'].includes(before.phase)
      : ['published', 'post-pending'].includes(before.phase);
  if (!allowed) return { status: before.phase === 'complete' ? 'no-op' as const : 'failed' as const, changed: false, before, snapshot: before, error: before.phase === 'complete' ? null : { code: 'RELEASE_PHASE_INVALID', message: `Cannot ${input.action} from ${before.phase}` } };
  await input[input.action]?.();
  const snapshot = releaseSnapshot(input.version, await input.inspect());
  const progressed = snapshot.phase !== before.phase;
  return { status: progressed ? 'applied' as const : 'blocked' as const, changed: progressed, before, snapshot, error: progressed ? null : { code: 'RELEASE_PROGRESS_PENDING', message: `${input.action} has not reached the next observable phase` } };
}

export { deriveReleasePhase, releaseSnapshot, runReleaseAction };
export type { ReleaseFacts, ReleasePhase };
