import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  createPlatformIssue,
  inspectPlatformIssue,
  requirementSectionAnchors,
  syncPlatformIssue
} from '../../../lib/platform/issues.ts';
import type { GitHubClient } from '../../../lib/platform/github-client.ts';

function fixture(issueNumber = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-issue-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: root });
  const dir = path.join(root, '.agents', 'workspace', 'active', 'TASK-20260101-000001');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), '{"platform":{"type":"github"}}');
  fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: TASK-20260101-000001\ntype: feature\nstatus: active\nagent_infra_version: v0.9.11-alpha.0\nissue_number: ${issueNumber}\n---\n\n# 任务：Add safe sync\n\n## 描述\n\nKeep | shell characters.\n\n## 需求\n\n- [x] first\n- [ ] second\n\n## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n`);
  return root;
}

function clientFor(handler: (args: string[], input?: string, method?: string) => unknown): GitHubClient {
  return {
    version() { return { ok: true, value: '2.72.0' }; },
    json(args, options = {}) {
      const value = handler(args, options.input, options.method);
      if (value && typeof value === 'object' && (value as { ok?: unknown }).ok === false) return value as never;
      return { ok: true, value } as never;
    },
    text() { return { ok: true, value: '' }; }
  };
}

function inLabelIssueFixture() {
  const root = fixture('7');
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({
    platform: { type: 'github' }, labels: { in: { core: ['lib/'] } }
  }));
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'lib', 'core.ts'), 'change\n');
  const taskPath = path.join(root, '.agents', 'workspace', 'active', 'TASK-20260101-000001', 'task.md');
  const task = fs.readFileSync(taskPath, 'utf8').replace('issue_number: 7\n---', 'issue_number: 7\ndelivery_base_ref: HEAD~1\n---');
  fs.writeFileSync(taskPath, task);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'change'], { cwd: root });
  return root;
}

function contextResponse(args: string[]) {
  const endpoint = args.find((arg) => arg.startsWith('repos/')) || '';
  if (endpoint === 'repos/acme/widgets') return { full_name: 'acme/widgets', permissions: { admin: true } };
  if (args[1] === 'graphql' && args.some((arg) => arg.includes('viewer { login }'))) {
    return { data: { viewer: { login: 'codex' } } };
  }
  return null;
}

test('issue inspection normalizes stable remote identity and metadata', async () => {
  const root = fixture('7');
  const result = await inspectPlatformIssue('TASK-20260101-000001', {
    cwd: root,
    client: clientFor((args) => contextResponse(args) || {
      number: 7, id: 70, node_id: 'I_7', html_url: 'https://github.com/acme/widgets/issues/7',
      state: 'open', title: 'title', body: 'body', labels: [{ name: 'z' }, { name: 'a' }],
      assignees: [{ login: 'b' }, { login: 'a' }], milestone: { title: '0.8.6' }, pull_request: undefined
    })
  });
  assert.equal(result.status, 'no-op');
  assert.deepEqual(result.issue?.labels, ['a', 'z']);
  assert.deepEqual(result.issue?.assignees, ['a', 'b']);
  assert.equal(result.issue?.nodeId, 'I_7');
});

