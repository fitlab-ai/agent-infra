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
  overrides: { worktree?: string; shellConfigHostDir?: string } = {}
): SandboxBindMountDeclaration[] {
  return [
    {
      hostPaths: overrides.worktree
        ? [overrides.worktree]
        : worktreeDirCandidates(config, branch),
      containerPath: '/workspace',
      readOnly: false
    },
    {
      hostPaths: [path.join(config.repoRoot, '.agents', 'workspace')],
      containerPath: '/workspace/.agents/workspace',
      readOnly: false
    },
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
  ];
}
