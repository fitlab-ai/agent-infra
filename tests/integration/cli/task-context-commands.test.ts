import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { CLI_PATH } from '../../helpers.ts';

const TASK_ID = 'TASK-20260719-000001';

function fixture(): { repoRoot: string; taskMd: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-context-cli-'));
  spawnSync('git', ['init', '--quiet'], { cwd: repoRoot });
  spawnSync('git', ['checkout', '-q', '-b', 'feature/current'], { cwd: repoRoot });
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', TASK_ID);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.agents', '.airc.json'), JSON.stringify({ project: 'demo' }));
  const taskMd = path.join(taskDir, 'task.md');
  fs.writeFileSync(taskMd, `---
id: ${TASK_ID}
branch: feature/current
status: active
current_step: code
updated_at: 2026-07-19 00:00:00+00:00
agent_infra_version: v0.0.0
---
# Task

## Description

body

## Requirements

- [ ] requirement

## Review Disagreement Ledger

| id | stage | round | severity | status | evidence |
|----|-------|-------|----------|--------|----------|
| PL-1 | plan | 1 | major | needs-human-decision | plan.md#PL-1 |

## Human Rulings

## Implementation Inputs

| id | ledger_id | decision_evidence | stage | needs_implementation | decided_at | status | consumed_by |
|----|-----------|-------------------|-------|----------------------|------------|--------|-------------|

## Activity Log

- 2026-07-19 00:00:00+00:00 — **Code Task (Round 1) [started]** by codex — started
`);
  fs.writeFileSync(path.join(taskDir, 'plan.md'), '### PL-1: choice [needs-human-decision]\n\ndetail\n');
  return { repoRoot, taskMd };
}

function run(repoRoot: string, args: string[]) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], { cwd: repoRoot, encoding: 'utf8' });
}

test('read-only task commands use implicit context and explicit task flags', () => {
  const data = fixture();
  for (const args of [
    ['task', 'show'], ['task', 'show', '--task', TASK_ID], ['task', 'files'],
    ['task', 'log'], ['task', 'status'], ['task', 'issue-body'], ['task', 'cat', 'plan']
  ]) {
    const result = run(data.repoRoot, args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  }
});

test('public task commands reject positional task refs and accept both scope aliases', () => {
  const data = fixture();
  for (const args of [
    ['task', 'show', TASK_ID],
    ['task', 'files', TASK_ID],
    ['task', 'log', TASK_ID],
    ['task', 'status', TASK_ID],
    ['task', 'issue-body', TASK_ID]
  ]) {
    const result = run(data.repoRoot, args);
    assert.equal(result.status, 1, `${args.join(' ')} should be rejected`);
    assert.match(result.stderr, /positional task ref.*--task <ref>.*-t <ref>/);
  }
  for (const flag of ['--task', '-t']) {
    const result = run(data.repoRoot, ['task', 'show', flag, TASK_ID]);
    assert.equal(result.status, 0, `${flag}: ${result.stderr}`);
  }
});

test('decisions and decide use --item without confusing it with task refs', () => {
  const data = fixture();
  const detail = run(data.repoRoot, ['task', 'decisions', '--item', '1']);
  assert.equal(detail.status, 0, detail.stderr);
  assert.match(detail.stdout, /PL-1/);

  const decided = run(data.repoRoot, ['decide', '-i', 'PL-1', 'chosen behavior']);
  assert.equal(decided.status, 0, decided.stderr);
  assert.match(fs.readFileSync(data.taskMd, 'utf8'), /human-decided/);
});

test('grep defaults to current context and supports --current/--task while -i remains ignore-case', () => {
  const data = fixture();
  const implicit = run(data.repoRoot, ['task', 'grep', '-i', 'DETAIL']);
  assert.equal(implicit.status, 0, implicit.stderr);
  const current = run(data.repoRoot, ['task', 'grep', '-i', 'DETAIL', '--current', 'plan']);
  assert.equal(current.status, 0, current.stderr);
  const explicit = run(data.repoRoot, ['task', 'grep', 'detail', '-t', TASK_ID, 'plan']);
  assert.equal(explicit.status, 0, explicit.stderr);
  const legacy = run(data.repoRoot, ['task', 'grep', 'detail', TASK_ID, 'plan']);
  assert.equal(legacy.status, 1);
});

test('implicit context failures never select one of multiple tasks', () => {
  const data = fixture();
  const other = path.join(data.repoRoot, '.agents', 'workspace', 'active', 'TASK-20260719-000002');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'task.md'), '---\nid: TASK-20260719-000002\nbranch: feature/current\n---\n');
  const result = run(data.repoRoot, ['task', 'show']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /multiple active tasks/);
});
