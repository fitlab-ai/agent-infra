import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLifecyclePathDecision } from '../../../lib/task/lifecycle-path.ts';

function decision(path: string, heading = '流程裁定') {
  return `# Analysis\n\n## ${heading}\n\n- **本任务路径**：${path}。\n- **判定依据**：需求与验收明确。\n- **未满足的更高路径条件**：没有独立审计事实。\n- **升级触发条件**：出现不可逆 schema 决策。\n`;
}

test('flow decision maps each canonical path to its fixed stage sequence', () => {
  const expected = {
    精简路径: ['analysis', 'code', 'review-code'],
    标准路径: ['analysis', 'plan', 'code', 'review-code'],
    完整路径: ['analysis', 'review-analysis', 'plan', 'review-plan', 'code', 'review-code']
  } as const;
  for (const [path, stages] of Object.entries(expected)) {
    const parsed = parseLifecyclePathDecision(decision(path), 'analysis.md', 'a'.repeat(64));
    assert.equal(parsed.status, 'valid');
    if (parsed.status === 'valid') assert.deepEqual(parsed.decision.stages, stages);
  }
});

test('flow decision semantic digest excludes artifact identity and formatting', () => {
  const first = parseLifecyclePathDecision(decision('标准路径'), 'analysis.md', 'a'.repeat(64));
  const second = parseLifecyclePathDecision(decision('standard').replaceAll('。', ''), 'analysis-r2.md', 'b'.repeat(64));
  assert.equal(first.status, 'valid');
  assert.equal(second.status, 'valid');
  if (first.status === 'valid' && second.status === 'valid') assert.equal(first.decision.semanticDigest, second.decision.semanticDigest);
});

test('missing, duplicate, and unknown flow decisions fail closed', () => {
  assert.equal(parseLifecyclePathDecision('# Analysis\n').status, 'missing');
  assert.equal(parseLifecyclePathDecision(`${decision('标准路径')}\n- **本任务路径**：完整路径。\n`).status, 'invalid');
  assert.equal(parseLifecyclePathDecision(decision('experimental')).status, 'invalid');
});
