import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_REQUIREMENT_SECTION_ANCHORS,
  chooseMilestone,
  computeInLabels,
  desiredIssueType,
  planIssueMetadata,
  resolveRequirementSection,
  syncRequirementCheckboxes
} from '../../../lib/platform/issue-metadata.ts';

test('metadata planner converges status labels and skips unavailable repository labels', () => {
  const plan = planIssueMetadata({
    snapshot: {
      labels: ['status: blocked', 'status: waiting-for-triage', 'in: cli'],
      assignees: [], milestone: null, state: 'open', body: ''
    },
    desired: { status: 'in-progress' },
    repositoryLabels: new Set(['status: in-progress', 'status: blocked', 'in: cli']),
    capabilities: { authenticated: true, comment: true, triage: true, push: true, admin: false }
  });
  assert.deepEqual(plan.operations, [{
    name: 'labels:status', status: 'planned', reasonCode: null,
    value: ['in: cli', 'status: in-progress']
  }]);
});

test('metadata planner degrades only permission-bound operations', () => {
  const plan = planIssueMetadata({
    snapshot: { labels: ['status: blocked'], assignees: ['old'], milestone: null, state: 'open', body: '' },
    desired: { status: 'in-progress', assignees: 'current' },
    repositoryLabels: new Set(['status: in-progress']),
    currentUser: 'codex',
    capabilities: { authenticated: true, comment: true, triage: false, push: true, admin: false }
  });
  assert.deepEqual(plan.operations.map(({ name, status, reasonCode }) => ({ name, status, reasonCode })), [
    { name: 'labels:status', status: 'skipped', reasonCode: 'TRIAGE_REQUIRED' },
    { name: 'assignees', status: 'planned', reasonCode: null }
  ]);
});

test('requirement checkbox sync updates and appends only inside one anchored section', () => {
  const body = 'Intro\n\n## Requirements\n\nN/A\n- [ ] first\n- [x] unknown\n\n## Footer\n\n- [ ] first\n';
  assert.deepEqual(syncRequirementCheckboxes(body, [
    { text: 'first', checked: true }, { text: 'second', checked: false }
  ]), {
    status: 'synced',
    changed: true,
    body: 'Intro\n\n## Requirements\n\nN/A\n- [x] first\n- [x] unknown\n\n- [ ] second\n## Footer\n\n- [ ] first\n'
  });
});

test('requirement section resolution supports mapped H3 anchors and ignores fenced headings', () => {
  const body = '```md\n## Requirements\n```\n\n### Expected behavior\n\nN/A\n\n### Next\n';
  assert.deepEqual(resolveRequirementSection(body, [
    ...DEFAULT_REQUIREMENT_SECTION_ANCHORS,
    { level: 3, heading: 'Expected behavior' }
  ]), {
    status: 'found',
    bodyStart: body.indexOf('\n\nN/A', body.indexOf('### Expected behavior')) + 1,
    bodyEnd: body.indexOf('### Next')
  });
});

test('requirement checkbox sync reports skipped and fails closed without candidate bodies', () => {
  assert.deepEqual(syncRequirementCheckboxes('Intro only\n', [{ text: 'first', checked: true }]), {
    status: 'skipped', changed: false, body: 'Intro only\n', code: 'NO_REQUIREMENTS_ANCHOR'
  });

  const duplicateAnchor = syncRequirementCheckboxes(
    '## Requirements\n\n## 需求\n',
    [{ text: 'first', checked: true }]
  );
  assert.deepEqual(duplicateAnchor, { status: 'failed', code: 'REQUIREMENTS_ANCHOR_AMBIGUOUS' });

  const duplicateIdentity = syncRequirementCheckboxes(
    '## Requirements\n\n- [ ] same\n- [x] same\n',
    [{ text: 'same', checked: true }]
  );
  assert.deepEqual(duplicateIdentity, { status: 'failed', code: 'REQUIREMENT_IDENTITY_AMBIGUOUS' });

  const duplicateLocalIdentity = syncRequirementCheckboxes(
    '## Requirements\n\nN/A\n',
    [{ text: 'same', checked: true }, { text: 'same', checked: false }]
  );
  assert.deepEqual(duplicateLocalIdentity, { status: 'failed', code: 'REQUIREMENT_IDENTITY_AMBIGUOUS' });
});

test('requirement checkbox sync is idempotent and preserves CRLF', () => {
  const body = '## Requirements\r\n\r\nN/A\r\n';
  const first = syncRequirementCheckboxes(body, [{ text: 'first', checked: true }]);
  assert.equal(first.status, 'synced');
  if (first.status !== 'synced') return;
  assert.equal(first.body, '## Requirements\r\n\r\nN/A\r\n- [x] first');
  assert.deepEqual(syncRequirementCheckboxes(first.body, [{ text: 'first', checked: true }]), {
    status: 'synced', changed: false, body: first.body
  });
});

test('milestone selection and task type mapping are deterministic', () => {
  assert.equal(chooseMilestone('initial', ['0.9.x', 'General Backlog', '0.8.x']), '0.8.x');
  assert.equal(chooseMilestone('specific', ['0.8.x', '0.8.5', '0.8.7'], '0.8.x'), '0.8.7');
  assert.equal(chooseMilestone('none', ['0.8.x']), null);
  assert.equal(desiredIssueType('bugfix'), 'Bug');
  assert.equal(desiredIssueType('refactor'), 'Task');
});

test('closing an Issue clears status labels and unavailable labels preserve remote state', () => {
  const snapshot = { labels: ['status: blocked', 'in: cli'], assignees: [], milestone: null, state: 'open' as const, body: '' };
  const capabilities = { authenticated: true, comment: true, triage: true, push: true, admin: false };
  assert.deepEqual(planIssueMetadata({
    snapshot,
    desired: { status: 'declined', state: 'closed' },
    repositoryLabels: new Set(['status: declined', 'status: blocked', 'in: cli']),
    capabilities
  }).operations[0], {
    name: 'labels:status', status: 'planned', reasonCode: null, value: ['in: cli']
  });
  assert.deepEqual(planIssueMetadata({
    snapshot,
    desired: { status: 'not-created' },
    repositoryLabels: new Set(['status: blocked']),
    capabilities
  }).operations, [{ name: 'labels:status', status: 'skipped', reasonCode: 'LABEL_UNAVAILABLE' }]);
});

test('in labels come from configured path prefixes and existing repository labels', () => {
  assert.deepEqual(computeInLabels(
    ['lib/platform/issues.ts', 'templates/.agents/rules/issue-sync.en.md'],
    { cli: ['bin/', 'lib/'], templates: ['templates/'], missing: ['lib/'] },
    new Set(['in: cli', 'in: templates'])
  ), ['in: cli', 'in: templates']);
});
