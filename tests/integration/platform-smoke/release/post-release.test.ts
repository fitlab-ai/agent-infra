import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  changedPaths,
  inspectLocalReleaseFacts,
  inspectPostReleaseFacts,
  inspectPostWorktree,
  releaseSmokeStatus,
  runOptionalDemo
} from '../../../../lib/internal/release-workflow.ts';
import type { CommandRunner } from '../../../../lib/internal/release-workflow.ts';
import { sha256Transcript } from '../../../../lib/internal/demo-transcript.ts';

function result(status: number, stdout = '', stderr = '') {
  return { status, stdout, stderr, pid: 1, signal: null, output: [], error: undefined };
}

const recordingInputs = [
  'assets/demo-init.tape', 'scripts/demo-regen.sh', 'scripts/normalize-gif-duration.py',
  'bin/cli.ts', 'lib/log.ts', 'lib/prompt.ts', 'lib/paths.ts',
  'lib/render.ts', 'lib/sandbox/engines/index.ts'
];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-demo-'));
  for (const file of recordingInputs) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), file);
  }
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['add', '.'], { cwd: root });
  return root;
}

function recorder(calls: string[]): CommandRunner {
  return (cwd, executable, args, options) => {
    calls.push([executable, ...args].join(' '));
    if (executable === 'git' && args[0] === 'check-attr') return result(0, 'assets/demo-init.gif: filter: lfs\n');
    if (executable === 'git' && args[1] === 'pointer') return result(0, 'size 6\n');
    if (executable === 'npm') {
      const output = options?.env?.DEMO_OUTPUT_PATH;
      assert.ok(output);
      fs.writeFileSync(path.join(cwd, output), Buffer.from('GIF89a'));
    }
    return result(0);
  };
}

