import type { VerificationStatus } from './verification-types.ts';

export type GateClassification = 'hard' | 'soft' | 'info';
export type PlatformAuditId =
  | 'closed-status-labels' | 'status-label' | 'comment-marker' | 'pr-comment-marker'
  | 'pr-comment-last-commit' | 'pr-comment-content' | 'comment-content' | 'task-comment-content'
  | 'in-labels-computed' | 'pr-type-label' | 'in-labels-match-pr' | 'pr-assignee'
  | 'requirements' | 'issue-type' | 'issue-fields' | 'milestone';

export type PlatformAuditPolicy = {
  classification: GateClassification;
  enabled: boolean;
  expectedStatusLabel?: string;
  expectedCommentMarkerKey?: 'artifact' | 'summary';
  expectedPrCommentMarkerKey?: 'prSummary';
  requireSpecificMilestone?: boolean;
};

export type VerificationRecord = {
  type: string;
  status: VerificationStatus;
  message: string;
  fail_type?: string;
  checkId?: string;
  classification?: GateClassification;
  effectiveStatus?: VerificationStatus;
  reason?: string;
  action?: string;
  dependsOn?: string;
  warnings?: string[];
  subchecks?: VerificationRecord[];
};

const OPTIONAL_PLATFORM_AUDITS = new Set<PlatformAuditId>([
  'closed-status-labels', 'status-label', 'comment-marker', 'pr-comment-marker',
  'pr-comment-last-commit', 'pr-comment-content', 'comment-content', 'task-comment-content',
  'in-labels-computed', 'pr-type-label', 'in-labels-match-pr', 'pr-assignee',
  'requirements', 'issue-type', 'issue-fields', 'milestone'
]);

const STATUS_LABELS: Record<string, string> = {
  'create-task': 'status: waiting-for-triage',
  'analyze-task': 'status: pending-design-work',
  'review-analysis': 'status: pending-design-work',
  'plan-task': 'status: pending-design-work',
  'review-plan': 'status: pending-design-work',
  'code-task': 'status: in-progress',
  'review-code': 'status: in-progress'
};

const ARTIFACT_COMMENT_SKILLS = new Set([
  'analyze-task', 'plan-task', 'review-analysis', 'review-plan', 'code-task',
  'review-code', 'review-pr', 'run-manual-validation'
]);
const PR_AUDIT_SKILLS = new Set(['create-pr']);
const IN_LABEL_AUDIT_SKILLS = new Set(['code-task', 'commit', 'create-pr']);

export function platformAuditPolicy(checkId: PlatformAuditId, context: { skillName?: string; artifactFile?: string | null }): PlatformAuditPolicy {
  const skillName = context.skillName || '';
  const artifactComment = Boolean(context.artifactFile) && ARTIFACT_COMMENT_SKILLS.has(skillName);
  const prAudit = PR_AUDIT_SKILLS.has(skillName);
  const inLabelAudit = IN_LABEL_AUDIT_SKILLS.has(skillName);

  switch (checkId) {
    case 'status-label':
      return { classification: 'soft', enabled: Boolean(STATUS_LABELS[skillName]), expectedStatusLabel: STATUS_LABELS[skillName] };
    case 'comment-marker':
      return { classification: 'soft', enabled: artifactComment || skillName === 'complete-task', expectedCommentMarkerKey: artifactComment ? 'artifact' : 'summary' };
    case 'pr-comment-marker':
      return { classification: 'soft', enabled: skillName === 'commit' || prAudit, expectedPrCommentMarkerKey: 'prSummary' };
    case 'pr-comment-last-commit':
      return { classification: 'soft', enabled: skillName === 'commit', expectedPrCommentMarkerKey: 'prSummary' };
    case 'pr-comment-content':
      return { classification: 'soft', enabled: skillName === 'complete-manual-validation' };
    case 'comment-content':
      return { classification: 'soft', enabled: artifactComment, expectedCommentMarkerKey: 'artifact' };
    case 'task-comment-content':
      return { classification: 'soft', enabled: true };
    case 'in-labels-computed':
      return { classification: 'soft', enabled: inLabelAudit };
    case 'pr-type-label':
    case 'in-labels-match-pr':
    case 'pr-assignee':
      return { classification: 'soft', enabled: prAudit };
    case 'requirements':
      return { classification: 'soft', enabled: skillName === 'complete-task' };
    case 'milestone':
      return { classification: 'soft', enabled: true, requireSpecificMilestone: skillName === 'code-task' };
    case 'closed-status-labels':
    case 'issue-type':
    case 'issue-fields':
      return { classification: 'soft', enabled: true };
  }
}

export function classificationForCheck(checkId: string): GateClassification {
  return checkId.startsWith('platform.') && OPTIONAL_PLATFORM_AUDITS.has(checkId.slice('platform.'.length) as PlatformAuditId)
    ? 'soft'
    : 'hard';
}

export function effectiveStatus(status: VerificationStatus, classification: GateClassification): VerificationStatus {
  return classification === 'hard' ? status : 'pass';
}

export function normalizeVerificationRecord(record: VerificationRecord): VerificationRecord {
  const checkId = record.checkId ?? record.type;
  const classification = record.classification ?? classificationForCheck(checkId);
  return {
    ...record,
    checkId,
    classification,
    effectiveStatus: record.effectiveStatus ?? effectiveStatus(record.status, classification),
    reason: record.reason ?? record.fail_type ?? (classification === 'info' ? 'NOT_APPLICABLE' : record.status === 'pass' ? 'OK' : 'CHECK_FAILED'),
    action: record.action ?? (classification === 'info' || record.status === 'pass' ? 'No action required' : 'Review the check evidence and retry after correction')
  };
}
