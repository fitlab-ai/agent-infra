import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { observeCurrentRun, readCurrentRun, startCurrentRun } from '../../../lib/task/current-run.ts';
import { inspectLifecycleExecution } from '../../../lib/task/lifecycle-execution.ts';

const taskId = 'TASK-20260101-000001';
const roots = new Set<string>();

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'current-run-'));
  roots.add(root);
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: active\n---\n\n# Task\n`);
  return { root, taskDir };
}

test('standalone execution stays blocked until the current child attempt reaches a terminal state', () => {
  const f = fixture();
  startCurrentRun(f.taskDir, {
    taskId,
    runId: 'run-1',
    mode: 'orchestrated',
    stage: 'analysis',
    round: 1,
    artifact: 'analysis.md',
    role: 'executor',
    client: 'codex',
    startedAt: '2026-01-01T00:00:00.000Z',
    lastObservedAt: '2026-01-01T00:00:00.000Z',
    spawnAttemptId: 'attempt-1'
  });

  const starting = inspectLifecycleExecution(taskId, {
    mode: 'standalone',
    identity: { stage: 'analysis', round: 1, artifact: 'analysis.md', role: 'executor' }
  }, { repoRoot: f.root });
  assert.equal(starting.ok, false);
  assert.equal(starting.error?.code, 'LIVE_CHILD_DISCOVERY_REQUIRED');

  const current = readCurrentRun(f.taskDir);
  assert.ok(current);
  observeCurrentRun(f.taskDir, current, { status: 'not-started' }, '2026-01-01T00:01:00.000Z');
  const terminal = inspectLifecycleExecution(taskId, {
    mode: 'standalone',
    identity: { stage: 'analysis', round: 1, artifact: 'analysis.md', role: 'executor' }
  }, { repoRoot: f.root });
  assert.equal(terminal.ok, true);
});
