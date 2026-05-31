import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { hostJoin } from './engines/wsl2-paths.ts';

const validatedBranches = new Set();

type SandboxPathConfig = {
  project: string;
  containerPrefix: string;
  worktreeBase: string;
  shareBase: string;
  shellConfigBase: string;
};

type HostResources = {
  cpu: number;
  memory: number;
};

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

export function assertValidBranchName(branch: string): void {
  if (validatedBranches.has(branch)) {
    return;
  }

  if (!branch || branch.trim().length === 0) {
    throw new Error('Branch name is required');
  }

  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) {
    throw new Error(`Invalid branch name '${branch}': only letters, digits, ., _, -, and / are allowed`);
  }

  try {
    execFileSync('git', ['check-ref-format', '--branch', branch], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch {
    throw new Error(`Invalid branch name '${branch}': does not satisfy git branch naming rules`);
  }

  validatedBranches.add(branch);
}

export function sanitizeBranchName(branch: string): string {
  assertValidBranchName(branch);
  return branch.replace(/\//g, '..');
}

export function legacySanitizeBranchName(branch: string): string {
  assertValidBranchName(branch);
  return branch.replace(/\//g, '-');
}

export function safeNameCandidates(branch: string): string[] {
  return dedupe([sanitizeBranchName(branch), legacySanitizeBranchName(branch)]);
}

export function containerName(config: Pick<SandboxPathConfig, 'containerPrefix'>, branch: string): string {
  return `${config.containerPrefix}-${sanitizeBranchName(branch)}`;
}

export function containerNameCandidates(config: Pick<SandboxPathConfig, 'containerPrefix'>, branch: string): string[] {
  return safeNameCandidates(branch).map((name) => `${config.containerPrefix}-${name}`);
}

export function worktreeDir(config: Pick<SandboxPathConfig, 'worktreeBase'>, branch: string): string {
  return hostJoin(config.worktreeBase, sanitizeBranchName(branch));
}

export function worktreeDirCandidates(config: Pick<SandboxPathConfig, 'worktreeBase'>, branch: string): string[] {
  return safeNameCandidates(branch).map((name) => hostJoin(config.worktreeBase, name));
}

export function shareDir(config: Pick<SandboxPathConfig, 'shareBase'>): string {
  return config.shareBase;
}

export function shareCommonDir(config: Pick<SandboxPathConfig, 'shareBase'>): string {
  return hostJoin(config.shareBase, 'common');
}

export function shareBranchDir(config: Pick<SandboxPathConfig, 'shareBase'>, branch: string): string {
  return hostJoin(config.shareBase, 'branches', sanitizeBranchName(branch));
}

export function shellConfigDir(config: Pick<SandboxPathConfig, 'shellConfigBase'>, branch: string): string {
  return hostJoin(config.shellConfigBase, sanitizeBranchName(branch));
}

export function shellConfigDirCandidates(config: Pick<SandboxPathConfig, 'shellConfigBase'>, branch: string): string[] {
  return safeNameCandidates(branch).map((name) => hostJoin(config.shellConfigBase, name));
}

export function sandboxLabel(config: Pick<SandboxPathConfig, 'project'>): string {
  return `${config.project}.sandbox`;
}

export function sandboxBranchLabel(config: Pick<SandboxPathConfig, 'project'>): string {
  return `${sandboxLabel(config)}.branch`;
}

export function sandboxImageConfigLabel(config: Pick<SandboxPathConfig, 'project'>): string {
  return `${sandboxLabel(config)}.image-config`;
}

export function parsePositiveIntegerOption(value: unknown, optionName: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer, got: ${value}`);
  }

  return parsed;
}

export function detectHostResources(): HostResources {
  // Resource hints are for engines that pre-allocate a managed VM. macOS uses
  // sysctl for Colima defaults, while the generic fallback supports WSL2 or
  // other direct callers that need conservative CPU and memory defaults.
  if (process.platform === 'darwin') {
    try {
      const hostCpu = Number(execFileSync('sysctl', ['-n', 'hw.ncpu'], { encoding: 'utf8' }).trim());
      const hostMemBytes = Number(execFileSync('sysctl', ['-n', 'hw.memsize'], { encoding: 'utf8' }).trim());
      const hostMemGb = Math.floor(hostMemBytes / 1024 / 1024 / 1024);

      return {
        cpu: Math.max(1, hostCpu - 2),
        memory: Math.max(2, Math.floor(hostMemGb / 2))
      };
    } catch {
      // Fall through to generic detection below.
    }
  }

  const hostCpu = os.cpus()?.length ?? 4;
  const hostMemGb = Math.floor(os.totalmem() / 1024 / 1024 / 1024);

  return {
    cpu: Math.max(1, Math.min(hostCpu, hostCpu - 1 || 1)),
    memory: Math.max(2, Math.floor(hostMemGb / 2))
  };
}
