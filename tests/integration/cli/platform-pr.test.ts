import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { filePath, gitSafeEnv, INTERNAL_CLI_PATH } from '../../helpers.ts';
import { withTaskExecutionLock } from '../../../lib/task/task-execution-lock.ts';
import { buildBoundFact, buildUnboundFact, encodePrDeliveryFact } from '../../../lib/task/pr-delivery-fact.ts';
import { parseTypedTaskFrontmatter } from '../../../lib/task/frontmatter.ts';
import { readPrDeliveryFact } from '../../../lib/task/pr-delivery-fact.ts';

function factLine(fact: ReturnType<typeof buildUnboundFact> | ReturnType<typeof buildBoundFact>): string {
  return `pr_delivery_fact: ${JSON.stringify(encodePrDeliveryFact(fact))}`;
}

function boundFixture(number: number, headSha = 'a'.repeat(40)) {
  return buildBoundFact({
    identity: {
      repository: 'fitlab-ai/agent-infra', number, nodeId: `PR_${number}`,
      url: `https://github.com/fitlab-ai/agent-infra/pull/${number}`,
      head: { repository: 'fitlab-ai/agent-infra', ref: 'feature', sha: headSha },
      base: { repository: 'fitlab-ai/agent-infra', ref: 'main', sha: 'b'.repeat(40) }
    },
    source: 'explicit-bind', verifiedAt: '2026-01-01T00:00:00.000Z', remoteState: 'open'
  });
}

function run(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'platform-pr', ...args], {
    encoding: 'utf8', cwd: options.cwd, env: gitSafeEnv(options.env)
  });
}

test('platform-pr CLI advertises all PR and summary intents', () => {
  const output = run(['--help']);
  assert.equal(output.status, 0);
  for (const operation of ['inspect', 'resolve-external', 'create', 'bind', 'skip', 'sync', 'sync-in-labels', 'summary-context', 'summary-sync']) {
    assert.match(output.stdout, new RegExp(`platform-pr ${operation}`));
  }
});

test('platform-pr sync-in-labels validates the PR number before platform access', () => {
  const output = run(['sync-in-labels', '--pr', '0']);
  assert.equal(output.status, 1);
  assert.equal(JSON.parse(output.stdout).error.code, 'PR_PAYLOAD_INVALID');
});

test('platform-pr summary-sync accepts the commit path no-op result before task resolution', () => {
  const bodyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-pr-summary-'));
  const bodyFile = path.join(bodyRoot, 'body.md');
  fs.writeFileSync(bodyFile, '');
  try {
    const output = run([
      'summary-sync', 'TASK-1', '--agent', 'codex', '--body-file', bodyFile, '--result', 'no_op'
    ]);
    assert.equal(output.status, 1);
    assert.equal(JSON.parse(output.stdout).error.code, 'INVALID_TASK_REF');
  } finally {
    fs.rmSync(bodyRoot, { recursive: true, force: true });
  }
});

function externalFixture(taskContent: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-pr-external-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:fitlab-ai/agent-infra.git'], { cwd: root });
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), '{"platform":{"type":"github"},"delivery":{"remote":"origin","baseRef":"main"}}');
  const renderedTask = taskContent.replaceAll('{task-id}', taskId);
  const fact = `\n${factLine(buildUnboundFact())}`;
  const taskWithContract = renderedTask
    .replace('\n---\n', '\nagent_infra_version: v0.9.11-alpha.0\n---\n')
    .replace('\nagent_infra_version:', `${fact}\nagent_infra_version:`)
    .replace('## Activity Log', '## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n\n## Activity Log');
  fs.writeFileSync(path.join(taskDir, 'task.md'), taskWithContract);
  const closing = path.join(root, 'closing.json');
  const calls = path.join(root, 'calls.jsonl');
  const fake = path.join(root, 'fake-gh.cjs');
  fs.copyFileSync(filePath('tests/fixtures/validate-artifact/fake-gh.js'), fake);
  const candidate = {
    number: 771, id: 'PR_771', url: 'https://github.com/fitlab-ai/agent-infra/pull/771',
    state: 'MERGED', title: 'Community fix', body: '', isDraft: false,
    headRefName: 'community-fix', headRefOid: 'a'.repeat(40), headRepository: { nameWithOwner: 'contributor/agent-infra' },
    baseRefName: 'main', baseRefOid: 'b'.repeat(40), baseRepository: { nameWithOwner: 'fitlab-ai/agent-infra' },
    mergedAt: '2026-08-07T01:00:00Z', mergeCommit: { oid: 'c'.repeat(40) },
    labels: { nodes: [] }, assignees: { nodes: [] }, milestone: null
  };
  fs.writeFileSync(closing, JSON.stringify([
    { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'page-2' } },
    { previousCursor: 'page-2', nodes: [candidate], pageInfo: { hasNextPage: false, endCursor: null } }
  ]));
  const selectedPr = path.join(root, 'selected-pr.json');
  fs.writeFileSync(selectedPr, JSON.stringify({
    number: 771, node_id: 'PR_771', html_url: 'https://github.com/fitlab-ai/agent-infra/pull/771',
    state: 'closed', title: 'Community fix', body: '', draft: false,
    head: { ref: 'community-fix', sha: 'a'.repeat(40), repo: { full_name: 'contributor/agent-infra' } },
    base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: 'fitlab-ai/agent-infra' } },
    merged_at: '2026-08-07T01:00:00Z', merge_commit_sha: 'c'.repeat(40)
  }));
  const env = {
    AGENT_INFRA_GH_BIN: process.execPath,
    AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([fake]),
    GH_FAKE_CLOSING_PRS_PATH: closing,
    GH_FAKE_PR_PATH: selectedPr,
    GH_FAKE_ARGS_PATH: calls
  };
  return { root, taskId, taskDir, calls, selectedPr, env };
}

