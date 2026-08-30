import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CLI_PATH, INTERNAL_CLI_PATH } from '../../helpers.ts';

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
  ledgerHeading = '## 审查分歧账本',
  includeLedger = true
): void {
  const dir = path.join(activeDir, taskId);
  fs.mkdirSync(dir, { recursive: true });
  const log = entries.length ? `${entries.join('\n')}\n` : '';
  const ledger = includeLedger
    ? `${ledgerHeading}\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n${ledgerRows.join('\n')}\n\n`
    : '';
  fs.writeFileSync(
    path.join(dir, 'task.md'),
    `---\nid: ${taskId}\nbranch: feat\nstatus: active\nagent_infra_version: v0.9.11-alpha.0\n---\n# 任务：${taskId}\n\n${ledger}${heading}\n\n${log}\n## 完成检查清单\n\n- [ ] done\n`
  );
}

function runCli(args: string[], cwd: string) {
  return spawnSync('node', [CLI_PATH, ...args], { cwd, encoding: 'utf8' });
}

function runInternal(args: string[], cwd: string) {
  return spawnSync('node', [INTERNAL_CLI_PATH, ...args], { cwd, encoding: 'utf8' });
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

test('typed task-activity intents produce a compact paired Review PR row', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000019';
  const taskDir = path.join(activeDir, taskId);
  const head = 'a'.repeat(40);
  writeTask(activeDir, taskId, '## 活动日志', [
    '- 2026-06-18 13:00:00+08:00 — **Plan Task (Round 1)** by claude — plan done'
  ]);
  const artifactPath = path.join(taskDir, 'pr-review.md');
  fs.writeFileSync(artifactPath, `# PR 审查报告

## 身份信息

- **被审 head SHA**：${head}

## 发布结果

- **正式 Review 状态**：pending
`);

  const started = runInternal([
    'task-activity', taskId, 'pr-review-start', '--agent', 'claude-code',
    '--artifact', 'pr-review.md', '--head', head
  ], repoRoot);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  assert.equal(JSON.parse(started.stdout).status, 'applied');

  fs.writeFileSync(artifactPath, fs.readFileSync(artifactPath, 'utf8').replace('pending', 'applied'));
  const completed = runInternal([
    'task-activity', taskId, 'pr-review-complete', '--agent', 'claude-code',
    '--artifact', 'pr-review.md', '--head', head, '--verdict', 'approved',
    '--blockers', '0', '--major', '1', '--minor', '2'
  ], repoRoot);
  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  assert.equal(JSON.parse(completed.stdout).status, 'applied');

  const out = runCli(['task', 'log', taskId], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(
    out.stdout,
    /^2\s+Review PR \(Round 1\)\s+claude\s+\d{4}-\d{2}-\d{2} \S+\s+\d{4}-\d{2}-\d{2} \S+\s+Verdict: Approved, blockers: 0, major: 1, minor: 2 → pr-review\.md/m
  );

  const invalid = runInternal([
    'task-activity', taskId, 'pr-review-complete', '--agent', 'codex',
    '--artifact', 'pr-review.md', '--head', head, '--verdict', 'approved'
  ], repoRoot);
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).error.code, 'ACTIVITY_PAYLOAD_INVALID');
});

