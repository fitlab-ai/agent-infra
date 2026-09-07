import { createHash } from 'node:crypto';

export type ControlRecoveryOutcome = 'not-executed' | 'in-progress' | 'success' | 'failure' | 'unknown' | 'rejected';

export type ControlRecoveryOperation = Readonly<{
  family: 'task-lifecycle' | 'task-finalization' | 'task-orchestration' | 'task-create' | 'codex-controller';
  intent: string;
  class: string;
  mutatesDomain: boolean;
}>;

export type ControlRecoveryBinding = Readonly<{
  requestId: string;
  generation: string;
  taskId: string | null;
  intentDigest: string;
}>;

export type ControlRecoveryInput = Readonly<{
  operation: ControlRecoveryOperation;
  binding: ControlRecoveryBinding;
  startedCommitted: boolean;
  terminalResult?: Readonly<Record<string, unknown>> | null;
  domain?: Readonly<Record<string, unknown>> | null;
  journal?: Readonly<{
    exists: boolean;
    completedSteps?: readonly string[];
    failure?: string | null;
  }> | null;
  explicitRejection?: boolean;
  evidenceConflict?: boolean;
}>;

export type ControlRecoveryDecision = Readonly<{
  outcome: ControlRecoveryOutcome;
  responseReconstructable: boolean;
  reasonCode: string;
}>;

const LIFECYCLE_INTENTS = ['block', 'activate', 'cancel', 'complete', 'close-codescan', 'close-dependabot', 'restore'] as const;
const ORCHESTRATION_INTENTS = [
  'begin-or-resume', 'route.read', 'route.clean-completion', 'status', 'prepare', 'dispatch',
  'await-activation', 'recover-prepared', 'hook-start', 'hook-stop', 'advance', 'pause'
] as const;

export const SANDBOX_CONTROL_RECOVERY_OPERATIONS: readonly ControlRecoveryOperation[] = Object.freeze([
  ...LIFECYCLE_INTENTS.map((intent) => ({ family: 'task-lifecycle' as const, intent, class: 'lifecycle-mutation', mutatesDomain: true })),
  { family: 'task-finalization', intent: 'complete', class: 'finalization', mutatesDomain: true },
  ...ORCHESTRATION_INTENTS.map((intent) => ({
    family: 'task-orchestration' as const,
    intent,
    class: intent === 'route.clean-completion' ? 'route.clean-completion' : intent === 'route.read' || intent === 'status' ? 'read-only' : 'orchestration',
    mutatesDomain: !['route.read', 'status'].includes(intent)
  })),
  { family: 'task-create', intent: 'create', class: 'task-create', mutatesDomain: true },
  ...(['open', 'close', 'verify'] as const).map((intent) => ({ family: 'codex-controller' as const, intent, class: 'codex-controller', mutatesDomain: intent !== 'verify' }))
]);

export function digestControlRecoveryIntent(family: string, intent: string): string {
  return createHash('sha256').update(`${family}\0${intent}`, 'utf8').digest('hex');
}

export function findSandboxControlRecoveryOperation(family: ControlRecoveryOperation['family'], intent: string): ControlRecoveryOperation | null {
  return SANDBOX_CONTROL_RECOVERY_OPERATIONS.find((operation) => operation.family === family && operation.intent === intent) ?? null;
}

function bindingMatchesResult(binding: ControlRecoveryBinding, result: Readonly<Record<string, unknown>>): boolean {
  return result.requestId === binding.requestId
    && result.generation === binding.generation
    && (result.taskId === undefined || result.taskId === binding.taskId)
    && (result.intentDigest === undefined || result.intentDigest === binding.intentDigest);
}

function domainEvidenceMatches(operation: ControlRecoveryOperation, domain: Readonly<Record<string, unknown>> | null | undefined): boolean {
  if (!domain) return false;
  if (operation.class === 'route.clean-completion') {
    const completion = domain.completionEvidence as Record<string, unknown> | undefined;
    return domain.status === 'completed'
      && domain.pendingDelegation === null
      && completion?.kind === 'reviewed-head-clean'
      && typeof completion.observedAt === 'number'
      && typeof completion.head === 'string'
      && typeof completion.headTree === 'string'
      && typeof completion.worktreeTree === 'string'
      && typeof completion.lastReviewedCommit === 'string';
  }
  if (operation.class === 'read-only') return domain.snapshotValid === true;
  return domain.consistent === true;
}

export function classifySandboxControlRecovery(input: ControlRecoveryInput): ControlRecoveryDecision {
  const result = input.terminalResult ?? null;
  if (input.evidenceConflict) return { outcome: 'unknown', responseReconstructable: false, reasonCode: 'RECOVERY_EVIDENCE_CONFLICT' };
  if (input.explicitRejection && !input.startedCommitted) {
    return { outcome: 'not-executed', responseReconstructable: true, reasonCode: 'RECOVERY_EXPLICIT_REJECTION' };
  }
  if (!input.startedCommitted) {
    return { outcome: 'not-executed', responseReconstructable: false, reasonCode: 'RECOVERY_NOT_STARTED' };
  }
  if (!result) return { outcome: 'in-progress', responseReconstructable: false, reasonCode: 'RECOVERY_TERMINAL_RESULT_MISSING' };
  if (!bindingMatchesResult(input.binding, result)) {
    return { outcome: 'unknown', responseReconstructable: false, reasonCode: 'RECOVERY_RESULT_BINDING_MISMATCH' };
  }
  const status = result.status;
  const failed = status === 'failed' || result.error !== null && result.error !== undefined;
  if (failed) {
    if (input.operation.mutatesDomain && input.domain && input.domain.consistent === false) {
      return { outcome: 'failure', responseReconstructable: true, reasonCode: 'RECOVERY_TERMINAL_FAILURE' };
    }
    return { outcome: 'unknown', responseReconstructable: false, reasonCode: 'RECOVERY_FAILURE_EVIDENCE_INCOMPLETE' };
  }
  if (input.operation.class === 'route.clean-completion' && result.changed !== true
    && input.domain?.status === 'completed' && domainEvidenceMatches(input.operation, input.domain)) {
    return { outcome: 'success', responseReconstructable: true, reasonCode: 'RECOVERY_ROUTE_COMPLETION_NOOP' };
  }
  if (!domainEvidenceMatches(input.operation, input.domain)) {
    if (input.journal?.exists && (input.journal.completedSteps?.length ?? 0) > 0) {
      return { outcome: 'in-progress', responseReconstructable: false, reasonCode: 'RECOVERY_DOMAIN_EVIDENCE_INCOMPLETE' };
    }
    return { outcome: 'unknown', responseReconstructable: false, reasonCode: 'RECOVERY_DOMAIN_EVIDENCE_MISSING' };
  }
  if (input.operation.family === 'task-lifecycle' && input.journal?.exists) {
    return { outcome: input.journal.failure ? 'failure' : 'unknown', responseReconstructable: false, reasonCode: 'RECOVERY_LIFECYCLE_JOURNAL_PRESENT' };
  }
  return { outcome: 'success', responseReconstructable: true, reasonCode: 'RECOVERY_TERMINAL_AND_DOMAIN_MATCH' };
}

export function operationRecoveryBinding(
  requestId: string,
  generation: string,
  taskId: string | null,
  family: string,
  intent: string
): ControlRecoveryBinding {
  return { requestId, generation, taskId, intentDigest: digestControlRecoveryIntent(family, intent) };
}
