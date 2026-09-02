import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  inspectPlatformPullRequestByNumber,
  inspectGitHubIssueClosingChangeRequests,
  normalizePullRequest,
  resolveGitHubChangeRequestGitEvidence,
  selectExternalPullRequest,
  selectPullRequest,
  syncPlatformPullRequest,
  syncPlatformPullRequestInLabels,
  warningResultForPrimary
} from '../../../lib/platform/pull-requests.ts';
import type { GitHubClient, RequestOptions } from '../../../lib/platform/github-client.ts';
import { buildBoundFact, encodePrDeliveryFact } from '../../../lib/task/pr-delivery-fact.ts';

const remote = (number: number, head = 'feature', base = 'main') => ({
  number,
  node_id: `PR_${number}`,
  html_url: `https://github.com/o/r/pull/${number}`,
  state: 'open',
  title: 'Title',
  body: 'Body',
  draft: false,
  head: { ref: head, sha: `sha-${number}`, repo: { full_name: 'o/r' } },
  base: { ref: base, sha: `base-${number}`, repo: { full_name: 'o/r' } },
  labels: [{ name: 'type: feature' }],
  assignees: [{ login: 'codex' }],
  milestone: { title: '1.0.0' }
});

test('PR identity normalization retains canonical remote facts', () => {
  assert.deepEqual(normalizePullRequest(remote(7), 'o/r'), {
    repository: 'o/r', number: 7, nodeId: 'PR_7', url: 'https://github.com/o/r/pull/7',
    state: 'open', title: 'Title', body: 'Body', draft: false,
    head: { repository: 'o/r', ref: 'feature', sha: 'sha-7' },
    base: { repository: 'o/r', ref: 'main', sha: 'base-7' },
    mergedAt: null, mergeCommitSha: null,
    labels: ['type: feature'], assignees: ['codex'], milestone: '1.0.0',
    mergeability: { state: 'unknown', detail: null }
  });
});

test('PR warning result preserves the primary lifecycle outcome', () => {
  assert.equal(warningResultForPrimary('pr_created'), 'pr_created_with_warnings');
  assert.equal(warningResultForPrimary('pr_reused'), 'pr_reused_with_warnings');
  assert.equal(warningResultForPrimary('no_op'), 'no_op_with_warnings');
});

test('PR identity normalization retains authoritative merge facts', () => {
  const merged = { ...remote(8), state: 'closed', merged_at: '2026-07-25T00:00:00Z', merge_commit_sha: 'merge-8' };
  const normalized = normalizePullRequest(merged, 'o/r');
  assert.equal(normalized?.state, 'closed');
  assert.equal(normalized?.base.sha, 'base-8');
  assert.equal(normalized?.mergedAt, '2026-07-25T00:00:00Z');
  assert.equal(normalized?.mergeCommitSha, 'merge-8');
});

test('PR mergeability normalization fails closed on missing and contradictory facts', () => {
  assert.deepEqual(normalizePullRequest({ ...remote(9), mergeable: false, mergeable_state: ' DIRTY ' }, 'o/r')?.mergeability, {
    state: 'conflicting', detail: 'dirty'
  });
  assert.deepEqual(normalizePullRequest({ ...remote(9), mergeable: true, mergeable_state: 'dirty' }, 'o/r')?.mergeability, {
    state: 'unknown', detail: 'dirty'
  });
  assert.deepEqual(normalizePullRequest({ ...remote(9), mergeable: true, mergeable_state: 'BLOCKED' }, 'o/r')?.mergeability, {
    state: 'mergeable', detail: 'blocked'
  });
  assert.deepEqual(normalizePullRequest({ ...remote(9), mergeable: null }, 'o/r')?.mergeability, {
    state: 'unknown', detail: null
  });
  assert.deepEqual(normalizePullRequest(remote(9), 'o/r')?.mergeability, {
    state: 'unknown', detail: null
  });
});

function prByNumberFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-by-number-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:o/r.git'], { cwd: root });
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), '{"platform":{"type":"github"}}');
  return root;
}

