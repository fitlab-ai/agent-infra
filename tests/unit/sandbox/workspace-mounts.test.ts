import assert from 'node:assert/strict';
import test from 'node:test';
import { sandboxCoreBindMounts } from '../../../lib/sandbox/mounts.ts';

const config = {
  repoRoot: '/repo',
  worktreeBase: '/worktrees',
  shareBase: '/share',
  shellConfigBase: '/shell'
};

test('task-bound mount topology preserves the workspace root and exposes only one writable task child', () => {
  const mounts = sandboxCoreBindMounts(config, 'feature', {
    worktree: '/worktree',
    shellConfigHostDir: '/shell/feature',
    workspaceViewRoot: '/views/current',
    controlDir: '/control/current',
    taskSource: '/repo/.agents/workspace/active/TASK-20260809-010203',
    taskId: 'TASK-20260809-010203'
  });
  const workspace = mounts.filter((mount) => mount.containerPath.startsWith('/workspace/.agents/workspace'));
  assert.deepEqual(workspace, [
    {
      hostPaths: ['/views/current/active/.short-ids.json'],
      containerPath: '/workspace/.agents/workspace/active/.short-ids.json',
      readOnly: true
    },
    { hostPaths: ['/views/current/completed'], containerPath: '/workspace/.agents/workspace/completed', readOnly: true },
    { hostPaths: ['/views/current/blocked'], containerPath: '/workspace/.agents/workspace/blocked', readOnly: true },
    { hostPaths: ['/views/current/archive'], containerPath: '/workspace/.agents/workspace/archive', readOnly: true },
    {
      hostPaths: ['/repo/.agents/workspace/active/TASK-20260809-010203'],
      containerPath: '/workspace/.agents/workspace/active/TASK-20260809-010203',
      readOnly: false
    }
  ]);
  assert.equal(workspace.some((mount) => mount.containerPath === '/workspace/.agents/workspace/active'), false);
  assert.equal(mounts.some((mount) => mount.hostPaths.includes('/repo/.agents/workspace')), false);
});

test('branch-only topology mounts each isolated state read-only without covering the workspace root', () => {
  const mounts = sandboxCoreBindMounts(config, 'feature', {
    workspaceViewRoot: '/views/empty',
    controlDir: '/control/empty'
  });
  assert.deepEqual(
    mounts.filter((mount) => mount.containerPath.startsWith('/workspace/.agents/workspace')),
    [
      { hostPaths: ['/views/empty/active'], containerPath: '/workspace/.agents/workspace/active', readOnly: true },
      { hostPaths: ['/views/empty/completed'], containerPath: '/workspace/.agents/workspace/completed', readOnly: true },
      { hostPaths: ['/views/empty/blocked'], containerPath: '/workspace/.agents/workspace/blocked', readOnly: true },
      { hostPaths: ['/views/empty/archive'], containerPath: '/workspace/.agents/workspace/archive', readOnly: true }
    ]
  );
});
