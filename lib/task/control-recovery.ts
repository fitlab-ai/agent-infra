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
  criticalPhases?: readonly string[];
  domain?: Readonly<Record<string, unknown>> | null;
  journal?: Readonly<{
    exists: boolean;
    completedSteps?: readonly string[];
    failure?: string | null;
  }> | null;
  explicitRejection?: boolean;
  evidenceConflict?: boolean;
}>;

export const SANDBOX_CONTROL_REQUIRED_COMPLETION_PHASES = Object.freeze([
  'completed', 'evidence-written', 'publish-authorized'
] as const);

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

function domainEvidenceMatches(
  operation: ControlRecoveryOperation,
  result: Readonly<Record<string, unknown>>,
  domain: Readonly<Record<string, unknown>> | null | undefined
): boolean {
  if (!domain) return false;
  if (domain.consistent !== true) return false;
  if (operation.class === 'route.clean-completion') {
    const completion = domain.completionEvidence as Record<string, unknown> | undefined;
    const snapshot = domain.snapshot as Record<string, unknown> | undefined;
    const lastReviewedCommit = domain.lastReviewedCommit;
    return result.status === 'completed'
      && domain.status === 'completed'
      && domain.pendingDelegation === null
      && completion?.kind === 'reviewed-head-clean'
      && typeof completion.observedAt === 'string'
      && typeof completion.head === 'string'
      && typeof completion.headTree === 'string'
      && typeof completion.worktreeTree === 'string'
      && typeof completion.lastReviewedCommit === 'string'
      && snapshot?.head === completion.head
      && snapshot.headTree === completion.headTree
      && snapshot.worktreeTree === completion.worktreeTree
      && lastReviewedCommit === completion.lastReviewedCommit;
  }
  if (operation.class === 'read-only') return result.changed === false && domain.snapshotValid === true;
  return true;
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
  if (!result) return { outcome: 'unknown', responseReconstructable: false, reasonCode: 'RECOVERY_TERMINAL_RESULT_MISSING' };
  if (!bindingMatchesResult(input.binding, result)) {
    return { outcome: 'unknown', responseReconstructable: false, reasonCode: 'RECOVERY_RESULT_BINDING_MISMATCH' };
  }
  if (!SANDBOX_CONTROL_REQUIRED_COMPLETION_PHASES.every((phase) => input.criticalPhases?.includes(phase))) {
    return { outcome: 'unknown', responseReconstructable: false, reasonCode: 'RECOVERY_CRITICAL_AUDIT_INCOMPLETE' };
  }
  const status = result.status;
  const failed = status === 'failed' || result.error !== null && result.error !== undefined;
  if (failed) {
    if (input.domain && input.domain.consistent === false) {
      return { outcome: 'failure', responseReconstructable: true, reasonCode: 'RECOVERY_TERMINAL_FAILURE' };
    }
    return { outcome: 'unknown', responseReconstructable: false, reasonCode: 'RECOVERY_FAILURE_EVIDENCE_INCOMPLETE' };
  }
  if (result.changed === null) {
    return { outcome: 'unknown', responseReconstructable: false, reasonCode: 'RECOVERY_RESULT_CHANGE_FLAG_MISSING' };
  }
  if (!domainEvidenceMatches(input.operation, result, input.domain)) {
    if (input.journal?.exists && (input.journal.completedSteps?.length ?? 0) > 0) {
      return { outcome: 'in-progress', responseReconstructable: false, reasonCode: 'RECOVERY_DOMAIN_EVIDENCE_INCOMPLETE' };
    }
    return { outcome: 'unknown', responseReconstructable: false, reasonCode: 'RECOVERY_DOMAIN_EVIDENCE_MISSING' };
  }
  if (input.operation.family === 'task-lifecycle' && input.journal?.exists) {
    if (input.journal.failure) {
      return { outcome: 'failure', responseReconstructable: true, reasonCode: 'RECOVERY_LIFECYCLE_JOURNAL_FAILURE' };
    }
    return {
      outcome: input.journal.completedSteps && input.journal.completedSteps.length > 0 ? 'in-progress' : 'unknown',
      responseReconstructable: false,
      reasonCode: 'RECOVERY_LIFECYCLE_JOURNAL_PRESENT'
    };
  }
  return {
    outcome: 'success',
    responseReconstructable: true,
    reasonCode: input.operation.class === 'route.clean-completion' && result.changed === false
      ? 'RECOVERY_ROUTE_COMPLETION_NOOP'
      : 'RECOVERY_TERMINAL_AND_DOMAIN_MATCH'
  };
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
