import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectMetadata,
  groupArtifacts,
  collectGit,
  collectPlatform,
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
    branch: 'feat',
    issue_number: '468'
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
    ['updated_at', '-'],
    ['issue_number', '468'],
    ['pr_status', '-']
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

// --- collectPlatform -------------------------------------------------------

test('collectPlatform makes no calls when there is no issue and pr is not created', () => {
  let calls = 0;
  const run: Runner = () => {
    calls += 1;
    throw new Error('should not be called');
  };
  const platform = collectPlatform({}, run);
  assert.equal(platform.issue, '-');
  assert.equal(platform.pr, '-');
  assert.equal(calls, 0);
});

test('collectPlatform skips the PR call when pr_status is created but pr_number is absent', () => {
  let calls = 0;
  const run: Runner = () => {
    calls += 1;
    throw new Error('should not be called');
  };
  const platform = collectPlatform({ pr_status: 'created' }, run);
  assert.equal(platform.pr, '-');
  assert.equal(calls, 0);
});

test('collectPlatform summarizes gh JSON for issue and pr', () => {
  const run: Runner = (_file, args) => {
    if (args[0] === 'issue') {
      return JSON.stringify({ state: 'OPEN', labels: [{ name: 'in: cli' }, { name: 'type: feature' }] });
    }
    if (args[0] === 'pr') {
      return JSON.stringify({
        state: 'OPEN',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }]
      });
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const platform = collectPlatform(
    { issue_number: '468', pr_status: 'created', pr_number: '42' },
    run
  );
  assert.equal(platform.issue, 'OPEN [in: cli, type: feature]');
  assert.equal(platform.pr, 'OPEN, checks: 1/2');
});

test('collectPlatform degrades to - when gh fails (offline)', () => {
  const run: Runner = () => {
    throw new Error('gh: offline');
  };
  const platform = collectPlatform({ issue_number: '468' }, run);
  assert.equal(platform.issue, '-');
});

// --- renderStatus ----------------------------------------------------------

const baseModel: StatusModel = {
  taskId: 'TASK-20260101-000001',
  shortId: '#01',
  title: 'demo title',
  issueNumber: '468',
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
  git: {
    current: 'feat',
    frontmatter: 'feat',
    match: 'yes',
    exists: 'yes',
    uncommitted: 'clean',
    aheadBehind: '-'
  },
  platform: { issue: 'OPEN', pr: '-' }
};

test('renderStatus emits all five sections with aligned rows', () => {
  const out = renderStatus(baseModel).join('\n');
  assert.match(out, /^Task TASK-20260101-000001  \(#01\)$/m);
  assert.match(out, /^demo title$/m);
  assert.match(out, /^Metadata$/m);
  assert.match(out, /^Artifacts \(2\)$/m);
  assert.match(out, /^Git$/m);
  assert.match(out, /^Platform$/m);
  // Stage group renders its files joined, in order.
  assert.match(out, /^  plan +plan\.md, plan-r2\.md$/m);
  // Platform issue row is labeled with the issue number.
  assert.match(out, /^  issue #468 +OPEN$/m);
});

test('renderStatus shows (none) when a task has no artifacts', () => {
  const out = renderStatus({ ...baseModel, artifacts: { count: 0, groups: [] } }).join('\n');
  assert.match(out, /^Artifacts \(0\)\n {2}\(none\)$/m);
});
