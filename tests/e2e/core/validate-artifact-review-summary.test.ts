import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { verifyInProcess } from '../../../lib/task/verification-engine.ts';

const scenarios = [
  { skill: 'review-analysis', stage: 'analysis', artifact: 'review-analysis.md', findingId: 'AN-1' },
  { skill: 'review-plan', stage: 'plan', artifact: 'review-plan.md', findingId: 'PL-1' },
  { skill: 'review-code', stage: 'code', artifact: 'review-code.md', findingId: 'CD-1' }
] as const;

function fixture(scenario: (typeof scenarios)[number], summary: string, withFinding = false) {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-summary-gate-'));
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---
id: TASK-20260101-000001
---

# Task

## Review Disagreement Ledger

| id | stage | round | severity | status | evidence |
|----|-------|-------|----------|--------|----------|
${withFinding ? `| ${scenario.findingId} | ${scenario.stage} | 1 | minor | open | ${scenario.artifact}#finding |` : ''}
`);
  fs.writeFileSync(path.join(taskDir, scenario.artifact), summary);
  return taskDir;
}

async function check(scenario: (typeof scenarios)[number], taskDir: string) {
  return verifyInProcess({
    mode: 'check',
    skillName: scenario.skill,
    taskDir,
    artifactFile: scenario.artifact,
    checks: ['review-summary'],
    repositoryRoot: process.cwd()
  });
}

for (const [index, scenario] of scenarios.entries()) {
  test(`${scenario.skill} review-summary gate rejects placeholders`, async () => {
    const taskDir = fixture(scenario, `## Review Summary

- **Overall Verdict**: Approved
- **Findings (AI-actionable)**: {unresolved-blockers} blockers, {unresolved-major} majors, {unresolved-minor} minors
`);
    assert.equal((await check(scenario, taskDir)).status, 'fail');
  });

  test(`${scenario.skill} review-summary gate compares numeric counts with its ledger stage`, async () => {
    const summary = index % 2 === 0
      ? `## 审查摘要

- **总体结论**：需要修改
- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要
`
      : `## Review Summary

- **Overall Verdict**: Changes Requested
- **Findings (AI-actionable)**: 0 blockers, 0 majors, 0 minors
`;
    const taskDir = fixture(scenario, summary, true);
    assert.equal((await check(scenario, taskDir)).status, 'fail');

    fs.writeFileSync(
      path.join(taskDir, scenario.artifact),
      summary.replace(/0 (次要|minors)/, '1 $1')
    );
    assert.equal((await check(scenario, taskDir)).status, 'pass');
  });
}
