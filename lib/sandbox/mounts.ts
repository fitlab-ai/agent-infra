import path from 'node:path';
import {
  shareBranchDir,
  shareCommonDir,
  shellConfigDirCandidates,
  worktreeDirCandidates
} from './constants.ts';
import type { SandboxConfig } from './config.ts';
import { sandboxWorkspaceViewStatePaths } from './workspace-view.ts';
import { SANDBOX_GIT_COMMON_DIR } from './git-metadata.ts';

export type SandboxBindMountDeclaration = {
  hostPaths: string[];
  containerPath: string;
  readOnly: boolean;
};

function workspaceStateMounts(workspaceViewRoot: string, taskBound: boolean): SandboxBindMountDeclaration[] {
  return sandboxWorkspaceViewStatePaths(workspaceViewRoot)
    // The writable completed-task mount below is nested under this path. Keep
    // the worktree target visible so Docker can mount it without creating a
    // mountpoint inside a read-only parent bind mount.
    .filter(({ state }) => !(taskBound && state === 'completed'))
    .map(({ state, hostPath }) => taskBound && state === 'active'
      ? {
          hostPaths: [path.join(hostPath, '.short-ids.json')],
          containerPath: '/task-workspace/active/.short-ids.json',
          readOnly: true
        }
      : {
          hostPaths: [hostPath],
          containerPath: path.posix.join('/task-workspace', state),
          readOnly: true
        }
    );
}

function assertGitMetadataPair(overrides: {
  gitCommonDir?: string;
  worktreeGitFile?: string;
}): void {
  if (Boolean(overrides.gitCommonDir) !== Boolean(overrides.worktreeGitFile)) {
    throw new Error('SANDBOX_GIT_METADATA_INCOMPLETE');
  }
}

function gitCommonMount(gitCommonDir?: string): SandboxBindMountDeclaration[] {
  return gitCommonDir ? [{ hostPaths: [gitCommonDir], containerPath: SANDBOX_GIT_COMMON_DIR, readOnly: false }] : [];
}

function worktreeGitFileMount(worktreeGitFile?: string): SandboxBindMountDeclaration[] {
  return worktreeGitFile ? [{ hostPaths: [worktreeGitFile], containerPath: '/workspace/.git', readOnly: true }] : [];
}

function taskWorkspaceMounts(taskSources: string[], taskBound: boolean, overrides: {
  taskId?: string;
  completedTaskSource?: string;
}): SandboxBindMountDeclaration[] {
  if (!taskBound) return [];
  const taskId = overrides.taskId!;
  const mounts: SandboxBindMountDeclaration[] = [{
    hostPaths: taskSources,
    containerPath: path.posix.join('/task-workspace/active', taskId),
    readOnly: false
  }];
  if (overrides.completedTaskSource) mounts.push({
    hostPaths: [overrides.completedTaskSource],
    containerPath: path.posix.join('/task-workspace/completed', taskId),
    readOnly: false
  });
  return mounts;
}

function sharedMounts(config: Pick<SandboxConfig, 'repoRoot' | 'worktreeBase' | 'shareBase' | 'shellConfigBase'>, branch: string,
  shellConfigHostDir?: string): SandboxBindMountDeclaration[] {
  return [{
    hostPaths: [shareCommonDir(config)], containerPath: '/share/common', readOnly: false
  }, {
    hostPaths: [shareBranchDir(config, branch)], containerPath: '/share/branch', readOnly: false
  }, {
    hostPaths: shellConfigHostDir ? [shellConfigHostDir] : shellConfigDirCandidates(config, branch),
    containerPath: '/home/devuser/.host-shell-config', readOnly: true
  }];
}

function controlMounts(overrides: { controlDir: string; controlRootDir?: string; controlStatusDir: string; runtimeDir?: string }, taskBound: boolean): SandboxBindMountDeclaration[] {
  const mounts: SandboxBindMountDeclaration[] = [{
    hostPaths: [overrides.controlStatusDir], containerPath: '/run/agent-infra/control-status', readOnly: true
  }, {
    hostPaths: [overrides.controlDir], containerPath: '/run/agent-infra/control', readOnly: false
  }];
  if (taskBound && overrides.runtimeDir) mounts.push({
    hostPaths: [overrides.runtimeDir], containerPath: '/run/agent-infra/runtime', readOnly: false
  });
  if (taskBound && overrides.controlRootDir) mounts.push({
    hostPaths: [overrides.controlRootDir], containerPath: '/run/agent-infra/control-root', readOnly: false
  });
  return mounts;
}

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
    controlRootDir?: string;
    controlStatusDir: string;
    gitCommonDir?: string;
    worktreeGitFile?: string;
    runtimeDir?: string;
    taskSources?: string[];
    completedTaskSource?: string;
    taskId?: string;
  }
): SandboxBindMountDeclaration[] {
  const taskSources = overrides.taskSources ?? [];
  const taskBound = Boolean(taskSources.length > 0 && overrides.taskId);
  assertGitMetadataPair(overrides);
  if (taskBound && !overrides.controlRootDir) throw new Error('SANDBOX_CONTROL_ROOT_MISSING');
  const mounts: SandboxBindMountDeclaration[] = [
    ...gitCommonMount(overrides.gitCommonDir),
    {
      hostPaths: overrides.worktree
        ? [overrides.worktree]
        : worktreeDirCandidates(config, branch),
      containerPath: '/workspace',
      readOnly: false
    },
    ...worktreeGitFileMount(overrides.worktreeGitFile),
    ...workspaceStateMounts(overrides.workspaceViewRoot, taskBound),
    ...taskWorkspaceMounts(taskSources, taskBound, overrides),
    ...sharedMounts(config, branch, overrides.shellConfigHostDir),
    ...controlMounts(overrides, taskBound)
  ];
  return mounts;
}
