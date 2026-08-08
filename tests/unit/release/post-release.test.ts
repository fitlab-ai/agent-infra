import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  changedPaths,
  computeDemoInputDigest,
  inspectLocalReleaseFacts,
  inspectPostWorktree,
  releaseSmokeStatus,
  runOptionalDemo
} from '../../../lib/internal/release-workflow.ts';
import type { CommandRunner } from '../../../lib/internal/release-workflow.ts';

function result(status: number, stdout = '', stderr = '') {
  return { status, stdout, stderr, pid: 1, signal: null, output: [], error: undefined };
}

const inputs = [
  'assets/demo-init.tape', 'scripts/demo-regen.sh', 'scripts/normalize-gif-duration.py',
  'bin/cli.ts', 'lib/init.ts', 'lib/log.ts', 'lib/prompt.ts', 'lib/paths.ts',
  'lib/render.ts', 'lib/builtin-tuis.ts', 'lib/sandbox/engines/index.ts',
  'src/sync-templates.js', 'templates/AGENTS.md'
];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-demo-'));
  for (const file of inputs) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), file);
  }
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['add', '.'], { cwd: root });
  return root;
}

function recorder(calls: string[]): CommandRunner {
  return (cwd, executable, args) => {
    calls.push([executable, ...args].join(' '));
    if (executable === 'git' && args[0] === 'check-attr') return result(0, 'assets/demo-init.gif: filter: lfs\n');
    if (executable === 'git' && args[1] === 'pointer') return result(0, 'size 6\n');
    if (executable === 'npm') {
      fs.writeFileSync(path.join(cwd, 'assets/demo-init.gif'), Buffer.from('GIF89a'));
    }
    return result(0);
  };
}

function commit(root: string, message: string) {
  spawnSync('git', ['add', '.'], { cwd: root });
  const committed = spawnSync('git', ['commit', '-qm', message], { cwd: root });
  assert.equal(committed.status, 0, String(committed.stderr));
}

function releaseFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-release-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'Codex'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'codex@example.com'], { cwd: root });
  spawnSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
  spawnSync('git', ['config', 'tag.gpgsign', 'false'], { cwd: root });
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'initial\n');
  commit(root, 'initial');
  fs.appendFileSync(path.join(root, 'tracked.txt'), 'release\n');
  commit(root, 'release');
  spawnSync('git', ['tag', 'v1.2.3'], { cwd: root });
  return root;
}

test('changed paths parse porcelain v1 status combinations', () => {
  const run: CommandRunner = () => result(0, ' M .agents/.airc.json\r\nM  package.json\r\nMM package-lock.json\r\n?? new-file.txt\r\n');

  assert.deepEqual(changedPaths('/repo', run), [
    '.agents/.airc.json',
    'package.json',
    'package-lock.json',
    'new-file.txt'
  ]);
});

test('changed paths reject malformed porcelain v1 records', () => {
  const run: CommandRunner = () => result(0, ' M package.json\ninvalid-record\n');

  assert.throws(() => changedPaths('/repo', run), /Invalid git status --porcelain=v1 record/);
});

