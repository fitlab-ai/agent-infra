import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  completeSandboxTaskCutover,
  prepareSandboxTaskCutover,
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
      /SANDBOX_TASK_CUTOVER_CONFLICT: host=/
    );
    fs.copyFileSync(
      path.join(cutoverRoot, 'payload', 'projection', 'plan.md'),
      path.join(f.hostTaskDir, 'plan.md')
    );
    const reconciled = await prepareSandboxTaskCutover(input);
    assert.equal(reconciled.state, 'verified-equal');
    await completeSandboxTaskCutover(input);
    assert.equal(fs.existsSync(cutoverRoot), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
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
