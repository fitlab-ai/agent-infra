import { inspectRequiredChecks } from './pr-checks.ts';

type VerificationStatus = 'pass' | 'fail' | 'blocked';
type VerificationCheck = { type: string; status: VerificationStatus; message: string; fail_type?: string };

function verificationCheck(type: string, status: VerificationStatus, message: string, failType?: string): VerificationCheck {
  return { type, status, message, ...(failType ? { fail_type: failType } : {}) };
}

export { inspectRequiredChecks, verificationCheck };
export type { VerificationCheck, VerificationStatus };
