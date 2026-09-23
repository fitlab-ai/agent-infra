import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseLifecyclePathDecision } from '../../../lib/task/lifecycle-path.ts';

const SKILL_PATH = fileURLToPath(new URL('../../../.agents/skills/analyze-task/SKILL.md', import.meta.url));

function decision(path: string) {
  const skill = fs.readFileSync(SKILL_PATH, 'utf8');
  const template = /<!-- lifecycle-path-decision-template:start -->\n([\s\S]*?)\n<!-- lifecycle-path-decision-template:end -->/.exec(skill);
  assert.ok(template, 'analyze-task must provide a marked canonical flow-decision template');
  return `# Analysis\n\n${template[1]!.replace('{lifecycle-path}', path)}`;
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
