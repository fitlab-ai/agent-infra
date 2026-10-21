import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { createTaskWorkspaceFixture } from '../../helpers.ts';

const CLI = path.resolve('bin/internal-cli.ts');

function run(repoRoot: string, args: string[]) {
  return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, 'task-workspace', ...args], {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8'
  });
}

function initFixtureRepository(repoRoot: string): void {
  execFileSync('git', ['init', '-q'], { cwd: repoRoot });
}

test('task-workspace resolve returns the shared host root and isolated container root', () => {
  const fixture = createTaskWorkspaceFixture('task-workspace-cli-');
  initFixtureRepository(fixture.repoRoot);
  const host = run(fixture.repoRoot, ['resolve', '--boundary', 'host']);
  assert.equal(host.status, 0, host.stderr);
  assert.deepEqual(JSON.parse(host.stdout), {
    status: 'resolved', changed: false, projectKey: fixture.project, boundary: 'host', root: fixture.taskRoot, error: null
  });
  const container = run(fixture.repoRoot, ['resolve', '--boundary', 'container']);
  assert.equal(container.status, 0, container.stderr);
  assert.equal(JSON.parse(container.stdout).root, '/task-workspace');
});
