type ManualOverrideCapability = Readonly<{
  failureId: string;
  operator: string;
  reason: string;
}>;

type GuardProducer = Readonly<{
  producerId: string;
  guardId: `G-${string}`;
  code: string;
}>;

const guardProducerCatalog: readonly GuardProducer[] = [
  { producerId: 'task.resolve', guardId: 'G-01', code: 'TASK_NOT_FOUND' },
  { producerId: 'task.resolve', guardId: 'G-01', code: 'TASK_IDENTITY_CONFLICT' },
  { producerId: 'task.write', guardId: 'G-02', code: 'TASK_STATE_MISMATCH' },
  { producerId: 'task-event', guardId: 'G-04', code: 'TASK_STATE_MISMATCH' },
  { producerId: 'task-event', guardId: 'G-04', code: 'EVENT_TRANSITION_INVALID' },
  { producerId: 'task-event', guardId: 'G-04', code: 'EVENT_START_MISSING' },
  { producerId: 'task-verify', guardId: 'G-05', code: 'VERIFY_TASK_STATE_MISMATCH' },
  { producerId: 'task-verify', guardId: 'G-05', code: 'VERIFY_ARTIFACT_INVALID' },
  { producerId: 'verification-engine', guardId: 'G-06', code: 'CHECK_FAILED' },
  { producerId: 'verification-engine', guardId: 'G-06', code: 'CHECK_BLOCKED' },
  { producerId: 'activity-intent', guardId: 'G-07', code: 'TASK_STATE_MISMATCH' },
  { producerId: 'ledger-intent', guardId: 'G-07', code: 'TASK_STATE_MISMATCH' },
  { producerId: 'decision-intent', guardId: 'G-07', code: 'TASK_STATE_MISMATCH' },
  { producerId: 'workflow-warning', guardId: 'G-07', code: 'TASK_STATE_MISMATCH' },
  { producerId: 'review-finalization', guardId: 'G-07', code: 'TASK_STATE_MISMATCH' },
  { producerId: 'ledger-intent', guardId: 'G-08', code: 'LEDGER_TRANSITION_INVALID' },
  { producerId: 'lifecycle-execution', guardId: 'G-09', code: 'ORCHESTRATION_STANDALONE_BUSY' },
  { producerId: 'lifecycle-execution', guardId: 'G-09', code: 'ORCHESTRATION_PROVENANCE_MISMATCH' },
  { producerId: 'lifecycle-execution', guardId: 'G-09', code: 'ORCHESTRATION_STATE_INVALID' },
  { producerId: 'platform.issue', guardId: 'G-10', code: 'PLATFORM_BIND_FAILED' },
  { producerId: 'platform.pull-request', guardId: 'G-10', code: 'PLATFORM_BIND_FAILED' }
];

function guardFailureId(producerId: string, code: string): string {
  return `${producerId}:${code}`;
}

function allowsManualOverride(
  capability: ManualOverrideCapability | undefined,
  producerId: string,
  code: string
): boolean {
  return capability?.failureId === guardFailureId(producerId, code);
}

export { allowsManualOverride, guardFailureId, guardProducerCatalog };
export type { GuardProducer, ManualOverrideCapability };
