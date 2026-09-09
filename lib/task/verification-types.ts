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
  parseIssueNumber: (value: unknown) => number | null;
  parsePrNumber: (value: unknown) => number | null;
};

type VerificationStatus = 'pass' | 'fail' | 'blocked';
type VerificationCheckResult = {
  type: string;
  status: VerificationStatus;
  message: string;
  fail_type?: string;
  warnings?: string[];
};
type VerificationContext = {
  skillName: string;
  taskDir: string;
  artifactFile?: string;
  config: Record<string, unknown>;
};
type VerificationEngineRequest = {
  mode: 'gate' | 'checks';
  skillName: string;
  taskDir: string;
  artifactFile?: string;
  checks: readonly string[];
  repositoryRoot?: string;
};

export type {
  VerificationCheckResult,
  VerificationContext,
  VerificationEngineRequest,
  VerificationStatus
};
