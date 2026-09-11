import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createTaskWorkflowRequest,
  readTaskArtifact,
  validateTaskWorkflowRequest,
  writeTaskArtifact
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

test('task-workflow reads and compare-writes the shared task directory', onPlatforms('linux', 'darwin'), async () => {
  const root = testRoot('task-workflow-direct-');
  const taskDir = path.join(root, 'active', 'TASK-20260904-002407');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'plan.md'), 'candidate\n');
  const candidate = await readTaskArtifact(taskDir, { artifact: 'plan.md' });
  await writeTaskArtifact(taskDir, {
    artifact: candidate.artifact,
    bytes: Buffer.from('published\n'),
    expectedSha256: candidate.sha256
  });
  assert.equal(fs.readFileSync(path.join(taskDir, 'plan.md'), 'utf8'), 'published\n');
  fs.writeFileSync(path.join(taskDir, 'plan.md'), 'concurrent\n');
  await assert.rejects(
    writeTaskArtifact(taskDir, {
      artifact: candidate.artifact,
      bytes: Buffer.from('stale\n'),
      expectedSha256: candidate.sha256
    }),
    /TASK_ARTIFACT_WRITE_CONFLICT/
  );
  assert.equal(fs.readFileSync(path.join(taskDir, 'plan.md'), 'utf8'), 'concurrent\n');
  fs.rmSync(root, { recursive: true, force: true });
});