function createFixture(fact: ReturnType<typeof buildUnboundFact> | ReturnType<typeof buildBoundFact> = buildUnboundFact()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-pr-create-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  fs.writeFileSync(path.join(root, 'source.txt'), 'base\n');
  execFileSync('git', ['add', 'source.txt'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const remote = path.join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['remote', 'add', 'aaa', 'https://github.com/fitlab-ai/agent-infra.git'], { cwd: root });
  execFileSync('git', ['config', `url.${remote}.insteadOf`, 'https://github.com/fitlab-ai/agent-infra.git'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:fitlab-ai/agent-infra.git'], { cwd: root });
  execFileSync('git', ['push', '-q', 'aaa', `HEAD:refs/heads/feature`], { cwd: root });
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), '{"platform":{"type":"github"},"delivery":{"remote":"origin","baseRef":"main"}}');
  fs.writeFileSync(path.join(taskDir, 'task.md'), [
    '---', `id: ${taskId}`, 'status: active', 'branch: feature', 'issue_number: 7', 'agent_infra_version: v0.9.12-alpha.0',
    factLine(fact), '---', '', '# Task', '', '## Review Disagreement Ledger', '',
    '| id | stage | round | severity | status | evidence |',
    '|----|-------|-------|----------|--------|----------|', '', '## Activity Log', ''
  ].join('\n'));
  const title = path.join(root, 'title.txt');
  const body = path.join(root, 'body.md');
  const pulls = path.join(root, 'pulls.json');
  const pr = path.join(root, 'pr.json');
  const calls = path.join(root, 'calls.jsonl');
  const counter = path.join(root, 'counter.txt');
  const fake = path.join(root, 'fake-gh.cjs');
  fs.writeFileSync(title, 'feat: create fixture\n');
  fs.writeFileSync(body, 'Body\n');
  fs.writeFileSync(pulls, '[]');
  fs.writeFileSync(pr, JSON.stringify({
    number: 1, node_id: 'PR_1', html_url: 'https://github.com/fitlab-ai/agent-infra/pull/1',
    state: 'open', title: 'Fixture PR', body: 'Body', draft: false,
    head: { ref: 'feature', sha: headSha, repo: { full_name: 'fitlab-ai/agent-infra' } },
    base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: 'fitlab-ai/agent-infra' } },
    merged_at: null, merge_commit_sha: null
  }));
  fs.copyFileSync(filePath('tests/fixtures/validate-artifact/fake-gh.js'), fake);
  const env = {
    AGENT_INFRA_GH_BIN: process.execPath,
    AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([fake]),
    GH_FAKE_PRS_PATH: pulls,
    GH_FAKE_PR_PATH: pr,
    GH_FAKE_ARGS_PATH: calls,
    AGENT_INFRA_PLATFORM_RETRY_DELAYS_MS: '0'
  };
  return { root, taskId, taskDir, headSha, pr, calls, counter, env };
}

