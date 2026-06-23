import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CLI_PATH } from '../../helpers.ts';

const SCRIPT = path.resolve(process.cwd(), '.agents/scripts/task-short-id.js');

function mkFixture(): { repoRoot: string; activeDir: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-log-'));
  spawnSync('git', ['init', '--quiet'], { cwd: repoRoot });
  const agentsDir = path.join(repoRoot, '.agents');
  fs.mkdirSync(path.join(agentsDir, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(agentsDir, 'scripts', 'task-short-id.js'));
  fs.writeFileSync(
    path.join(agentsDir, '.airc.json'),
    JSON.stringify({ project: 'demo', task: { shortIdLength: 2 } })
  );
  const activeDir = path.join(agentsDir, 'workspace', 'active');
  fs.mkdirSync(activeDir, { recursive: true });
  return { repoRoot, activeDir };
}

// `heading` is the activity-log H2 line; `entries` are raw '- ...' lines.
function writeTask(
  activeDir: string,
  taskId: string,
  heading: string,
  entries: string[],
  ledgerRows: string[] = [],
  ledgerHeading = '## 审查分歧账本'
): void {
  const dir = path.join(activeDir, taskId);
  fs.mkdirSync(dir, { recursive: true });
  const log = entries.length ? `${entries.join('\n')}\n` : '';
  const ledger = ledgerRows.length
    ? `${ledgerHeading}\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n${ledgerRows.join('\n')}\n\n`
    : '';
  fs.writeFileSync(
    path.join(dir, 'task.md'),
    `---\nid: ${taskId}\nbranch: feat\n---\n# 任务：${taskId}\n\n${ledger}${heading}\n\n${log}\n## 完成检查清单\n\n- [ ] done\n`
  );
}

function runCli(args: string[], cwd: string) {
  return spawnSync('node', [CLI_PATH, ...args], { cwd, encoding: 'utf8' });
}

test('ai task log <ref> renders legacy done-only entries as one row each, sorted ascending', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000007';
  // Intentionally out of order in the file to prove the command sorts by time.
  // No start markers -> every step is a done-only row (backward compatibility).
  writeTask(activeDir, taskId, '## 活动日志', [
    '- 2026-06-18 14:00:00+08:00 — **Plan Task (Round 1)** by claude — Plan completed → plan.md',
    '- 2026-06-16 15:06:43+08:00 — **Create Task** by claude — Task created from description'
  ]);
  spawnSync('node', [SCRIPT, 'alloc', taskId], { cwd: repoRoot, encoding: 'utf8' });

  const out = runCli(['task', 'log', '1'], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  // Status columns; human counts are folded into NOTE on review rows only.
  assert.match(out.stdout, /#\s+STEP\s+AGENT\s+STARTED\s+DONE\s+NOTE/);
  // Row 1 is the earliest step (Create Task): STARTED empty, DONE has the time.
  // Non-review rows carry no human counts.
  assert.match(out.stdout, /^1\s+Create Task\s+claude\s+2026-06-16 15:06:43\+08:00\s+Task created/m);
  assert.match(out.stdout, /^2\s+Plan Task \(Round 1\)\s+claude\s+2026-06-18 14:00:00\+08:00\s+Plan completed → plan\.md/m);
  // Trailing total counts rows (steps), not raw entries.
  assert.match(out.stdout, /^Total: 2 steps$/m);
});

test('ai task log folds a started+done pair onto one row', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000011';
  writeTask(activeDir, taskId, '## 活动日志', [
    '- 2026-06-18 14:00:00+08:00 — **Plan Task (Round 1) [started]** by claude — started',
    '- 2026-06-18 14:30:00+08:00 — **Plan Task (Round 1)** by claude — Plan completed → plan.md'
  ]);

  const out = runCli(['task', 'log', taskId], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  // One row: STARTED and DONE both populated, step base has the suffix stripped.
  assert.match(out.stdout, /^1\s+Plan Task \(Round 1\)\s+claude\s+2026-06-18 14:00:00\+08:00\s+2026-06-18 14:30:00\+08:00\s+Plan completed → plan\.md/m);
  assert.match(out.stdout, /^Total: 1 steps$/m);
});

test('ai task log shows a started-only step as in progress', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000012';
  writeTask(activeDir, taskId, '## 活动日志', [
    '- 2026-06-16 15:06:43+08:00 — **Create Task** by claude — created',
    '- 2026-06-18 14:00:00+08:00 — **Code Task (Round 1) [started]** by claude — started'
  ]);

  const out = runCli(['task', 'log', taskId], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  // In-flight row: STARTED time set, DONE rendered as '(in progress)'.
  assert.match(out.stdout, /^2\s+Code Task \(Round 1\)\s+claude\s+2026-06-18 14:00:00\+08:00\s+\(in progress\)\s+started/m);
  assert.match(out.stdout, /^Total: 2 steps$/m);
});

test('ai task log locates an English "## Activity Log" section', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000008';
  writeTask(activeDir, taskId, '## Activity Log', [
    '- 2026-06-16 15:06:43+08:00 — **Create Task** by codex — created'
  ]);

  const out = runCli(['task', 'log', taskId], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^1\s+Create Task\s+codex\s+2026-06-16 15:06:43\+08:00\s+created/m);
  assert.match(out.stdout, /^Total: 1 steps$/m);
});

test('ai task log folds English human counts into the NOTE on canonical review steps, even for a zh task', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000013';
  writeTask(
    activeDir,
    taskId,
    '## 活动日志',
    [
      '- 2026-06-18 14:00:00+08:00 — **Review Analysis (Round 1) [started]** by claude — started',
      '- 2026-06-18 14:15:00+08:00 — **Review Analysis (Round 1)** by claude — Verdict: Approved, blockers: 0, major: 0, minor: 0 (+ 2 env-blocked) → review-analysis.md',
      '- 2026-06-18 15:00:00+08:00 — **Review Analysis (Round 2) [started]** by claude — started',
      '- 2026-06-18 15:10:00+08:00 — **Review Analysis (Round 2)** by claude — Verdict: Approved, blockers: 0, major: 0, minor: 0 → review-analysis-r2.md',
      '- 2026-06-18 16:00:00+08:00 — **Review Plan (Round 1)** by claude — Verdict: Approved, blockers: 0, major: 0, minor: 0 (+ 1 env-blocked) → review-plan.md'
    ],
    [
      '| HD-1 | analysis | - | decision | needs-human-decision | analysis.md#HD-1 |',
      '| HD-2 | analysis | - | decision | human-decided | task.md#人工裁决 |',
      '| PL-1 | plan | 1 | major | needs-human-decision | review-plan.md#1 |',
      '| CD-1 | code | 1 | blocker | needs-human-decision | review-code.md#1 |',
      '| PRC-1 | post-review-commit | - | - | human-decided | task.md#PRC-1 |'
    ]
  );

  const out = runCli(['task', 'log', taskId], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  // Human counts join the verdict count list (comma-separated, after minor, before ->),
  // and the redundant `(+ N env-blocked)` fragment is removed. Labels are always English
  // even though the task uses a Chinese activity-log heading. analysis stage has 2
  // human-decision rows (HD-1 + HD-2); both Round 1 and Round 2 show that stage total.
  assert.match(
    out.stdout,
    /^1\s+Review Analysis \(Round 1\)\s+claude\s+2026-06-18 14:00:00\+08:00\s+2026-06-18 14:15:00\+08:00\s+Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-verify: 2, Human-decision: 2 → review-analysis\.md/m
  );
  assert.match(
    out.stdout,
    /^2\s+Review Analysis \(Round 2\)\s+claude\s+2026-06-18 15:00:00\+08:00\s+2026-06-18 15:10:00\+08:00\s+Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-verify: 0, Human-decision: 2 → review-analysis-r2\.md/m
  );
  assert.match(
    out.stdout,
    /^3\s+Review Plan \(Round 1\)\s+claude\s+2026-06-18 16:00:00\+08:00\s+Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-verify: 1, Human-decision: 1 → review-plan\.md/m
  );
});

test('ai task log folds English human counts for an English task', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000014';
  writeTask(
    activeDir,
    taskId,
    '## Activity Log',
    [
      '- 2026-06-18 16:00:00+08:00 — **Review Code (Round 1)** by claude — Verdict: Approved, blockers: 0, major: 0, minor: 0 (+ 1 env-blocked) → review-code.md'
    ],
    ['| CD-1 | code | 1 | blocker | human-decided | review-code.md#1 |'],
    '## Review Disagreement Ledger'
  );

  const out = runCli(['task', 'log', taskId], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(
    out.stdout,
    /^1\s+Review Code \(Round 1\)\s+claude\s+2026-06-18 16:00:00\+08:00\s+Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-verify: 1, Human-decision: 1 → review-code\.md/m
  );
});

test('ai task log renders a human-executed review row as `human` with a `-` STARTED placeholder', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000015';
  // A human review entry: CJK executor name, done-only (no start marker).
  writeTask(activeDir, taskId, '## 活动日志', [
    '- 2026-06-18 15:32:53+08:00 — **Human Review** by 张三 — Verdict: Changes Requested, blockers: 1, major: 0, minor: 0 → human-review.md'
  ]);

  const out = runCli(['task', 'log', taskId], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  // AGENT normalized to `human` (drops the CJK name -> columns stay aligned);
  // STARTED shows the `-` placeholder since the human step has no start marker.
  // `Human Review` is not a canonical review prefix, so NOTE carries no human counts.
  assert.match(
    out.stdout,
    /^1\s+Human Review\s+human\s+-\s+2026-06-18 15:32:53\+08:00\s+Verdict: Changes Requested, blockers: 1, major: 0, minor: 0 → human-review\.md/m
  );
  assert.match(out.stdout, /^Total: 1 steps$/m);
});

test('ai task log keeps an AI agent (cursor) as-is with an empty STARTED on a legacy done-only row', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000016';
  // cursor is a known AI executor; a done-only row must NOT be mistaken for human.
  writeTask(activeDir, taskId, '## 活动日志', [
    '- 2026-06-18 14:00:00+08:00 — **Code Task (Round 1)** by cursor — Code implemented → code.md'
  ]);

  const out = runCli(['task', 'log', taskId], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  // AGENT stays `cursor` (not `human`); STARTED stays empty (not `-`), so the next
  // populated column after the empty STARTED is the DONE timestamp.
  assert.match(
    out.stdout,
    /^1\s+Code Task \(Round 1\)\s+cursor\s+2026-06-18 14:00:00\+08:00\s+Code implemented → code\.md/m
  );
  assert.match(out.stdout, /^Total: 1 steps$/m);
});

test('ai task log fails when the task has no activity log section', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000009';
  const dir = path.join(activeDir, taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${taskId}\nbranch: feat\n---\n# 任务\n\n## 描述\n\nno log\n`);

  const out = runCli(['task', 'log', taskId], repoRoot);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /ai task log:/);
  assert.match(out.stderr, /no activity log section/);
});

test('ai task log fails when the activity log section has no entries', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000010';
  writeTask(activeDir, taskId, '## 活动日志', []);

  const out = runCli(['task', 'log', taskId], repoRoot);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /no activity log entries/);
});

test('ai task log rejects an unknown ref', () => {
  const { repoRoot } = mkFixture();
  const out = runCli(['task', 'log', 'not-a-task'], repoRoot);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /ai task log:/);
});

test('ai task log requires an argument', () => {
  const { repoRoot } = mkFixture();
  const out = runCli(['task', 'log'], repoRoot);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /Usage: ai task log/);
});
