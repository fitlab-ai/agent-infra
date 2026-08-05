const LOCAL_VERIFICATION_CHECKS = [
  'task-meta', 'artifact', 'implementation-input', 'activity-log', 'completion-checklist',
  'orchestration-state', 'orchestration-evidence'
] as const;

function isLocalVerificationCheck(value: string): value is typeof LOCAL_VERIFICATION_CHECKS[number] {
  return (LOCAL_VERIFICATION_CHECKS as readonly string[]).includes(value);
}

export { LOCAL_VERIFICATION_CHECKS, isLocalVerificationCheck };
