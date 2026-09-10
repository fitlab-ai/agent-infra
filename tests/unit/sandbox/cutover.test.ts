import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  completeSandboxTaskCutover,
  prepareSandboxTaskCutover,
  recordSandboxTaskCutoverReconciliation,
  sandboxTaskCutoverRoot,
  snapshotSandboxTaskTree
} from '../../../lib/sandbox/cutover.ts';

const taskId = 'TASK-20260904-002407';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-cutover-'));
  const hostTaskDir = path.join(root, 'repo', '.agents', 'workspace', 'active', taskId);
  const projectionDir = path.join(root, 'view', taskId);
  const manifestPath = path.join(root, 'control', 'manifest.json');
  fs.mkdirSync(hostTaskDir, { recursive: true });
  fs.mkdirSync(projectionDir, { recursive: true });
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(path.join(hostTaskDir, 'task.md'), 'same\n');
  fs.writeFileSync(path.join(projectionDir, 'task.md'), 'same\n');
  fs.writeFileSync(manifestPath, '{"legacy":true}\n');
  return { root, hostTaskDir, projectionDir, manifestPath };
}

function params(f: ReturnType<typeof fixture>) {
  return {
    base: path.join(f.root, 'home', '.agent-infra', 'sandbox-cutover'),
    project: 'project',
    container: 'project-dev-feature',
    taskId,
    generation: 'generation-1',
    hostTaskDir: f.hostTaskDir,
    projectionDir: f.projectionDir,
    manifestPath: f.manifestPath
  };
}

test('cutover records equal trees and removes its journal only after direct readiness', async () => {
  const f = fixture();
  const input = params(f);
  try {
    const prepared = await prepareSandboxTaskCutover(input);
    assert.equal(prepared.state, 'verified-equal');
    const cutoverRoot = sandboxTaskCutoverRoot(input);
    assert.equal(fs.existsSync(path.join(cutoverRoot, 'journal.json')), true);
    await completeSandboxTaskCutover(input);
    assert.equal(fs.existsSync(cutoverRoot), false);
    assert.equal(fs.readFileSync(path.join(f.hostTaskDir, 'task.md'), 'utf8'), 'same\n');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('cutover preserves a changed projection outside the view and is replayable', async () => {
  const f = fixture();
  const input = params(f);
  fs.writeFileSync(path.join(f.projectionDir, 'plan.md'), 'projection-only\n');
  try {
    await assert.rejects(
      prepareSandboxTaskCutover(input),
      /SANDBOX_TASK_CUTOVER_CONFLICT/
    );
    const cutoverRoot = sandboxTaskCutoverRoot(input);
    assert.equal(fs.readFileSync(path.join(f.hostTaskDir, 'task.md'), 'utf8'), 'same\n');
    assert.equal(fs.readFileSync(path.join(cutoverRoot, 'payload', 'projection', 'plan.md'), 'utf8'), 'projection-only\n');
    await assert.rejects(
      prepareSandboxTaskCutover(input),
      /SANDBOX_TASK_CUTOVER_RECONCILIATION_REQUIRED/
    );
    fs.copyFileSync(
      path.join(cutoverRoot, 'payload', 'projection', 'plan.md'),
      path.join(f.hostTaskDir, 'plan.md')
    );
    await assert.rejects(
      prepareSandboxTaskCutover(input),
      /SANDBOX_TASK_CUTOVER_RECONCILIATION_REQUIRED/
    );
    const reconciliation = await recordSandboxTaskCutoverReconciliation({
      ...input,
      operator: 'maintainer'
    });
    assert.equal(reconciliation.action, 'reconcile-host');
    const reconciled = await prepareSandboxTaskCutover(input);
    assert.equal(reconciled.state, 'verified-equal');
    await completeSandboxTaskCutover(input);
    assert.equal(fs.existsSync(cutoverRoot), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('cutover accepts an audited merged reconciliation without replacing host state', async () => {
  const f = fixture();
  const input = params(f);
  fs.writeFileSync(path.join(f.hostTaskDir, 'task.md'), 'host-new-event\n');
  fs.writeFileSync(path.join(f.projectionDir, 'task.md'), 'sandbox-human-decision\n');
  try {
    await assert.rejects(prepareSandboxTaskCutover(input), /SANDBOX_TASK_CUTOVER_CONFLICT/);
    fs.writeFileSync(path.join(f.hostTaskDir, 'task.md'), 'host-new-event\nsandbox-human-decision\n');
    await recordSandboxTaskCutoverReconciliation({
      ...input,
      operator: 'maintainer'
    });
    const reconciled = await prepareSandboxTaskCutover(input);
    assert.equal(reconciled.state, 'verified-equal');
    await completeSandboxTaskCutover(input);
    assert.equal(fs.readFileSync(path.join(f.hostTaskDir, 'task.md'), 'utf8'), 'host-new-event\nsandbox-human-decision\n');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('cutover rejects a stale host reconciliation fact', async () => {
  const f = fixture();
  const input = params(f);
  fs.writeFileSync(path.join(f.projectionDir, 'plan.md'), 'projection-only\n');
  try {
    await assert.rejects(prepareSandboxTaskCutover(input), /SANDBOX_TASK_CUTOVER_CONFLICT/);
    fs.copyFileSync(
      path.join(sandboxTaskCutoverRoot(input), 'payload', 'projection', 'plan.md'),
      path.join(f.hostTaskDir, 'plan.md')
    );
    await recordSandboxTaskCutoverReconciliation({ ...input, operator: 'maintainer' });
    fs.writeFileSync(path.join(f.hostTaskDir, 'task.md'), 'changed-after-confirmation\n');
    await assert.rejects(prepareSandboxTaskCutover(input), /SANDBOX_TASK_CUTOVER_RECONCILIATION_REQUIRED/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('cutover rejects a changed payload or manifest after reconciliation', async () => {
  for (const mutate of ['payload', 'manifest'] as const) {
    const f = fixture();
    const input = params(f);
    fs.writeFileSync(path.join(f.projectionDir, 'plan.md'), 'projection-only\n');
    try {
      await assert.rejects(prepareSandboxTaskCutover(input), /SANDBOX_TASK_CUTOVER_CONFLICT/);
      const cutoverRoot = sandboxTaskCutoverRoot(input);
      fs.copyFileSync(
        path.join(cutoverRoot, 'payload', 'projection', 'plan.md'),
        path.join(f.hostTaskDir, 'plan.md')
      );
      await recordSandboxTaskCutoverReconciliation({ ...input, operator: 'maintainer' });
      if (mutate === 'payload') {
        fs.writeFileSync(path.join(cutoverRoot, 'payload', 'projection', 'plan.md'), 'tampered\n');
      } else {
        fs.writeFileSync(f.manifestPath, '{"changed":true}\n');
      }
      await assert.rejects(prepareSandboxTaskCutover(input), /SANDBOX_TASK_CUTOVER_RECONCILIATION_REQUIRED/);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('cutover rejects unstable tree entries and leaves a prepared journal', async () => {
  const f = fixture();
  const input = params(f);
  fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.projectionDir, 'link'));
  try {
    assert.throws(() => snapshotSandboxTaskTree(f.projectionDir), /SANDBOX_TASK_CUTOVER_SOURCE_INVALID/);
    await assert.rejects(prepareSandboxTaskCutover(input), /SANDBOX_TASK_CUTOVER_INVALID/);
    assert.equal(fs.existsSync(path.join(sandboxTaskCutoverRoot(input), 'journal.json')), true);
    assert.equal(fs.existsSync(path.join(sandboxTaskCutoverRoot(input), 'payload')), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
