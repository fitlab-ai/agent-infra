import type fs from 'node:fs';

export type VerificationShared = {
  repoRoot: string;
  loadTask: (taskDir: string) => { ok: true; content: string; metadata: Record<string, string> } | { ok: false; message: string };
  getCheckedRequirements: (content: string) => string[];
  normalizeContent: (text: unknown) => string;
  isBlank: (value: unknown) => boolean;
  escapeRegExp: (value: string) => string;
  passResult: (type: string, message: string, warnings?: string[]) => VerificationCheckResult;
  failResult: (type: string, message: string, failType?: string) => VerificationCheckResult;
  blockedResult: (type: string, message: string, failType?: string) => VerificationCheckResult;
  safeStat: (filePath: string) => fs.Stats | null;
};

type VerificationStatus = 'pass' | 'fail' | 'blocked';
type VerificationCheckResult = {
  type: string;
  status: VerificationStatus;
  message: string;
  fail_type?: string;
  warnings?: string[];
  checkId?: string;
  classification?: 'hard' | 'soft' | 'info';
  effectiveStatus?: VerificationStatus;
  reason?: string;
  action?: string;
  dependsOn?: string;
  subchecks?: VerificationCheckResult[];
};
export type {
  VerificationCheckResult,
  VerificationStatus
};
