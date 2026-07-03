import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  collectMetadata,
  groupArtifacts,
  collectGit,
  collectWorkflow,
  collectRuntime,
  renderStatus,
  type Runner,
  type StatusModel
} from '../../../lib/task/commands/status.ts';
import type { Artifact } from '../../../lib/task/artifacts.ts';

function artifact(name: string, mtimeMs: number): Artifact {
  return { index: mtimeMs, name, path: `/tmp/${name}`, size: 1, mtimeMs };
}

// --- collectMetadata -------------------------------------------------------

test('collectMetadata emits the fixed key order and degrades missing fields to -', () => {
  const rows = collectMetadata({
    type: 'feature',
    status: 'active',
    current_step: 'code',
    priority: 'High',
    branch: 'feat'
  });
  assert.deepEqual(rows, [
    ['type', 'feature'],
    ['status', 'active'],
    ['current_step', 'code'],
    ['priority', 'High'],
    ['effort', '-'],
    ['branch', 'feat'],
    ['assigned_to', '-'],
    ['created_at', '-'],
    ['updated_at', '-']
  ]);
});

// --- groupArtifacts --------------------------------------------------------

test('groupArtifacts buckets by stage in timeline order and preserves input order', () => {
  const artifacts = [
    'analysis.md',
    'review-analysis.md',
    'plan.md',
    'plan-r2.md',
    'review-plan.md',
    'code.md',
    'task.md',
    'weird.md'
  ].map((name, i) => artifact(name, i));

  const groups = groupArtifacts(artifacts);
  assert.deepEqual(
    groups.map((g) => g.stage),
    ['analysis', 'review-analysis', 'plan', 'review-plan', 'code', 'task', 'other']
  );
  // plan group keeps the input (mtime) order, not alphabetical.
  assert.deepEqual(groups.find((g) => g.stage === 'plan')!.files, ['plan.md', 'plan-r2.md']);
  // review-analysis is NOT swallowed by the analysis bucket.
  assert.deepEqual(groups.find((g) => g.stage === 'analysis')!.files, ['analysis.md']);
  assert.deepEqual(groups.find((g) => g.stage === 'review-analysis')!.files, ['review-analysis.md']);
  // unrecognized names fall into 'other'.
  assert.deepEqual(groups.find((g) => g.stage === 'other')!.files, ['weird.md']);
});

test('groupArtifacts returns no groups for an empty task dir', () => {
  assert.deepEqual(groupArtifacts([]), []);
});

// --- collectGit ------------------------------------------------------------

const throwingRun: Runner = () => {
  throw new Error('git unavailable');
};

test('collectGit degrades every git-derived field on failure but keeps frontmatter branch', () => {
  // Acceptance point: git调用失败降级（mock execFileSync）. frontmatter is read
  // straight from task.md, so it survives even when every subprocess throws.
  const git = collectGit('feat', throwingRun);
  assert.equal(git.frontmatter, 'feat');
  assert.equal(git.current, '-');
  assert.equal(git.match, '-');
  assert.equal(git.exists, 'no');
  assert.equal(git.uncommitted, '-');
  assert.equal(git.aheadBehind, '-');
});