test('platform-pr create reports accepted, replay, and uncertain POST outcomes', () => {
  const createdFixture = createFixture();
  try {
    const env = { ...createdFixture.env, GH_FAKE_CREATED_HEAD_SHA: createdFixture.headSha };
    const created = run([
      'create', createdFixture.taskId, '--agent', 'codex', '--base', 'main', '--head', 'feature',
      '--title-file', 'title.txt', '--body-file', 'body.md'
    ], { cwd: createdFixture.root, env });
    assert.equal(created.status, 0, created.stderr || created.stdout);
    assert.deepEqual(JSON.parse(created.stdout).creation, { kind: 'created', createdByCurrentOperation: true });
    const bound = readPrDeliveryFact(parseTypedTaskFrontmatter(fs.readFileSync(path.join(createdFixture.taskDir, 'task.md'), 'utf8')));
    assert.equal(bound.status, 'valid');
    assert.equal(bound.fact.state, 'bound');
    if (bound.fact.state === 'bound') assert.equal(bound.fact.provenance.establishedBy, 'create-post');

    const replay = run([
      'create', createdFixture.taskId, '--agent', 'codex', '--base', 'main', '--head', 'feature',
      '--title-file', 'title.txt', '--body-file', 'body.md'
    ], { cwd: createdFixture.root, env });
    assert.equal(replay.status, 0, replay.stderr || replay.stdout);
    assert.deepEqual(JSON.parse(replay.stdout).creation, { kind: 'no-op', createdByCurrentOperation: false });
  } finally {
    fs.rmSync(createdFixture.root, { recursive: true, force: true });
  }

  const uncertainFixture = createFixture();
  try {
    fs.writeFileSync(uncertainFixture.counter, '1');
    const output = run([
      'create', uncertainFixture.taskId, '--agent', 'codex', '--base', 'main', '--head', 'feature',
      '--title-file', 'title.txt', '--body-file', 'body.md'
    ], {
      cwd: uncertainFixture.root,
      env: {
        ...uncertainFixture.env,
        GH_FAKE_TRANSIENT_FAIL_MATCHER: 'POST',
        GH_FAKE_TRANSIENT_FAIL_COUNTER_FILE: uncertainFixture.counter
      }
    });
    assert.equal(output.status, 2, output.stderr || output.stdout);
    const payload = JSON.parse(output.stdout);
    assert.equal(payload.creation.kind, 'unknown');
    assert.equal(payload.creation.errorCode, 'PR_CREATE_OUTCOME_UNKNOWN');
    const fact = readPrDeliveryFact(parseTypedTaskFrontmatter(fs.readFileSync(path.join(uncertainFixture.taskDir, 'task.md'), 'utf8')));
    assert.equal(fact.status, 'valid');
    assert.equal(fact.fact.state, 'unbound');
  } finally {
    fs.rmSync(uncertainFixture.root, { recursive: true, force: true });
  }
});

