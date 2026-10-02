import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildLifecycleFacts } from '../../../lib/task/capabilities.ts';
import { findAuthoritativeReviewCodeArtifact } from '../../../lib/task/review-fingerprint.ts';
import { canonicalSemanticDigest } from '../../../lib/task/artifact-operations.ts';
import { sha256File } from '../../../lib/task/artifact-receipts.ts';

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
      const completed = ['analysis.md', 'analysis-r2.md', 'review-code.md', 'review-code-r2.md'];
      const actions = new Map([
        ['analysis', 'Analyze Task'], ['review-code', 'Review Code']
      ]);
      const facts = completed.map((name) => {
        const family = name.startsWith('analysis') ? 'analysis' : 'review-code';
        const event = family === 'analysis' ? 'analyze.completed' : 'review-code.completed';
        const filePath = path.join(root, name);
        return { event, output: name, outputSha256: sha256File(filePath), semanticDigest: canonicalSemanticDigest('# Artifact\n'), requestId: `fixture-${name}`, result: 'completed' };
      });
      const logs = completed.flatMap((name) => {
        const family = name.startsWith('analysis') ? 'analysis' : 'review-code';
        const round = name.includes('-r2') ? 2 : 1;
        const action = actions.get(family)!;
        const step = `${action} (Round ${round})`;
        const second = String((family === 'analysis' ? 0 : 10) + round * 2).padStart(2, '0');
        const done = String(Number(second) + 1).padStart(2, '0');
        return [
          `- 2026-01-01 00:00:${second}+00:00 — **${step} [started]** by codex — started`,
          `- 2026-01-01 00:00:${done}+00:00 — **${step}** by codex — completed → ${name}`
        ];
      });
      const task = content.replace('\n---\n', `\ncompletion_facts: '${JSON.stringify(facts)}'\n---\n`)
        + `\n## Activity Log\n\n${logs.join('\n')}\n`;
      fs.writeFileSync(path.join(root, 'task.md'), task);
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