test('collectGit renders frontmatter/match/exists as - when task.md has no branch', () => {
  const run: Runner = (_file, args) => {
    if (args.includes('--abbrev-ref')) return 'main\n';
    if (args[0] === 'status') return '';
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const git = collectGit('', run);
  assert.equal(git.frontmatter, '-');
  assert.equal(git.match, '-');
  assert.equal(git.exists, '-');
});

test('collectGit parses current/match/uncommitted/aheadBehind from stubbed output', () => {
  const run: Runner = (_file, args) => {
    if (args.includes('--abbrev-ref')) return 'feat\n';
    if (args.includes('--verify')) return 'deadbeef\n';
    if (args[0] === 'status') return ' M a.ts\n M b.ts\n';
    if (args[0] === 'rev-list') return '2\t3\n';
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const git = collectGit('feat', run);
  assert.equal(git.current, 'feat');
  assert.equal(git.match, 'yes');
  assert.equal(git.exists, 'yes');
  assert.equal(git.uncommitted, '2 file(s)');
  assert.equal(git.aheadBehind, '2 ahead / 3 behind');
});

test('collectGit isolates a single failing field (rev-list) without degrading the rest', () => {
  const run: Runner = (_file, args) => {
    if (args.includes('--abbrev-ref')) return 'feat\n';
    if (args.includes('--verify')) return 'deadbeef\n';
    if (args[0] === 'status') return '';
    if (args[0] === 'rev-list') throw new Error('no upstream configured');
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const git = collectGit('feat', run);
  assert.equal(git.aheadBehind, '-');
  assert.equal(git.current, 'feat');
  assert.equal(git.uncommitted, 'clean');
  assert.equal(git.exists, 'yes');
});

// --- collectWorkflow -------------------------------------------------------

function taskWithLog(entries: string[]): string {
  return ['# Task', '', '## 活动日志', '', ...entries, '', '## 完成检查清单'].join('\n');
}

test('collectWorkflow reports the latest started-only row as in-progress', () => {
  const workflow = collectWorkflow(
    taskWithLog([
      '- 2026-07-02 20:00:00+08:00 — **Code Task (Round 2) [started]** by codex — started'
    ]),
    new Date('2026-07-02T12:30:00Z')
  );
  assert.equal(workflow.state, 'in-progress');
  assert.equal(workflow.step, 'Code Task (Round 2)');
  assert.equal(workflow.agent, 'codex');
  assert.equal(workflow.startedAt, '2026-07-02 20:00:00+08:00');
  assert.equal(workflow.doneAt, '-');
  assert.equal(workflow.stale, 'no');
});

test('collectWorkflow reports paired completion as idle', () => {
  const workflow = collectWorkflow(
    taskWithLog([
      '- 2026-07-02 20:00:00+08:00 — **Plan Task (Round 3) [started]** by codex — started',
      '- 2026-07-02 20:05:00+08:00 — **Plan Task (Round 3)** by codex — Plan completed → plan-r3.md'
    ]),
    new Date('2026-07-02T12:30:00Z')
  );
  assert.equal(workflow.state, 'idle');
  assert.equal(workflow.doneAt, '2026-07-02 20:05:00+08:00');
  assert.equal(workflow.stale, '-');
});

test('collectWorkflow marks in-progress rows stale after 60 minutes', () => {
  const workflow = collectWorkflow(
    taskWithLog([
      '- 2026-07-02 19:00:00+08:00 — **Code Task (Round 2) [started]** by codex — started'
    ]),
    new Date('2026-07-02T12:01:00Z')
  );
  assert.equal(workflow.state, 'in-progress');
  assert.equal(workflow.stale, 'yes');
});

// --- collectRuntime --------------------------------------------------------

test('collectRuntime reports unmanaged when workflow is in-progress without a run record', () => {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-status-runtime-'));
  const runtime = collectRuntime(
    taskDir,
    {
      state: 'in-progress',
      step: 'Code Task (Round 2)',
      agent: 'codex',
      startedAt: '2026-07-02 20:00:00+08:00',
      doneAt: '-',
      stale: 'no'
    },
    throwingRun
  );
  assert.equal(runtime.mode, 'unmanaged');
  assert.equal(runtime.status, 'inferred-from-workflow');
});

test('collectRuntime reads the latest managed tmux run through docker exec', () => {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-status-runtime-'));
  const runsDir = path.join(taskDir, 'runs');
  fs.mkdirSync(runsDir);
  fs.writeFileSync(
    path.join(runsDir, 'run-test.json'),
    JSON.stringify({
      version: 1,
      run_id: 'run-test',
      engine: 'docker',
      container: 'agent-dev',
      run_dir: '/tmp/agent-infra-runs/run-test',
      status_file: '/tmp/agent-infra-runs/run-test/status',
      log_file: '/tmp/agent-infra-runs/run-test/output.log'
    }),
    'utf8'
  );

  const files = new Map([
    ['/tmp/agent-infra-runs/run-test/status', 'running\n'],
    ['/tmp/agent-infra-runs/run-test/session', 'work\n'],
    ['/tmp/agent-infra-runs/run-test/window', 'ai-test\n'],
    ['/tmp/agent-infra-runs/run-test/pane', '%12\n'],
    ['/tmp/agent-infra-runs/run-test/started_at', '2026-07-02 20:00:00+08:00\n'],
    ['/tmp/agent-infra-runs/run-test/finished_at', ''],
    ['/tmp/agent-infra-runs/run-test/exit_code', '']
  ]);
  const run: Runner = (file, args) => {
    assert.equal(file, 'docker');
    assert.deepEqual(args.slice(0, 3), ['exec', 'agent-dev', 'cat']);
    const value = files.get(args[3] ?? '');
    if (value === undefined) throw new Error(`missing file ${args[3]}`);
    return value;
  };

  const runtime = collectRuntime(
    taskDir,
    { state: 'idle', step: '-', agent: '-', startedAt: '-', doneAt: '-', stale: '-' },
    run
  );
  assert.equal(runtime.mode, 'managed-tmux');
  assert.equal(runtime.status, 'running');
  assert.equal(runtime.run, 'run-test');
  assert.equal(runtime.tmux, 'work:ai-test:%12');
  assert.equal(runtime.startedAt, '2026-07-02 20:00:00+08:00');
  assert.equal(runtime.finishedAt, '-');
  assert.equal(runtime.exitCode, '-');
  assert.equal(runtime.log, '/tmp/agent-infra-runs/run-test/output.log');
});

// --- renderStatus ----------------------------------------------------------

const baseModel: StatusModel = {
  taskId: 'TASK-20260101-000001',
  shortId: '#01',
  title: 'demo title',
  metadata: [
    ['type', 'feature'],
    ['status', 'active']
  ],
  artifacts: {
    count: 2,
    groups: [
      { stage: 'analysis', files: ['analysis.md'] },
      { stage: 'plan', files: ['plan.md', 'plan-r2.md'] }
    ]
  },
  workflow: {
    state: 'in-progress',
    step: 'Code Task (Round 2)',
    agent: 'codex',
    startedAt: '2026-07-02 20:00:00+08:00',
    doneAt: '-',
    stale: 'no'
  },
  runtime: {
    mode: 'managed-tmux',
    status: 'running',
    run: 'run-test',
    tmux: 'work:ai-test:%12',
    startedAt: '2026-07-02 20:00:00+08:00',
    finishedAt: '-',
    exitCode: '-',
    log: '/tmp/agent-infra-runs/run-test/output.log'
  },
  git: {
    current: 'feat',
    frontmatter: 'feat',
    match: 'yes',
    exists: 'yes',
    uncommitted: 'clean',
    aheadBehind: '-'
  },
};

test('renderStatus emits workflow and runtime before git', () => {
  const out = renderStatus(baseModel).join('\n');
  assert.match(out, /^Task TASK-20260101-000001  \(#01\)$/m);
  assert.match(out, /^demo title$/m);
  assert.match(out, /^Metadata$/m);
  assert.match(out, /^Artifacts \(2\)$/m);
  assert.match(out, /^Workflow$/m);
  assert.match(out, /^  state +in-progress$/m);
  assert.match(out, /^Runtime$/m);
  assert.match(out, /^  mode +managed-tmux$/m);
  assert.match(out, /^Git$/m);
  // Stage group renders its files joined, in order.
  assert.match(out, /^  plan +plan\.md, plan-r2\.md$/m);
});

test('renderStatus shows (none) when a task has no artifacts', () => {
  const out = renderStatus({ ...baseModel, artifacts: { count: 0, groups: [] } }).join('\n');
  assert.match(out, /^Artifacts \(0\)\n {2}\(none\)$/m);
});
