import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { sandboxCoreBindMounts } from '../../../lib/sandbox/mounts.ts';

const config = {
  repoRoot: '/repo',
  worktreeBase: '/worktrees',
  shareBase: '/share',
  shellConfigBase: '/shell'
};

test('task-bound mount topology exposes isolated state mounts and one writable task child', () => {
  const mounts = sandboxCoreBindMounts(config, 'feature', {
    gitCommonDir: '/repo/.git',
    worktreeGitFile: '/control/current/workspace.git',
    worktree: '/worktree',
    shellConfigHostDir: '/shell/feature',
    workspaceViewRoot: '/views/current',
    controlDir: '/control/current',
    controlStatusDir: '/control/status',
    runtimeDir: '/repo/.agents/workspace/active/TASK-20260809-010203/.runtime/sandbox-control/runtime',
    taskSources: ['/repo/.agents/workspace/active/TASK-20260809-010203'],
    taskId: 'TASK-20260809-010203'
  });
  const controllerHome = '/tmp/agent-infra-codex-controllers/controller-home';
  const controllerContext = path.join(controllerHome, 'controller-context.json');
  assert.deepEqual(mounts.flatMap((mount) => mount.hostPaths), [
    '/repo/.git',
    '/worktree',
    '/control/current/workspace.git',
    path.join('/views/current', 'active', '.short-ids.json'),
    path.join('/views/current', 'completed'),
    path.join('/views/current', 'blocked'),
    path.join('/views/current', 'archive'),
    '/repo/.agents/workspace/active/TASK-20260809-010203',
    '/share/common',
    '/share/branches/feature',
    '/shell/feature',
    '/control/status',
    '/control/current',
    '/repo/.agents/workspace/active/TASK-20260809-010203/.runtime/sandbox-control/runtime'
  ]);
  assert.equal(mounts.some((mount) => mount.hostPaths.some((hostPath) =>
    controllerContext === hostPath || controllerContext.startsWith(`${hostPath}/`))), false);
  assert.deepEqual(mounts.slice(0, 3), [
    { hostPaths: ['/repo/.git'], containerPath: '/run/agent-infra/git', readOnly: false },
    { hostPaths: ['/worktree'], containerPath: '/workspace', readOnly: false },
    { hostPaths: ['/control/current/workspace.git'], containerPath: '/workspace/.git', readOnly: true }
  ]);
  const workspace = mounts.filter((mount) => mount.containerPath.startsWith('/workspace/.agents/workspace'));
  assert.deepEqual(workspace, [
    {
      hostPaths: [path.join('/views/current', 'active', '.short-ids.json')],
      containerPath: '/workspace/.agents/workspace/active/.short-ids.json',
      readOnly: true
    },
    {
      hostPaths: [path.join('/views/current', 'completed')],
      containerPath: '/workspace/.agents/workspace/completed',
      readOnly: true
    },
    {
      hostPaths: [path.join('/views/current', 'blocked')],
      containerPath: '/workspace/.agents/workspace/blocked',
      readOnly: true
    },
    {
      hostPaths: [path.join('/views/current', 'archive')],
      containerPath: '/workspace/.agents/workspace/archive',
      readOnly: true
    },
    {
      hostPaths: ['/repo/.agents/workspace/active/TASK-20260809-010203'],
      containerPath: '/workspace/.agents/workspace/active/TASK-20260809-010203',
      readOnly: false
    },
  ]);
  assert.equal(mounts.some((mount) => mount.hostPaths.includes('/repo/.agents/workspace')), false);
  assert.deepEqual(mounts.find((mount) => mount.containerPath === '/run/agent-infra/runtime'), {
    hostPaths: ['/repo/.agents/workspace/active/TASK-20260809-010203/.runtime/sandbox-control/runtime'],
    containerPath: '/run/agent-infra/runtime',
    readOnly: false
  });
  assert.equal(mounts.some((mount) => mount.hostPaths.some((hostPath) => hostPath.includes('private-capabilities'))), false);
  assert.deepEqual(mounts.find((mount) => mount.containerPath === '/run/agent-infra/control-status'), {
    hostPaths: ['/control/status'],
    containerPath: '/run/agent-infra/control-status',
    readOnly: true
  });
  assert.deepEqual(mounts.find((mount) => mount.containerPath === '/run/agent-infra/control'), {
    hostPaths: ['/control/current'],
    containerPath: '/run/agent-infra/control',
    readOnly: false
  });
});

test('branch-only topology mounts each isolated workspace state read-only', () => {
  const mounts = sandboxCoreBindMounts(config, 'feature', {
    gitCommonDir: '/repo/.git',
    worktreeGitFile: '/control/empty/workspace.git',
    workspaceViewRoot: '/views/empty',
    controlDir: '/control/empty',
    controlStatusDir: '/control/status-empty'
  });
  assert.deepEqual(
    mounts.filter((mount) => mount.containerPath.startsWith('/workspace/.agents/workspace')),
    [
      { hostPaths: [path.join('/views/empty', 'active')], containerPath: '/workspace/.agents/workspace/active', readOnly: true },
      { hostPaths: [path.join('/views/empty', 'completed')], containerPath: '/workspace/.agents/workspace/completed', readOnly: true },
      { hostPaths: [path.join('/views/empty', 'blocked')], containerPath: '/workspace/.agents/workspace/blocked', readOnly: true },
      { hostPaths: [path.join('/views/empty', 'archive')], containerPath: '/workspace/.agents/workspace/archive', readOnly: true }
    ]
  );
});
