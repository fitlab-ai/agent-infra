import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { resolveProjectTaskWorkspaceLayout, resolveTaskWorkspaceExecutionBoundary, resolveTaskWorkspaceLayout } from '../../../lib/task/workspace-root.ts';
import { createSandboxControlIdentitySentinel, writeSandboxControlIdentitySentinel } from '../../../lib/sandbox/control/identity-sentinel.ts';
import { resolveTaskRef } from '../../../lib/task/resolve-ref.ts';
import { resolveShortIdReadOnly } from '../../../lib/task/short-id.ts';
import { taskViewForManifest } from '../../../lib/sandbox/control/task-view.ts';
import { createTaskWorkspaceFixture, taskWorkspaceRoot } from '../../helpers.ts';

test('host task workspaces are shared by worktrees and isolated by project', () => {
  const first = resolveTaskWorkspaceLayout({ project: 'agent-infra', boundary: 'host', home: '/home/dev' });
  const second = resolveTaskWorkspaceLayout({ project: 'agent-infra', boundary: 'host', home: '/home/dev' });
  const other = resolveTaskWorkspaceLayout({ project: 'other', boundary: 'host', home: '/home/dev' });
  assert.equal(first.root, path.join('/home/dev', '.agent-infra/task-workspaces/agent-infra'));
  assert.equal(first.root, second.root);
  assert.notEqual(first.root, other.root);
  assert.equal(first.shortIds, path.join(first.active, '.short-ids.json'));
});

test('container task root is separate from the project checkout', () => {
  const layout = resolveTaskWorkspaceLayout({ project: 'agent-infra', boundary: 'container' });
  assert.equal(layout.root, '/task-workspace');
  assert.equal(path.posix.relative('/workspace', layout.root).startsWith('..'), true);
});

