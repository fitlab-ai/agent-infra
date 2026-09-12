export type RecoveryWarning = Readonly<{ code: string; message: string; action: string }>;

function warningText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && !/[\r\n]/u.test(value);
}

export function isRecoveryWarning(value: unknown): value is RecoveryWarning {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const warning = value as Record<string, unknown>;
  return Object.keys(warning).sort().join(',') === 'action,code,message'
    && warningText(warning.code)
    && warningText(warning.message)
    && warningText(warning.action);
}

export function sameRecoveryWarning(left: unknown, right: unknown): boolean {
  return isRecoveryWarning(left) && isRecoveryWarning(right)
    && left.code === right.code
    && left.message === right.message
    && left.action === right.action;
}
