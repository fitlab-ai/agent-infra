import path from 'node:path';
import {
  shareBranchDir,
  shareCommonDir,
  shellConfigDirCandidates,
  worktreeDirCandidates
} from './constants.ts';
import type { SandboxConfig } from './config.ts';

export type SandboxBindMountDeclaration = {
  hostPaths: string[];
  containerPath: string;
  readOnly: boolean;
};

export function sandboxCoreBindMounts(
  config: Pick<
    SandboxConfig,
    'repoRoot' | 'worktreeBase' | 'shareBase' | 'shellConfigBase'
  >,
  branch: string,
  overrides: {
    worktree?: string;
    shellConfigHostDir?: string;
    workspaceViewRoot: string;
    controlDir: string;
    controlStatusDir: string;
    taskSource?: string;
    taskId?: string;
  }
): SandboxBindMountDeclaration[] {
  const taskBound = Boolean(overrides.taskSource && overrides.taskId);
  const mounts: SandboxBindMountDeclaration[] = [
    {
      hostPaths: overrides.worktree
        ? [overrides.worktree]
        : worktreeDirCandidates(config, branch),
      containerPath: '/workspace',
      readOnly: false
    },
    {
      hostPaths: [overrides.workspaceViewRoot],
      containerPath: '/workspace/.agents/workspace',
      readOnly: true
    },
  ];
  if (taskBound) {
    mounts.push({
      hostPaths: [overrides.taskSource!],
      containerPath: path.posix.join('/workspace/.agents/workspace/active', overrides.taskId!),
      readOnly: false
    });
  }
  mounts.push(
    {
      hostPaths: [shareCommonDir(config)],
      containerPath: '/share/common',
      readOnly: false
    },
    {
      hostPaths: [shareBranchDir(config, branch)],
      containerPath: '/share/branch',
      readOnly: false
    },
    {
      hostPaths: overrides.shellConfigHostDir
        ? [overrides.shellConfigHostDir]
        : shellConfigDirCandidates(config, branch),
      containerPath: '/home/devuser/.host-shell-config',
      readOnly: true
    }
  );
  mounts.push({
    hostPaths: [overrides.controlStatusDir],
    containerPath: '/run/agent-infra/control-status',
    readOnly: true
  }, {
    hostPaths: [overrides.controlDir],
    containerPath: '/run/agent-infra/control',
    readOnly: false
  });
  return mounts;
}
