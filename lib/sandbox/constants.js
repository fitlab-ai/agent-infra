import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const validatedBranches = new Set();

function dedupe(items) {
  return [...new Set(items)];
}

export function assertValidBranchName(branch) {
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

export function sanitizeBranchName(branch) {
  assertValidBranchName(branch);
  return branch.replace(/\//g, '..');
}

export function legacySanitizeBranchName(branch) {
  assertValidBranchName(branch);
  return branch.replace(/\//g, '-');
}

export function safeNameCandidates(branch) {
  return dedupe([sanitizeBranchName(branch), legacySanitizeBranchName(branch)]);
}

export function containerName(config, branch) {
  return `${config.containerPrefix}-${sanitizeBranchName(branch)}`;
}

export function containerNameCandidates(config, branch) {
  return safeNameCandidates(branch).map((name) => `${config.containerPrefix}-${name}`);
}

export function worktreeDir(config, branch) {
  return config.worktreeBase.startsWith('/')
    ? path.posix.join(config.worktreeBase, sanitizeBranchName(branch))
    : path.join(config.worktreeBase, sanitizeBranchName(branch));
}

export function worktreeDirCandidates(config, branch) {
  return safeNameCandidates(branch).map((name) => (
    config.worktreeBase.startsWith('/')
      ? path.posix.join(config.worktreeBase, name)
      : path.join(config.worktreeBase, name)
  ));
}

export function sandboxLabel(config) {
  return `${config.project}.sandbox`;
}

export function sandboxBranchLabel(config) {
  return `${sandboxLabel(config)}.branch`;
}

export function sandboxImageConfigLabel(config) {
  return `${sandboxLabel(config)}.image-config`;
}

export function parsePositiveIntegerOption(value, optionName) {
  if (value === undefined || value === null) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer, got: ${value}`);
  }

  return parsed;
}

export function detectHostResources() {
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
