import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { decide } from '../../../lib/decide.ts';

function makeTask(): { repoRoot: string; taskId: string; taskMd: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'decide-'));
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(path.join(repoRoot, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.agents', '.airc.json'), JSON.stringify({ project: 'demo' }));
  const taskMd = path.join(taskDir, 'task.md');
  fs.writeFileSync(
    taskMd,
    `---\nid: ${taskId}\nupdated_at: 2026-01-01 00:00:00+00:00\nagent_infra_version: unknown\n---\n# 任务：demo\n\n## 审查分歧账本\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n| HD-1 | plan | - | decision | needs-human-decision | plan.md#HD-1 |\n\n## 人工裁决\n\n## 活动日志\n`
  );
  return { repoRoot, taskId, taskMd };
}

test('decide marks a pending HD row as human-decided and records the decision', async () => {
  const { repoRoot, taskId, taskMd } = makeTask();
  try {
    const code = await decide([taskId, 'HD-1', '选择 A，保持最小范围。'], {
      repoRoot,
      now: () => '2026-07-01 09:30:00+08:00',
      version: '0.7.8-alpha.0'
    });
    assert.equal(code, 0);
    const content = fs.readFileSync(taskMd, 'utf8');
    assert.match(content, /\| HD-1 \| plan \| - \| decision \| human-decided \| task\.md#HD-1 \|/);
    assert.match(content, /### HD-1/);
    assert.match(content, /选择 A，保持最小范围。/);
    assert.match(content, /\*\*Human Decision\*\* by human/);
    assert.match(content, /^updated_at: 2026-07-01 09:30:00\+08:00$/m);
    assert.match(content, /^agent_infra_version: 0\.7\.8-alpha\.0$/m);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('decide rejects missing or already-decided HD rows', async () => {
  const { repoRoot, taskId, taskMd } = makeTask();
  try {
    assert.equal(await decide([taskId, 'HD-9', 'x'], { repoRoot }), 1);
    fs.writeFileSync(
      taskMd,
      fs.readFileSync(taskMd, 'utf8').replace('needs-human-decision', 'human-decided')
    );
    assert.equal(await decide([taskId, 'HD-1', 'x'], { repoRoot }), 1);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