function collectedTranscript(value = 'visible demo output\n') {
  return async () => ({ status: 'ok' as const, transcript: value, sha256: sha256Transcript(value) });
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
      localTag: true, localTagAncestor: false, localTagConflict: false, postCommit: null
    });
    fs.appendFileSync(path.join(root, 'tracked.txt'), 'post\n');
    commit(root, 'chore: prepare next dev iteration after v1.2.3');
    fs.appendFileSync(path.join(root, 'tracked.txt'), 'ordinary\n');
    commit(root, 'fix: ordinary follow-up');
    const postCommit = spawnSync('git', ['rev-parse', 'HEAD~1'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    assert.deepEqual(inspectLocalReleaseFacts(root, '1.2.3'), {
      localTag: false, localTagAncestor: true, localTagConflict: false, postCommit
    });

    spawnSync('git', ['switch', '-q', '--orphan', 'divergent'], { cwd: root });
    spawnSync('git', ['rm', '-q', '-rf', '.'], { cwd: root });
    fs.writeFileSync(path.join(root, 'other.txt'), 'other\n');
    commit(root, 'divergent');
    assert.deepEqual(inspectLocalReleaseFacts(root, '1.2.3'), {
      localTag: false, localTagAncestor: false, localTagConflict: true, postCommit: null
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('post release facts are rebuilt from the commit tree and current Git state', () => {
  const root = releaseFixture();
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.4-alpha.0' }));
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'assets', 'demo-init.transcript'), 'visible demo output\n');
    fs.writeFileSync(path.join(root, 'assets', 'demo-init.transcript.sha256'), `${'a'.repeat(64)}\n`);
    commit(root, 'chore: prepare next dev iteration after v1.2.3');
    const postCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();

    const post = inspectPostReleaseFacts(root, postCommit);
    assert.equal(post.commit, postCommit);
    assert.equal(post.isHead, true);
    assert.equal(post.published, false);
    assert.equal(post.branch, 'main');
    assert.equal(post.newVersion, '1.2.4-alpha.0');
    assert.equal(post.demoTranscriptSha256, 'a'.repeat(64));
    assert.deepEqual(post.changedPaths, ['assets/demo-init.transcript', 'assets/demo-init.transcript.sha256', 'package.json']);
    assert.deepEqual(post.worktree, []);
    assert.deepEqual(post.staged, []);

    fs.appendFileSync(path.join(root, 'tracked.txt'), 'later\n');
    commit(root, 'fix: later change');
    assert.equal(inspectPostReleaseFacts(root, postCommit).isHead, false);
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

test('unchanged visible transcript skips recorder and tool probes', async () => {
  const root = fixture();
  const calls: string[] = [];
  try {
    const value = 'visible demo output\n';
    fs.writeFileSync(path.join(root, 'assets/demo-init.transcript.sha256'), `${sha256Transcript(value)}\n`);
    assert.deepEqual(await runOptionalDemo(root, recorder(calls), collectedTranscript(value)), {
      status: 'skipped', reasonCode: 'DEMO_TRANSCRIPT_UNCHANGED', message: null, outputPath: null
    });
    assert.deepEqual(calls, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('changed visible transcript records into one validated asset generation', async () => {
  const root = fixture();
  const calls: string[] = [];
  try {
    const value = 'visible demo output\n';
    assert.deepEqual(await runOptionalDemo(root, recorder(calls), collectedTranscript(value)), {
      status: 'recorded', reasonCode: null, message: null, outputPath: 'assets/demo-init.gif'
    });
    assert.deepEqual(calls.slice(0, 5), [
      'git lfs version', 'git check-attr filter -- assets/demo-init.gif',
      'vhs --version', 'ffmpeg -version', 'npm run demo:regen'
    ]);
    assert.match(calls[5]!, /^git lfs pointer --file=assets\/\.demo-init\.promotion-[^/]+\/demo-init\.gif$/);
    assert.equal(fs.readFileSync(path.join(root, 'assets/demo-init.transcript'), 'utf8'), value);
    assert.equal(fs.readFileSync(path.join(root, 'assets/demo-init.transcript.sha256'), 'utf8'), `${sha256Transcript(value)}\n`);
    assert.equal(fs.readFileSync(path.join(root, 'assets/demo-init.gif'), 'utf8'), 'GIF89a');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function missingRecordingTool(calls: string[], missing: 'vhs' | 'ffmpeg'): CommandRunner {
  return (cwd, executable, args, options) => {
    calls.push([executable, ...args].join(' '));
    if (executable === missing) return result(1, '', `${missing} is unavailable`);
    if (executable === 'git' && args[0] === 'check-attr') return result(0, 'assets/demo-init.gif: filter: lfs\n');
    if (executable === 'npm') {
      const output = options?.env?.DEMO_OUTPUT_PATH;
      assert.ok(output);
      fs.writeFileSync(path.join(cwd, output), Buffer.from('GIF89a'));
    }
    return result(0);
  };
}

for (const missing of ['vhs', 'ffmpeg'] as const) {
  test(`changed visible transcript fails closed when ${missing} is unavailable`, async () => {
    const root = fixture();
    const calls: string[] = [];
    try {
      const demo = await runOptionalDemo(root, missingRecordingTool(calls, missing), collectedTranscript());
      assert.equal(demo.status, 'failed');
      assert.equal(demo.reasonCode, missing === 'vhs' ? 'VHS_MISSING' : 'FFMPEG_MISSING');
      assert.match(demo.message ?? '', new RegExp(missing));
      assert.equal(calls.includes('npm run demo:regen'), false);
      assert.equal(calls.some((call) => call.includes('git lfs pointer')), false);
      assert.equal(fs.existsSync(path.join(root, 'assets', 'demo-init.transcript.sha256')), false);
      assert.equal(fs.readdirSync(path.join(root, 'assets')).some((name) => name.startsWith('.demo-init.promotion-')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('failed recording does not advance the transcript baseline', async () => {
  const root = fixture();
  const run: CommandRunner = (_cwd, executable) =>
    executable === 'npm' ? result(1, '', 'recording failed')
      : executable === 'git' ? result(0, 'assets/demo-init.gif: filter: lfs\n') : result(0);
  try {
    assert.equal((await runOptionalDemo(root, run, collectedTranscript())).reasonCode, 'DEMO_COMMAND_FAILED');
    assert.equal(fs.existsSync(path.join(root, 'assets/demo-init.transcript.sha256')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing Git LFS fails after transcript collection and before recording tools are probed', async () => {
  const root = fixture();
  const calls: string[] = [];
  const run: CommandRunner = (_cwd, executable, args) => {
    calls.push([executable, ...args].join(' '));
    return result(1, '', 'missing');
  };
  try {
    assert.equal((await runOptionalDemo(root, run, collectedTranscript())).reasonCode, 'GIT_LFS_MISSING');
    assert.deepEqual(calls, ['git lfs version']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('invalid demo output fails without advancing the transcript baseline', async () => {
  const root = fixture();
  const run: CommandRunner = (cwd, executable, _args, options) => {
    if (executable === 'npm') fs.writeFileSync(path.join(cwd, options?.env?.DEMO_OUTPUT_PATH ?? ''), 'not gif');
    return executable === 'git' ? result(0, 'assets/demo-init.gif: filter: lfs\n') : result(0);
  };
  try {
    assert.equal((await runOptionalDemo(root, run, collectedTranscript())).reasonCode, 'DEMO_OUTPUT_INVALID');
    assert.equal(fs.existsSync(path.join(root, 'assets/demo-init.transcript.sha256')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