test('issue inspection returns a structured legacy cutoff error for numeric identities', async () => {
  const root = fixture('42');
  try {
    const result = await inspectPlatformIssue('TASK-20260101-000001', { cwd: root, runtimeVersion: 'v1.0.0' });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'PLATFORM_IDENTITY_LEGACY_UNSUPPORTED');
    assert.match(result.error?.message || '', /current schema/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('issue create binds exactly once and replay inspects the existing binding', async () => {
  const root = fixture();
  let posts = 0;
  const client = clientFor((args, input) => {
    const context = contextResponse(args);
    if (context) return context;
    if (args.includes('POST')) {
      posts += 1;
      const payload = JSON.parse(input || '{}');
      assert.equal(payload.title, 'feat: Add safe sync');
      assert.match(payload.body, /Keep \| shell characters/);
      return { number: 9, id: 90, node_id: 'I_9', html_url: 'https://github.com/acme/widgets/issues/9' };
    }
    return { number: 9, id: 90, node_id: 'I_9', html_url: 'https://github.com/acme/widgets/issues/9', state: 'open', title: 'x', body: '', labels: [], assignees: [], milestone: null };
  });
  const first = await createPlatformIssue('TASK-20260101-000001', { cwd: root, agent: 'codex', client });
  assert.equal(first.status, 'applied');
  assert.equal(first.task.issueNumber, 9);
  const second = await createPlatformIssue('TASK-20260101-000001', { cwd: root, agent: 'codex', client });
  assert.equal(second.status, 'no-op');
  assert.equal(posts, 1);
});

test('issue sync plans dry-run without writes and applies incremental label writes', async () => {
  const root = fixture('7');
  let patches = 0;
  let labels = ['status: blocked'];
  const client = clientFor((args, input) => {
    const context = contextResponse(args);
    if (context) return context;
    const endpoint = args.find((arg) => arg.startsWith('repos/')) || '';
    if (endpoint.endsWith('/labels?per_page=100')) return [{ name: 'status: blocked' }, { name: 'status: in-progress' }];
    if (args.includes('DELETE') && endpoint.includes('/labels/')) {
      labels = labels.filter((label) => label !== decodeURIComponent(endpoint.split('/labels/')[1]!));
      return {};
    }
    if (args.includes('POST') && endpoint.endsWith('/labels')) {
      labels.push(...(JSON.parse(input || '{}').labels as string[]));
      return {};
    }
    if (args.includes('PATCH')) {
      patches += 1;
      return {};
    }
    return { number: 7, id: 70, node_id: 'I_7', html_url: 'https://github.com/acme/widgets/issues/7', state: 'open', title: 'x', body: '', labels: labels.map((name) => ({ name })), assignees: [], milestone: null };
  });
  const dry = await syncPlatformIssue('TASK-20260101-000001', { cwd: root, agent: 'codex', status: 'in-progress', dryRun: true, client });
  assert.equal(dry.status, 'planned');
  assert.equal(patches, 0);
  const applied = await syncPlatformIssue('TASK-20260101-000001', { cwd: root, agent: 'codex', status: 'in-progress', client });
  assert.equal(applied.status, 'applied');
  assert.equal(patches, 0);
  assert.deepEqual(labels.sort(), ['status: in-progress']);
  const replay = await syncPlatformIssue('TASK-20260101-000001', { cwd: root, agent: 'codex', status: 'in-progress', client });
  assert.equal(replay.status, 'no-op');
  assert.equal(patches, 0);
});

test('issue in-label sync requires the task-bound base and uses it for diff evidence', async () => {
  const missingBase = fixture('7');
  try {
    const client = clientFor((args) => contextResponse(args) || (args.some((arg) => arg.endsWith('/labels?per_page=100')) ? [{ name: 'in: core' }] : {
      number: 7, id: 70, node_id: 'I_7', html_url: 'https://github.com/acme/widgets/issues/7',
      state: 'open', title: 'x', body: '', labels: [], assignees: [], milestone: null
    }));
    const result = await syncPlatformIssue('TASK-20260101-000001', {
      cwd: missingBase, agent: 'codex', client, inLabels: 'from-diff'
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'IN_LABEL_SYNC_BASE_MISSING');
  } finally {
    fs.rmSync(missingBase, { recursive: true, force: true });
  }

  const root = fixture('7');
  try {
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    execFileSync('git', ['branch', '-M', 'main'], { cwd: root });
    execFileSync('git', ['checkout', '-qb', 'feature'], { cwd: root });
    fs.writeFileSync(path.join(root, 'lib.txt'), 'change\n');
    fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({
      platform: { type: 'github' }, labels: { in: { core: ['lib.txt'] } }
    }));
    fs.writeFileSync(path.join(root, '.agents', 'workspace', 'active', 'TASK-20260101-000001', 'task.md'),
      fs.readFileSync(path.join(root, '.agents', 'workspace', 'active', 'TASK-20260101-000001', 'task.md'), 'utf8')
        .replace('issue_number: 7', 'issue_number: 7\ndelivery_base_ref: main'));
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'change'], { cwd: root });
    let payload: Record<string, unknown> | null = null;
    let currentLabels: string[] = ['in: stale', 'keep'];
    const client = clientFor((args, input) => {
      const context = contextResponse(args);
      if (context) return context;
      const endpoint = args.find((arg) => arg.startsWith('repos/')) || '';
      if (endpoint.endsWith('/labels?per_page=100')) return [{ name: 'in: core' }];
      if (args.includes('DELETE') && endpoint.includes('/labels/')) {
        currentLabels = currentLabels.filter((label) => label !== decodeURIComponent(endpoint.split('/labels/')[1]!));
        return {};
      }
      if (args.includes('POST') && endpoint.endsWith('/labels')) {
        currentLabels.push(...(JSON.parse(input || '{}').labels as string[]));
        return {};
      }
      if (args.includes('PATCH')) {
        payload = JSON.parse(input || '{}') as Record<string, unknown>;
        return {};
      }
      return {
        number: 7, id: 70, node_id: 'I_7', html_url: 'https://github.com/acme/widgets/issues/7',
        state: 'open', title: 'x', body: '', labels: currentLabels.map((name) => ({ name })), assignees: [], milestone: null
      };
    });
    const result = await syncPlatformIssue('TASK-20260101-000001', {
      cwd: root, agent: 'codex', client, inLabels: 'from-diff'
    });
    assert.equal(result.status, 'applied');
    assert.equal((payload as Record<string, unknown> | null)?.labels, undefined);
    assert.deepEqual(currentLabels, ['keep', 'in: core']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('issue sync upgrades a deterministic in-label failure after status success to partial', async () => {
  const root = inLabelIssueFixture();
  let labels = ['status: blocked', 'keep'];
  try {
    const client = clientFor((args, input) => {
      const context = contextResponse(args);
      if (context) return context;
      const endpoint = args.find((arg) => arg.startsWith('repos/')) || '';
      if (endpoint.endsWith('/labels?per_page=100')) return [
        { name: 'status: blocked' }, { name: 'status: in-progress' }, { name: 'in: core' }
      ];
      if (args.includes('DELETE') && endpoint.includes('/labels/')) {
        labels = labels.filter((label) => label !== decodeURIComponent(endpoint.split('/labels/')[1]!));
        return {};
      }
      if (args.includes('POST') && endpoint.endsWith('/labels')) {
        const posted = JSON.parse(input || '{}').labels as string[];
        if (posted.includes('in: core')) return { ok: false, error: { code: 'PLATFORM_REQUEST_INVALID', message: 'label rejected', retryable: false } };
        labels.push(...posted);
        return {};
      }
      return { number: 7, id: 70, node_id: 'I_7', html_url: 'https://github.com/acme/widgets/issues/7', state: 'open', title: 'x', body: '', labels: labels.map((name) => ({ name })), assignees: [], milestone: null };
    });
    const result = await syncPlatformIssue('TASK-20260101-000001', {
      cwd: root, agent: 'codex', status: 'in-progress', inLabels: 'from-diff', client
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.error?.code, 'IN_LABEL_SYNC_PARTIAL');
    assert.equal(result.changed, true);
    assert.deepEqual(labels.sort(), ['keep', 'status: in-progress']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('issue sync reports changed when the post-write in-label reread fails', async () => {
  const root = inLabelIssueFixture();
  let labels = ['keep'];
  let issueReads = 0;
  try {
    const client = clientFor((args, input) => {
      const context = contextResponse(args);
      if (context) return context;
      const endpoint = args.find((arg) => arg.startsWith('repos/')) || '';
      if (endpoint.endsWith('/labels?per_page=100')) return [{ name: 'in: core' }];
      if (args.includes('POST') && endpoint.endsWith('/labels')) {
        labels.push(...(JSON.parse(input || '{}').labels as string[]));
        return {};
      }
      if (/issues\/7$/.test(endpoint)) {
        issueReads += 1;
        if (issueReads === 2) return { ok: false, error: { code: 'PLATFORM_READ_FAILED', message: 'reread failed', retryable: true } };
      }
      return { number: 7, id: 70, node_id: 'I_7', html_url: 'https://github.com/acme/widgets/issues/7', state: 'open', title: 'x', body: '', labels: labels.map((name) => ({ name })), assignees: [], milestone: null };
    });
    const result = await syncPlatformIssue('TASK-20260101-000001', {
      cwd: root, agent: 'codex', inLabels: 'from-diff', client
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.error?.code, 'IN_LABEL_SYNC_PARTIAL');
    assert.equal(result.changed, true);
    assert.deepEqual(labels, ['keep', 'in: core']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('requirement anchors follow the deterministically selected Issue Form', () => {
  const root = fixture('7');
  const formDir = path.join(root, '.github', 'ISSUE_TEMPLATE');
  fs.mkdirSync(formDir, { recursive: true });
  fs.writeFileSync(path.join(formDir, 'feature.yml'), [
    'name: Feature',
    'body:',
    '  - type: textarea',
    '    id: solution',
    '    attributes:',
    '      label: Proposed solution'
  ].join('\n'));
  assert.deepEqual(requirementSectionAnchors(root, 'feature'), [
    { level: 2, heading: '需求' },
    { level: 2, heading: 'Requirements' },
    { level: 3, heading: 'Proposed solution' }
  ]);
});

test('requirements sync plans, applies once, and converges on replay', async () => {
  const root = fixture('7');
  let patches = 0;
  let body = 'Intro\n\n## Requirements\n\nN/A\n';
  const client = clientFor((args, input) => {
    const context = contextResponse(args);
    if (context) return context;
    if (args.includes('PATCH')) {
      patches += 1;
      body = JSON.parse(input || '{}').body;
      return {};
    }
    return {
      number: 7, id: 70, node_id: 'I_7', html_url: 'https://github.com/acme/widgets/issues/7',
      state: 'open', title: 'x', body, labels: [], assignees: [], milestone: null
    };
  });
  const dry = await syncPlatformIssue('TASK-20260101-000001', {
    cwd: root, agent: 'codex', requirements: true, dryRun: true, client
  });
  assert.equal(dry.status, 'planned');
  assert.equal(patches, 0);

  const applied = await syncPlatformIssue('TASK-20260101-000001', {
    cwd: root, agent: 'codex', requirements: true, client
  });
  assert.equal(applied.status, 'applied');
  assert.equal(patches, 1);
  assert.match(body, /- \[x\] first\n- \[ \] second/);

  const replay = await syncPlatformIssue('TASK-20260101-000001', {
    cwd: root, agent: 'codex', requirements: true, client
  });
  assert.equal(replay.status, 'no-op');
  assert.equal(patches, 1);
});

test('requirements sync degrades without an anchor and fails before writes on ambiguity', async () => {
  const root = fixture('7');
  let patches = 0;
  let body = 'Hand-written issue\n';
  const client = clientFor((args) => {
    const context = contextResponse(args);
    if (context) return context;
    if (args.includes('PATCH')) patches += 1;
    return {
      number: 7, id: 70, node_id: 'I_7', html_url: 'https://github.com/acme/widgets/issues/7',
      state: 'open', title: 'x', body, labels: [], assignees: [], milestone: null
    };
  });
  const skipped = await syncPlatformIssue('TASK-20260101-000001', {
    cwd: root, agent: 'codex', requirements: true, client
  });
  assert.equal(skipped.status, 'degraded');
  assert.deepEqual(skipped.operations, [{
    name: 'requirements', status: 'skipped', reasonCode: 'NO_REQUIREMENTS_ANCHOR'
  }]);

  body = '## Requirements\n\n## 需求\n';
  const failed = await syncPlatformIssue('TASK-20260101-000001', {
    cwd: root, agent: 'codex', requirements: true, client
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error?.code, 'REQUIREMENTS_ANCHOR_AMBIGUOUS');
  assert.equal(patches, 0);
});

test('issue sync flattens paginated milestones and converges on a specific version', async () => {
  const root = fixture('7');
  let patches = 0;
  let currentMilestone = '0.8.x';
  const client = clientFor((args, input) => {
    const context = contextResponse(args);
    if (context) return context;
    const endpoint = args.find((arg) => arg.startsWith('repos/')) || '';
    if (endpoint.endsWith('/milestones?state=open&per_page=100')) return [
      [{ title: '0.8.x', number: 80 }],
      [{ title: '0.8.5', number: 85 }, { title: '0.8.6', number: 86 }]
    ];
    if (args.includes('PATCH')) {
      patches += 1;
      const payload = JSON.parse(input || '{}');
      assert.deepEqual(payload, { milestone: 86 });
      currentMilestone = '0.8.6';
      return {};
    }
    return {
      number: 7, id: 70, node_id: 'I_7', html_url: 'https://github.com/acme/widgets/issues/7',
      state: 'open', title: 'x', body: '', labels: [], assignees: [], milestone: { title: currentMilestone }
    };
  });

  const applied = await syncPlatformIssue('TASK-20260101-000001', { cwd: root, agent: 'codex', milestone: 'specific', client });
  assert.equal(applied.status, 'applied');
  assert.equal(patches, 1);

  const replay = await syncPlatformIssue('TASK-20260101-000001', { cwd: root, agent: 'codex', milestone: 'specific', client });
  assert.equal(replay.status, 'no-op');
  assert.equal(patches, 1);
});

test('issue sync resolves organization schema and migrates type before pinned fields', async () => {
  const root = fixture('7');
  const taskPath = path.join(root, '.agents', 'workspace', 'active', 'TASK-20260101-000001', 'task.md');
  fs.writeFileSync(taskPath, fs.readFileSync(taskPath, 'utf8').replace('type: feature', 'type: feature\npriority: 高'));
  const writes: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const client = clientFor((args, input) => {
    const context = contextResponse(args);
    if (context) return context;
    if (args.includes('--input')) {
      const payload = JSON.parse(input || '{}');
      writes.push(payload);
      return { data: {} };
    }
    const query = args.find((arg) => arg.startsWith('query=')) || '';
    if (query.includes('organization(login')) return { data: { organization: { issueTypes: { nodes: [{
      id: 'TYPE_FEATURE', name: 'Feature', pinnedFields: [{
        __typename: 'IssueFieldSingleSelect', id: 'FIELD_PRIORITY', name: 'Priority', options: [{ id: 'OPT_HIGH', name: 'High' }]
      }]
    }] } } } };
    if (query.includes('issueFieldValues')) return { data: { repository: { issue: {
      id: 'ISSUE_NODE', issueType: { id: 'TYPE_TASK', name: 'Task', pinnedFields: [] }, issueFieldValues: { nodes: [] }
    } } } };
    return { number: 7, id: 70, node_id: 'I_7', html_url: 'https://github.com/acme/widgets/issues/7', state: 'open', title: 'x', body: '', labels: [], assignees: [], milestone: null };
  });
  const result = await syncPlatformIssue('TASK-20260101-000001', { cwd: root, agent: 'codex', issueType: true, fields: true, client });
  assert.equal(result.status, 'applied');
  assert.deepEqual(writes.map((write) => Object.keys(write.variables)), [
    ['issueId', 'issueTypeId'], ['issueId', 'issueFields']
  ]);
  assert.deepEqual(writes[1]!.variables.issueFields, [{ fieldId: 'FIELD_PRIORITY', singleSelectOptionId: 'OPT_HIGH' }]);
});
