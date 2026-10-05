import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import {
  appendCodexLifecycleBinding,
  parseCodexLifecycleBinding,
  resolveCodexLifecycleStoreRoot,
  verifyCodexLifecycleTaskBinding
} from '../../../lib/agent-clients/adapters/codex-lifecycle/binding.ts';

const roots = new Set<string>();
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test('Codex lifecycle binding survives the native task_name carrier round trip', () => {
  const binding = {
    taskId: 'TASK-20261005-122106',
    runId: 'run-1',
    receiptId: 'receipt-1'
  };
  const taskName = appendCodexLifecycleBinding('analysis_executor_r1', binding);
  assert.match(taskName, /^analysis_executor_r1--agent-infra-binding-[A-Za-z0-9_-]+$/u);
  assert.deepEqual(parseCodexLifecycleBinding(taskName), {
    taskName,
    label: 'analysis_executor_r1',
    binding
  });
});

test('Codex lifecycle binding rejects malformed and path-unsafe native task names', () => {
  assert.equal(parseCodexLifecycleBinding('analysis_executor_r1'), null);
  assert.throws(() => appendCodexLifecycleBinding('../escape', {
    taskId: 'TASK-20261005-122106', runId: 'run-1', receiptId: 'receipt-1'
  }), /task_name/);
  assert.throws(() => parseCodexLifecycleBinding(`../${appendCodexLifecycleBinding('x', {
    taskId: 'TASK-20261005-122106', runId: 'run-1', receiptId: 'receipt-1'
  })}`), /task_name/);
});

test('Codex lifecycle binding accepts only the exact current task run receipt and native role', () => {
  const binding = { taskId: 'TASK-20261005-122106', runId: 'run-1', receiptId: 'receipt-1' };
  const run = {
    taskId: binding.taskId,
    runId: binding.runId,
    status: 'running',
    pendingDelegation: {
      ...binding, id: binding.receiptId, client: 'codex', role: 'executor', status: 'prepared',
      requestedModel: 'model', requestedReasoningEffort: 'high'
    }
  };
  assert.doesNotThrow(() => verifyCodexLifecycleTaskBinding(binding, run, 'agent-infra-lifecycle-executor', {
    requestedModel: 'model', requestedReasoningEffort: 'high'
  }));
  for (const mismatch of [
    { ...binding, taskId: 'TASK-20261005-122107' },
    { ...binding, runId: 'run-2' },
    { ...binding, receiptId: 'receipt-2' }
  ]) assert.throws(() => verifyCodexLifecycleTaskBinding(mismatch, run, 'agent-infra-lifecycle-executor'));
  assert.throws(() => verifyCodexLifecycleTaskBinding(binding, run, 'agent-infra-lifecycle-reviewer'));
});

test('Codex lifecycle store root resolves from the canonical task directory in every task state', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lifecycle-binding-'));
  roots.add(repo);
  const taskId = 'TASK-20261005-122106';
  const taskDir = path.join(repo, '.agents', 'workspace', 'archive', '2026', '10', '05', taskId, 'local');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: completed\n---\n`);

  assert.equal(resolveCodexLifecycleStoreRoot(taskId, { repoRoot: repo }), path.join(taskDir, '.runtime', 'codex-lifecycle'));
  assert.equal(fs.existsSync(path.join(repo, '.agents', 'workspace', '.runtime', 'codex-lifecycle')), false);
});
