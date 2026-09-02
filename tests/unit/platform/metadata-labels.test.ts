import test from 'node:test';
import assert from 'node:assert/strict';

import { computeInLabels, taskTypeLabel } from '../../../lib/platform/metadata-labels.ts';

test('shared metadata labels normalize task types and configured path matches', () => {
  assert.equal(taskTypeLabel('bugfix'), 'type: bug');
  assert.equal(taskTypeLabel('refactor'), 'type: enhancement');
  assert.equal(taskTypeLabel('unknown'), null);
  assert.deepEqual(computeInLabels(
    ['lib/platform/pull-requests.ts', 'templates/.agents/rules/pr-sync.en.md'],
    { templates: ['templates/'], cli: ['bin/', 'lib/'], ignored: ['lib/'] },
    new Set(['in: cli', 'in: templates'])
  ), ['in: cli', 'in: templates']);
});

test('configured path matches stop at directory boundaries', () => {
  assert.deepEqual(computeInLabels(
    ['library/README.md'],
    { lib: ['lib/'], library: ['lib'] },
    new Set(['in: lib', 'in: library'])
  ), []);
});