test('local release facts distinguish exact, ancestor, and divergent tags with bounded post history', () => {
  const root = releaseFixture();
  try {
    assert.deepEqual(inspectLocalReleaseFacts(root, '1.2.3'), {
      localTag: true, localTagAncestor: false, localTagConflict: false, postCommit: false
    });
    fs.appendFileSync(path.join(root, 'tracked.txt'), 'post\n');
    commit(root, 'chore: prepare next dev iteration after v1.2.3');
    fs.appendFileSync(path.join(root, 'tracked.txt'), 'ordinary\n');
    commit(root, 'fix: ordinary follow-up');
    assert.deepEqual(inspectLocalReleaseFacts(root, '1.2.3'), {
      localTag: false, localTagAncestor: true, localTagConflict: false, postCommit: true
    });

    spawnSync('git', ['switch', '-q', '--orphan', 'divergent'], { cwd: root });
    spawnSync('git', ['rm', '-q', '-rf', '.'], { cwd: root });
    fs.writeFileSync(path.join(root, 'other.txt'), 'other\n');
    commit(root, 'divergent');
    assert.deepEqual(inspectLocalReleaseFacts(root, '1.2.3'), {
      localTag: false, localTagAncestor: false, localTagConflict: true, postCommit: false
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('smoke status binds automatic runs by tag commit and manual runs by exact version title', () => {
  const runs = [
    {
      workflowName: 'Post-Release Smoke', displayTitle: 'Post-Release Smoke v1.2.3',
      event: 'workflow_dispatch', headSha: 'main', status: 'completed', conclusion: 'success',
      createdAt: '2026-07-26T10:00:00Z', databaseId: 20, attempt: 1
    },
    {
      workflowName: 'Post-Release Smoke', displayTitle: 'Post-Release Smoke v1.2.3',
      event: 'workflow_dispatch', headSha: 'main', status: 'in_progress', conclusion: '',
      createdAt: '2026-07-26T11:00:00Z', databaseId: 21, attempt: 1
    },
    {
      workflowName: 'Post-Release Smoke', displayTitle: 'Post-Release Smoke v9.9.9',
      event: 'workflow_dispatch', headSha: 'main', status: 'completed', conclusion: 'success',
      createdAt: '2026-07-26T12:00:00Z', databaseId: 22, attempt: 1
    }
  ];
  assert.equal(releaseSmokeStatus(runs, '1.2.3', 'tag-sha'), 'pending');
  assert.equal(releaseSmokeStatus([{
    workflowName: 'Post-Release Smoke', displayTitle: 'automatic', event: 'workflow_run',
    headSha: 'tag-sha', status: 'completed', conclusion: 'success',
    createdAt: '2026-07-26T09:00:00Z', databaseId: 10, attempt: 1
  }], '1.2.3', 'tag-sha'), 'success');
  assert.equal(releaseSmokeStatus([{
    workflowName: 'Not Post-Release Smoke', displayTitle: 'Post-Release Smoke v1.2.3',
    event: 'workflow_dispatch', headSha: 'main', status: 'completed', conclusion: 'success',
    createdAt: '2026-07-26T12:00:00Z', databaseId: 30, attempt: 1
  }], '1.2.3', 'tag-sha'), null);
});

test('post worktree preflight rejects staged, unstaged, and untracked changes', () => {
  for (const kind of ['staged', 'unstaged', 'untracked'] as const) {
    const root = releaseFixture();
    try {
      if (kind === 'untracked') fs.writeFileSync(path.join(root, 'untracked.txt'), 'change\n');
      else {
        fs.appendFileSync(path.join(root, 'tracked.txt'), 'change\n');
        if (kind === 'staged') spawnSync('git', ['add', 'tracked.txt'], { cwd: root });
      }
      assert.equal(inspectPostWorktree(root)?.code, 'WORKTREE_DIRTY');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('demo input digest is stable and changes for canonical UX inputs', () => {
  const root = fixture();
  try {
    const initial = computeDemoInputDigest(root);
    assert.equal(computeDemoInputDigest(root), initial);
    fs.appendFileSync(path.join(root, 'lib/prompt.ts'), 'changed');
    assert.notEqual(computeDemoInputDigest(root), initial);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unchanged demo inputs skip recorder and tool probes', () => {
  const root = fixture();
  const calls: string[] = [];
  try {
    fs.writeFileSync(path.join(root, 'assets/demo-init.inputs.sha256'), `${computeDemoInputDigest(root)}\n`);
    assert.deepEqual(runOptionalDemo(root, recorder(calls)), {
      status: 'skipped', reasonCode: 'DEMO_INPUTS_UNCHANGED', message: null, outputPath: null
    });
    assert.deepEqual(calls, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('changed demo inputs record after LFS and media tool probes and advance the digest', () => {
  const root = fixture();
  const calls: string[] = [];
  try {
    assert.deepEqual(runOptionalDemo(root, recorder(calls)), {
      status: 'recorded', reasonCode: null, message: null, outputPath: 'assets/demo-init.gif'
    });
    assert.deepEqual(calls, [
      'git lfs version',
      'git check-attr filter -- assets/demo-init.gif',
      'vhs --version',
      'ffmpeg -version',
      'npm run demo:regen',
      'git lfs pointer --file=assets/demo-init.gif'
    ]);
    assert.equal(fs.readFileSync(path.join(root, 'assets/demo-init.inputs.sha256'), 'utf8'), `${computeDemoInputDigest(root)}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed recording does not advance the demo digest', () => {
  const root = fixture();
  const run: CommandRunner = (_cwd, executable) =>
    executable === 'npm' ? result(1, '', 'recording failed')
      : executable === 'git' ? result(0, 'assets/demo-init.gif: filter: lfs\n') : result(0);
  try {
    assert.equal(runOptionalDemo(root, run).reasonCode, 'DEMO_COMMAND_FAILED');
    assert.equal(fs.existsSync(path.join(root, 'assets/demo-init.inputs.sha256')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing Git LFS fails before recording tools are probed', () => {
  const root = fixture();
  const calls: string[] = [];
  const run: CommandRunner = (_cwd, executable, args) => {
    calls.push([executable, ...args].join(' '));
    return result(1, '', 'missing');
  };
  try {
    assert.equal(runOptionalDemo(root, run).reasonCode, 'GIT_LFS_MISSING');
    assert.deepEqual(calls, ['git lfs version']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('invalid demo output fails without advancing the digest', () => {
  const root = fixture();
  const run: CommandRunner = (cwd, executable) => {
    if (executable === 'npm') fs.writeFileSync(path.join(cwd, 'assets/demo-init.gif'), 'not gif');
    return executable === 'git' ? result(0, 'assets/demo-init.gif: filter: lfs\n') : result(0);
  };
  try {
    assert.equal(runOptionalDemo(root, run).reasonCode, 'DEMO_OUTPUT_INVALID');
    assert.equal(fs.existsSync(path.join(root, 'assets/demo-init.inputs.sha256')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
