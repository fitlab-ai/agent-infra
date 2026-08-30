import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyPrReviewActivityIntent,
  inspectPrReviewActivity
} from '../../../lib/task/activity-intent.ts';
import { VERSION } from '../../../lib/version.ts';

const HEAD = 'a'.repeat(40);

function fixtureTask() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-intent-'));
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---
id: ${taskId}
type: feature
workflow: feature-development
status: active
created_at: 2026-01-01 00:00:00+08:00
updated_at: 2026-01-01 00:00:00+08:00
agent_infra_version: v0.9.2
current_step: technical-design-review
assigned_to: claude
---

# 任务

## 审查反馈

<!-- review artifacts -->

## Review Disagreement Ledger

| id | stage | round | severity | status | evidence |
|----|-------|-------|----------|--------|----------|

## 活动日志

- 2026-01-01 00:00:00+08:00 — **Plan Task** by claude — plan done
`);
  return { root, taskId, taskDir };
}

function writeArtifact(taskDir: string, name = 'pr-review.md', status = 'pending', head = HEAD): void {
  fs.writeFileSync(path.join(taskDir, name), `# PR 审查报告

## 身份信息

- **被审 head SHA**：${head}

## 发布结果

- **正式 Review 状态**：${status}
`);
}

function setArtifactStatus(taskDir: string, name: string, status: string): void {
  const file = path.join(taskDir, name);
  const content = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, content.replace(/(正式 Review 状态\*\*：).+/, `$1${status}`));
}

function metadata(timestamp: string) {
  return { metadataProvider: () => ({ timestamp, agentInfraVersion: VERSION }) };
}

test('PR review start and complete create a paired compact Activity Log row without changing current_step', () => {
  const fixture = fixtureTask();
  try {
    writeArtifact(fixture.taskDir);
    const started = applyPrReviewActivityIntent({
      kind: 'pr-review-start', taskRef: fixture.taskId,
      agent: 'claude-code', artifact: 'pr-review.md', head: HEAD
    }, { repoRoot: fixture.root, ...metadata('2026-01-01 01:00:00+08:00') });
    assert.equal(started.status, 'applied');

    setArtifactStatus(fixture.taskDir, 'pr-review.md', 'applied');
    const completed = applyPrReviewActivityIntent({
      kind: 'pr-review-complete', taskRef: fixture.taskId,
      agent: 'claude-code', artifact: 'pr-review.md', head: HEAD,
      verdict: 'changes-requested', blockers: 1, major: 2, minor: 3
    }, { repoRoot: fixture.root, ...metadata('2026-01-01 01:30:00+08:00') });
    assert.equal(completed.status, 'applied');

    const updated = fs.readFileSync(path.join(fixture.taskDir, 'task.md'), 'utf8');
    assert.match(updated, /\*\*Review PR \(Round 1\) \[started\]\*\* by claude — started/);
    assert.match(updated, /\*\*Review PR \(Round 1\)\*\* by claude — Verdict: Changes Requested, blockers: 1, major: 2, minor: 3 → pr-review\.md/);
    assert.match(updated, /\[PR 审查报告（Round 1）\]\(pr-review\.md\)/);
    assert.match(updated, /^current_step: technical-design-review$/m);
    assert.match(updated, new RegExp(`^agent_infra_version: ${VERSION.replace('.', '\\.')}$`, 'm'));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('identical PR review start and terminal intents replay as no-op', () => {
  const fixture = fixtureTask();
  try {
    writeArtifact(fixture.taskDir);
    const startIntent = {
      kind: 'pr-review-start' as const, taskRef: fixture.taskId,
      agent: 'codex', artifact: 'pr-review.md', head: HEAD
    };
    assert.equal(applyPrReviewActivityIntent(startIntent, { repoRoot: fixture.root }).status, 'applied');
    assert.equal(applyPrReviewActivityIntent(startIntent, { repoRoot: fixture.root }).status, 'no-op');

    setArtifactStatus(fixture.taskDir, 'pr-review.md', 'no-op');
    const completeIntent = {
      kind: 'pr-review-complete' as const, taskRef: fixture.taskId,
      agent: 'codex', artifact: 'pr-review.md', head: HEAD,
      verdict: 'approved' as const, blockers: 0, major: 0, minor: 0
    };
    assert.equal(applyPrReviewActivityIntent(completeIntent, { repoRoot: fixture.root }).status, 'applied');
    assert.equal(applyPrReviewActivityIntent(completeIntent, { repoRoot: fixture.root }).status, 'no-op');

    const updated = fs.readFileSync(path.join(fixture.taskDir, 'task.md'), 'utf8');
    assert.equal((updated.match(/Review PR \(Round 1\) \[started\]/g) ?? []).length, 1);
    assert.equal((updated.match(/Verdict: Approved/g) ?? []).length, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('PR review terminate closes an open row and rejects a conflicting terminal payload', () => {
  const fixture = fixtureTask();
  try {
    writeArtifact(fixture.taskDir);
    assert.equal(applyPrReviewActivityIntent({
      kind: 'pr-review-start', taskRef: fixture.taskId,
      agent: 'codex', artifact: 'pr-review.md', head: HEAD
    }, { repoRoot: fixture.root }).status, 'applied');
    setArtifactStatus(fixture.taskDir, 'pr-review.md', 'superseded');

    const intent = {
      kind: 'pr-review-terminate' as const, taskRef: fixture.taskId,
      agent: 'codex', artifact: 'pr-review.md', head: HEAD,
      outcome: 'superseded' as const, reason: 'head changed before publish'
    };
    assert.equal(applyPrReviewActivityIntent(intent, { repoRoot: fixture.root }).status, 'applied');
    assert.equal(applyPrReviewActivityIntent(intent, { repoRoot: fixture.root }).status, 'no-op');

    const conflict = applyPrReviewActivityIntent({ ...intent, reason: 'different reason' }, { repoRoot: fixture.root });
    assert.equal(conflict.status, 'failed');
    assert.equal(conflict.error?.code, 'ACTIVITY_STATE_CONFLICT');
    assert.match(fs.readFileSync(path.join(fixture.taskDir, 'task.md'), 'utf8'), /Outcome: Superseded, reason: head changed before publish → pr-review\.md/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('PR review inspection reports prepared, open and latest successful identities', () => {
  const fixture = fixtureTask();
  try {
    writeArtifact(fixture.taskDir);
    const prepared = inspectPrReviewActivity({ kind: 'pr-review-inspect', taskRef: fixture.taskId }, { repoRoot: fixture.root });
    assert.equal(prepared.status, 'ready');
    assert.equal(prepared.snapshot?.prepared?.artifact, 'pr-review.md');
    assert.equal(prepared.snapshot?.nextRound, 2);

    applyPrReviewActivityIntent({
      kind: 'pr-review-start', taskRef: fixture.taskId,
      agent: 'codex', artifact: 'pr-review.md', head: HEAD
    }, { repoRoot: fixture.root });
    const open = inspectPrReviewActivity({ kind: 'pr-review-inspect', taskRef: fixture.taskId }, { repoRoot: fixture.root });
    assert.equal(open.snapshot?.open?.artifact, 'pr-review.md');
    assert.equal(open.snapshot?.open?.head, HEAD);

    setArtifactStatus(fixture.taskDir, 'pr-review.md', 'applied');
    applyPrReviewActivityIntent({
      kind: 'pr-review-complete', taskRef: fixture.taskId,
      agent: 'codex', artifact: 'pr-review.md', head: HEAD,
      verdict: 'approved', blockers: 0, major: 0, minor: 0
    }, { repoRoot: fixture.root });
    const completed = inspectPrReviewActivity({ kind: 'pr-review-inspect', taskRef: fixture.taskId }, { repoRoot: fixture.root });
    assert.equal(completed.snapshot?.latestSuccessful?.artifact, 'pr-review.md');
    assert.equal(completed.snapshot?.latestSuccessful?.head, HEAD);
    assert.equal(completed.snapshot?.open, null);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('PR review inspection accepts annotated formal review statuses from legacy artifacts', () => {
  const fixture = fixtureTask();
  try {
    writeArtifact(fixture.taskDir, 'pr-review.md', 'applied（APPROVE）');
    const taskPath = path.join(fixture.taskDir, 'task.md');
    fs.appendFileSync(
      taskPath,
      '- 2026-01-01 01:00:00+08:00 — **Review PR (Round 1)** by claude — receipt legacy-review\n'
    );

    const inspected = inspectPrReviewActivity(
      { kind: 'pr-review-inspect', taskRef: fixture.taskId },
      { repoRoot: fixture.root }
    );
    assert.equal(inspected.status, 'ready');
    assert.equal(inspected.snapshot?.latestSuccessful?.artifactStatus, 'applied');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('inspection keeps a prior applied round as latest successful after a later aborted round', () => {
  const fixture = fixtureTask();
  try {
    writeArtifact(fixture.taskDir, 'pr-review.md');
    applyPrReviewActivityIntent({
      kind: 'pr-review-start', taskRef: fixture.taskId,
      agent: 'codex', artifact: 'pr-review.md', head: HEAD
    }, { repoRoot: fixture.root });
    setArtifactStatus(fixture.taskDir, 'pr-review.md', 'applied');
    applyPrReviewActivityIntent({
      kind: 'pr-review-complete', taskRef: fixture.taskId,
      agent: 'codex', artifact: 'pr-review.md', head: HEAD,
      verdict: 'approved', blockers: 0, major: 0, minor: 0
    }, { repoRoot: fixture.root });

    const secondHead = 'b'.repeat(40);
    writeArtifact(fixture.taskDir, 'pr-review-r2.md', 'pending', secondHead);
    applyPrReviewActivityIntent({
      kind: 'pr-review-start', taskRef: fixture.taskId,
      agent: 'codex', artifact: 'pr-review-r2.md', head: secondHead
    }, { repoRoot: fixture.root });
    setArtifactStatus(fixture.taskDir, 'pr-review-r2.md', 'aborted');
    applyPrReviewActivityIntent({
      kind: 'pr-review-terminate', taskRef: fixture.taskId,
      agent: 'codex', artifact: 'pr-review-r2.md', head: secondHead,
      outcome: 'aborted', reason: 'validation failed before publish'
    }, { repoRoot: fixture.root });

    const inspected = inspectPrReviewActivity({ kind: 'pr-review-inspect', taskRef: fixture.taskId }, { repoRoot: fixture.root });
    assert.equal(inspected.snapshot?.latestSuccessful?.artifact, 'pr-review.md');
    assert.equal(inspected.snapshot?.latestTerminal?.artifact, 'pr-review-r2.md');
    assert.equal(inspected.snapshot?.latestTerminal?.artifactStatus, 'aborted');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('PR review intents reject missing starts, identity mismatches and invalid payloads', () => {
  const fixture = fixtureTask();
  try {
    writeArtifact(fixture.taskDir, 'pr-review.md', 'applied');
    const missingStart = applyPrReviewActivityIntent({
      kind: 'pr-review-complete', taskRef: fixture.taskId,
      agent: 'codex', artifact: 'pr-review.md', head: HEAD,
      verdict: 'approved', blockers: 0, major: 0, minor: 0
    }, { repoRoot: fixture.root });
    assert.equal(missingStart.error?.code, 'ACTIVITY_STATE_CONFLICT');

    const wrongHead = applyPrReviewActivityIntent({
      kind: 'pr-review-start', taskRef: fixture.taskId,
      agent: 'codex', artifact: 'pr-review.md', head: 'b'.repeat(40)
    }, { repoRoot: fixture.root });
    assert.equal(wrongHead.error?.code, 'ACTIVITY_IDENTITY_MISMATCH');

    const badCount = applyPrReviewActivityIntent({
      kind: 'pr-review-complete', taskRef: fixture.taskId,
      agent: 'codex', artifact: 'pr-review.md', head: HEAD,
      verdict: 'approved', blockers: -1, major: 0, minor: 0
    }, { repoRoot: fixture.root });
    assert.equal(badCount.error?.code, 'ACTIVITY_INTENT_INVALID');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('PR review dry-run validates without writing and lock failures fail closed', () => {
  const fixture = fixtureTask();
  try {
    writeArtifact(fixture.taskDir);
    const before = fs.readFileSync(path.join(fixture.taskDir, 'task.md'), 'utf8');
    const planned = applyPrReviewActivityIntent({
      kind: 'pr-review-start', taskRef: fixture.taskId,
      agent: 'codex', artifact: 'pr-review.md', head: HEAD, dryRun: true
    }, { repoRoot: fixture.root });
    assert.equal(planned.status, 'planned');
    assert.equal(fs.readFileSync(path.join(fixture.taskDir, 'task.md'), 'utf8'), before);

    const unsupported = Object.assign(new Error('unsupported'), { code: 'EPERM' });
    const failed = applyPrReviewActivityIntent({
      kind: 'pr-review-start', taskRef: fixture.taskId,
      agent: 'codex', artifact: 'pr-review.md', head: HEAD
    }, {
      repoRoot: fixture.root,
      lockOptions: { lockRoot: path.join(fixture.root, 'locks'), linkSync: () => { throw unsupported; } }
    });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error?.code, 'ORCHESTRATION_LOCK_UNSUPPORTED');
    assert.equal(fs.readFileSync(path.join(fixture.taskDir, 'task.md'), 'utf8'), before);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('PR review intents reject a task that is not active', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-intent-'));
  try {
    const taskId = 'TASK-20260101-000001';
    const taskDir = path.join(root, '.agents', 'workspace', 'completed', taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: completed\n---\n`);
    writeArtifact(taskDir);
    const result = applyPrReviewActivityIntent({
      kind: 'pr-review-start', taskRef: taskId,
      agent: 'codex', artifact: 'pr-review.md', head: HEAD
    }, { repoRoot: root });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'TASK_STATE_MISMATCH');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
