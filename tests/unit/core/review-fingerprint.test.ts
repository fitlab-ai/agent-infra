import assert from 'node:assert/strict';
import test from 'node:test';

import { parseReviewedGitTree } from '../../../lib/task/review-fingerprint.ts';

test('reviewed Git trees accept object IDs and reject malformed values', () => {
  assert.equal(parseReviewedGitTree('a'.repeat(40)), 'a'.repeat(40));
  assert.equal(parseReviewedGitTree('not-a-git-object'), null);
});
