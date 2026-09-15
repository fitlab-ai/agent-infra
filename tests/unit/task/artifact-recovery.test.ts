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
  prepareArtifactRecoveryFinal,
  recordArtifactRecoveryPassed,
  reconcileArtifactRecovery,
  readArtifactRecoveryIntent,
  sha256Content,
  stageArtifactCandidate
} from '../../../lib/task/artifact-recovery.ts';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), prefix));
}

test('artifact recovery publishes a staged candidate through durable states', () => {
  const repoRoot = makeTempDir('agent-infra-recovery-');
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
  assert.equal(context.stagingPath, path.join(taskDir, '.local-artifact-recovery', 'abcde-00000000001', 'candidate.md'));
  assert.deepEqual(fs.readFileSync(context.stagingPath), baseline);
  assert.equal(readArtifactRecoveryIntent(repoRoot, taskId, 'code', 'code.md')?.state, 'awaiting-preflight-recovery');

  const staged = stageArtifactCandidate(context, candidate);
  assert.equal(staged.candidateSha256.length, 64);
  assert.deepEqual(fs.readFileSync(artifact), baseline);

  prepareArtifactRecoveryCommit(context, staged.candidateSha256, staged.semanticDigest);
  assert.equal(readArtifactRecoveryIntent(repoRoot, taskId, 'code', 'code.md')?.state, 'preflight-ready');

  const preflight = commitArtifactRecovery(context);
  assert.equal(preflight.state, 'preflight-passed');
  prepareArtifactRecoveryFinal(context, candidate);
  const committed = commitArtifactRecovery(context);
  assert.equal(committed.state, 'passed');
  assert.deepEqual(fs.readFileSync(artifact), candidate);
  assert.equal(readArtifactRecoveryIntent(repoRoot, taskId, 'code', 'code.md')?.state, 'passed');

  const consumed = consumeArtifactRecovery(context);
  assert.equal(consumed.state, 'consumed');
  assert.equal(readArtifactRecoveryIntent(repoRoot, taskId, 'code', 'code.md')?.state, 'consumed');
});

test('artifact recovery refuses a formal target changed after staging', () => {
  const repoRoot = makeTempDir('agent-infra-recovery-');
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
  assert.equal(readArtifactRecoveryIntent(repoRoot, taskId, 'plan', 'plan.md')?.state, 'preflight-commit-started');
});

test('artifact recovery publishes the validated snapshot when the candidate changes after preparation', () => {
  const repoRoot = makeTempDir('agent-infra-recovery-');
  const taskId = 'TASK-20260101-000003';
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const artifact = path.join(taskDir, 'code.md');
  const baseline = Buffer.from('baseline\n');
  const candidate = Buffer.from('validated\n');
  fs.writeFileSync(artifact, baseline);

  const context = beginArtifactRecovery(
    { taskId, family: 'code', artifact: 'code.md', round: 1, requestId: 'recovery-test-3' },
    baseline,
    { repoRoot, taskDir, recoveryId: 'abcde-00000000003' }
  );
  const staged = stageArtifactCandidate(context, candidate);
  prepareArtifactRecoveryCommit(context, staged.candidateSha256, staged.semanticDigest);
  fs.writeFileSync(context.stagingPath, 'unvalidated-race\n');

  const preflight = commitArtifactRecovery(context);
  assert.equal(preflight.state, 'preflight-passed');
  prepareArtifactRecoveryFinal(context, candidate);
  const committed = commitArtifactRecovery(context);
  assert.equal(committed.state, 'passed');
  assert.deepEqual(fs.readFileSync(artifact), candidate);
  assert.equal(readArtifactRecoveryIntent(repoRoot, taskId, 'code', 'code.md')?.state, 'passed');
});

test('artifact recovery publishes sealed bytes when final.md is swapped before rename', () => {
  const repoRoot = makeTempDir('agent-infra-recovery-');
  const taskId = 'TASK-20260101-000008';
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const artifact = path.join(taskDir, 'code.md');
  const baseline = Buffer.from('baseline\n');
  const candidate = Buffer.from('validated-final\n');
  fs.writeFileSync(artifact, baseline);

  const context = beginArtifactRecovery(
    { taskId, family: 'code', artifact: 'code.md', round: 1, requestId: 'recovery-test-8' },
    baseline,
    { repoRoot, taskDir, recoveryId: 'abcde-00000000008' }
  );
  const staged = stageArtifactCandidate(context, candidate);
  prepareArtifactRecoveryCommit(context, staged.candidateSha256, staged.semanticDigest);

  const originalRename = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === artifact) {
      const generation = path.join(context.generationsPath, `${staged.candidateSha256}.md`);
      fs.chmodSync(generation, 0o644);
      fs.writeFileSync(generation, 'unvalidated-final-race\n');
    }
    return originalRename(from, to);
  }) as typeof fs.renameSync;
  try {
    const committed = commitArtifactRecovery(context);
    assert.equal(committed.state, 'preflight-passed');
  } finally {
    fs.renameSync = originalRename;
  }

  assert.deepEqual(fs.readFileSync(artifact), candidate);
  assert.equal(readArtifactRecoveryIntent(repoRoot, taskId, 'code', 'code.md')?.state, 'preflight-passed');
});

