import assert from 'node:assert/strict';
import test from 'node:test';

import { commitPushDecision } from '../../../lib/task/commit-policy.ts';

test('commit caller skips automatic push on main and master only', () => {
  for (const branch of ['main', 'master']) {
    const decision = commitPushDecision({ branch, automatic: true }, `origin:refs/heads/${branch}`);
    assert.equal(decision.shouldPush, false);
    assert.equal(decision.warning?.code, 'COMMIT_AUTOPUSH_PROTECTED_BRANCH');
  }
  assert.equal(commitPushDecision({ branch: 'feature/a', automatic: true }, 'origin:refs/heads/feature/a').shouldPush, true);
  assert.equal(commitPushDecision({ branch: 'main', automatic: false }, 'origin:refs/heads/main').shouldPush, true);
});
