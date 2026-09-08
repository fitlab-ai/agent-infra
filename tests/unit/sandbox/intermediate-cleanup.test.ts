import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  removeIntermediateCleanupCandidates,
  scanIntermediateCleanup
} from '../../../lib/sandbox/intermediate-cleanup.ts';
import { createSandboxControlBindingVerifier } from '../../../lib/sandbox/control/lifecycle.ts';
import { captureSandboxAuthority } from '../../../lib/sandbox/engines/authority.ts';
import {
  checkpointIntentDigest,
  writeCheckpointIntent,
  type CheckpointIntent
} from '../../../lib/task/commit-intent.ts';
import {
  semanticDigest,
  sha256Content
} from '../../../lib/task/local-artifact-finalization.ts';
import { withTaskExecutionLock } from '../../../lib/task/task-execution-lock.ts';
import { onPlatforms } from '../../helpers.ts';

function cleanupIntermediateFiles(
  repoRoot: string,
  options: Parameters<typeof scanIntermediateCleanup>[1] = {}
) {
  const first = removeIntermediateCleanupCandidates(scanIntermediateCleanup(repoRoot, options).items);
  const known = new Set(first.items.map((item) => `${item.kind}\0${item.path}`));
  const emptyParents = scanIntermediateCleanup(repoRoot, options).items.filter((item) =>
    item.kind === 'EMPTY-AUX-PARENT' && item.disposition === 'planned' && !known.has(`${item.kind}\0${item.path}`)
  );
  const second = removeIntermediateCleanupCandidates(emptyParents);
  const items = [...first.items, ...second.items];
  return {
    status: items.some((item) => item.disposition === 'failed') ? 'partial' as const : 'completed' as const,
    items,
    remaining: items.filter((item) => item.disposition !== 'deleted' && item.disposition !== 'skipped')
  };
}

const TASK_ID = 'TASK-20260101-000001';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com'
    }
  }).trim();
}