test('typed task-activity terminate intents render paired aborted and superseded Review PR rows', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000020';
  const taskDir = path.join(activeDir, taskId);
  const firstHead = 'a'.repeat(40);
  const secondHead = 'b'.repeat(40);
  writeTask(activeDir, taskId, '## 活动日志', [
    '- 2026-06-18 13:00:00+08:00 — **Plan Task (Round 1)** by claude — plan done'
  ]);

  const runTermination = (
    artifact: string,
    head: string,
    outcome: 'aborted' | 'superseded',
    reason: string
  ) => {
    const artifactPath = path.join(taskDir, artifact);
    fs.writeFileSync(artifactPath, `# PR 审查报告

## 身份信息

- **被审 head SHA**：${head}

## 发布结果

- **正式 Review 状态**：pending
`);
    const started = runInternal([
      'task-activity', taskId, 'pr-review-start', '--agent', 'claude',
      '--artifact', artifact, '--head', head
    ], repoRoot);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    fs.writeFileSync(artifactPath, fs.readFileSync(artifactPath, 'utf8').replace('pending', outcome));
    const terminated = runInternal([
      'task-activity', taskId, 'pr-review-terminate', '--agent', 'claude',
      '--artifact', artifact, '--head', head, '--outcome', outcome, '--reason', reason
    ], repoRoot);
    assert.equal(terminated.status, 0, terminated.stderr || terminated.stdout);
  };

  runTermination('pr-review.md', firstHead, 'superseded', 'head changed before publish');
  runTermination('pr-review-r2.md', secondHead, 'aborted', 'validation failed before publish');

  const out = runCli(['task', 'log', taskId], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(
    out.stdout,
    /^2\s+Review PR \(Round 1\)\s+claude\s+\d{4}-\d{2}-\d{2} \S+\s+\d{4}-\d{2}-\d{2} \S+\s+Outcome: Superseded, reason: head changed before publish → pr-review\.md/m
  );
  assert.match(
    out.stdout,
    /^3\s+Review PR \(Round 2\)\s+claude\s+\d{4}-\d{2}-\d{2} \S+\s+\d{4}-\d{2}-\d{2} \S+\s+Outcome: Aborted, reason: validation failed before publish → pr-review-r2\.md/m
  );
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
      '- 2026-06-18 14:15:00+08:00 — **Review Analysis (Round 1)** by claude — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 2 → review-analysis.md',
      '- 2026-06-18 15:00:00+08:00 — **Review Analysis (Round 2) [started]** by claude — started',
      '- 2026-06-18 15:10:00+08:00 — **Review Analysis (Round 2)** by claude — Verdict: Approved, blockers: 0, major: 0, minor: 0 → review-analysis-r2.md',
      '- 2026-06-18 16:00:00+08:00 — **Review Plan (Round 1)** by claude — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 1 → review-plan.md'
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
  // and the source `Manual-validation: N` field is normalized. Labels are always English
  // even though the task uses a Chinese activity-log heading. analysis stage has 1
  // pending human-decision row (HD-1); the human-decided HD-2 row is not pending.
  assert.match(
    out.stdout,
    /^1\s+Review Analysis \(Round 1\)\s+claude\s+2026-06-18 14:00:00\+08:00\s+2026-06-18 14:15:00\+08:00\s+Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 2, Human-decision: 1 → review-analysis\.md/m
  );
  assert.match(
    out.stdout,
    /^2\s+Review Analysis \(Round 2\)\s+claude\s+2026-06-18 15:00:00\+08:00\s+2026-06-18 15:10:00\+08:00\s+Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 0, Human-decision: 1 → review-analysis-r2\.md/m
  );
  assert.match(
    out.stdout,
    /^3\s+Review Plan \(Round 1\)\s+claude\s+2026-06-18 16:00:00\+08:00\s+Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 1, Human-decision: 1 → review-plan\.md/m
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
      '- 2026-06-18 16:00:00+08:00 — **Review Code (Round 1)** by claude — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 1 → review-code.md'
    ],
    ['| CD-1 | code | 1 | blocker | human-decided | review-code.md#1 |'],
    '## Review Disagreement Ledger'
  );

  const out = runCli(['task', 'log', taskId], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(
    out.stdout,
    /^1\s+Review Code \(Round 1\)\s+claude\s+2026-06-18 16:00:00\+08:00\s+Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 1, Human-decision: 0 → review-code\.md/m
  );
});

