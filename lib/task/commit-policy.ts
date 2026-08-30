import type { OperationWarning } from './operation-outcome.ts';

type CommitPushPolicy = Readonly<{
  branch: string;
}>;

type CommitPushDecision = Readonly<{
  shouldPush: boolean;
  warning: OperationWarning | null;
}>;

function commitPushDecision(policy: CommitPushPolicy, target: string): CommitPushDecision {
  const branch = policy.branch.trim();
  if (branch === 'main' || branch === 'master') return {
    shouldPush: false,
    warning: {
      code: 'COMMIT_AUTOPUSH_PROTECTED_BRANCH',
      message: `Automatic commit push is disabled for protected branch '${branch}'`,
      retryable: false,
      step: 'push',
      target,
      severity: 'IMPORTANT'
    }
  };
  return { shouldPush: true, warning: null };
}

export { commitPushDecision };
export type { CommitPushDecision, CommitPushPolicy };
