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
