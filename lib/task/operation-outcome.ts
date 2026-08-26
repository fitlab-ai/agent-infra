type OperationOutcome =
  | null
  | 'committed_with_warnings'
  | 'pr_created_with_warnings'
  | 'completed_with_warnings';

type OperationWarningSeverity = 'IMPORTANT' | 'ACTION_REQUIRED';

type OperationWarning = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
  step: string;
  target: string;
  severity: OperationWarningSeverity;
}>;

type OperationResultFields = Readonly<{
  outcome: OperationOutcome;
  warnings: readonly OperationWarning[];
}>;

function warningKey(warning: Pick<OperationWarning, 'step' | 'code' | 'target'>): string {
  return `${warning.step}\0${warning.code}\0${warning.target}`;
}

function mergeOperationWarnings(...groups: readonly (readonly OperationWarning[])[]): readonly OperationWarning[] {
  const merged = new Map<string, OperationWarning>();
  for (const group of groups) {
    for (const warning of group) {
      const canonical = {
        code: warning.code,
        message: warning.message,
        retryable: warning.retryable,
        step: warning.step,
        target: warning.target,
        severity: warning.severity
      } satisfies OperationWarning;
      merged.set(warningKey(canonical), canonical);
    }
  }
  return [...merged.values()];
}

const RETRY_HINTS: Readonly<Record<string, string>> = {
  COMMIT_AUTOPUSH_PROTECTED_BRANCH: 'Review the protected branch policy; push the local commit manually if delivery is intended.',
  COMMIT_PUSH_FAILED: 'Retry the commit push-only path after fixing the remote push failure.',
  PR_METADATA_SYNC_FAILED: 'Retry create-pr metadata synchronization; do not create another pull request.',
  PR_SUMMARY_SYNC_FAILED: 'Retry create-pr summary synchronization; do not create another pull request.',
  FINALIZATION_WARNING_PENDING: 'Retry complete-task to process the pending finalization step.'
};

function retryHintForWarning(warning: Pick<OperationWarning, 'code' | 'step'>): string {
  return RETRY_HINTS[warning.code]
    ?? `Retry the ${warning.step} operation after resolving ${warning.code}.`;
}

function operationResultFields(
  outcome: OperationOutcome = null,
  warnings: readonly OperationWarning[] = []
): OperationResultFields {
  return { outcome, warnings: mergeOperationWarnings(warnings) };
}

export { mergeOperationWarnings, operationResultFields, retryHintForWarning, warningKey };
export type { OperationOutcome, OperationResultFields, OperationWarning, OperationWarningSeverity };
