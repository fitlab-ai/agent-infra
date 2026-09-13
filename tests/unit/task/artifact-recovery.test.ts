import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  beginArtifactRecovery,
  commitArtifactRecovery,
  consumeArtifactRecovery,
  prepareArtifactRecoveryCommit,
  readArtifactRecoveryIntent,
  stageArtifactCandidate
} from '../../../lib/task/artifact-recovery.ts';

test('artifact recovery publishes a staged candidate through durable states', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-recovery-'));
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const artifact = path.join(taskDir, 'code.md');
  const baseline = Buffer.from('baseline\n');
  const candidate = Buffer.from('candidate\n');
  fs.writeFileSync(artifact, baseline);

  const context = beginArtifactRecovery(
    {
      taskId,
      family: 'code',
      artifact: 'code.md',
      round: 1,
      requestId: 'recovery-test-1'
    },
    baseline,
    { repoRoot, taskDir, recoveryId: 'abcde-00000000001' }
  );

  assert.deepEqual(fs.readFileSync(artifact), baseline);
  assert.deepEqual(fs.readFileSync(context.stagingPath), baseline);
  assert.equal(readArtifactRecoveryIntent(repoRoot, taskId, 'code', 'code.md')?.state, 'awaiting-recovery');

  const staged = stageArtifactCandidate(context, candidate);
  assert.equal(staged.candidateSha256.length, 64);
  assert.deepEqual(fs.readFileSync(artifact), baseline);

  prepareArtifactRecoveryCommit(context, staged.candidateSha256, staged.semanticDigest);
  assert.equal(readArtifactRecoveryIntent(repoRoot, taskId, 'code', 'code.md')?.state, 'finalize-ready');

  const committed = commitArtifactRecovery(context);
  assert.equal(committed.state, 'passed');
  assert.deepEqual(fs.readFileSync(artifact), candidate);
  assert.equal(readArtifactRecoveryIntent(repoRoot, taskId, 'code', 'code.md')?.state, 'passed');

  const consumed = consumeArtifactRecovery(context);
  assert.equal(consumed.state, 'consumed');
  assert.equal(readArtifactRecoveryIntent(repoRoot, taskId, 'code', 'code.md')?.state, 'consumed');
});

test('artifact recovery refuses a formal target changed after staging', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-recovery-'));
  const taskId = 'TASK-20260101-000002';
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const artifact = path.join(taskDir, 'plan.md');
  const baseline = Buffer.from('baseline\n');
  fs.writeFileSync(artifact, baseline);

  const context = beginArtifactRecovery(
    { taskId, family: 'plan', artifact: 'plan.md', round: 1, requestId: 'recovery-test-2' },
    baseline,
    { repoRoot, taskDir, recoveryId: 'abcde-00000000002' }
  );
  const staged = stageArtifactCandidate(context, Buffer.from('candidate\n'));
  prepareArtifactRecoveryCommit(context, staged.candidateSha256, staged.semanticDigest);
  fs.writeFileSync(artifact, 'external\n');

  assert.throws(
    () => commitArtifactRecovery(context),
    /ARTIFACT_RECOVERY_CONFLICT/
  );
  assert.equal(fs.readFileSync(artifact, 'utf8'), 'external\n');
  assert.equal(readArtifactRecoveryIntent(repoRoot, taskId, 'plan', 'plan.md')?.state, 'commit-started');
});
