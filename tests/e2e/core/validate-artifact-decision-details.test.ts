import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { verifyInProcess } from '../../../lib/task/verification-engine.ts';

async function check(content: string) {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-detail-gate-'));
  fs.writeFileSync(path.join(taskDir, 'review-analysis.md'), content);
  return verifyInProcess({
    mode: 'check',
    skillName: 'review-analysis',
    taskDir,
    artifactFile: 'review-analysis.md',
    checks: ['decision-details'],
    repositoryRoot: process.cwd()
  });
}

test('decision-details gate passes when ids are unique and ignores fenced examples', async () => {
  const result = await check(`~~~md
### AN-1：示例 [needs-human-decision]
~~~

### AN-1：正式详情 [needs-human-decision]
- **要决定什么**：选择方案
`);
  assert.equal(result.status, 'pass');
});

test('decision-details gate does not hide a later duplicate behind a tilde fence', async () => {
  const result = await check(`~~~~md \`example\`
### AN-1：示例 [needs-human-decision]
~~~~

### AN-1：正式详情 [needs-human-decision]
- **要决定什么**：选择方案

### AN-1：上一轮复核理由

Previous review rationale
The earlier review recorded the cause and risk for this behavior.
`);
  assert.equal(result.status, 'fail');
  assert.match(result.message, /Duplicate decision detail ids/);
});

test('decision-details gate rejects duplicate ids', async () => {
  const content = [
    '### AN-1：第一个 [needs-human-decision]',
    '- **要决定什么**：A',
    '',
    '### AN-1：第二个 [needs-human-decision]',
    '- **要决定什么**：B',
    ''
  ].join('\n');
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-detail-readonly-'));
  const artifact = path.join(taskDir, 'review-analysis.md');
  fs.writeFileSync(artifact, content);
  const before = fs.readFileSync(artifact);
  const result = await verifyInProcess({
    mode: 'check', skillName: 'review-analysis', taskDir, artifactFile: 'review-analysis.md',
    checks: ['decision-details'], repositoryRoot: process.cwd()
  });
  assert.equal(result.status, 'fail');
  assert.match(result.message, /Duplicate decision detail ids/);
  assert.deepEqual(fs.readFileSync(artifact), before);
});
