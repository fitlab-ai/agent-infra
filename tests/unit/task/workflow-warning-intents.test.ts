import { taskWorkspaceRoot } from '../../helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { applyWorkflowWarningIntent, projectFinalizationWarning } from '../../../lib/task/workflow-warning-intents.ts';
import { parseWorkflowWarnings } from '../../../lib/task/workflow-warnings.ts';
import { createTaskWorkspaceFixture } from '../../helpers.ts';

function fixture() {
  const { repoRoot } = createTaskWorkspaceFixture('warning-intents-');
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(taskWorkspaceRoot(repoRoot),  'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nupdated_at: old\nstatus: active\nagent_infra_version: v0.8.6-alpha.0\n---\n# Task\n## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n\n## Activity Log\n\n`);
  return { repoRoot, taskId, taskMd: path.join(taskDir, 'task.md') };
}

test('warning add creates a missing section, updates an open identity and replays', () => {
  const f = fixture();
  try {
    const options = { repoRoot: f.repoRoot, metadataProvider: () => ({ timestamp: '2026-07-19 12:00:00+00:00', agentInfraVersion: 'v0.8.6-alpha.0' }) };
    const base = { kind: 'add' as const, taskRef: f.taskId, step: 'issue-sync', severity: 'IMPORTANT' as const, code: 'PERMISSION_DEGRADED', target: 'label', message: 'a | b', action: 'wait \\ retry' };
    const created = applyWorkflowWarningIntent(base, options);
    assert.equal(created.status, 'applied');
    assert.equal(created.entityId, 'WW-1');
    assert.equal(applyWorkflowWarningIntent(base, options).status, 'no-op');
    const updated = applyWorkflowWarningIntent({ ...base, severity: 'ACTION_REQUIRED', message: 'changed' }, options);
    assert.equal(updated.status, 'applied');
    assert.equal(updated.entityId, 'WW-1');
    assert.equal((fs.readFileSync(f.taskMd, 'utf8').match(/\| WW-1 \|/g) ?? []).length, 1);
  } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('resolved warnings are idempotent and a later event receives a fresh id', () => {
  const f = fixture();
  try {
    const options = { repoRoot: f.repoRoot, metadataProvider: () => ({ timestamp: '2026-07-19 12:00:00+00:00', agentInfraVersion: 'v0.8.6-alpha.0' }) };
    const add = { kind: 'add' as const, taskRef: f.taskId, step: 'create-pr', severity: 'IMPORTANT' as const, code: 'SYNC', target: 'pr', message: 'failed', action: 'retry' };
    applyWorkflowWarningIntent(add, options);
    const resolved = { kind: 'set-status' as const, taskRef: f.taskId, id: 'WW-1', status: 'resolved' as const, resolution: 'done' };
    assert.equal(applyWorkflowWarningIntent(resolved, options).status, 'applied');
    assert.equal(applyWorkflowWarningIntent(resolved, options).status, 'no-op');
    const reopened = applyWorkflowWarningIntent(add, options);
    assert.equal(reopened.entityId, 'WW-2');
  } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('finalization warning projection requires a prepared task and replays without changing its resolution', () => {
  const f = fixture();
  try {
    const options = {
      repoRoot: f.repoRoot,
      metadataProvider: () => ({ timestamp: '2026-07-19 12:00:00+00:00', agentInfraVersion: 'v0.8.6-alpha.0' })
    };
    const warning = {
      code: 'VERIFY_FAILED', message: 'retry verification', retryable: true,
      step: 'complete-task', target: 'verification', severity: 'ACTION_REQUIRED' as const,
      status: 'resolved' as const, resolvedAt: '2026-07-19 11:59:00+00:00'
    };
    const initial = fs.readFileSync(f.taskMd, 'utf8');
    const rejected = projectFinalizationWarning(f.taskId, warning, options);
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.error?.code, 'TASK_STATE_MISMATCH');
    assert.equal(fs.readFileSync(f.taskMd, 'utf8'), initial);

    const lifecyclePath = path.join(path.dirname(f.taskMd), '.task-lifecycle.json');
    fs.writeFileSync(lifecyclePath, JSON.stringify({ taskId: f.taskId, intent: 'complete' }));
    const projected = projectFinalizationWarning(f.taskId, warning, { ...options, resolution: 'superseded' });
    assert.equal(projected.status, 'applied');
    const afterProjection = fs.readFileSync(f.taskMd, 'utf8');
    const [row] = parseWorkflowWarnings(afterProjection);
    assert.equal(row?.id, 'WW-1');
    assert.equal(row?.resolvedAt, warning.resolvedAt);
    assert.equal(row?.resolution, 'Superseded by a later verification observation');

    const replay = projectFinalizationWarning(f.taskId, warning, { ...options, resolution: 'superseded' });
    assert.equal(replay.status, 'no-op');
    assert.equal(fs.readFileSync(f.taskMd, 'utf8'), afterProjection);

    const newResolvedWarning = { ...warning, code: 'VERIFY_RETRIED', target: 'verification-retry', resolvedAt: null };
    const newProjection = projectFinalizationWarning(f.taskId, newResolvedWarning, options);
    assert.equal(newProjection.status, 'applied');
    const projectedLine = fs.readFileSync(f.taskMd, 'utf8').split('\n').find((line) => line.includes('| VERIFY_RETRIED |'));
    const projectedCells = projectedLine?.split('|').slice(1, -1).map((cell) => cell.trim());
    assert.equal(projectedCells?.[9], '');
  } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});
