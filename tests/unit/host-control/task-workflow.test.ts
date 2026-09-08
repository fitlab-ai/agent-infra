import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  TASK_WORKFLOW_OPERATIONS,
  captureProjectionTopology,
  createTaskWorkflowRequest,
  landProjectionArtifact,
  validateTaskWorkflowRequest,
  workflowArguments,
  type TaskProjectionManifest
} from '../../../lib/sandbox/control/task-workflow.ts';

test('task-workflow exposes a closed typed operation catalog', () => {
  assert.deepEqual([...TASK_WORKFLOW_OPERATIONS], [
    'artifact-inspect', 'artifact-finalize-local', 'review-finalize-summary', 'event',
    'ledger-finding-response', 'ledger-finding-review', 'ledger-finding-upsert',
    'decision-next-id', 'decision-upsert', 'invalidation-reconcile', 'warning-add'
  ]);
});

test('task-workflow rejects client paths and unknown fields', () => {
  assert.throws(() => validateTaskWorkflowRequest({
    version: 1,
    id: 'request-1',
    taskId: 'TASK-20260904-002407',
    generation: 'generation-1',
    operation: 'artifact-finalize-local',
    artifact: 'plan.md',
    taskDir: '/tmp/escape'
  }), /TASK_WORKFLOW_REQUEST_INVALID/);
});

test('task-workflow converts a CLI artifact command into a bound typed request', () => {
  const request = createTaskWorkflowRequest('task-artifact', [
    'TASK-20260904-002407', 'finalize-local', '--family', 'plan', '--artifact', 'plan-r8.md'
  ], 'TASK-20260904-002407', 'generation-1');
  assert.equal(request.operation, 'artifact-finalize-local');
  assert.deepEqual(request.fields, {
    taskRef: 'TASK-20260904-002407',
    family: 'plan',
    artifact: 'plan-r8.md'
  });
  assert.deepEqual(workflowArguments(request), [
    'TASK-20260904-002407', 'finalize-local', '--family', 'plan', '--artifact', 'plan-r8.md'
  ]);
});

test('artifact landing refuses an unverified projection topology before reading', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-workflow-topology-'));
  const projection = path.join(root, 'projection');
  const authoritative = path.join(root, 'authoritative');
  fs.mkdirSync(projection);
  fs.mkdirSync(authoritative);
  fs.writeFileSync(path.join(projection, 'plan.md'), 'candidate\n');
  const manifest: TaskProjectionManifest = {
    version: 1,
    taskId: 'TASK-20260904-002407',
    generation: 'generation-1',
    projectionRoot: projection,
    authoritativeTaskDir: authoritative,
    topology: { verified: false, ancestors: [] }
  };
  await assert.rejects(
    landProjectionArtifact(manifest, { artifact: 'plan.md' }),
    /TASK_PROJECTION_TOPOLOGY_UNVERIFIED/
  );
  assert.equal(fs.readdirSync(authoritative).length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('artifact landing verifies, hashes, and atomically copies the same projection bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-workflow-landing-'));
  const projection = path.join(root, 'projection');
  const authoritative = path.join(root, 'authoritative');
  fs.mkdirSync(projection);
  fs.mkdirSync(authoritative);
  fs.writeFileSync(path.join(projection, 'plan.md'), 'candidate\n');
  const manifest: TaskProjectionManifest = {
    version: 1,
    taskId: 'TASK-20260904-002407',
    generation: 'generation-1',
    projectionRoot: projection,
    authoritativeTaskDir: authoritative,
    topology: { verified: true, ancestors: captureProjectionTopology(projection) }
  };
  const result = await landProjectionArtifact(manifest, { artifact: 'plan.md' });
  assert.equal(result.bytes, Buffer.byteLength('candidate\n'));
  assert.equal(fs.readFileSync(path.join(authoritative, 'plan.md'), 'utf8'), 'candidate\n');
  fs.rmSync(root, { recursive: true, force: true });
});
