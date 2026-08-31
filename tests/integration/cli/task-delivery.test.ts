import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { snapshotReview } from '../../../lib/git/review-snapshot.ts';
import { resolvePostReviewGlobs } from '../../../lib/task/review-fingerprint.ts';
import { deliverTaskBranch } from '../../../lib/task/delivery.ts';

const TASK_ID = 'TASK-20260831-000001';
const BRANCH = 'agent-infra-feature-delivery';
const roots = new Set<string>();

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function writeReview(repoRoot: string, taskDir: string, targetHead: string, reviewedHead: string): void {
  const snapshot = snapshotReview({
    cwd: repoRoot,
    mode: 'worktree',
    baseline: reviewedHead,
    diffBase: targetHead,
    globs: resolvePostReviewGlobs({}, {})
  });
  fs.writeFileSync(path.join(taskDir, 'review-code.md'), [
    '# Code Review',
    '',
    '## Review Summary',
    '',
    `- **Review Target Head**: ${targetHead}`,
    `- **Reviewed Head**: ${reviewedHead}`,
    `- **Reviewed Diff Base**: ${targetHead}`,
    `- **Reviewed Diff Fingerprint**: ${snapshot.fingerprint}`,
    `- **Reviewed Snapshot Tree**: ${snapshot.tree}`,
    '- **Overall Verdict**: Approved',
    '- **Findings (AI-actionable)**: 0 blockers, 0 majors, 0 minors / **Manual-validation**: 0'
  ].join('\n') + '\n');
}

function updateReviewedHead(taskPath: string, reviewedHead: string): void {
  const content = fs.readFileSync(taskPath, 'utf8');
  fs.writeFileSync(taskPath, content.replace(/^last_reviewed_commit:.*$/m, `last_reviewed_commit: ${reviewedHead}`));
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-delivery-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'task-delivery-remote-'));
  roots.add(root);
  roots.add(remote);
  git(remote, ['init', '--bare', '-q']);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), '.agents/workspace/\n');
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ delivery: { remote: 'origin', baseRef: 'main' } }) + '\n');
  fs.writeFileSync(path.join(root, 'source.txt'), 'base\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  git(root, ['branch', '-M', 'main']);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-q', 'origin', 'main']);
  const targetHead = git(root, ['rev-parse', 'HEAD']);
  git(root, ['checkout', '-qb', BRANCH]);
  fs.writeFileSync(path.join(root, 'source.txt'), 'feature\n');
  git(root, ['add', 'source.txt']);
  git(root, ['commit', '-qm', 'feature']);
  const reviewedHead = git(root, ['rev-parse', 'HEAD']);
  const taskDir = path.join(root, '.agents', 'workspace', 'active', TASK_ID);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), [
    '---',
    `id: ${TASK_ID}`,
    'status: active',
    'agent_infra_version: v0.9.11-alpha.0',
    `branch: ${BRANCH}`,
    `last_reviewed_commit: ${reviewedHead}`,
    'delivery_remote: origin',
    'delivery_base_ref: main',
    'delivery_remote_head:',
    '---',
    '',
    '# Task',
    '',
    '## Review Disagreement Ledger',
    '',
    '| id | stage | round | severity | status | evidence |',
    '|----|-------|-------|----------|--------|----------|',
    '',
    '## Activity Log',
    '',
    '- 2026-08-31 00:00:00+00:00 — **Review Code** by codex — done'
  ].join('\n') + '\n');
  writeReview(root, taskDir, targetHead, reviewedHead);
  return { root, remote, taskDir, taskPath: path.join(taskDir, 'task.md'), targetHead, reviewedHead };
}

function remoteHead(remote: string, branch = BRANCH): string | null {
  const output = git(remote, ['show-ref', '--hash', `refs/heads/${branch}`]);
  return output || null;
}

test('task delivery creates, reuses, and safely updates a task branch', () => {
  const f = fixture();
  const first = deliverTaskBranch(TASK_ID, { repoRoot: f.root, agent: 'codex' });
  assert.equal(first.status, 'applied');
  assert.equal(first.state, 'absent');
  assert.equal(remoteHead(f.remote), f.reviewedHead);
  assert.match(fs.readFileSync(f.taskPath, 'utf8'), new RegExp(`delivery_remote_head: ${f.reviewedHead}`));

  const same = deliverTaskBranch(TASK_ID, { repoRoot: f.root, agent: 'codex' });
  assert.equal(same.status, 'no-op');
  assert.equal(same.state, 'same');

  fs.writeFileSync(path.join(f.root, 'source.txt'), 'feature-2\n');
  git(f.root, ['add', 'source.txt']);
  git(f.root, ['commit', '-qm', 'feature-2']);
  const nextHead = git(f.root, ['rev-parse', 'HEAD']);
  updateReviewedHead(f.taskPath, nextHead);
  writeReview(f.root, f.taskDir, f.targetHead, nextHead);
  const updated = deliverTaskBranch(TASK_ID, { repoRoot: f.root, agent: 'codex' });
  assert.equal(updated.status, 'applied');
  assert.equal(updated.state, 'known-old');
  assert.equal(remoteHead(f.remote), nextHead);
});

test('task delivery refuses an unknown remote branch drift', () => {
  const f = fixture();
  assert.equal(deliverTaskBranch(TASK_ID, { repoRoot: f.root, agent: 'codex' }).status, 'applied');
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'task-delivery-external-'));
  roots.add(external);
  git(external, ['clone', '-q', f.remote, '.']);
  git(external, ['checkout', '-qb', BRANCH, `origin/${BRANCH}`]);
  git(external, ['config', 'user.name', 'External']);
  git(external, ['config', 'user.email', 'external@example.com']);
  fs.writeFileSync(path.join(external, 'external.txt'), 'drift\n');
  git(external, ['add', 'external.txt']);
  git(external, ['commit', '-qm', 'external drift']);
  git(external, ['push', '-q', 'origin', `${BRANCH}:${BRANCH}`]);

  fs.writeFileSync(path.join(f.root, 'source.txt'), 'feature-2\n');
  git(f.root, ['add', 'source.txt']);
  git(f.root, ['commit', '-qm', 'feature-2']);
  const nextHead = git(f.root, ['rev-parse', 'HEAD']);
  updateReviewedHead(f.taskPath, nextHead);
  writeReview(f.root, f.taskDir, f.targetHead, nextHead);
  const result = deliverTaskBranch(TASK_ID, { repoRoot: f.root, agent: 'codex' });
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'DELIVERY_REMOTE_DRIFT');
  assert.notEqual(remoteHead(f.remote), nextHead);
});
