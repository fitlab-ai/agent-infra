import test from 'node:test';
import assert from 'node:assert/strict';

import { artifactCompletionOrder, hasArtifactCompletionLog } from '../../../lib/task/completion-facts.ts';

const timestamp = '2026-10-01 23:12:47+08:00';

function lifecycleLog(): string {
  return [
    '## Activity Log',
    `- ${timestamp} — **Plan Task (Round 1) [started]** by codex — started`,
    `- ${timestamp} — **Plan Task (Round 1)** by codex — Plan completed → plan.md`,
    `- ${timestamp} — **Plan Task (Round 2) [started]** by codex — started`,
    `- ${timestamp} — **Plan Task (Round 2)** by codex — Plan completed → plan-r2.md`
  ].join('\n');
}

test('completion logs require a paired done row for the requested artifact family', () => {
  const content = lifecycleLog();
  assert.equal(hasArtifactCompletionLog(content, 'plan.md', 'plan.completed'), true);
  assert.equal(hasArtifactCompletionLog(content, 'plan-r2.md', 'plan.completed'), true);
  assert.equal(hasArtifactCompletionLog(content, 'plan.md', 'review-plan.completed'), false);
  assert.equal(hasArtifactCompletionLog('## Activity Log\n- ' + timestamp + ' — **Plan Task (Round 1)** by codex — Plan completed → plan.md', 'plan.md', 'plan.completed'), false);
});

test('same-second completions preserve Activity Log source order', () => {
  const content = lifecycleLog();
  const round1 = artifactCompletionOrder(content, 'plan.md', 'plan.completed');
  const round2 = artifactCompletionOrder(content, 'plan-r2.md', 'plan.completed');
  assert.equal(typeof round1, 'number');
  assert.equal(typeof round2, 'number');
  assert.ok(round1! < round2!);
});

