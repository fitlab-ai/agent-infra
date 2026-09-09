import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildLifecycleFacts } from '../../../lib/task/capabilities.ts';
import { findAuthoritativeReviewCodeArtifact } from '../../../lib/task/review-fingerprint.ts';

for (const consumer of ['lifecycle facts', 'review selection'] as const) {
  test(`${consumer} uses only canonical artifact identities`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-name-contract-'));
    const content = '---\nid: TASK-20260909-160000\nstatus: active\n---\n# Task\n';
    try {
      fs.writeFileSync(path.join(root, 'task.md'), content);
      for (const name of [
        'analysis.md', 'analysis-r2.md', 'analysis-r01.md', 'analysis-r9007199254740992.md',
        'review-code.md', 'review-code-r2.md', 'review-code-r099.md', 'review-code-r9007199254740992.md'
      ]) fs.writeFileSync(path.join(root, name), '# Artifact\n');
      if (consumer === 'lifecycle facts') {
        const result = buildLifecycleFacts(root, content);
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.deepEqual(result.facts.artifacts.analysis?.slice().sort(), ['analysis-r2.md', 'analysis.md']);
        assert.deepEqual(result.facts.artifacts['review-code']?.slice().sort(), ['review-code-r2.md', 'review-code.md']);
      } else {
        const result = findAuthoritativeReviewCodeArtifact(root);
        assert.equal(result.ok, true);
        assert.equal(result.fileName, 'review-code-r2.md');
        assert.equal(result.round, 2);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
