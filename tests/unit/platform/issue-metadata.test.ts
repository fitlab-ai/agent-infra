import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseMilestone,
  computeInLabels,
  desiredIssueType,
  planIssueMetadata,
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

test('requirement checkbox sync preserves unrelated body and fails closed on ambiguity', () => {
  const body = 'Intro\n\n- [ ] first\n- [x] second\n\nFooter\n';
  assert.deepEqual(syncRequirementCheckboxes(body, [
    { text: 'first', checked: true }, { text: 'second', checked: false }
  ]), {
    ok: true,
    changed: true,
    body: 'Intro\n\n- [x] first\n- [ ] second\n\nFooter\n'
  });
  const duplicate = syncRequirementCheckboxes('- [ ] same\n- [x] same\n', [{ text: 'same', checked: true }]);
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.code, 'REQUIREMENT_IDENTITY_AMBIGUOUS');
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
