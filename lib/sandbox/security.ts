import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { toEnginePath } from './engines/wsl2-paths.ts';

const SECURITY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'security');
const SECURITY_PROFILE = path.join(SECURITY_DIR, 'nested-bubblewrap.json');

export function sandboxSecurityProfilePath(): string {
  return SECURITY_PROFILE;
}

// Every task sandbox loads the controlled seccomp policy and sets
// apparmor=unconfined. The policy allows nested namespace creation and mount
// operations while keeping the remaining syscalls gated.
export function sandboxSecurityArgs(engine: string): string[] {
  if (!fs.existsSync(SECURITY_PROFILE)) {
    throw new Error(`Sandbox security profile is missing: ${SECURITY_PROFILE}`);
  }
  return [
    '--security-opt', `seccomp=${toEnginePath(engine, SECURITY_PROFILE)}`,
    '--security-opt', 'apparmor=unconfined'
  ];
}
