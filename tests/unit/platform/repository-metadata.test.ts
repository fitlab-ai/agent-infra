import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLabelDefinitions, buildMilestonePlan } from '../../../lib/platform/repository-metadata.ts';

test('milestone planning preserves SemVer precedence and the compatibility baseline', () => {
  const plan = buildMilestonePlan(['v1.2.3', 'v1.3.0-rc.1', 'v1.2.3-alpha.10', 'v999.0.0-01'], false);

  assert.deepEqual(plan.baseline, { version: '1.3.0', source: 'git tag v1.3.0-rc.1' });
  assert.deepEqual(plan.desired.map((item) => [item.title, item.state]), [
    ['General Backlog', 'open'],
    ['1.3.x', 'open'],
    ['1.3.1', 'open'],
    ['1.4.0', 'open'],
    ['1.4.x', 'open']
  ]);
});

test('milestone planning adds the next minor line at patch zero and history targets', () => {
  const plan = buildMilestonePlan(['v1.2.0', 'v1.1.4'], true);

  assert.deepEqual(plan.desired.map((item) => `${item.title}:${item.state}`), [
    'General Backlog:open',
    '1.2.x:open',
    '1.2.1:open',
    '1.3.0:open',
    '1.3.x:open',
    '1.2.0:closed',
    '1.1.x:open',
    '1.1.4:closed'
  ]);
});

test('invalid tags fall back without reading a manifest and label mappings stay deterministic', () => {
  const plan = buildMilestonePlan(['v1.0.0-01', 'release'], false);
  assert.deepEqual(plan.baseline, { version: '0.1.0', source: 'compatibility default' });

  const labels = buildLabelDefinitions({ labels: { in: { docs: ['docs/'], core: ['lib/'] } } });
  assert.deepEqual(labels.filter((item) => item.name.startsWith('in:')).map((item) => item.name), ['in: core', 'in: docs']);
});
