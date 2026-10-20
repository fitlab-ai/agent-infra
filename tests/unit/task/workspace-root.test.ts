import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { resolveProjectTaskWorkspaceLayout, resolveTaskWorkspaceExecutionBoundary, resolveTaskWorkspaceLayout } from '../../../lib/task/workspace-root.ts';
import { createSandboxControlIdentitySentinel, writeSandboxControlIdentitySentinel } from '../../../lib/sandbox/control/identity-sentinel.ts';
import { resolveTaskRef } from '../../../lib/task/resolve-ref.ts';
import { resolveShortIdReadOnly } from '../../../lib/task/short-id.ts';
import { taskViewForManifest } from '../../../lib/sandbox/control/task-view.ts';
import { createTaskWorkspaceFixture, createTempDir, taskWorkspaceRoot } from '../../helpers.ts';

const require = createRequire(import.meta.url);
const { installTaskWorkspacePathMapping } = require('../../../scripts/test-task-workspace-path-mapping.cjs') as {
  installTaskWorkspacePathMapping: (root: string) => () => void;
};

test('host task workspace root is deterministic for a project and isolated between projects', () => {
  const first = resolveTaskWorkspaceLayout({ project: 'agent-infra', boundary: 'host', home: '/home/dev' });
  const other = resolveTaskWorkspaceLayout({ project: 'other', boundary: 'host', home: '/home/dev' });
  assert.equal(first.root, path.join('/home/dev', '.agent-infra/task-workspaces/agent-infra'));
  assert.notEqual(first.root, other.root);
  assert.equal(first.shortIds, path.join(first.active, '.short-ids.json'));
});

test('container task root is separate from the project checkout', () => {
  const layout = resolveTaskWorkspaceLayout({ project: 'agent-infra', boundary: 'container' });
  assert.equal(layout.root, '/task-workspace');
  assert.equal(path.posix.relative('/workspace', layout.root).startsWith('..'), true);
});

test('task workspace mapping rewrites filesystem paths without changing data or options', (t) => {
  const target = createTempDir('workspace-root-mapping-');
  const restore = installTaskWorkspacePathMapping(target);
  t.after(restore);
  const destination = path.join(target, 'payload.txt');
  fs.writeFileSync('/task-workspace/payload.txt', '/task-workspace/data', { encoding: 'utf8' });
  assert.equal(fs.readFileSync(destination, 'utf8'), '/task-workspace/data');
  assert.equal(fs.realpathSync.native('/task-workspace/payload.txt'), destination);
  const copy = path.join(target, 'copied.txt');
  fs.copyFileSync('/task-workspace/payload.txt', '/task-workspace/copied.txt');
  fs.renameSync('/task-workspace/copied.txt', '/task-workspace/renamed.txt');
  assert.equal(fs.readFileSync(path.join(target, 'renamed.txt'), 'utf8'), '/task-workspace/data');
  assert.equal(fs.existsSync(copy), false);
});

test('verified sandbox markers select the container boundary for both permission modes', (t) => {
  const fixture = createTaskWorkspaceFixture('workspace-root-boundary-');
  const prior = new Map<string, string | undefined>();
  prior.set('AGENT_INFRA_CONTROL_STATUS_DIR', process.env.AGENT_INFRA_CONTROL_STATUS_DIR);
  const envValues = {
    AGENT_INFRA_SANDBOX: '1',
    AGENT_INFRA_CONTROL_GENERATION: 'generation-test',
    AGENT_INFRA_CONTROL_DIR: path.join(fixture.home, 'control'),
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

  const containerRoot = path.join(fixture.home, 'container-mounts', fixture.project);
  fs.mkdirSync(containerRoot, { recursive: true });
  const restorePathMapping = installTaskWorkspacePathMapping(containerRoot);
  t.after(restorePathMapping);

  const taskId = 'TASK-20991231-235959';
  const homeDecoyId = 'TASK-20991231-235958';
  const taskMd = `---\nid: ${taskId}\nstatus: active\n---\n`;
  const decoyActive = path.join(fixture.taskRoot, 'active', homeDecoyId);
  fs.mkdirSync(decoyActive, { recursive: true });
  fs.writeFileSync(path.join(decoyActive, 'task.md'), `---\nid: ${homeDecoyId}\nstatus: active\n---\n`);
  fs.writeFileSync(path.join(fixture.taskRoot, 'active', '.short-ids.json'), JSON.stringify({ version: 1, ids: { '01': homeDecoyId } }));
  for (const mode of ['task-bound', 'branch-only'] as const) {
    const statusDir = path.join(fixture.home, `status-${fixture.project}-${mode}`);
    process.env.AGENT_INFRA_CONTROL_STATUS_DIR = statusDir;
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
    if (resolved.ok) assert.equal(resolved.taskMdPath, path.join('/task-workspace', 'active', taskId, 'task.md'));
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
