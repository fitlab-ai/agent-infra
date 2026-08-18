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
    controlStatusDir: '/control/status',
    taskSource: '/repo/.agents/workspace/active/TASK-20260809-010203',
    taskId: 'TASK-20260809-010203'
  });
  const workspace = mounts.filter((mount) => mount.containerPath.startsWith('/workspace/.agents/workspace'));
  assert.deepEqual(workspace, [
    {
      hostPaths: ['/views/current'],
      containerPath: '/workspace/.agents/workspace',
      readOnly: true
    },
    {
      hostPaths: ['/repo/.agents/workspace/active/TASK-20260809-010203'],
      containerPath: '/workspace/.agents/workspace/active/TASK-20260809-010203',
      readOnly: false
    }
  ]);
  assert.equal(mounts.some((mount) => mount.hostPaths.includes('/repo/.agents/workspace')), false);
  assert.deepEqual(mounts.at(-2), {
    hostPaths: ['/control/status'],
    containerPath: '/run/agent-infra/control-status',
    readOnly: true
  });
  assert.deepEqual(mounts.at(-1), {
    hostPaths: ['/control/current'],
    containerPath: '/run/agent-infra/control',
    readOnly: false
  });
});

test('branch-only topology mounts the isolated workspace view root read-only', () => {
  const mounts = sandboxCoreBindMounts(config, 'feature', {
    workspaceViewRoot: '/views/empty',
    controlDir: '/control/empty',
    controlStatusDir: '/control/status-empty'
  });
  assert.deepEqual(
    mounts.filter((mount) => mount.containerPath.startsWith('/workspace/.agents/workspace')),
    [
      { hostPaths: ['/views/empty'], containerPath: '/workspace/.agents/workspace', readOnly: true }
    ]
  );
});
