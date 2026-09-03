import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractPullRequestFileNames,
  extractRepositoryLabelNames,
  labelDelta,
  mergeInLabels,
  planInLabelUpdate,
  validateInLabelMapping,
  validateRepositoryLabelPayload
} from '../../../lib/platform/in-label-sync.ts';

test('in-label planner computes a deterministic target and preserves unrelated labels', () => {
  assert.deepEqual(planInLabelUpdate({
    changedFiles: ['lib/core.ts', 'templates/.agents/rules/issue-sync.en.md'],
    currentLabels: ['in: stale', 'type: bug', 'priority: high'],
    mapping: { core: ['lib/'], templates: ['templates/'] },
    repositoryLabels: new Set(['in: core', 'in: templates'])
  }), {
    current: ['in: stale'],
    target: ['in: core', 'in: templates'],
    labels: ['in: core', 'in: templates', 'priority: high', 'type: bug'],
    changed: true,
    error: null
  });
});

test('paginated GitHub values are normalized without accepting malformed file payloads', () => {
  assert.deepEqual(extractRepositoryLabelNames([[{ name: 'in: core' }], [{ name: 'type: bug' }]]), ['in: core', 'type: bug']);
  assert.deepEqual(extractPullRequestFileNames([[{ filename: 'a.ts' }], [{ filename: 'b.ts' }]]), ['a.ts', 'b.ts']);
  assert.equal(extractPullRequestFileNames([{ filename: 'a.ts' }, { status: 'renamed' }]), null);
});

test('merging in labels is idempotent and removes stale in labels only', () => {
  assert.deepEqual(mergeInLabels(['in: old', 'keep', 'keep'], ['in: new', 'in: new']), ['in: new', 'keep']);
});

test('in-label authority validation fails closed for malformed mappings and repository payloads', () => {
  assert.equal(validateInLabelMapping('lib/' as unknown).ok, false);
  assert.equal(validateInLabelMapping({ core: 'lib/' } as unknown).ok, false);
  assert.equal(validateInLabelMapping({ core: [''] }).ok, false);
  assert.equal(validateRepositoryLabelPayload({ name: 'in: core' }).ok, false);
  assert.equal(validateRepositoryLabelPayload([[{ name: 'in: core' }, { color: 'fff' }]]).ok, false);
  assert.equal(validateRepositoryLabelPayload([[{ name: 'in: core' }], { name: 'in: cli' }] as unknown).ok, false);
});

test('label delta changes only selected prefixes', () => {
  assert.deepEqual(labelDelta(['in: old', 'keep', 'type: bug'], ['in: new', 'keep', 'type: feature'], 'in:'), {
    add: ['in: new'], remove: ['in: old']
  });
});