test('artifact recovery rejects a symlinked recovery-root ancestor before creating outside files', () => {
  const repoRoot = makeTempDir('agent-infra-recovery-');
  const external = makeTempDir('agent-infra-recovery-external-');
  const taskId = 'TASK-20260101-000004';
  const workspace = path.join(repoRoot, '.agents', 'workspace');
  const taskDir = path.join(workspace, 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const artifact = path.join(taskDir, 'code.md');
  const baseline = Buffer.from('baseline\n');
  fs.writeFileSync(artifact, baseline);
  fs.symlinkSync(external, path.join(taskDir, '.local-artifact-recovery'), 'dir');

  assert.throws(
    () => beginArtifactRecovery(
      { taskId, family: 'code', artifact: 'code.md', round: 1, requestId: 'recovery-test-4' },
      baseline,
      { repoRoot, taskDir, recoveryId: 'abcde-00000000004' }
    ),
    /ARTIFACT_RECOVERY_PATH_INVALID/
  );
  assert.equal(fs.existsSync(path.join(external, taskId)), false);
});

test('artifact recovery binds the fast-path provenance to the finalizer bytes', () => {
  const repoRoot = makeTempDir('agent-infra-recovery-');
  const taskId = 'TASK-20260101-000007';
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const artifact = path.join(taskDir, 'analysis.md');
  const validated = Buffer.from('validated\n');
  fs.writeFileSync(artifact, 'stale\n');

  assert.throws(
    () => recordArtifactRecoveryPassed(
      { taskId, family: 'analysis', artifact: 'analysis.md', round: 1, requestId: 'recovery-test-7' },
      {
        repoRoot,
        taskDir,
        expectedFinalSha256: sha256Content(validated.toString('utf8')),
        expectedFinalSemanticDigest: sha256Content(validated.toString('utf8'))
      }
    ),
    /ARTIFACT_RECOVERY_CANDIDATE_MISMATCH/
  );
  assert.equal(readArtifactRecoveryIntent(repoRoot, taskId, 'analysis', 'analysis.md'), null);
});

test('artifact recovery reconciles a commit-started transaction and pauses on a third target fingerprint', () => {
  const repoRoot = makeTempDir('agent-infra-recovery-');
  const taskId = 'TASK-20260101-000005';
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const artifact = path.join(taskDir, 'plan.md');
  const baseline = Buffer.from('baseline\n');
  const candidate = Buffer.from('candidate\n');
  fs.writeFileSync(artifact, baseline);

  const context = beginArtifactRecovery(
    { taskId, family: 'plan', artifact: 'plan.md', round: 1, requestId: 'recovery-test-5' },
    baseline,
    { repoRoot, taskDir, recoveryId: 'abcde-00000000005' }
  );
  const staged = stageArtifactCandidate(context, candidate);
  prepareArtifactRecoveryCommit(context, staged.candidateSha256, staged.semanticDigest);
  const originalRename = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === artifact) throw new Error('injected rename failure');
    return originalRename(from, to);
  }) as typeof fs.renameSync;
  try {
    assert.throws(() => commitArtifactRecovery(context), /lifecycle task lock operation failed/);
  } finally {
    fs.renameSync = originalRename;
  }

  assert.equal(readArtifactRecoveryIntent(repoRoot, taskId, 'plan', 'plan.md')?.state, 'preflight-commit-started');
  const retried = reconcileArtifactRecovery(context);
  assert.equal(retried.status, 'preflight-passed');
  assert.deepEqual(fs.readFileSync(artifact), candidate);
  prepareArtifactRecoveryFinal(context, candidate);
  commitArtifactRecovery(context);
  consumeArtifactRecovery(context);

  const secondContext = beginArtifactRecovery(
    { taskId, family: 'plan', artifact: 'plan.md', round: 1, requestId: 'recovery-test-5b' },
    candidate,
    { repoRoot, taskDir, recoveryId: 'abcde-00000000006' }
  );
  const second = stageArtifactCandidate(secondContext, Buffer.from('candidate-2\n'));
  prepareArtifactRecoveryCommit(secondContext, second.candidateSha256, second.semanticDigest);
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === artifact) throw new Error('injected rename failure');
    return originalRename(from, to);
  }) as typeof fs.renameSync;
  try {
    assert.throws(() => commitArtifactRecovery(secondContext), /lifecycle task lock operation failed/);
  } finally {
    fs.renameSync = originalRename;
  }
  fs.chmodSync(artifact, 0o644);
  fs.writeFileSync(artifact, 'third-fingerprint\n');
  const paused = reconcileArtifactRecovery(secondContext);
  assert.equal(paused.status, 'indeterminate');
  assert.equal(readArtifactRecoveryIntent(repoRoot, taskId, 'plan', 'plan.md')?.state, 'preflight-commit-started');
  assert.equal(fs.readFileSync(artifact, 'utf8'), 'third-fingerprint\n');
});
