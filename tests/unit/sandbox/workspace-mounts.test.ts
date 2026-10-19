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

test('task-bound mount topology leaves completed target visible for its writable task mount', () => {
  const mounts = sandboxCoreBindMounts(config, 'feature', {
    gitCommonDir: '/repo/.git',
    worktreeGitFile: '/control/current/workspace.git',
    worktree: '/worktree',
    shellConfigHostDir: '/shell/feature',
    workspaceViewRoot: '/views/current',
    controlDir: '/control/current-root/channel',
    controlRootDir: '/control/current-root',
    controlStatusDir: '/control/current-root/public',
    runtimeDir: '/control/current-root/runtime',
    taskSources: ['/home/test/.agent-infra/task-workspaces/demo/active/TASK-20260809-010203'],
    completedTaskSource: '/home/test/.agent-infra/task-workspaces/demo/completed/TASK-20260809-010203',
    taskId: 'TASK-20260809-010203'
  });
  const controllerHome = '/tmp/agent-infra-codex-controllers/controller-home';
  const controllerContext = path.join(controllerHome, 'controller-context.json');
  assert.deepEqual(mounts.flatMap((mount) => mount.hostPaths), [
    '/repo/.git',
    '/worktree',
    '/control/current/workspace.git',
    path.join('/views/current', 'active', '.short-ids.json'),
    path.join('/views/current', 'blocked'),
    path.join('/views/current', 'archive'),
    '/home/test/.agent-infra/task-workspaces/demo/active/TASK-20260809-010203',
    '/home/test/.agent-infra/task-workspaces/demo/completed/TASK-20260809-010203',
    '/share/common',
    '/share/branches/feature',
    '/shell/feature',
    '/control/current-root/public',
    '/control/current-root/channel',
    '/control/current-root/runtime',
    '/control/current-root'
  ]);
  assert.equal(mounts.some((mount) => mount.hostPaths.some((hostPath) =>
    controllerContext === hostPath || controllerContext.startsWith(`${hostPath}/`))), false);
  assert.deepEqual(mounts.slice(0, 3), [
    { hostPaths: ['/repo/.git'], containerPath: '/run/agent-infra/git', readOnly: false },
    { hostPaths: ['/worktree'], containerPath: '/workspace', readOnly: false },
    { hostPaths: ['/control/current/workspace.git'], containerPath: '/workspace/.git', readOnly: true }
  ]);
  const workspace = mounts.filter((mount) => mount.containerPath.startsWith('/task-workspace'));
  assert.deepEqual(workspace, [
    {
      hostPaths: [path.join('/views/current', 'active', '.short-ids.json')],
      containerPath: '/task-workspace/active/.short-ids.json',
      readOnly: true
    },
    {
      hostPaths: [path.join('/views/current', 'blocked')],
      containerPath: '/task-workspace/blocked',
      readOnly: true
    },
    {
      hostPaths: [path.join('/views/current', 'archive')],
      containerPath: '/task-workspace/archive',
      readOnly: true
    },
    {
      hostPaths: ['/home/test/.agent-infra/task-workspaces/demo/active/TASK-20260809-010203'],
      containerPath: '/task-workspace/active/TASK-20260809-010203',
      readOnly: false
    },
    {
      hostPaths: ['/home/test/.agent-infra/task-workspaces/demo/completed/TASK-20260809-010203'],
      containerPath: '/task-workspace/completed/TASK-20260809-010203',
      readOnly: false
    },
  ]);
  assert.equal(mounts.some((mount) => mount.hostPaths.includes('/home/test/.agent-infra/task-workspaces/demo')), false);
  assert.equal(mounts.some((mount) => mount.containerPath === '/task-workspace/completed'), false);
  assert.equal(mounts.some((mount) => mount.containerPath === '/task-workspace/completed/TASK-20260809-010203'), true);
  assert.deepEqual(mounts.find((mount) => mount.containerPath === '/run/agent-infra/runtime'), {
    hostPaths: ['/control/current-root/runtime'],
    containerPath: '/run/agent-infra/runtime',
    readOnly: false
  });
  assert.equal(mounts.some((mount) => mount.hostPaths.some((hostPath) => hostPath.includes('private-capabilities'))), false);
  assert.deepEqual(mounts.find((mount) => mount.containerPath === '/run/agent-infra/control-status'), {
    hostPaths: ['/control/current-root/public'],
    containerPath: '/run/agent-infra/control-status',
    readOnly: true
  });
  assert.deepEqual(mounts.find((mount) => mount.containerPath === '/run/agent-infra/control'), {
    hostPaths: ['/control/current-root/channel'],
    containerPath: '/run/agent-infra/control',
    readOnly: false
  });
  assert.deepEqual(mounts.find((mount) => mount.containerPath === '/run/agent-infra/control-root'), {
    hostPaths: ['/control/current-root'],
    containerPath: '/run/agent-infra/control-root',
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
    mounts.filter((mount) => mount.containerPath.startsWith('/task-workspace')),
    [
      { hostPaths: [path.join('/views/empty', 'active')], containerPath: '/task-workspace/active', readOnly: true },
      { hostPaths: [path.join('/views/empty', 'completed')], containerPath: '/task-workspace/completed', readOnly: true },
      { hostPaths: [path.join('/views/empty', 'blocked')], containerPath: '/task-workspace/blocked', readOnly: true },
      { hostPaths: [path.join('/views/empty', 'archive')], containerPath: '/task-workspace/archive', readOnly: true }
    ]
  );
  assert.equal(mounts.some((mount) => mount.containerPath === '/run/agent-infra/control-root'), false);
});
