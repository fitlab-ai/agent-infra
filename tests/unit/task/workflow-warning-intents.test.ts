import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyWorkflowWarningIntent } from '../../../lib/task/workflow-warning-intents.ts';

function fixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warning-intents-'));
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nupdated_at: old\nagent_infra_version: old\n---\n# Task\n\n## Activity Log\n\n`);
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
