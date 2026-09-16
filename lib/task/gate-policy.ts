import type { VerificationStatus } from './verification-types.ts';

export type GateClassification = 'hard' | 'soft' | 'info';

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

const OPTIONAL_PLATFORM_AUDITS = new Set([
  'closed-status-labels', 'status-label', 'comment-marker', 'pr-comment-marker',
  'pr-comment-last-commit', 'pr-comment-content', 'comment-content', 'task-comment-content',
  'in-labels-computed', 'pr-type-label', 'in-labels-match-pr', 'pr-assignee',
  'requirements', 'issue-type', 'issue-fields', 'milestone'
]);

export function classificationForCheck(checkId: string): GateClassification {
  return checkId.startsWith('platform.') && OPTIONAL_PLATFORM_AUDITS.has(checkId.slice('platform.'.length))
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
    reason: record.reason ?? record.fail_type ?? (record.status === 'pass' ? 'OK' : 'CHECK_FAILED'),
    action: record.action ?? (record.status === 'pass' ? 'No action required' : 'Review the check evidence and retry after correction')
  };
}
