import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';

import { filePath, gitSafeEnv, INTERNAL_CLI_PATH, sandboxControlSafeEnv } from '../../helpers.ts';
import { readPlatformOperationJournal, recordPlatformOperation } from '../../../lib/task/platform-operation-journal.ts';

function run(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'platform-issue', ...args], {
    encoding: 'utf8',
    cwd: options.cwd,
    env: gitSafeEnv(options.env)
  });
}

function runRecovery(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-platform-recovery', ...args], {
    encoding: 'utf8', cwd: options.cwd, env: sandboxControlSafeEnv(gitSafeEnv(options.env))
  });
}

test('platform-issue CLI validates closed option combinations before I/O', () => {
  for (const args of [
    ['sync', 'TASK-20260101-000001', '--agent', 'codex'],
    ['sync', 'TASK-20260101-000001', '--agent', 'codex', '--base', 'main'],
    ['sync', 'TASK-20260101-000001', '--agent', 'codex', '--in-labels', 'from-diff'],
    ['sync', 'TASK-20260101-000001', '--agent', 'codex', '--in-labels', 'none', '--base', 'main'],
    ['sync', 'TASK-20260101-000001', '--agent', 'codex', '--close-reason', 'completed'],
    ['inspect', 'TASK-20260101-000001', '--dry-run']
  ]) {
    const result = run(args);
    assert.equal(result.status, 1, `${args.join(' ')}\n${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).error.code, 'ISSUE_PAYLOAD_INVALID');
  }
});

test('platform-issue CLI advertises the four intent operations', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /platform-issue inspect/);
  assert.match(result.stdout, /platform-issue create/);
  assert.match(result.stdout, /platform-issue bind/);
  assert.match(result.stdout, /platform-issue sync/);
});

test('platform-issue requirements sync persists once and converges across CLI processes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-issue-cli-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:fitlab-ai/agent-infra.git'], { cwd: root });
    const taskId = 'TASK-20260101-000001';
    const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', '.airc.json'), '{"platform":{"type":"github"}}');
    fs.writeFileSync(path.join(taskDir, 'task.md'), [
      '---',
      `id: ${taskId}`,
      'type: bugfix',
      'status: active',
      'platform_issue_identity: \'{"kind":"number","value":7}\'',
      '---',
      '',
      '# Task',
      '',
      '## Requirements',
      '',
      '- [x] first',
      '- [ ] second',
      ''
    ].join('\n'));
    const issuePath = path.join(root, 'issue.json');
    const argsPath = path.join(root, 'gh-args.jsonl');
    const fakeGhPath = path.join(root, 'fake-gh.cjs');
    fs.copyFileSync(filePath('tests/fixtures/validate-artifact/fake-gh.js'), fakeGhPath);
    fs.writeFileSync(issuePath, JSON.stringify({
      number: 7,
      id: 70,
      node_id: 'I_7',
      html_url: 'https://github.com/fitlab-ai/agent-infra/issues/7',
      state: 'open',
      title: 'Issue',
      body: 'Intro\n\n## Requirements\n\nN/A\n',
      labels: [],
      assignees: [],
      milestone: null
    }));
    const env = {
      AGENT_INFRA_GH_BIN: process.execPath,
      AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([fakeGhPath]),
      GH_FAKE_ISSUE_PATH: issuePath,
      GH_FAKE_ARGS_PATH: argsPath
    };

    const dry = run(['sync', taskId, '--agent', 'codex', '--requirements', '--dry-run'], { cwd: root, env });
    assert.equal(dry.status, 0, `${dry.stderr}\n${dry.stdout}`);
    assert.equal(JSON.parse(dry.stdout).status, 'planned');

    const applied = run(['sync', taskId, '--agent', 'codex', '--requirements'], { cwd: root, env });
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).status, 'applied');
    assert.match(JSON.parse(fs.readFileSync(issuePath, 'utf8')).body, /- \[x\] first\n- \[ \] second/);

    const replay = run(['sync', taskId, '--agent', 'codex', '--requirements'], { cwd: root, env });
    assert.equal(replay.status, 0, replay.stderr);
    assert.equal(JSON.parse(replay.stdout).status, 'no-op');
    const calls = fs.readFileSync(argsPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.filter((args) => args.includes('PATCH')).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('platform-issue in-label sync journals its hard dependency and dry-run is not recoverable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-issue-in-labels-'));
  try {
    execFileSync('git', ['init', '-qb', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:fitlab-ai/agent-infra.git'], { cwd: root });
    const taskId = 'TASK-20260101-000001';
    const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({
      platform: { type: 'github' }, labels: { in: { core: ['lib/'] } }
    }));
    fs.writeFileSync(path.join(root, 'lib', 'sample.ts'), 'export {};\n');
    fs.writeFileSync(path.join(taskDir, 'task.md'), [
      '---', `id: ${taskId}`, 'type: bugfix', 'status: active',
      'platform_issue_identity: \'{"kind":"number","value":7}\'', '---', '', '# Task', ''
    ].join('\n'));
    execFileSync('git', ['add', '.agents']);
    const tree = execFileSync('git', ['write-tree'], { cwd: root, encoding: 'utf8' }).trim();
    const commit = execFileSync('git', ['commit-tree', tree, '-m', 'fixture'], { cwd: root, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', 'refs/heads/main', commit], { cwd: root });
    execFileSync('git', ['add', 'lib/sample.ts'], { cwd: root });
    const featureTree = execFileSync('git', ['write-tree'], { cwd: root, encoding: 'utf8' }).trim();
    const featureCommit = execFileSync('git', ['commit-tree', featureTree, '-p', commit, '-m', 'feature fixture'], { cwd: root, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', 'refs/heads/feature', featureCommit], { cwd: root });
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/feature'], { cwd: root });
    fs.writeFileSync(path.join(taskDir, 'task.md'), fs.readFileSync(path.join(taskDir, 'task.md'), 'utf8').replace('platform_issue_identity:', 'delivery_base_ref: main\nplatform_issue_identity:'));
    const issuePath = path.join(root, 'issue.json');
    const labelsPath = path.join(root, 'labels.json');
    const fakeGhPath = path.join(root, 'fake-gh.cjs');
    fs.copyFileSync(filePath('tests/fixtures/validate-artifact/fake-gh.js'), fakeGhPath);
    fs.writeFileSync(issuePath, JSON.stringify({
      number: 7, id: 70, node_id: 'I_7', html_url: 'https://github.com/fitlab-ai/agent-infra/issues/7',
      state: 'open', title: 'Issue', body: 'Issue body', labels: ['in: core'], assignees: [], milestone: null
    }));
    fs.writeFileSync(labelsPath, JSON.stringify([{ name: 'status: blocked' }]));
    const env = {
      AGENT_INFRA_GH_BIN: process.execPath,
      AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([fakeGhPath]),
      GH_FAKE_ISSUE_PATH: issuePath,
      GH_FAKE_LABELS_PATH: labelsPath
    };

    const dry = run(['sync', taskId, '--agent', 'codex', '--in-labels', 'from-diff', '--base', 'main', '--dry-run'], { cwd: root, env });
    assert.equal(dry.status, 0, dry.stderr || dry.stdout);
    assert.equal(fs.existsSync(path.join(taskDir, '.platform-operations.json')), false);

    const synced = run(['sync', taskId, '--agent', 'codex', '--in-labels', 'from-diff', '--base', 'main'], { cwd: root, env });
    assert.equal(synced.status, 0, synced.stderr || synced.stdout);
    const operation = readPlatformOperationJournal(taskId, root).operations[0];
    assert.equal(operation?.kind, 'issue-metadata');
    assert.equal(operation?.dependency, 'required');
    assert.equal(operation?.issueMetadata?.inLabels, 'from-diff');
    assert.equal(operation?.issueMetadata?.base, 'main');
    assert.equal(operation?.state, 'succeeded');

    assert.ok(operation);
    recordPlatformOperation({ taskRef: taskId, cwd: root, ...operation, state: 'unknown' });
    fs.writeFileSync(path.join(root, 'lib', 'second.ts'), 'export const second = true;\n');
    execFileSync('git', ['add', 'lib/second.ts'], { cwd: root });
    const nextTree = execFileSync('git', ['write-tree'], { cwd: root, encoding: 'utf8' }).trim();
    const nextCommit = execFileSync('git', ['commit-tree', nextTree, '-p', featureCommit, '-m', 'second fixture'], { cwd: root, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', 'refs/heads/feature', nextCommit], { cwd: root });
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/feature'], { cwd: root });
    assert.deepEqual(execFileSync('git', ['diff', 'main...HEAD', '--name-only'], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/).sort(), ['lib/sample.ts', 'lib/second.ts']);
    const recovered = runRecovery([taskId, 'recover', '--agent', 'codex', '--selection', 'required'], { cwd: root, env });
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    const recoveredJournal = readPlatformOperationJournal(taskId, root).operations;
    const superseded = recoveredJournal.find((item) => item.id === operation.id);
    const retargeted = recoveredJournal.find((item) => item.id !== operation.id && item.issueMetadata?.inLabels === 'from-diff');
    assert.equal(superseded?.state, 'failed');
    assert.equal(superseded?.lastCode, 'PLATFORM_OPERATION_SUPERSEDED');
    assert.notDeepEqual(retargeted?.issueMetadata?.fromDiffFiles, operation.issueMetadata?.fromDiffFiles, JSON.stringify(recoveredJournal));
    assert.equal(retargeted?.state, 'succeeded');

    assert.ok(retargeted);
    recordPlatformOperation({ taskRef: taskId, cwd: root, ...retargeted, state: 'unknown' });
    assert.equal(readPlatformOperationJournal(taskId, root).operations.find((item) => item.id === retargeted.id)?.state, 'unknown');
    const mappingFilesBefore = execFileSync('git', ['diff', 'main...HEAD', '--name-only'], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/).sort();
    fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({
      platform: { type: 'github' }, labels: { in: { cli: ['lib/'] } }
    }));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.agents', '.airc.json'), 'utf8')).labels.in, { cli: ['lib/'] });
    const mappingRecovery = runRecovery([taskId, 'recover', '--agent', 'codex', '--selection', 'required'], { cwd: root, env });
    assert.equal(mappingRecovery.status, 0, mappingRecovery.stderr || mappingRecovery.stdout);
    const mappingJournal = readPlatformOperationJournal(taskId, root).operations;
    const staleMapping = mappingJournal.find((item) => item.id === retargeted.id);
    const currentMapping = mappingJournal.find((item) => item.id !== retargeted.id
      && item.issueMetadata?.inLabels === 'from-diff'
      && JSON.stringify(item.issueMetadata.fromDiffFiles) === JSON.stringify(retargeted.issueMetadata?.fromDiffFiles));
    assert.equal(staleMapping?.state, 'failed', JSON.stringify({ mappingRecovery: mappingRecovery.stdout, mappingJournal }));
    assert.equal(staleMapping?.lastCode, 'PLATFORM_OPERATION_SUPERSEDED');
    assert.ok(currentMapping);
    assert.notEqual(currentMapping.id, retargeted.id);
    assert.notEqual(currentMapping.issueMetadata?.inLabelMappingDigest, retargeted.issueMetadata?.inLabelMappingDigest, JSON.stringify({ retargeted, currentMapping }));
    assert.deepEqual(currentMapping.issueMetadata?.fromDiffFiles, retargeted.issueMetadata?.fromDiffFiles);
    assert.deepEqual(execFileSync('git', ['diff', 'main...HEAD', '--name-only'], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/).sort(), mappingFilesBefore);
    assert.equal(currentMapping.state, 'succeeded');
    assert.deepEqual(JSON.parse(fs.readFileSync(issuePath, 'utf8')).labels, ['in: cli']);

    const statusSync = run(['sync', taskId, '--agent', 'codex', '--status', 'none'], { cwd: root, env });
    assert.equal(statusSync.status, 0, statusSync.stderr || statusSync.stdout);
    const statusOperation = readPlatformOperationJournal(taskId, root).operations.find((item) => item.issueMetadata?.status === 'none');
    assert.equal(statusOperation?.kind, 'issue-metadata');
    assert.equal(statusOperation?.issueMetadata?.requirements, false);
    assert.equal(statusOperation?.state, 'succeeded');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
