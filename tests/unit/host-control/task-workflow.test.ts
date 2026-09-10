import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  captureProjectionTopology,
  createTaskWorkflowRequest,
  landProjectionArtifact,
  validateTaskWorkflowRequest,
  readProjectionArtifact,
  type TaskProjectionManifest
} from '../../../lib/sandbox/control/task-workflow.ts';
import { parseArtifactCommand } from '../../../lib/task/artifact-command.ts';
import { onPlatforms } from '../../helpers.ts';

function testRoot(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

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

test('task-workflow preserves arguments for the shared domain parser', () => {
  const args = ['TASK-20260904-002407', 'finalize-local', '--family', 'plan', '--family', 'code', '--artifact', 'plan.md'];
  const request = createTaskWorkflowRequest('task-artifact', args, args[0]!, 'generation-1');
  assert.deepEqual(request.args, args);
  assert.throws(() => parseArtifactCommand(request.args), /duplicate option/u);
});

test('task-workflow routes candidate initialization and repair with task binding', () => {
  for (const operation of ['init', 'repair']) {
    const args = ['TASK-20260904-002407', operation, '--family', 'plan', '--artifact', 'plan.md'];
    assert.equal(createTaskWorkflowRequest('task-artifact', args, args[0]!, 'g1').operation, `artifact-${operation}`);
    assert.throws(() => createTaskWorkflowRequest('task-artifact', args, 'TASK-20260904-002408', 'g1'), /TASK_WORKFLOW_REQUEST_INVALID/u);
  }
});

test('artifact landing refuses an unverified projection topology before reading', async () => {
  const root = testRoot('task-workflow-topology-');
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
    readProjectionArtifact(manifest, { artifact: 'plan.md' }),
    /TASK_PROJECTION_TOPOLOGY_UNVERIFIED/
  );
  assert.equal(fs.readdirSync(authoritative).length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('artifact landing verifies, hashes, and atomically copies the same projection bytes', onPlatforms('linux', 'darwin'), async () => {
  const root = testRoot('task-workflow-landing-');
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
  const candidate = await readProjectionArtifact(manifest, { artifact: 'plan.md' });
  fs.writeFileSync(path.join(projection, 'plan.md'), 'changed after validation\n');
  await landProjectionArtifact(manifest, candidate);
  assert.equal(candidate.bytes.length, Buffer.byteLength('candidate\n'));
  assert.equal(fs.readFileSync(path.join(authoritative, 'plan.md'), 'utf8'), 'candidate\n');
  fs.rmSync(root, { recursive: true, force: true });
});
