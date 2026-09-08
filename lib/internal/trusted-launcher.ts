import os from 'node:os';
import fs from 'node:fs';

const TRUSTED_LAUNCHER_FD_ENV = 'AGENT_INFRA_TRUSTED_LAUNCHER_FD';
const TRUSTED_LAUNCHER_PROOF_PREFIX = 'agent-infra-launcher-v1';
const validatedProofs = new Set<string>();

function launcherProofForProcess(pid: number, key: string, value: string): boolean {
  const match = new RegExp(`^${TRUSTED_LAUNCHER_PROOF_PREFIX}:${pid.toString()}:([a-f0-9]{64}):([a-f0-9]{64})$`, 'u').exec(value);
  return match !== null && match[1] === key;
}

function launcherAuthorityPath(): string {
  return `${os.homedir()}/.agent-infra/launcher-authority`;
}

export function hasTrustedLauncherProof(env: NodeJS.ProcessEnv = process.env): boolean {
  const rawFd = env[TRUSTED_LAUNCHER_FD_ENV];
  if (!rawFd || !/^\d+$/u.test(rawFd)) return false;
  const fd = Number(rawFd);
  if (!Number.isSafeInteger(fd) || fd < 3) return false;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() && !stat.isFIFO()) return false;
    const key = fs.readFileSync(launcherAuthorityPath(), 'utf8').trim();
    if (!/^[a-f0-9]{64}$/u.test(key)) return false;
    const cacheKey = `${process.pid}:${fd}:${key}`;
    if (validatedProofs.has(cacheKey)) return true;
    const proof = fs.readFileSync(fd, 'utf8').trim();
    if (!launcherProofForProcess(process.pid, key, proof)) return false;
    validatedProofs.add(cacheKey);
    return true;
  } catch {
    return false;
  }
}

export { TRUSTED_LAUNCHER_FD_ENV, TRUSTED_LAUNCHER_PROOF_PREFIX };
