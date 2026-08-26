import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  inspectCommitFinalization,
  inspectCreatePrCommitGate,
  planCommitTaskFinalization
} from '../../../lib/task/commit-finalization.ts';
import { createCommitIntent, updateCommitIntent } from '../../../lib/task/commit-intent.ts';

const taskId = 'TASK-20260101-000001';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function fixture(options: { anchor?: string; activity?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-finalization-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(root, 'source.txt'), 'base\n');
  git(root, ['add', 'source.txt']);
  git(root, ['commit', '-qm', 'base']);
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const anchor = options.anchor === undefined ? '' : `last_reviewed_commit: ${options.anchor}\n`;
  fs.writeFileSync(path.join(taskDir, 'task.md'), [
    '---', `id: ${taskId}`, 'status: active', anchor.trimEnd(), '---', '', '# Task', '',
    '## Activity Log', '', options.activity ?? ''
  ].filter((line) => line !== '').join('\n') + '\n');
  return { root, taskDir, head: git(root, ['rev-parse', 'HEAD']) };
}

function approve(taskDir: string, baseline: string, tree: string) {
  fs.writeFileSync(path.join(taskDir, 'review-code.md'), [
    '# Review', '', `- **Review Baseline Commit**: \`${baseline}\``,
    `- **Reviewed Snapshot Tree**: \`${tree}\``, '', '## Review Summary', '',
    '- **Overall Verdict**: Approved',
    '- **Findings (AI-actionable)**: 0 blockers, 0 major, 0 minor / **Manual-validation**: 0', ''
  ].join('\n'));
}

test('idle lifecycle keeps normal commit reachable while create-pr requires an anchor', () => {
  const f = fixture();
  approve(f.taskDir, f.head, git(f.root, ['rev-parse', 'HEAD^{tree}']));

  const lifecycle = inspectCommitFinalization(f.taskDir, f.root, taskId);
  assert.equal(lifecycle.disposition, 'idle');
  const gate = inspectCreatePrCommitGate(f.taskDir, f.root, taskId);
  assert.equal(gate.allowed, false);
  assert.equal(gate.code, 'COMMIT_FINALIZATION_EVIDENCE_MISSING');
});

test('prepared intent requires exactly one open Commit started entry', () => {
  const f = fixture();
  createCommitIntent(f.taskDir, {
    taskId, mode: 'standalone', phase: 'prepared', baselineHead: f.head,
    committedHead: null, pushEvidence: null, orchestration: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
  }, { token: () => 'token' });

  assert.equal(inspectCommitFinalization(f.taskDir, f.root, taskId).disposition, 'conflict');
});

test('committed intent with matching review and Git tree is recoverable and plans one task write', () => {
  const started = '- 2026-01-01 00:00:00+00:00 — **Commit [started]** by codex — started';
  const f = fixture({ activity: started });
  approve(f.taskDir, f.head, git(f.root, ['rev-parse', 'HEAD^{tree}']));
  createCommitIntent(f.taskDir, {
    taskId, mode: 'standalone', phase: 'prepared', baselineHead: f.head,
    committedHead: null, pushEvidence: null, orchestration: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
  }, { token: () => 'token' });
  updateCommitIntent(f.taskDir, taskId, 'token', {
    phase: 'committed', committedHead: f.head, updatedAt: '2026-01-01T00:00:01.000Z'
  });

  const inspection = inspectCommitFinalization(f.taskDir, f.root, taskId);
  assert.equal(inspection.disposition, 'recoverable');
  const plan = planCommitTaskFinalization(f.taskDir, inspection, 'codex', '2026-01-01 00:00:02+00:00');
  assert.equal(plan.mutations.length, 2);
  assert.match(String(plan.commitNote), /^[a-f0-9]{7,} base$/);
});

test('committed no-op retry with the same commit note closes its new open activity row', () => {
  const f = fixture({ activity: [
    '- 2026-01-01 00:00:00+00:00 — **Commit [started]** by codex — started; attempt=original-attempt; baseline=0000000000000000000000000000000000000000; agent=codex',
    '- 2026-01-01 00:00:01+00:00 — **Commit** by codex — 0000000 base',
    '- 2026-01-01 00:00:02+00:00 — **Commit [started]** by codex — started; attempt=retry-attempt; baseline=0000000000000000000000000000000000000000; agent=codex'
  ].join('\n') });
  const actualNote = git(f.root, ['show', '-s', '--format=%h%x20%s', f.head]);
  const taskContent = fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8').replace('0000000 base', actualNote);
  fs.writeFileSync(path.join(f.taskDir, 'task.md'), taskContent.replaceAll('0000000000000000000000000000000000000000', f.head));
  approve(f.taskDir, f.head, git(f.root, ['rev-parse', 'HEAD^{tree}']));
  createCommitIntent(f.taskDir, {
    taskId, mode: 'standalone', phase: 'committed', baselineHead: f.head,
    committedHead: f.head, pushEvidence: null, orchestration: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
  }, { token: () => 'token' });

  const inspection = inspectCommitFinalization(f.taskDir, f.root, taskId);
  assert.equal(inspection.disposition, 'recoverable');
  assert.equal(inspection.needsLog, true);
  assert.equal(planCommitTaskFinalization(f.taskDir, inspection, 'codex', '2026-01-01 00:00:03+00:00').mutations.length, 2);
});

test('malformed intent is invalid and never treated as recoverable', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.taskDir, 'commit-intent.json'), '{');

  const inspection = inspectCommitFinalization(f.taskDir, f.root, taskId);
  assert.equal(inspection.disposition, 'invalid');
  assert.equal(inspection.code, 'COMMIT_FINALIZATION_EVIDENCE_INVALID');
});