test('platform-pr preserves created outcome when post-accepted task binding fails', () => {
  const f = createFixture();
  try {
    const invalidTask = fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8')
      .replace(/## Review Disagreement Ledger[\s\S]*$/, '## Notes\n');
    const output = run([
      'create', f.taskId, '--agent', 'codex', '--base', 'main', '--head', 'feature',
      '--title-file', 'title.txt', '--body-file', 'body.md'
    ], {
      cwd: f.root,
      env: {
        ...f.env,
        GH_FAKE_CREATED_HEAD_SHA: f.headSha,
        GH_FAKE_POST_TASK_PATH: path.join(f.taskDir, 'task.md'),
        GH_FAKE_POST_TASK_CONTENT: invalidTask
      }
    });
    assert.equal(output.status, 1, output.stderr || output.stdout);
    const payload = JSON.parse(output.stdout);
    assert.deepEqual(payload.creation, { kind: 'created', createdByCurrentOperation: true });
    assert.equal(payload.error.code, 'PR_CREATED_BIND_FAILED');
    const fact = readPrDeliveryFact(parseTypedTaskFrontmatter(fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8')));
    assert.equal(fact.status, 'valid');
    assert.equal(fact.fact.state, 'unbound');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('platform-pr bind rejects mismatched task and delivery identities before writing', () => {
  const f = createFixture();
  try {
    fs.writeFileSync(f.pr, JSON.stringify({
      number: 1, node_id: 'PR_1', html_url: 'https://github.com/fitlab-ai/agent-infra/pull/1',
      state: 'open', title: 'Wrong PR', body: '', draft: false,
      head: { ref: 'unrelated-feature', sha: 'a'.repeat(40), repo: { full_name: 'fitlab-ai/agent-infra' } },
      base: { ref: 'release', sha: 'b'.repeat(40), repo: { full_name: 'fitlab-ai/agent-infra' } },
      merged_at: null, merge_commit_sha: null
    }));
    const before = fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8');
    const output = run(['bind', f.taskId, '--agent', 'codex', '--pr', '1'], { cwd: f.root, env: f.env });
    assert.equal(output.status, 1, output.stderr || output.stdout);
    assert.equal(JSON.parse(output.stdout).error.code, 'PR_BIND_IDENTITY_MISMATCH');
    assert.equal(fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8'), before);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('platform-pr bind normalizes a potential merge commit on an open PR', () => {
  const f = createFixture();
  try {
    const pr = JSON.parse(fs.readFileSync(f.pr, 'utf8')) as Record<string, unknown>;
    pr.merge_commit_sha = 'p'.repeat(40);
    fs.writeFileSync(f.pr, JSON.stringify(pr));
    const output = run(['bind', f.taskId, '--agent', 'codex', '--pr', '1'], { cwd: f.root, env: f.env });
    assert.equal(output.status, 0, output.stderr || output.stdout);
    assert.equal(JSON.parse(output.stdout).status, 'applied');
    const fact = readPrDeliveryFact(parseTypedTaskFrontmatter(fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8')));
    assert.equal(fact.status, 'valid');
    assert.equal(fact.fact.state, 'bound');
    if (fact.fact.state === 'bound') {
      assert.equal(fact.fact.binding.remoteState, 'open');
      assert.equal(fact.fact.binding.mergedAt, null);
      assert.equal(fact.fact.binding.mergeCommitSha, null);
    }
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('platform-pr external binding rechecks the selected identity before writing', () => {
  const f = externalFixture('---\nid: {task-id}\nstatus: active\nissue_number: 767\n---\n\n# Task\n\n## Activity Log\n');
  try {
    const before = fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8');
    const selected = JSON.parse(fs.readFileSync(f.selectedPr, 'utf8')) as Record<string, unknown>;
    selected.head = { ref: 'changed-after-selection', sha: 'a'.repeat(40), repo: { full_name: 'contributor/agent-infra' } };
    fs.writeFileSync(f.selectedPr, JSON.stringify(selected));
    const output = run(['resolve-external', f.taskId, '--agent', 'codex'], { cwd: f.root, env: f.env });
    assert.equal(output.status, 1, output.stderr || output.stdout);
    assert.equal(JSON.parse(output.stdout).error.code, 'PR_EXTERNAL_IDENTITY_MISMATCH');
    const fact = readPrDeliveryFact(parseTypedTaskFrontmatter(fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8')));
    assert.equal(fact.status, 'valid');
    assert.equal(fact.fact.state, 'unbound');
    assert.equal(fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8'), before);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

for (const [label, mutation] of [
  ['unmerged', { state: 'open', merged_at: null, merge_commit_sha: null }],
  ['changed merge commit', { merge_commit_sha: 'd'.repeat(40) }]
] as const) {
  test(`platform-pr external binding rejects ${label} merged evidence before writing`, () => {
    const f = externalFixture('---\nid: {task-id}\nstatus: active\nissue_number: 767\n---\n\n# Task\n\n## Activity Log\n');
    try {
      const taskPath = path.join(f.taskDir, 'task.md');
      const before = fs.readFileSync(taskPath, 'utf8');
      const selected = JSON.parse(fs.readFileSync(f.selectedPr, 'utf8')) as Record<string, unknown>;
      Object.assign(selected, mutation);
      fs.writeFileSync(f.selectedPr, JSON.stringify(selected));
      const output = run(['resolve-external', f.taskId, '--agent', 'codex'], { cwd: f.root, env: f.env });
      assert.equal(output.status, 1, output.stderr || output.stdout);
      assert.equal(JSON.parse(output.stdout).error.code, 'PR_EXTERNAL_IDENTITY_MISMATCH');
      assert.equal(fs.readFileSync(taskPath, 'utf8'), before);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });
}

test('platform-pr skip refuses a bound fact without mutation', () => {
  const current = createFixture(buildBoundFact({
    identity: {
      repository: 'fitlab-ai/agent-infra', number: 1, nodeId: 'PR_1',
      url: 'https://github.com/fitlab-ai/agent-infra/pull/1',
      head: { repository: 'fitlab-ai/agent-infra', ref: 'feature', sha: 'a'.repeat(40) },
      base: { repository: 'fitlab-ai/agent-infra', ref: 'main', sha: 'b'.repeat(40) }
    },
    source: 'created', verifiedAt: '2026-01-01T00:00:00.000Z', remoteState: 'open'
  }));
  try {
    const before = fs.readFileSync(path.join(current.taskDir, 'task.md'), 'utf8');
    const conflict = run(['skip', current.taskId, '--agent', 'codex'], { cwd: current.root, env: current.env });
    assert.equal(conflict.status, 1, conflict.stderr || conflict.stdout);
    assert.equal(JSON.parse(conflict.stdout).error.code, 'PR_DELIVERY_FACT_CONFLICT');
    assert.equal(fs.readFileSync(path.join(current.taskDir, 'task.md'), 'utf8'), before);
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('platform-pr skip refuses completed tasks without mutation', () => {
  const f = externalFixture('---\nid: {task-id}\nstatus: active\n---\n\n# Task\n\n## Activity Log\n');
  try {
    const completedDir = path.join(f.root, '.agents', 'workspace', 'completed', f.taskId);
    fs.mkdirSync(path.dirname(completedDir), { recursive: true });
    fs.renameSync(f.taskDir, completedDir);
    const taskPath = path.join(completedDir, 'task.md');
    const before = fs.readFileSync(taskPath, 'utf8');
    const output = run(['skip', f.taskId, '--agent', 'codex'], { cwd: f.root, env: f.env });
    assert.equal(output.status, 1, output.stderr || output.stdout);
    assert.equal(JSON.parse(output.stdout).error.code, 'TASK_STATE_INVALID');
    assert.equal(fs.readFileSync(taskPath, 'utf8'), before);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('platform-pr skip writes and replays the current skipped fact without platform calls', () => {
  const f = externalFixture('---\nid: {task-id}\nstatus: active\n---\n\n# Task\n\n## Activity Log\n');
  try {
    const output = run(['skip', f.taskId, '--agent', 'codex'], { cwd: f.root, env: f.env });
    assert.equal(output.status, 0, output.stderr || output.stdout);
    assert.equal(JSON.parse(output.stdout).status, 'applied');
    const taskPath = path.join(f.taskDir, 'task.md');
    const fact = readPrDeliveryFact(parseTypedTaskFrontmatter(fs.readFileSync(taskPath, 'utf8')));
    assert.equal(fact.status, 'valid');
    if (fact.status === 'valid') {
      assert.equal(fact.fact.state, 'skipped');
      assert.equal(fact.fact.reason, 'explicit');
    }
    const replay = run(['skip', f.taskId, '--agent', 'codex'], { cwd: f.root, env: f.env });
    assert.equal(replay.status, 0, replay.stderr || replay.stdout);
    assert.equal(JSON.parse(replay.stdout).status, 'no-op');
    assert.equal(fs.existsSync(f.calls) ? fs.readFileSync(f.calls, 'utf8').trim() : '', '');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('platform-pr skip dry-run does not mutate the current fact', () => {
  const f = externalFixture('---\nid: {task-id}\nstatus: active\n---\n\n# Task\n\n## Activity Log\n');
  try {
    const taskPath = path.join(f.taskDir, 'task.md');
    const before = fs.readFileSync(taskPath, 'utf8');
    const output = run(['skip', f.taskId, '--agent', 'codex', '--dry-run'], { cwd: f.root, env: f.env });
    assert.equal(output.status, 0, output.stderr || output.stdout);
    assert.equal(JSON.parse(output.stdout).status, 'planned');
    assert.equal(fs.readFileSync(taskPath, 'utf8'), before);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('platform-pr skip refuses required PR policy and missing facts without mutation', () => {
  const required = externalFixture('---\nid: {task-id}\nstatus: active\n---\n\n# Task\n\n## Activity Log\n');
  try {
    fs.writeFileSync(path.join(required.root, '.agents', '.airc.json'), JSON.stringify({ prFlow: 'required' }));
    const taskPath = path.join(required.taskDir, 'task.md');
    const before = fs.readFileSync(taskPath, 'utf8');
    const output = run(['skip', required.taskId, '--agent', 'codex'], { cwd: required.root, env: required.env });
    assert.equal(output.status, 1, output.stderr || output.stdout);
    assert.equal(JSON.parse(output.stdout).error.code, 'PR_SKIP_FORBIDDEN');
    assert.equal(fs.readFileSync(taskPath, 'utf8'), before);
  } finally {
    fs.rmSync(required.root, { recursive: true, force: true });
  }

  const missing = externalFixture('---\nid: {task-id}\nstatus: active\n---\n\n# Task\n\n## Activity Log\n');
  try {
    const taskPath = path.join(missing.taskDir, 'task.md');
    const before = fs.readFileSync(taskPath, 'utf8').replace(/^pr_delivery_fact:.*\n/m, '');
    fs.writeFileSync(taskPath, before);
    const output = run(['skip', missing.taskId, '--agent', 'codex'], { cwd: missing.root, env: missing.env });
    assert.equal(output.status, 1, output.stderr || output.stdout);
    assert.equal(JSON.parse(output.stdout).error.code, 'PR_DELIVERY_FACT_MISSING');
    assert.equal(fs.readFileSync(taskPath, 'utf8'), before);
  } finally {
    fs.rmSync(missing.root, { recursive: true, force: true });
  }
});

test('platform-pr resolve-external preserves normal tasks and fails explicitly when an empty inventory lacks an Issue', () => {
  const withArtifact = externalFixture('---\nid: {task-id}\nstatus: active\n---\n\n# Task\n\n## Activity Log\n');
  try {
    fs.writeFileSync(path.join(withArtifact.taskDir, 'analysis.md'), '# analysis\n');
    const normal = run(['resolve-external', withArtifact.taskId, '--agent', 'codex'], { cwd: withArtifact.root, env: withArtifact.env });
    assert.equal(normal.status, 0, normal.stderr || normal.stdout);
    assert.equal(JSON.parse(normal.stdout).mode, 'normal');
    const calls = fs.readFileSync(withArtifact.calls, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.some((call) => call.some((arg) => arg.includes('closedByPullRequestsReferences'))), false);
  } finally {
    fs.rmSync(withArtifact.root, { recursive: true, force: true });
  }

  const withoutIssue = externalFixture('---\nid: {task-id}\nstatus: active\n---\n\n# Task\n\n## Activity Log\n');
  try {
    const failed = run(['resolve-external', withoutIssue.taskId, '--agent', 'codex'], { cwd: withoutIssue.root, env: withoutIssue.env });
    assert.equal(failed.status, 1);
    assert.equal(JSON.parse(failed.stdout).error.code, 'EXTERNAL_DELIVERY_ISSUE_REQUIRED');
  } finally {
    fs.rmSync(withoutIssue.root, { recursive: true, force: true });
  }
});

test('platform-pr resolve-external paginates, binds one merged fork PR, audits evidence, and replays idempotently', () => {
  const f = externalFixture('---\nid: {task-id}\nstatus: active\nissue_number: 767\n---\n\n# Task\n\n## Activity Log\n');
  try {
    const args = ['resolve-external', f.taskId, '--agent', 'codex'];
    const first = run(args, { cwd: f.root, env: f.env });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstResult = JSON.parse(first.stdout);
    assert.equal(firstResult.mode, 'external');
    assert.equal(firstResult.authorization, 'unique');
    assert.equal(firstResult.selected.number, 771);
    const content = fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8');
    const fact = readPrDeliveryFact(parseTypedTaskFrontmatter(content));
    assert.equal(fact.status, 'valid');
    assert.equal(fact.fact.state, 'bound');
    assert.equal(fact.fact.identity.number, 771);
    assert.equal((content.match(/\*\*Bind External PR\*\*/g) || []).length, 1);

    const replay = run(['resolve-external', f.taskId, '--agent', 'claude'], { cwd: f.root, env: f.env });
    assert.equal(replay.status, 0, replay.stderr || replay.stdout);
    assert.equal(JSON.parse(replay.stdout).status, 'no-op');
    const replayContent = fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8');
    assert.equal((replayContent.match(/\*\*Bind External PR\*\*/g) || []).length, 1);

    const explicitReplay = run(['resolve-external', f.taskId, '--agent', 'codex', '--pr', '771'], { cwd: f.root, env: f.env });
    assert.equal(explicitReplay.status, 0, explicitReplay.stderr || explicitReplay.stdout);
    assert.equal(JSON.parse(explicitReplay.stdout).status, 'no-op');
    const explicitReplayContent = fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8');
    assert.equal((explicitReplayContent.match(/\*\*Bind External PR\*\*/g) || []).length, 1);

    const calls = fs.readFileSync(f.calls, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.filter((call) => call.some((arg) => arg.includes('closedByPullRequestsReferences'))).length, 6);
    assert.equal(calls.some((call) => call.includes('POST') && call.some((arg) => /\/pulls$/.test(arg))), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('platform-pr create refuses to locate or create a PR before remote branch delivery', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-pr-cli-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    fs.writeFileSync(path.join(root, 'source.txt'), 'base\n');
    execFileSync('git', ['add', 'source.txt'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    const remote = path.join(root, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:fitlab-ai/agent-infra.git'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'aaa', 'https://github.com/fitlab-ai/agent-infra.git'], { cwd: root });
    execFileSync('git', ['config', `url.${remote}.insteadOf`, 'https://github.com/fitlab-ai/agent-infra.git'], { cwd: root });
    const taskId = 'TASK-20260101-000001';
    const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', '.airc.json'), '{"platform":{"type":"github"},"delivery":{"remote":"origin","baseRef":"main"}}');
    fs.writeFileSync(path.join(taskDir, 'task.md'), [
      '---', `id: ${taskId}`, 'type: feature', 'status: active', 'issue_number: 7', factLine(buildUnboundFact()), '---', '',
      '# Task', '', '## Activity Log', ''
    ].join('\n'));
    const title = path.join(root, 'title.txt');
    const body = path.join(root, 'body.md');
    const pulls = path.join(root, 'pulls.json');
    const calls = path.join(root, 'calls.jsonl');
    const fake = path.join(root, 'fake-gh.cjs');
    fs.writeFileSync(title, 'feat: create adapter\n');
    fs.writeFileSync(body, 'Body\n\nCloses #7\n');
    fs.writeFileSync(pulls, '[]');
    fs.copyFileSync(filePath('tests/fixtures/validate-artifact/fake-gh.js'), fake);
    const env = {
      AGENT_INFRA_GH_BIN: process.execPath,
      AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([fake]),
      GH_FAKE_PRS_PATH: pulls,
      GH_FAKE_ARGS_PATH: calls
    };
    const args = ['create', taskId, '--agent', 'codex', '--base', 'main', '--head', 'feature', '--title-file', title, '--body-file', body];
    const created = run(args, { cwd: root, env });
    assert.equal(created.status, 1, `${created.stderr}\n${created.stdout}`);
    assert.equal(JSON.parse(created.stdout).error.code, 'PR_REMOTE_BRANCH_MISSING');
    const records = fs.readFileSync(calls, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line) as string[]);
    assert.equal(records.filter((call) => call.includes('POST') && call.some((item) => /\/pulls$/.test(item))).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('platform-pr create rechecks a bound PR before replaying it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-pr-bound-replay-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    fs.writeFileSync(path.join(root, 'source.txt'), 'base\n');
    execFileSync('git', ['add', 'source.txt'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    const remote = path.join(root, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:fitlab-ai/agent-infra.git'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'aaa', 'https://github.com/fitlab-ai/agent-infra.git'], { cwd: root });
    execFileSync('git', ['config', `url.${remote}.insteadOf`, 'https://github.com/fitlab-ai/agent-infra.git'], { cwd: root });
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const taskId = 'TASK-20260101-000001';
    const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', '.airc.json'), '{"platform":{"type":"github"},"delivery":{"remote":"origin","baseRef":"main"}}');
    fs.writeFileSync(path.join(taskDir, 'task.md'), [
      '---', `id: ${taskId}`, 'type: feature', 'status: active', 'issue_number: 7',
      factLine(boundFixture(771, headSha)), '---', '', '# Task', '', '## Activity Log', ''
    ].join('\n'));
    const title = path.join(root, 'title.txt');
    const body = path.join(root, 'body.md');
    const pr = path.join(root, 'pr.json');
    const calls = path.join(root, 'calls.jsonl');
    const fake = path.join(root, 'fake-gh.cjs');
    fs.writeFileSync(title, 'feat: replay bound PR\n');
    fs.writeFileSync(body, 'Body\n');
    fs.writeFileSync(pr, JSON.stringify({
      number: 771, node_id: 'PR_771', html_url: 'https://github.com/fitlab-ai/agent-infra/pull/771',
      state: 'open', head: { ref: 'feature', sha: headSha, repo: { full_name: 'fitlab-ai/agent-infra' } },
      base: { ref: 'main', sha: 'base-sha', repo: { full_name: 'fitlab-ai/agent-infra' } }
    }));
    fs.copyFileSync(filePath('tests/fixtures/validate-artifact/fake-gh.js'), fake);
    const env = {
      AGENT_INFRA_GH_BIN: process.execPath,
      AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([fake]),
      GH_FAKE_PR_PATH: pr,
      GH_FAKE_ARGS_PATH: calls
    };
    const replay = run([
      'create', taskId, '--agent', 'codex', '--base', 'main', '--head', 'feature',
      '--title-file', title, '--body-file', body
    ], { cwd: root, env });
    assert.equal(replay.status, 1, `${replay.stderr}\n${replay.stdout}`);
    assert.equal(JSON.parse(replay.stdout).error.code, 'PR_REMOTE_BRANCH_MISSING');
    assert.equal((fs.readFileSync(calls, 'utf8').match(/pulls\/771/g) || []).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('platform-pr create does not require commit finalization evidence before remote validation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-pr-gate-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    fs.writeFileSync(path.join(root, 'source.txt'), 'base\n');
    execFileSync('git', ['add', 'source.txt'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    const remote = path.join(root, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:fitlab-ai/agent-infra.git'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'aaa', 'https://github.com/fitlab-ai/agent-infra.git'], { cwd: root });
    execFileSync('git', ['config', `url.${remote}.insteadOf`, 'https://github.com/fitlab-ai/agent-infra.git'], { cwd: root });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const taskId = 'TASK-20260101-000001';
    const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', '.airc.json'), '{"platform":{"type":"github"},"delivery":{"remote":"origin","baseRef":"main"}}');
    fs.writeFileSync(path.join(taskDir, 'task.md'), [
      '---', `id: ${taskId}`, 'type: feature', 'status: active', 'issue_number: 7', factLine(buildUnboundFact()), '---', '',
      '# Task', '', '## Activity Log', '',
      '- 2026-01-01 00:00:00+00:00 — **Commit [started]** by codex — started', ''
    ].join('\n'));
    fs.writeFileSync(path.join(taskDir, 'review-code.md'), [
      '# Review', '', '## Review Summary', '',
      '- **Overall Verdict**: Approved',
      '- **Findings (AI-actionable)**: 0 blockers, 0 major, 0 minor / **Manual-validation**: 0', ''
    ].join('\n'));
    const title = path.join(root, 'title.txt');
    const body = path.join(root, 'body.md');
    const pulls = path.join(root, 'pulls.json');
    const calls = path.join(root, 'calls.jsonl');
    const fake = path.join(root, 'fake-gh.cjs');
    fs.writeFileSync(title, 'feat: blocked\n');
    fs.writeFileSync(body, 'Body\n');
    fs.writeFileSync(pulls, '[]');
    fs.copyFileSync(filePath('tests/fixtures/validate-artifact/fake-gh.js'), fake);
    const env = {
      AGENT_INFRA_GH_BIN: process.execPath,
      AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([fake]),
      GH_FAKE_PRS_PATH: pulls,
      GH_FAKE_ARGS_PATH: calls
    };

    const created = run([
      'create', taskId, '--agent', 'codex', '--base', 'main', '--head', 'feature',
      '--title-file', title, '--body-file', body
    ], { cwd: root, env });
    assert.equal(created.status, 1, created.stderr || created.stdout);
    const payload = JSON.parse(created.stdout);
    assert.equal(payload.status, 'failed');
    assert.equal(payload.error.code, 'PR_REMOTE_BRANCH_MISSING');
    const records = fs.readFileSync(calls, 'utf8').trim().split(/\r?\n/).filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(records.filter((call) => call.includes('POST') && call.some((item) => /\/pulls$/.test(item))).length, 0);
    const task = fs.readFileSync(path.join(taskDir, 'task.md'), 'utf8');
    assert.equal(task.includes('Create PR [started]'), false);
    assert.equal(JSON.parse(JSON.parse((task.match(/^pr_delivery_fact: (.+)$/m) || [])[1] || '"{}"')).state, 'unbound');

    const lockBusy = withTaskExecutionLock(root, taskId, 'test-holder', () => run([
      'create', taskId, '--agent', 'codex', '--base', 'main', '--head', 'feature',
      '--title-file', title, '--body-file', body
    ], { cwd: root, env }));
    assert.equal(lockBusy.status, 2, lockBusy.stderr || lockBusy.stdout);
    assert.equal(JSON.parse(lockBusy.stdout).error.code, 'ORCHESTRATION_LOCK_BUSY');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('platform-pr CLI rejects incomplete and conflicting payloads before I/O', () => {
  for (const args of [
    ['create', 'TASK-1', '--agent', 'codex'],
    ['bind', 'TASK-1', '--agent', 'codex'],
    ['resolve-external', 'TASK-1'],
    ['sync', 'TASK-1', '--agent', 'codex'],
    ['summary-sync', 'TASK-1', '--agent', 'codex']
  ]) {
    const output = run(args);
    assert.equal(output.status, 1, `${args.join(' ')}\n${output.stdout}\n${output.stderr}`);
    assert.equal(JSON.parse(output.stdout).error.code, 'PR_PAYLOAD_INVALID');
  }
});
