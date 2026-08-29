import path from 'node:path';
import {
  shareBranchDir,
  shareCommonDir,
  shellConfigDirCandidates,
  worktreeDirCandidates
} from './constants.ts';
import type { SandboxConfig } from './config.ts';
import { sandboxWorkspaceViewStatePaths } from './workspace-view.ts';

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
    runtimeDir?: string;
    taskSource?: string;
    taskSources?: string[];
    taskId?: string;
  }
): SandboxBindMountDeclaration[] {
  const taskSources = overrides.taskSources
    ?? (overrides.taskSource ? [overrides.taskSource] : []);
  const taskBound = Boolean(taskSources.length > 0 && overrides.taskId);
  const workspaceMounts = sandboxWorkspaceViewStatePaths(overrides.workspaceViewRoot).map(
    ({ state, hostPath }) => taskBound && state === 'active'
      ? {
          hostPaths: [path.join(hostPath, '.short-ids.json')],
          containerPath: '/workspace/.agents/workspace/active/.short-ids.json',
          readOnly: true
        }
      : {
          hostPaths: [hostPath],
          containerPath: path.posix.join('/workspace/.agents/workspace', state),
          readOnly: true
        }
  );
  const mounts: SandboxBindMountDeclaration[] = [
    {
      hostPaths: overrides.worktree
        ? [overrides.worktree]
        : worktreeDirCandidates(config, branch),
      containerPath: '/workspace',
      readOnly: false
    },
    ...workspaceMounts,
  ];
  if (taskBound) {
    mounts.push({
      hostPaths: taskSources,
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
  if (taskBound && overrides.runtimeDir) {
    mounts.push({
      hostPaths: [overrides.runtimeDir],
      containerPath: '/run/agent-infra/runtime',
      readOnly: false
    });
  }
  return mounts;
}