test('verified sandbox markers select the container boundary for both permission modes', (t) => {
  const fixture = createTaskWorkspaceFixture('workspace-root-boundary-');
  const statusDir = path.join(fixture.home, `status-${fixture.project}`);
  const prior = new Map<string, string | undefined>();
  const envValues = {
    AGENT_INFRA_SANDBOX: '1',
    AGENT_INFRA_CONTROL_GENERATION: 'generation-test',
    AGENT_INFRA_CONTROL_DIR: path.join(fixture.home, 'control'),
    AGENT_INFRA_CONTROL_STATUS_DIR: statusDir,
    AGENT_INFRA_CONTROL_ROOT_ID: 'a'.repeat(64),
    AGENT_INFRA_TASK_ID: undefined,
    AGENT_INFRA_RUNTIME_DIR: undefined,
    AGENT_INFRA_CONTROL_ROOT_DIR: undefined
  };
  for (const [key, value] of Object.entries(envValues)) {
    prior.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const rootPrefix = '/task-workspace';
  const containerRoot = path.join(fixture.home, 'container-mounts', fixture.project);
  fs.mkdirSync(containerRoot, { recursive: true });
  const remap = (value: fs.PathLike): fs.PathLike => {
    const candidate = path.posix.normalize(String(value).replaceAll('\\', '/'));
    return candidate === rootPrefix || candidate.startsWith(`${rootPrefix}/`)
      ? path.join(containerRoot, path.posix.relative(rootPrefix, candidate))
      : value;
  };
  const originalExists = fs.existsSync;
  const originalReadFile = fs.readFileSync;
  const originalReaddir = fs.readdirSync;
  t.mock.method(fs, 'existsSync', (filePath: fs.PathLike) => originalExists(remap(filePath)));
  t.mock.method(fs, 'readFileSync', ((filePath: fs.PathOrFileDescriptor, ...args: unknown[]) =>
    (originalReadFile as (...values: unknown[]) => Buffer | string)(remap(filePath as fs.PathLike), ...args)) as typeof fs.readFileSync);
  t.mock.method(fs, 'readdirSync', ((filePath: fs.PathLike, ...args: unknown[]) =>
    (originalReaddir as (...values: unknown[]) => unknown)(remap(filePath), ...args)) as typeof fs.readdirSync);

  const taskId = 'TASK-20991231-235959';
  const homeDecoyId = 'TASK-20991231-235958';
  const taskMd = `---\nid: ${taskId}\nstatus: active\n---\n`;
  const decoyActive = path.join(fixture.taskRoot, 'active', homeDecoyId);
  fs.mkdirSync(decoyActive, { recursive: true });
  fs.writeFileSync(path.join(decoyActive, 'task.md'), `---\nid: ${homeDecoyId}\nstatus: active\n---\n`);
  fs.writeFileSync(path.join(fixture.taskRoot, 'active', '.short-ids.json'), JSON.stringify({ version: 1, ids: { '01': homeDecoyId } }));
  for (const mode of ['task-bound', 'branch-only'] as const) {
    const sentinel = createSandboxControlIdentitySentinel({ mode, taskId: mode === 'task-bound' ? taskId : null, generation: 'generation-test', controlRootId: 'a'.repeat(64) });
    writeSandboxControlIdentitySentinel(statusDir, sentinel);
    if (mode === 'task-bound') {
      process.env.AGENT_INFRA_TASK_ID = taskId;
      process.env.AGENT_INFRA_RUNTIME_DIR = path.join(fixture.home, 'runtime');
      process.env.AGENT_INFRA_CONTROL_ROOT_DIR = path.join(fixture.home, 'root');
    } else {
      delete process.env.AGENT_INFRA_TASK_ID;
      delete process.env.AGENT_INFRA_RUNTIME_DIR;
      delete process.env.AGENT_INFRA_CONTROL_ROOT_DIR;
    }
    assert.equal(resolveTaskWorkspaceExecutionBoundary(), 'container');
    assert.equal(resolveProjectTaskWorkspaceLayout(fixture.repoRoot).root, '/task-workspace');

    const activeDir = path.join(containerRoot, 'active', taskId);
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, 'task.md'), taskMd);
    fs.writeFileSync(path.join(containerRoot, 'active', '.short-ids.json'), JSON.stringify({ version: 1, ids: { '01': taskId } }));

    const resolved = resolveTaskRef(taskId, { repoRoot: fixture.repoRoot });
    assert.equal(resolved.ok, true);
    if (resolved.ok) assert.equal(resolved.taskMdPath, `/task-workspace/active/${taskId}/task.md`);
    assert.deepEqual(resolveShortIdReadOnly('01', fixture.repoRoot, { shortIdLength: 2 }), { ok: true, taskId });
    assert.equal(taskViewForManifest({ repoRoot: fixture.repoRoot, mode, taskId: mode === 'task-bound' ? taskId : null, generation: 'generation-test' }).state,
      mode === 'task-bound' ? 'current' : 'not-applicable');
  }
});

test('project keys cannot escape the per-project root', () => {
  for (const project of ['', '.', '..', '../outside', 'a/b', 'a\\b', 'bad\nkey']) {
    assert.throws(() => resolveTaskWorkspaceLayout({ project, boundary: 'host', home: '/home/dev' }), TypeError);
  }
  assert.throws(() => resolveTaskWorkspaceLayout({ project: 'project', boundary: 'host', home: 'relative-home' }), /absolute path/u);
});

test('task workspace fixtures keep multiple repos independently addressable under one isolated HOME', () => {
  const home = process.env.AGENT_INFRA_TEST_HOME;
  const first = createTaskWorkspaceFixture('workspace-root-first-');
  const second = createTaskWorkspaceFixture('workspace-root-second-');
  assert.equal(process.env.HOME, home);
  assert.equal(first.home, home);
  assert.equal(second.home, home);
  assert.notEqual(first.project, second.project);
  assert.equal(taskWorkspaceRoot(first.repoRoot), first.taskRoot);
  assert.equal(taskWorkspaceRoot(second.repoRoot), second.taskRoot);
  assert.notEqual(first.taskRoot, second.taskRoot);
  assert.equal(fs.existsSync(first.taskRoot), true);
  assert.equal(fs.existsSync(second.taskRoot), true);
});
