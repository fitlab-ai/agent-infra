import { decodeRecoveryAction, decodeRecoveryManifest } from '../task/recovery-actions.ts';

type RecoveryComment = { content: string };

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
  const commit = commits.find((candidate) => candidate.taskId === input.taskId && candidate.snapshotSha256 === input.snapshotSha256 && candidate.actionCount === 1 && candidate.actionHeadSha256 === action.actionSha256);
  if (!commit) throw new Error('RECOVERY_EVIDENCE_MISSING: matching recovery commit is required');
  const prepare = prepares.find((candidate) => candidate.commitId === commit.commitId && candidate.snapshotSha256 === commit.snapshotSha256 && candidate.actionHeadSha256 === commit.actionHeadSha256 && candidate.actionCount === commit.actionCount);
  if (!prepare) throw new Error('RECOVERY_EVIDENCE_MISSING: matching recovery prepare is required');
  return payload.taskContent;
}

export { recoverTaskDocument };
export type { RecoveryComment };