function mockPrByNumberClient(pullRequest: unknown): GitHubClient {
  return {
    version() { return { ok: true, value: '2.72.0' }; },
    json(args: string[]) {
      const joined = args.join(' ');
      if (/api repos\/o\/r\/pulls\/42/.test(joined)) return { ok: true, value: pullRequest };
      if (args[1] === 'graphql' && args.some((arg) => arg.includes('viewer { login }'))) {
        return { ok: true, value: { data: { viewer: { login: 'codex' } } } };
      }
      if (args[0] === 'api' && /^repos\/[^/]+\/[^/]+$/.test(args[1] || '')) {
        return { ok: true, value: { full_name: 'o/r', fork: false, permissions: { triage: true, push: true, admin: false } } };
      }
      return { ok: false, error: { code: 'PLATFORM_REQUEST_FAILED', message: joined, retryable: false } };
    },
    text() { return { ok: true, value: '' }; }
  } as unknown as GitHubClient;
}

test('inspectPlatformPullRequestByNumber reads a bare PR number without a task binding', async () => {
  const root = prByNumberFixture();
  try {
    const result = await inspectPlatformPullRequestByNumber(42, { cwd: root, client: mockPrByNumberClient(remote(42)) });
    assert.equal(result.status, 'no-op');
    assert.equal(result.pullRequest?.number, 42);
    assert.equal(result.pullRequest?.head.sha, 'sha-42');
    assert.equal(result.pullRequest?.base.sha, 'base-42');
    assert.equal(result.task.id, null, 'bare-PR inspection must not require a task binding');
    assert.equal(result.task.prNumber, 42);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('in-label PR sync derives one target from PR files, updates Issue before PR, and re-reads both', () => {
  const root = prByNumberFixture();
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({
    platform: { type: 'github' }, labels: { in: { core: ['lib/'] } }
  }));
  let issueLabels = ['in: stale', 'keep'];
  let prLabels = ['in: stale', 'type: feature'];
  const calls: string[] = [];
  const client: GitHubClient = {
    version() { return { ok: true, value: '2.72.0' }; },
    json(args: string[], options: RequestOptions = {}) {
      const joined = args.join(' ');
      calls.push(joined);
      if (args[1] === 'graphql' && args.some((arg) => arg.includes('viewer { login }'))) {
        return { ok: true, value: { data: { viewer: { login: 'codex' } } } };
      }
      if (args[0] === 'api' && args[1] === 'repos/o/r') {
        return { ok: true, value: { full_name: 'o/r', fork: false, permissions: { triage: true, push: true, admin: false } } };
      }
      if (/pulls\/42$/.test(args[1] || '')) return { ok: true, value: { ...remote(42), labels: prLabels.map((name) => ({ name })) } };
      const endpoint = args.find((arg) => arg.startsWith('repos/')) || '';
      if (/pulls\/42\/files\?/.test(endpoint)) return { ok: true, value: [[{ filename: 'lib/core.ts' }]] };
      if (/labels\?per_page=100$/.test(endpoint)) return { ok: true, value: [[{ name: 'in: core' }, { name: 'in: stale' }]] };
      if (args[1] === 'graphql' && args.some((arg) => arg.includes('closingIssuesReferences'))) {
        return { ok: true, value: { data: { repository: { pullRequest: {
          closingIssuesReferences: { nodes: [{ number: 7 }], pageInfo: { hasNextPage: false, endCursor: null } }
        } } } } };
      }
      if (/issues\/7$/.test(args[1] || '')) return { ok: true, value: {
        number: 7, id: 70, node_id: 'I_7', html_url: 'https://github.com/o/r/issues/7', state: 'open', title: 'Issue', body: '',
        labels: issueLabels.map((name) => ({ name })), assignees: [], milestone: null
      } };
      if (args.includes('DELETE') && /issues\/(7|42)\/labels\//.test(endpoint)) {
        const name = decodeURIComponent(endpoint.split('/labels/')[1]!);
        if (endpoint.includes('/issues/7/')) issueLabels = issueLabels.filter((label) => label !== name);
        else prLabels = prLabels.filter((label) => label !== name);
        return { ok: true, value: {} };
      }
      if (args.includes('POST') && /issues\/(7|42)\/labels$/.test(endpoint)) {
        const labels = JSON.parse(options.input || '{}').labels as string[];
        if (endpoint.includes('/issues/7/')) issueLabels.push(...labels);
        else prLabels.push(...labels);
        return { ok: true, value: {} };
      }
      return { ok: false, error: { code: 'PLATFORM_REQUEST_FAILED', message: joined, retryable: false } };
    },
    text() { return { ok: true, value: '' }; }
  } as unknown as GitHubClient;
  try {
    const result = syncPlatformPullRequestInLabels(42, { cwd: root, client });
    assert.equal(result.status, 'applied', JSON.stringify({ error: result.error, operations: result.operations, resources: result.resources, calls }));
    assert.deepEqual([...issueLabels].sort(), ['in: core', 'keep']);
    assert.deepEqual([...prLabels].sort(), ['in: core', 'type: feature']);
    assert.ok(calls.findIndex((call) => /issues\/7\/labels/.test(call)) < calls.findIndex((call) => /issues\/42\/labels/.test(call)));
    assert.deepEqual(result.evidence?.pullRequestFiles, ['lib/core.ts']);
    assert.deepEqual(result.resources?.map((resource) => resource.effect), ['applied', 'applied']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function prOnlyInLabelFixture(closingIssues: number[], fixtureOptions: { failPullRequestWrite?: boolean; failPullRequestDeterministic?: boolean; injectConcurrentUnrelatedLabel?: boolean; prLabels?: string[] } = {}) {
  const root = prByNumberFixture();
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({
    platform: { type: 'github' }, labels: { in: { core: ['lib/'] } }
  }));
  let issueLabels = ['in: stale', 'keep'];
  let prLabels = fixtureOptions.prLabels || ['in: stale', 'type: feature'];
  const calls: string[] = [];
  const client: GitHubClient = {
    version() { return { ok: true, value: '2.72.0' }; },
    json(args: string[], request: RequestOptions = {}) {
      const joined = args.join(' ');
      calls.push(joined);
      if (args[1] === 'graphql' && args.some((arg) => arg.includes('viewer { login }'))) {
        return { ok: true, value: { data: { viewer: { login: 'codex' } } } };
      }
      if (args[0] === 'api' && args[1] === 'repos/o/r') {
        return { ok: true, value: { full_name: 'o/r', fork: false, permissions: { triage: true, push: true, admin: false } } };
      }
      if (/pulls\/42$/.test(args[1] || '')) return { ok: true, value: { ...remote(42), labels: prLabels.map((name) => ({ name })) } };
      const endpoint = args.find((arg) => arg.startsWith('repos/')) || '';
      if (/pulls\/42\/files\?/.test(endpoint)) return { ok: true, value: [[{ filename: 'lib/core.ts' }]] };
      if (/labels\?per_page=100$/.test(endpoint)) return { ok: true, value: [[{ name: 'in: core' }, { name: 'in: stale' }]] };
      if (args[1] === 'graphql' && args.some((arg) => arg.includes('closingIssuesReferences'))) {
        return { ok: true, value: { data: { repository: { pullRequest: {
          closingIssuesReferences: { nodes: closingIssues.map((number) => ({ number })), pageInfo: { hasNextPage: false, endCursor: null } }
        } } } } };
      }
      if (/issues\/7$/.test(args[1] || '')) return { ok: true, value: {
        number: 7, id: 70, node_id: 'I_7', html_url: 'https://github.com/o/r/issues/7', state: 'open', title: 'Issue', body: '',
        labels: issueLabels.map((name) => ({ name })), assignees: [], milestone: null
      } };
      if (args.includes('DELETE') && /issues\/(7|42)\/labels\//.test(endpoint)) {
        if (fixtureOptions.injectConcurrentUnrelatedLabel && endpoint.includes('/issues/42/') && !prLabels.includes('unrelated: concurrent')) {
          prLabels.push('unrelated: concurrent');
        }
        const name = decodeURIComponent(endpoint.split('/labels/')[1]!);
        if (endpoint.includes('/issues/7/')) issueLabels = issueLabels.filter((label) => label !== name);
        else prLabels = prLabels.filter((label) => label !== name);
        return { ok: true, value: {} };
      }
      if (args.includes('POST') && /issues\/(7|42)\/labels$/.test(endpoint)) {
        if (fixtureOptions.failPullRequestWrite && endpoint.includes('/issues/42/')) {
          return fixtureOptions.failPullRequestDeterministic
            ? { ok: false, error: { code: 'PLATFORM_REQUEST_INVALID', message: 'label rejected', retryable: false } }
            : { ok: false, error: { code: 'NETWORK_TRANSIENT', message: 'network timeout', retryable: true } };
        }
        const labels = JSON.parse(request.input || '{}').labels as string[];
        if (endpoint.includes('/issues/7/')) issueLabels.push(...labels);
        else prLabels.push(...labels);
        return { ok: true, value: {} };
      }
      return { ok: false, error: { code: 'PLATFORM_REQUEST_FAILED', message: joined, retryable: false } };
    },
    text() { return { ok: true, value: '' }; }
  } as unknown as GitHubClient;
  return { root, client, calls, getPrLabels: () => prLabels, getIssueLabels: () => issueLabels };
}

function boundPullRequestFixture(options: { milestoneFailure?: boolean; failPullRequestLabel?: boolean; prLabels?: string[] } = {}) {
  const root = prByNumberFixture();
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
  execFileSync('git', ['add', 'base.txt'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'lib', 'core.ts'), 'change\n');
  execFileSync('git', ['add', 'lib/core.ts'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'change'], { cwd: root });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({
    platform: { type: 'github' }, labels: { in: { core: ['lib/'] } }
  }));
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const fact = buildBoundFact({
    identity: {
      repository: 'o/r', number: 42, nodeId: 'PR_42', url: 'https://github.com/o/r/pull/42',
      head: { repository: 'o/r', ref: 'feature', sha: 'sha-42' },
      base: { repository: 'o/r', ref: 'main', sha: 'base-42' }
    }, source: 'created', verifiedAt: '2026-01-01T00:00:00.000Z', remoteState: 'open', issueNumber: 7
  });
  fs.writeFileSync(path.join(taskDir, 'task.md'), [
    '---', `id: ${taskId}`, 'type: feature', 'status: active', 'issue_number: 7',
    'delivery_base_ref: HEAD~1', `pr_delivery_fact: ${JSON.stringify(encodePrDeliveryFact(fact))}`, '---', ''
  ].join('\n'));
  let issueLabels = ['in: stale', 'keep'];
  let prLabels = options.prLabels || ['in: stale', 'type: feature'];
  let prBody = 'Body';
  const issueMilestone = options.milestoneFailure ? '1.0.1' : '1.0.0';
  const writes: string[] = [];
  const client: GitHubClient = {
    version() { return { ok: true, value: '2.72.0' }; },
    json(args: string[], request: RequestOptions = {}) {
      const endpoint = args.find((arg) => arg.startsWith('repos/')) || '';
      if (args[1] === 'graphql' && args.some((arg) => arg.includes('viewer { login }'))) {
        return { ok: true, value: { data: { viewer: { login: 'codex' } } } };
      }
      if (args[0] === 'api' && args[1] === 'repos/o/r') {
        return { ok: true, value: { full_name: 'o/r', fork: false, permissions: { triage: true, push: false, admin: false } } };
      }
      if (/pulls\/42$/.test(args[1] || '')) return { ok: true, value: { ...remote(42), body: prBody, labels: prLabels.map((name) => ({ name })) } };
      if (/labels\?per_page=100$/.test(endpoint)) return { ok: true, value: [[{ name: 'in: core' }, { name: 'in: stale' }]] };
      if (/issues\/7$/.test(args[1] || '')) return { ok: true, value: {
        number: 7, id: 70, node_id: 'I_7', html_url: 'https://github.com/o/r/issues/7', state: 'open', title: 'Issue', body: '',
        labels: issueLabels.map((name) => ({ name })), assignees: [{ login: 'codex' }], milestone: { title: issueMilestone }
      } };
      if (/milestones\?state=open/.test(endpoint)) {
        if (options.milestoneFailure) return { ok: false, error: { code: 'NETWORK_TRANSIENT', message: 'milestone lookup failed', retryable: true } };
        return { ok: true, value: [[{ title: '1.0.0', number: 100 }, { title: '1.0.1', number: 101 }]] };
      }
      if (args.includes('DELETE') && /issues\/(7|42)\/labels\//.test(endpoint)) {
        const name = decodeURIComponent(endpoint.split('/labels/')[1]!);
        if (endpoint.includes('/issues/7/')) issueLabels = issueLabels.filter((label) => label !== name);
        else prLabels = prLabels.filter((label) => label !== name);
        writes.push(`DELETE ${endpoint}`);
        return { ok: true, value: {} };
      }
      if (args.includes('POST') && /issues\/(7|42)\/labels$/.test(endpoint)) {
        if (options.failPullRequestLabel && endpoint.includes('/issues/42/')) {
          writes.push(`POST ${endpoint}`);
          return { ok: false, error: { code: 'PLATFORM_REQUEST_INVALID', message: 'label rejected', retryable: false } };
        }
        const labels = JSON.parse(request.input || '{}').labels as string[];
        if (endpoint.includes('/issues/7/')) issueLabels.push(...labels);
        else prLabels.push(...labels);
        writes.push(`POST ${endpoint}`);
        return { ok: true, value: {} };
      }
      if (args.includes('PATCH') && /issues\/42$/.test(endpoint)) {
        writes.push(`PATCH ${endpoint}`);
        const payload = JSON.parse(request.input || '{}') as { body?: string };
        if (payload.body !== undefined) prBody = payload.body;
        return { ok: true, value: {} };
      }
      return { ok: false, error: { code: 'PLATFORM_REQUEST_FAILED', message: args.join(' '), retryable: false } };
    },
    text() { return { ok: true, value: '' }; }
  } as unknown as GitHubClient;
  return { root, taskId, client, writes, getIssueLabels: () => issueLabels, getPrLabels: () => prLabels };
}

test('task-bound PR sync reads milestone prerequisites before writing Issue labels', () => {
  const fixture = boundPullRequestFixture({ milestoneFailure: true });
  try {
    const result = syncPlatformPullRequest(fixture.taskId, {
      cwd: fixture.root, agent: 'codex', metadata: true, primaryResult: 'no_op', client: fixture.client
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.error?.code, 'NETWORK_TRANSIENT');
    assert.deepEqual(fixture.writes, []);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('task-bound PR sync blocks with partial evidence on a nonretryable PR label failure', () => {
  const fixture = boundPullRequestFixture({ failPullRequestLabel: true, prLabels: ['type: feature'] });
  try {
    const result = syncPlatformPullRequest(fixture.taskId, {
      cwd: fixture.root, agent: 'codex', metadata: true, primaryResult: 'no_op', client: fixture.client
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.error?.code, 'IN_LABEL_SYNC_PARTIAL');
    assert.equal(result.changed, true);
    assert.deepEqual(fixture.getIssueLabels().sort(), ['in: core', 'keep']);
    assert.deepEqual(fixture.getPrLabels(), ['type: feature']);
    assert.equal(result.warnings?.length, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('task-bound PR metadata and in-label sync replay as no-op after convergence', () => {
  const fixture = boundPullRequestFixture();
  try {
    const first = syncPlatformPullRequest(fixture.taskId, {
      cwd: fixture.root, agent: 'codex', metadata: true, primaryResult: 'no_op', client: fixture.client
    });
    assert.equal(first.status, 'applied', JSON.stringify({ error: first.error, writes: fixture.writes }));
    const writes = fixture.writes.length;
    const second = syncPlatformPullRequest(fixture.taskId, {
      cwd: fixture.root, agent: 'codex', metadata: true, primaryResult: 'no_op', client: fixture.client
    });
    assert.equal(second.status, 'no-op');
    assert.equal(fixture.writes.length, writes);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('in-label PR sync updates only the PR when no unique closing Issue exists', () => {
  for (const closingIssues of [[], [7, 8]]) {
    const fixture = prOnlyInLabelFixture(closingIssues);
    try {
      const result = syncPlatformPullRequestInLabels(42, { cwd: fixture.root, client: fixture.client });
      assert.equal(result.status, 'degraded');
      assert.deepEqual([...fixture.getPrLabels()].sort(), ['in: core', 'type: feature']);
      assert.equal(fixture.calls.some((call) => /issues\/7|issues\/8/.test(call)), false);
      assert.equal(result.resources?.length, 1);
      assert.equal(result.resources?.[0]?.kind, 'pull-request');
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('in-label PR sync blocks with partial evidence when the PR write is uncertain after Issue convergence', () => {
  const fixture = prOnlyInLabelFixture([7], { failPullRequestWrite: true });
  try {
    const result = syncPlatformPullRequestInLabels(42, { cwd: fixture.root, client: fixture.client });
    assert.equal(result.status, 'blocked');
    assert.equal(result.error?.code, 'IN_LABEL_SYNC_PARTIAL');
    assert.deepEqual([...fixture.getIssueLabels()].sort(), ['in: core', 'keep']);
    assert.deepEqual(result.resources?.map((resource) => resource.effect), ['applied', 'unknown']);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('in-label PR sync upgrades a deterministic PR failure after Issue convergence to partial', () => {
  const fixture = prOnlyInLabelFixture([7], {
    failPullRequestWrite: true, failPullRequestDeterministic: true, prLabels: ['type: feature']
  });
  try {
    const result = syncPlatformPullRequestInLabels(42, { cwd: fixture.root, client: fixture.client });
    assert.equal(result.status, 'blocked');
    assert.equal(result.error?.code, 'IN_LABEL_SYNC_PARTIAL');
    assert.equal(result.changed, true);
    assert.deepEqual([...fixture.getIssueLabels()].sort(), ['in: core', 'keep']);
    assert.deepEqual(fixture.getPrLabels(), ['type: feature']);
    assert.deepEqual(result.resources?.map((resource) => resource.effect), ['applied', 'no-op']);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('in-label PR sync preserves an unrelated label added after the initial read', () => {
  const fixture = prOnlyInLabelFixture([], { injectConcurrentUnrelatedLabel: true });
  try {
    const result = syncPlatformPullRequestInLabels(42, { cwd: fixture.root, client: fixture.client });
    assert.equal(result.status, 'degraded');
    assert.deepEqual([...fixture.getPrLabels()].sort(), ['in: core', 'type: feature', 'unrelated: concurrent']);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('PR selection fails closed for zero or multiple exact head/base matches', () => {
  assert.deepEqual(selectPullRequest([remote(1), remote(2, 'other')], 'o/r', 'feature', 'main'), {
    status: 'resolved', pullRequest: normalizePullRequest(remote(1), 'o/r')
  });
  assert.equal(selectPullRequest([], 'o/r', 'feature', 'main').status, 'missing');
  assert.equal(selectPullRequest([remote(1), remote(2)], 'o/r', 'feature', 'main').status, 'ambiguous');
});

test('external PR selection filters before uniqueness and accepts a merged fork PR', () => {
  const merged = normalizePullRequest({
    ...remote(7), state: 'closed', merged_at: '2026-07-25T00:00:00Z', merge_commit_sha: 'merge-7',
    head: { ...remote(7).head, repo: { full_name: 'contributor/r' } }
  }, 'o/r')!;
  const unmerged = normalizePullRequest(remote(8), 'o/r')!;
  const otherRepository = { ...merged, number: 9, nodeId: 'PR_9', base: { ...merged.base, repository: 'other/r' } };
  const result = selectExternalPullRequest([unmerged, otherRepository, merged], 'O/R', null, null);
  assert.equal(result.status, 'selected');
  if (result.status !== 'selected') throw new Error('expected selected result');
  assert.equal(result.source, 'unique');
  assert.equal(result.selected?.number, 7);
  assert.deepEqual(result.eligible.map((item) => item.number), [7]);
});

test('external PR identity accepts a potential merge commit on an open PR', () => {
  const open = normalizePullRequest({ ...remote(10), merge_commit_sha: 'potential-10' }, 'o/r')!;
  const result = selectExternalPullRequest([open], 'o/r', null, null);
  assert.equal(result.status, 'normal');
  assert.deepEqual(result.candidates.map((item) => item.number), [10]);
});

test('external PR selection fails closed for ambiguity, explicit mismatch, binding conflict, and identity conflict', () => {
  const first = normalizePullRequest({
    ...remote(7), state: 'closed', merged_at: '2026-07-25T00:00:00Z', merge_commit_sha: 'merge-7'
  }, 'o/r')!;
  const second = { ...first, number: 8, nodeId: 'PR_8', url: 'https://github.com/o/r/pull/8' };
  const codes = [
    selectExternalPullRequest([first, second], 'o/r', null, null),
    selectExternalPullRequest([first], 'o/r', null, 8),
    selectExternalPullRequest([first], 'o/r', 8, 7),
    selectExternalPullRequest([first, { ...first, head: { ...first.head, sha: 'different' } }], 'o/r', null, null)
  ].map((result) => result.status === 'failed' ? result.code : null);
  assert.deepEqual(codes, ['PR_IDENTITY_AMBIGUOUS', 'PR_NOT_FOUND', 'PR_BIND_CONFLICT', 'PR_IDENTITY_INVALID']);
});

test('GitHub closing PR inspection exhausts cursor pagination and fails closed on incomplete identities', () => {
  const nodes = [7, 8].map((number) => ({
    number, id: `PR_${number}`, url: `https://github.com/o/r/pull/${number}`, state: 'MERGED',
    title: 'Merged', body: '', isDraft: false,
    headRefName: `feature-${number}`, headRefOid: `head-${number}`, headRepository: { nameWithOwner: 'fork/r' },
    baseRefName: 'main', baseRefOid: `base-${number}`, baseRepository: { nameWithOwner: 'o/r' },
    mergedAt: '2026-07-25T00:00:00Z', mergeCommit: { oid: `merge-${number}` },
    labels: { nodes: [] }, assignees: { nodes: [] }, milestone: null
  }));
  let calls = 0;
  const client = {
    json(args: string[]) {
      calls += 1;
      const second = args.includes('cursor=next');
      return { ok: true, value: { data: { repository: { issue: { closedByPullRequestsReferences: {
        nodes: [second ? nodes[1] : nodes[0]],
        pageInfo: second ? { hasNextPage: false, endCursor: null } : { hasNextPage: true, endCursor: 'next' }
      } } } } } };
    }
  } as unknown as GitHubClient;
  const inspected = inspectGitHubIssueClosingChangeRequests(client, 'o/r', 7, process.cwd());
  assert.equal(inspected.ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(inspected.ok ? inspected.value.map((item) => item.number) : [], [7, 8]);

  const invalidClient = {
    json() {
      return { ok: true, value: { data: { repository: { issue: { closedByPullRequestsReferences: {
        nodes: [{ ...nodes[0], headRefOid: undefined }], pageInfo: { hasNextPage: false, endCursor: null }
      } } } } } };
    }
  } as unknown as GitHubClient;
  const invalid = inspectGitHubIssueClosingChangeRequests(invalidClient, 'o/r', 7, process.cwd());
  assert.equal(invalid.ok, false);
  if (invalid.ok) throw new Error('expected invalid identity');
  assert.equal(invalid.error.code, 'PR_IDENTITY_INVALID');
});

test('GitHub evidence prefers an exact upstream remote', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'github-evidence-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
    assert.equal(spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:fork/r.git'], { cwd: root }).status, 0);
    assert.equal(spawnSync('git', ['remote', 'add', 'upstream', 'https://github.com/o/r.git'], { cwd: root }).status, 0);
    const pullRequest = normalizePullRequest(remote(7), 'o/r')!;
    assert.deepEqual(resolveGitHubChangeRequestGitEvidence({
      cwd: root, repository: 'o/r', pullRequest
    }), {
      ok: true,
      value: {
        remoteUrl: 'https://github.com/o/r.git',
        reviewedHeadRef: 'refs/pull/7/head',
        targetHeadRef: 'refs/heads/main'
      }
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('GitHub evidence preserves origin transport when rewriting a fork remote', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'github-evidence-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
    assert.equal(spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:fork/r.git'], { cwd: root }).status, 0);
    const pullRequest = normalizePullRequest(remote(7), 'o/r')!;
    assert.equal(resolveGitHubChangeRequestGitEvidence({
      cwd: root, repository: 'o/r', pullRequest
    }).value?.remoteUrl, 'git@github.com:o/r.git');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
