import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { toEnginePath } from './engines/wsl2-paths.ts';

const SECURITY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'security');
const SECURITY_PROFILE = path.join(SECURITY_DIR, 'nested-bubblewrap.json');

export function sandboxSecurityProfilePath(): string {
  return SECURITY_PROFILE;
}

// Every task sandbox loads the controlled seccomp policy and relaxes AppArmor
// so clients such as Codex can run bubblewrap inside the container. Docker's
// default seccomp filter blocks the required namespace syscalls, and its
// default AppArmor profile blocks the required mount operations.
export function sandboxSecurityArgs(engine: string): string[] {
  if (!fs.existsSync(SECURITY_PROFILE)) {
    throw new Error(`Sandbox security profile is missing: ${SECURITY_PROFILE}`);
  }
  return [
    '--security-opt', `seccomp=${toEnginePath(engine, SECURITY_PROFILE)}`,
    '--security-opt', 'apparmor=unconfined'
  ];
}
