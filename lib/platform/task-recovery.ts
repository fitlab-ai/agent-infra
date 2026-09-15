import { decodeRecoveryAction, decodeRecoveryManifest } from '../task/recovery-actions.ts';
import { createHash } from 'node:crypto';

type RecoveryComment = { content: string };
type RecoveryRemoteComment = { body: string; user?: { login?: string } };

function markerPattern(taskId: string, kind: string): RegExp {
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^<!-- sync-issue:${escaped}:${kind}:([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?::(\\d+)\\/(\\d+))? -->$`);
}

function recoveryEnvelopeContent(body: string): string {
  const normalized = body.replace(/\r\n/g, '\n').replace(/\n+$/, '\n');
  const headerEnd = normalized.indexOf('\n\n', normalized.indexOf('\n> **'));
  const footerStart = normalized.lastIndexOf('\n\n---\n*由 ');
  if (headerEnd < 0 || footerStart <= headerEnd) throw new Error('RECOVERY_EVIDENCE_MISSING: recovery comment envelope is invalid');
  return normalized.slice(headerEnd + 2, footerStart).replace(/\n+$/, '');
}

function recoverTaskFromComments(input: { taskId: string; comments: readonly RecoveryRemoteComment[] }): string {
  const taskMarker = `<!-- sync-issue:${input.taskId}:task -->`;
  const taskComments = input.comments.filter(({ body }) => body.replace(/\r\n/g, '\n').split('\n', 1)[0] === taskMarker);
  if (taskComments.length !== 1) throw new Error('RECOVERY_EVIDENCE_MISSING: exactly one task snapshot comment is required');
  const trustedAuthor = taskComments[0]!.user?.login;
  if (!trustedAuthor) throw new Error('RECOVERY_EVIDENCE_MISSING: task snapshot author is unavailable');
  const snapshotBody = taskComments[0]!.body.replace(/\r\n/g, '\n').replace(/\n+$/, '\n');
  const snapshotSha256 = createHash('sha256').update(snapshotBody, 'utf8').digest('hex');

  const actionPattern = markerPattern(input.taskId, 'recovery-action');
  const preparePattern = markerPattern(input.taskId, 'recovery-prepare');
  const commitPattern = markerPattern(input.taskId, 'recovery-commit');
  const actions = new Map<string, Array<{ part: number; total: number; content: string }>>();
  const prepares: RecoveryComment[] = [];
  const commits: RecoveryComment[] = [];
  const seenMarkers = new Set<string>();

  for (const comment of input.comments) {
    const marker = comment.body.replace(/\r\n/g, '\n').split('\n', 1)[0] || '';
    const actionMatch = marker.match(actionPattern);
    const prepareMatch = marker.match(preparePattern);
    const commitMatch = marker.match(commitPattern);
    if (!actionMatch && !prepareMatch && !commitMatch) continue;
    if (comment.user?.login !== trustedAuthor) throw new Error('RECOVERY_EVIDENCE_MISSING: recovery comment author does not match task snapshot author');
    if (seenMarkers.has(marker)) throw new Error('RECOVERY_EVIDENCE_MISSING: duplicate recovery marker');
    seenMarkers.add(marker);
    const content = recoveryEnvelopeContent(comment.body);
    if (actionMatch) {
      const actionId = actionMatch[1]!;
      const part = actionMatch[2] ? Number(actionMatch[2]) : 1;
      const total = actionMatch[3] ? Number(actionMatch[3]) : 1;
      const parts = actions.get(actionId) || [];
      parts.push({ part, total, content });
      actions.set(actionId, parts);
      continue;
    }
    const manifest = decodeRecoveryManifest(JSON.parse(content));
    const expectedId = (prepareMatch || commitMatch)![1]!;
    const expectedPhase = prepareMatch ? 'prepare' : 'commit';
    if (manifest.taskId !== input.taskId || manifest.commitId !== expectedId || manifest.phase !== expectedPhase) {
      throw new Error('RECOVERY_EVIDENCE_MISSING: recovery manifest marker identity is invalid');
    }
    (prepareMatch ? prepares : commits).push({ content });
  }

  const decodedActions = [...actions.entries()].map(([actionId, parts]) => {
    const totals = new Set(parts.map(({ total }) => total));
    const total = parts[0]?.total || 0;
    const sorted = [...parts].sort((left, right) => left.part - right.part);
    if (totals.size !== 1 || total < 1 || sorted.length !== total || sorted.some(({ part }, index) => part !== index + 1)) {
      throw new Error('RECOVERY_EVIDENCE_MISSING: recovery action chunks are incomplete');
    }
    const content = sorted.map(({ content }) => content).join('');
    const action = decodeRecoveryAction(JSON.parse(content));
    if (action.taskId !== input.taskId || action.actionId !== actionId) {
      throw new Error('RECOVERY_EVIDENCE_MISSING: recovery action marker identity is invalid');
    }
    return { action, content };
  });
  const matchingCommits = commits
    .map(({ content }) => ({ content, manifest: decodeRecoveryManifest(JSON.parse(content)) }))
    .filter(({ manifest }) => manifest.snapshotSha256 === snapshotSha256);
  if (matchingCommits.length !== 1) throw new Error('RECOVERY_EVIDENCE_MISSING: task snapshot must have exactly one matching recovery commit');
  const commit = matchingCommits[0]!;
  const matchingActions = decodedActions.filter(({ action }) => action.actionSha256 === commit.manifest.actionHeadSha256);
  if (matchingActions.length !== 1) throw new Error('RECOVERY_EVIDENCE_MISSING: recovery commit action is missing or ambiguous');
  const matchingPrepares = prepares.filter(({ content }) => {
    const manifest = decodeRecoveryManifest(JSON.parse(content));
    return manifest.commitId === commit.manifest.commitId
      && manifest.snapshotSha256 === commit.manifest.snapshotSha256
      && manifest.actionHeadSha256 === commit.manifest.actionHeadSha256
      && manifest.actionCount === commit.manifest.actionCount;
  });
  if (matchingPrepares.length !== 1) throw new Error('RECOVERY_EVIDENCE_MISSING: recovery commit prepare is missing or ambiguous');
  return recoverTaskDocument({
    taskId: input.taskId,
    snapshotSha256,
    actions: [{ content: matchingActions[0]!.content }],
    prepares: matchingPrepares,
    commits: [{ content: commit.content }]
  });
}

function recoverTaskDocument(input: {
  taskId: string;
  snapshotSha256: string;
  actions: readonly RecoveryComment[];
  prepares: readonly RecoveryComment[];
  commits: readonly RecoveryComment[];
}): string {
  const actions = input.actions.map(({ content }) => decodeRecoveryAction(JSON.parse(content)));
  if (actions.length !== 1) throw new Error('RECOVERY_EVIDENCE_MISSING: exactly one task-document action is required');
  const action = actions[0]!;
  if (action.taskId !== input.taskId || action.sequence !== 1 || action.type !== 'task-document') {
    throw new Error('RECOVERY_EVIDENCE_MISSING: task-document action identity is invalid');
  }
  const payload = action.payload as { taskContent?: unknown };
  if (!payload || typeof payload.taskContent !== 'string') throw new Error('RECOVERY_EVIDENCE_MISSING: task-document payload is invalid');
  const prepares = input.prepares.map(({ content }) => decodeRecoveryManifest(JSON.parse(content)));
  const commits = input.commits.map(({ content }) => decodeRecoveryManifest(JSON.parse(content)));
  const commit = commits.find((candidate) => candidate.phase === 'commit' && candidate.taskId === input.taskId && candidate.snapshotSha256 === input.snapshotSha256 && candidate.actionCount === 1 && candidate.actionHeadSha256 === action.actionSha256);
  if (!commit) throw new Error('RECOVERY_EVIDENCE_MISSING: matching recovery commit is required');
  const prepare = prepares.find((candidate) => candidate.phase === 'prepare' && candidate.commitId === commit.commitId && candidate.snapshotSha256 === commit.snapshotSha256 && candidate.actionHeadSha256 === commit.actionHeadSha256 && candidate.actionCount === commit.actionCount);
  if (!prepare) throw new Error('RECOVERY_EVIDENCE_MISSING: matching recovery prepare is required');
  return payload.taskContent;
}

export { recoverTaskDocument, recoverTaskFromComments };
export type { RecoveryComment, RecoveryRemoteComment };
