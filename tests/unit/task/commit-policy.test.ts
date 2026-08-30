import assert from 'node:assert/strict';
import test from 'node:test';

import { commitPushDecision } from '../../../lib/task/commit-policy.ts';

test('commit caller always skips push on main and master', () => {
  for (const branch of ['main', 'master']) {
    const decision = commitPushDecision({ branch }, `origin:refs/heads/${branch}`);
    assert.equal(decision.shouldPush, false);
    assert.equal(decision.warning?.code, 'COMMIT_AUTOPUSH_PROTECTED_BRANCH');
  }
  assert.equal(commitPushDecision({ branch: 'feature/a' }, 'origin:refs/heads/feature/a').shouldPush, true);
});