test('ai task log replaces pre-existing human counts on canonical review steps', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000017';
  writeTask(
    activeDir,
    taskId,
    '## 活动日志',
    [
      '- 2026-06-18 14:00:00+08:00 — **Review Plan (Round 1)** by claude — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 9, Human-decision: 8 → review-plan.md'
    ],
    ['| HD-1 | plan | - | decision | needs-human-decision | plan.md#HD-1 |']
  );

  const out = runCli(['task', 'log', taskId], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(
    out.stdout,
    /^1\s+Review Plan \(Round 1\)\s+claude\s+2026-06-18 14:00:00\+08:00\s+Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 9, Human-decision: 1 → review-plan\.md/m
  );
  assert.equal(out.stdout.match(/Manual-validation:/g)?.length, 1);
  assert.equal(out.stdout.match(/Human-decision:/g)?.length, 1);
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
  // AGENT keeps the `human` grouping but gains a visible `(unknown)` marker
  // (HD-3): unknown tokens are no longer silently collapsed to bare `human`.
  // STARTED shows the `-` placeholder since the human step has no start marker.
  // `Human Review` is not a canonical review prefix, so NOTE carries no human counts.
  assert.match(
    out.stdout,
    /^1\s+Human Review\s+human \(unknown\)\s+-\s+2026-06-18 15:32:53\+08:00\s+Verdict: Changes Requested, blockers: 1, major: 0, minor: 0 → human-review\.md/m
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

test('ai task log renders legacy long-name agents as their short token', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000018';
  // Pre-normalization legacy entries may carry `.airc.json` long names; the
  // renderer maps them to the canonical short token (claude-code -> claude).
  writeTask(activeDir, taskId, '## 活动日志', [
    '- 2026-06-18 14:00:00+08:00 — **Code Task (Round 1)** by claude-code — Code implemented → code.md',
    '- 2026-06-18 15:00:00+08:00 — **Review Plan (Round 1)** by antigravity-cli — Plan reviewed → review-plan.md'
  ]);

  const out = runCli(['task', 'log', taskId], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  // Long names classify as AI and render as their short display token; they
  // are NOT given the `(unknown)` marker and keep an empty STARTED on a
  // done-only row.
  assert.match(out.stdout, /^1\s+Code Task \(Round 1\)\s+claude\s+2026-06-18 14:00:00\+08:00\s+Code implemented → code\.md/m);
  assert.match(out.stdout, /^2\s+Review Plan \(Round 1\)\s+antigravity\s+2026-06-18 15:00:00\+08:00\s+Plan reviewed, Manual-validation: 0, Human-decision: 0 → review-plan\.md/m);
  assert.match(out.stdout, /^Total: 2 steps$/m);
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

test('ai task log preserves readable activity output and reports a missing ledger without writing', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000021';
  writeTask(activeDir, taskId, '## 活动日志', [
    '- 2026-06-18 15:06:43+08:00 — **Create Task** by codex — Task created'
  ], [], '## 审查分歧账本', false);
  const taskMd = path.join(activeDir, taskId, 'task.md');
  const before = fs.readFileSync(taskMd);
  const beforeMtime = fs.statSync(taskMd).mtimeMs;

  const out = runCli(['task', 'log', taskId], repoRoot);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /^1\s+Create Task\s+codex\s+2026-06-18 15:06:43\+08:00\s+Task created/m);
  assert.match(out.stdout, /Ledger: unavailable \[LEDGER_SECTION_MISSING:/);
  assert.match(out.stdout, /^Total: 1 steps$/m);
  assert.equal(out.stderr, '');
  assert.deepEqual(fs.readFileSync(taskMd), before);
  assert.equal(fs.statSync(taskMd).mtimeMs, beforeMtime);
});

test('ai task log rejects an unknown ref', () => {
  const { repoRoot } = mkFixture();
  const out = runCli(['task', 'log', 'not-a-task'], repoRoot);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /ai task log:/);
});

test('ai task log without a ref requires a matching current context', () => {
  const { repoRoot } = mkFixture();
  const out = runCli(['task', 'log'], repoRoot);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /no active task matches current branch/);
});
