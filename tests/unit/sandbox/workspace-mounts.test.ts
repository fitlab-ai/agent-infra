import assert from 'node:assert/strict';
import test from 'node:test';
import { sandboxCoreBindMounts } from '../../../lib/sandbox/mounts.ts';

const config = {
  repoRoot: '/repo',
  worktreeBase: '/worktrees',
  shareBase: '/share',
  shellConfigBase: '/shell'
};

test('task-bound mount topology uses a read-only view followed by one writable task child', () => {
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
    { hostPaths: ['/views/current'], containerPath: '/workspace/.agents/workspace', readOnly: true },
    {
      hostPaths: ['/repo/.agents/workspace/active/TASK-20260809-010203'],
      containerPath: '/workspace/.agents/workspace/active/TASK-20260809-010203',
      readOnly: false
    }
  ]);
  assert.equal(mounts.some((mount) => mount.hostPaths.includes('/repo/.agents/workspace')), false);
});

test('branch-only topology has no host task mount', () => {
  const mounts = sandboxCoreBindMounts(config, 'feature', {
    workspaceViewRoot: '/views/empty',
    controlDir: '/control/empty'
  });
  assert.equal(
    mounts.filter((mount) => mount.containerPath.startsWith('/workspace/.agents/workspace')).length,
    1
  );
});