function taskFixture(): { root: string; taskDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intermediate-cleanup-'));
  const taskDir = path.join(root, '.agents', 'workspace', 'completed', TASK_ID);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${TASK_ID}\nstatus: completed\nbranch: feature/cleanup\n---\n`);
  fs.mkdirSync(path.join(root, '.agents', 'workspace', '.task-finalization'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.agents', 'workspace', '.task-finalization', `${TASK_ID}.json`),
    `${JSON.stringify({
      version: 2,
      taskId: TASK_ID,
      intent: 'complete',
      receiptId: 'receipt-1',
      revision: 1,
      lifecycle: 'done',
      taskComment: 'done',
      verification: 'done',
      warningProjection: 'done',
      warnings: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastError: null
    })}\n`
  );
  return { root, taskDir };
}

function writeConsumedIntent(root: string, taskDir: string): string {
  const artifact = 'plan.md';
  const content = '# Plan\n';
  const artifactPath = path.join(taskDir, artifact);
  fs.writeFileSync(artifactPath, content);
  const intent = {
    version: 1,
    taskId: TASK_ID,
    family: 'plan',
    artifact,
    state: 'consumed',
    baselineSemanticDigest: null,
    artifactSha256: sha256Content(content),
    semanticDigest: semanticDigest(content)
  };
  const intentDir = path.join(root, '.agents', 'workspace', '.local-artifact-finalization-intents');
  fs.mkdirSync(intentDir, { recursive: true });
  fs.writeFileSync(path.join(intentDir, `${TASK_ID}-plan-${artifact}.json`), `${JSON.stringify(intent)}\n`);
  return path.join(intentDir, `${TASK_ID}-plan-${artifact}.json`);
}

function writeBoundControlEvidence(root: string): string {
  const generation = 'generation-1';
  const requestId = 'a'.repeat(16);
  const controlRoot = path.join(root, 'control', 'demo-container', 'identity');
  const channelDir = path.join(controlRoot, 'channel');
  const publicStatusDir = path.join(controlRoot, 'public');
  const processingDir = path.join(controlRoot, 'processing');
  fs.mkdirSync(processingDir, { recursive: true });
  fs.mkdirSync(channelDir, { recursive: true });
  fs.mkdirSync(path.join(channelDir, 'responses'), { recursive: true });
  fs.mkdirSync(publicStatusDir, { recursive: true });
  fs.mkdirSync(path.join(controlRoot, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(controlRoot, 'manifest.json'), `${JSON.stringify({
    engine: 'docker-desktop',
    repoRoot: root,
    worktreeRoot: root,
    project: 'demo',
    container: 'demo-container',
    containerIdentity: { id: 'f'.repeat(64), labels: {} },
    authorityEvidence: captureSandboxAuthority('docker-desktop', {
      lockDomain: 'b'.repeat(64),
      probe: (_command, args) => ({
        status: 0, signal: null, stdout: JSON.stringify(args.at(-1) === '{{json .ID}}' ? 'daemon' : { ApiVersion: '1.50' }),
        stderr: '', pid: 1, output: []
      })
    }),
    branch: 'feature/cleanup',
    mode: 'task-bound',
    taskId: TASK_ID,
    token: 'token',
    generation,
    channelDir,
    publicStatusDir,
    processingDir,
    runtimeDir: path.join(controlRoot, 'runtime')
  })}\n`);
  fs.writeFileSync(path.join(publicStatusDir, 'status.json'), `${JSON.stringify({
    version: 3,
    generation,
    broker: { pid: 999_999_999, startTime: 0, brokerId: 'broker' },
    state: 'healthy',
    reasonCode: null,
    activeRequestId: null,
    updatedAt: Date.now(),
    taskView: {
      state: 'current',
      taskId: TASK_ID,
      observedSource: 'completed',
      receipt: { receiptId: 'receipt-1', revision: 1, generation, requestId },
      reasonCode: null
    }
  })}\n`);
  const receiptPath = path.join(root, '.agents', 'workspace', '.task-finalization', `${TASK_ID}.json`);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
  receipt.controlBinding = { generation, requestId };
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
  const result = {
    status: 'completed', changed: false, taskId: TASK_ID,
    lifecycle: { status: 'no-op', changed: false, error: null },
    taskComment: { status: 'no-op', changed: false, error: null },
    verification: { status: 'no-op', changed: false, error: null },
    completedSteps: ['lifecycle', 'task-comment', 'verification'], pendingSteps: [],
    result: 'completed', warnings: [], error: null
  };
  fs.writeFileSync(path.join(channelDir, 'responses', `${requestId}.json`), `${JSON.stringify({
    version: 2, id: requestId, phase: 'completed', exitCode: 0,
    stdout: `${JSON.stringify({ version: 1, status: 'completed', changed: false, accepted: true, result, error: null })}\n`,
    stderr: '', error: null
  })}\n`);
  return controlRoot;
}

function writeSyncedIntent(root: string): string {
  const repoFile = path.join(root, 'tracked.txt');
  fs.writeFileSync(repoFile, 'before\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', 'tracked.txt');
  git(root, 'commit', '-q', '-m', 'initial');
  const expectedHead = git(root, 'rev-parse', 'HEAD');
  fs.writeFileSync(repoFile, 'after\n');
  git(root, 'add', 'tracked.txt');
  const expectedTree = git(root, 'write-tree');
  git(root, 'commit', '-q', '-m', 'checkpoint');
  const committedHead = git(root, 'rev-parse', 'HEAD');
  const identity = {
    taskId: TASK_ID,
    branch: 'feature/cleanup',
    mode: 'local' as const,
    expectedHead,
    expectedTree,
    paths: ['tracked.txt'],
    message: 'checkpoint',
    round: 1
  };
  const intent: CheckpointIntent = {
    version: 1,
    ...identity,
    digest: checkpointIntentDigest(identity),
    state: 'synced',
    committedHead,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
  writeCheckpointIntent(root, intent);
  const taskPath = path.join(root, '.agents', 'workspace', 'completed', TASK_ID, 'task.md');
  const task = fs.readFileSync(taskPath, 'utf8').replace(
    `branch: feature/cleanup\n`,
    `branch: feature/cleanup\ncheckpoint_commit: ${committedHead}\n`
  );
  fs.writeFileSync(taskPath, task);
  return path.join(root, '.agents', 'workspace', '.task-commit-intents', `${TASK_ID}.json`);
}

test('intermediate cleanup deletes only a receipt-backed consumed artifact intent', () => {
  const fixture = taskFixture();
  try {
    const target = writeConsumedIntent(fixture.root, fixture.taskDir);
    const planned = scanIntermediateCleanup(fixture.root);
    assert.equal(planned.items.some((item) => item.kind === 'LFAI-CONSUMED' && item.disposition === 'planned'), true);
    const result = cleanupIntermediateFiles(fixture.root);
    assert.equal(result.items.some((item) => item.kind === 'LFAI-CONSUMED' && item.disposition === 'deleted'), true);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(path.join(fixture.taskDir, 'plan.md')), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('intermediate cleanup preserves active and malformed auxiliary records', () => {
  const fixture = taskFixture();
  try {
    const target = writeConsumedIntent(fixture.root, fixture.taskDir);
    const activeId = 'TASK-20260101-000002';
    const activeDir = path.join(fixture.root, '.agents', 'workspace', 'active', activeId);
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, 'task.md'), `---\nid: ${activeId}\nstatus: active\nbranch: feature/active\n---\n`);
    const malformed = path.join(fixture.root, '.agents', 'workspace', '.task-commit-intents', `${activeId}.json`);
    fs.mkdirSync(path.dirname(malformed), { recursive: true });
    fs.writeFileSync(malformed, '{"version":1}\n');
    const result = cleanupIntermediateFiles(fixture.root);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(malformed), true);
    assert.equal(result.items.some((item) => item.disposition === 'protected' && item.reason === 'TASK_STATE_PROTECTED'), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('intermediate cleanup preserves symlinked auxiliary records', onPlatforms('linux', 'darwin'), () => {
  const fixture = taskFixture();
  try {
    const target = writeConsumedIntent(fixture.root, fixture.taskDir);
    const symlink = path.join(fixture.root, '.agents', 'workspace', '.local-artifact-finalization-intents', 'foreign.json');
    fs.symlinkSync(target, symlink);
    const result = cleanupIntermediateFiles(fixture.root);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.lstatSync(symlink).isSymbolicLink(), true);
    assert.equal(result.items.some((item) => item.disposition === 'protected' && item.reason === 'PATH_SYMLINK'), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('intermediate cleanup verifies synced commit identity and removes empty auxiliary parents', () => {
  const fixture = taskFixture();
  try {
    const target = writeSyncedIntent(fixture.root);
    fs.mkdirSync(path.join(fixture.root, '.agents', 'workspace', '.local-artifact-finalization-intents'), { recursive: true });
    const result = cleanupIntermediateFiles(fixture.root);
    assert.equal(result.items.some((item) => item.kind === 'COMMIT-SYNCED' && item.disposition === 'deleted'), true);
    assert.equal(fs.existsSync(target), false);
    assert.equal(result.items.some((item) => item.kind === 'EMPTY-AUX-PARENT' && item.disposition === 'deleted'), true);
    assert.equal(
      result.items.some((item) => item.kind === 'EMPTY-AUX-PARENT'
        && item.path.endsWith(path.join('.agents', 'workspace', '.task-commit-intents'))
        && item.disposition === 'deleted'),
      true
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('intermediate cleanup deletion runs inside the caller-owned task lock', () => {
  const fixture = taskFixture();
  try {
    const target = writeConsumedIntent(fixture.root, fixture.taskDir);
    withTaskExecutionLock(fixture.root, TASK_ID, 'test-holder', () => {
      const result = cleanupIntermediateFiles(fixture.root);
      assert.equal(fs.existsSync(target), false);
      assert.equal(result.items.some((item) => item.disposition === 'deleted'), true);
    });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('intermediate cleanup requires an explicit verifier for bound finalization receipts', () => {
  const fixture = taskFixture();
  try {
    const target = writeConsumedIntent(fixture.root, fixture.taskDir);
    const receiptPath = path.join(fixture.root, '.agents', 'workspace', '.task-finalization', `${TASK_ID}.json`);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    receipt.controlBinding = { generation: 'generation-1', requestId: 'a'.repeat(16) };
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
    const protectedReport = scanIntermediateCleanup(fixture.root);
    assert.equal(protectedReport.items.some((item) => item.reason === 'CONTROL_BINDING_MISMATCH'), true);
    const result = cleanupIntermediateFiles(fixture.root, { controlBindingVerifier: () => true });
    assert.equal(result.items.some((item) => item.disposition === 'deleted'), true);
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('intermediate cleanup accepts only terminal control evidence for bound receipts', () => {
  const fixture = taskFixture();
  try {
    const target = writeConsumedIntent(fixture.root, fixture.taskDir);
    const controlRoot = writeBoundControlEvidence(fixture.root);
    const verifier = createSandboxControlBindingVerifier(fixture.root, [controlRoot]);
    const result = cleanupIntermediateFiles(fixture.root, { controlBindingVerifier: verifier });
    assert.equal(result.items.some((item) => item.disposition === 'deleted'), true);
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('intermediate cleanup reuses captured terminal evidence after the control root is deleted', () => {
  const fixture = taskFixture();
  try {
    const target = writeConsumedIntent(fixture.root, fixture.taskDir);
    const controlRoot = writeBoundControlEvidence(fixture.root);
    const verifier = createSandboxControlBindingVerifier(fixture.root, [controlRoot]);
    fs.rmSync(controlRoot, { recursive: true, force: true });
    const result = cleanupIntermediateFiles(fixture.root, { controlBindingVerifier: verifier });
    assert.equal(result.items.some((item) => item.disposition === 'deleted'), true);
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('intermediate cleanup reconstructs terminal evidence from a removal journal on a later call', () => {
  const fixture = taskFixture();
  try {
    const target = writeConsumedIntent(fixture.root, fixture.taskDir);
    const controlRoot = writeBoundControlEvidence(fixture.root);
    const firstVerifier = createSandboxControlBindingVerifier(fixture.root, [controlRoot]);
    assert.equal(firstVerifier(TASK_ID, { generation: 'generation-1', requestId: 'a'.repeat(16) }), true);
    fs.rmSync(controlRoot, { recursive: true, force: true });

    const conflictingVerifier = createSandboxControlBindingVerifier(fixture.root, [], [{
      phase: 'carrier-removed',
      generation: 'generation-1',
      target: { branch: 'feature/other', controlRoot }
    }]);
    const protectedReport = cleanupIntermediateFiles(fixture.root, {
      controlBindingVerifier: conflictingVerifier
    });
    assert.equal(protectedReport.items.some((item) => item.reason === 'CONTROL_BINDING_MISMATCH'), true);
    assert.equal(fs.existsSync(target), true);

    const incompleteVerifier = createSandboxControlBindingVerifier(fixture.root, [], [{
      phase: 'carrier-removed',
      generation: 'generation-1',
      target: { branch: 'feature/cleanup', controlRoot }
    }]);
    const incompleteReport = cleanupIntermediateFiles(fixture.root, {
      controlBindingVerifier: incompleteVerifier
    });
    assert.equal(incompleteReport.items.some((item) => item.reason === 'CONTROL_BINDING_MISMATCH'), true);
    assert.equal(fs.existsSync(target), true);

    const secondVerifier = createSandboxControlBindingVerifier(fixture.root, [], [{
      phase: 'completed',
      generation: 'generation-1',
      target: { branch: 'feature/cleanup', controlRoot }
    }]);
    const result = cleanupIntermediateFiles(fixture.root, {
      controlBindingVerifier: secondVerifier
    });

    assert.equal(result.items.some((item) => item.disposition === 'deleted'), true);
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('intermediate cleanup protects a bound receipt when the captured control root is replaced', () => {
  const fixture = taskFixture();
  try {
    const target = writeConsumedIntent(fixture.root, fixture.taskDir);
    const controlRoot = writeBoundControlEvidence(fixture.root);
    const verifier = createSandboxControlBindingVerifier(fixture.root, [controlRoot]);
    fs.rmSync(controlRoot, { recursive: true, force: true });
    fs.writeFileSync(controlRoot, 'replacement\n');
    const result = cleanupIntermediateFiles(fixture.root, { controlBindingVerifier: verifier });
    assert.equal(fs.existsSync(target), true);
    assert.equal(result.items.some((item) => item.reason === 'CONTROL_BINDING_MISMATCH'), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('intermediate cleanup protects a bound receipt when the captured control root becomes a symlink', onPlatforms('linux', 'darwin'), () => {
  const fixture = taskFixture();
  const replacement = fs.mkdtempSync(path.join(os.tmpdir(), 'intermediate-cleanup-replacement-'));
  try {
    const target = writeConsumedIntent(fixture.root, fixture.taskDir);
    const controlRoot = writeBoundControlEvidence(fixture.root);
    const verifier = createSandboxControlBindingVerifier(fixture.root, [controlRoot]);
    fs.rmSync(controlRoot, { recursive: true, force: true });
    fs.symlinkSync(replacement, controlRoot, 'junction');
    const result = cleanupIntermediateFiles(fixture.root, { controlBindingVerifier: verifier });
    assert.equal(fs.existsSync(target), true);
    assert.equal(result.items.some((item) => item.reason === 'CONTROL_BINDING_MISMATCH'), true);
  } finally {
    fs.rmSync(replacement, { recursive: true, force: true });
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
