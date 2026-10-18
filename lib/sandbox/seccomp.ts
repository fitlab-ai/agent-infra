import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { toEnginePath } from './engines/wsl2-paths.ts';

const SECCOMP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seccomp');

const SANDBOX_SECCOMP_PROFILES: Readonly<Record<string, string>> = Object.freeze({
  codex: 'codex-bwrap.json'
});

export function sandboxSeccompProfilePath(toolId: string): string | null {
  const profile = SANDBOX_SECCOMP_PROFILES[toolId];
  return profile ? path.join(SECCOMP_DIR, profile) : null;
}

// Docker's default AppArmor profile denies the mount operations bubblewrap
// needs, even when the seccomp profile allows them. Relax AppArmor only for
// the same tools that need the bubblewrap seccomp profile.
export function sandboxAppArmorArgs(toolIds: readonly string[]): string[] {
  return toolIds.some((toolId) => SANDBOX_SECCOMP_PROFILES[toolId] !== undefined)
    ? ['--security-opt', 'apparmor=unconfined']
    : [];
}

export function sandboxSeccompArgs(engine: string, toolIds: readonly string[]): string[] {
  const profiles = [...new Set(
    toolIds
      .map(sandboxSeccompProfilePath)
      .filter((profile): profile is string => profile !== null)
  )];

  return profiles.flatMap((profile) => {
    if (!fs.existsSync(profile)) {
      throw new Error(`Sandbox seccomp profile is missing: ${profile}`);
    }
    return ['--security-opt', `seccomp=${toEnginePath(engine, profile)}`];
  });
}
