import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { decide } from '../../../lib/decide.ts';

function makeTask(rows: string[] = [
  '| HD-1 | plan | - | decision | needs-human-decision | plan.md#HD-1 |'
]): { repoRoot: string; taskId: string; taskMd: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'decide-'));
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(path.join(repoRoot, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.agents', '.airc.json'), JSON.stringify({ project: 'demo' }));
  const taskMd = path.join(taskDir, 'task.md');
  fs.writeFileSync(
    taskMd,
    `---\nid: ${taskId}\nupdated_at: 2026-01-01 00:00:00+00:00\nagent_infra_version: unknown\n---\n# 任务：demo\n\n## 审查分歧账本\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n${rows.join('\n')}\n\n## 人工裁决\n\n## 实现输入\n\n| id | ledger_id | decision_evidence | stage | needs_implementation | decided_at | status | consumed_by |\n|----|-----------|-------------------|-------|----------------------|------------|--------|-------------|\n\n## 活动日志\n\n- 2026-01-01 00:00:00+00:00 — **Create Task** by codex — created\n`
  );
  return { repoRoot, taskId, taskMd };
}

test('decide marks a legal pending row and records an independent HDR id', async () => {
  const { repoRoot, taskId, taskMd } = makeTask();
  try {
    const code = await decide([taskId, 'HD-1', '选择 A，保持最小范围。'], {
      repoRoot,
      now: () => '2026-07-01 09:30:00+08:00',
      version: '0.7.8-alpha.0'
    });
    assert.equal(code, 0);
    const content = fs.readFileSync(taskMd, 'utf8');
    assert.match(content, /\| HD-1 \| plan \| - \| decision \| human-decided \| task\.md#HDR-1 \|/);
    assert.match(content, /### HDR-1/);
    assert.match(content, /\*\*原账本 ID\*\*：HD-1/);
    assert.match(content, /选择 A，保持最小范围。/);
    assert.match(content, /\*\*Human Decision\*\* by human/);
    assert.match(content, /^updated_at: 2026-07-01 09:30:00\+08:00$/m);
    assert.match(content, /^agent_infra_version: 0\.7\.8-alpha\.0$/m);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('code decisions require explicit implementation intent and create auditable input rows', async () => {
  for (const [needs, expectedStatus] of [['true', 'pending'], ['false', 'not-required']] as const) {
    const { repoRoot, taskId, taskMd } = makeTask([
      '| CD-1 | code | 1 | major | needs-human-decision | review-code.md#CD-1 |'
    ]);
    try {
      const code = await decide([
        taskId, 'CD-1', '--needs-implementation', needs, `choose ${needs}`
      ], {
        repoRoot,
        now: () => '2026-07-01 09:30:00+08:00',
        version: '0.7.8-alpha.0'
      });
      assert.equal(code, 0);
      const content = fs.readFileSync(taskMd, 'utf8');
      assert.match(content, new RegExp(`\\| II-1 \\| CD-1 \\| task\\.md#HDR-1 \\| code \\| ${needs} \\| 2026-07-01 09:30:00\\+08:00 \\| ${expectedStatus} \\|\\s*\\|`));
      assert.ok(content.indexOf('**Create Task**') < content.indexOf('**Human Decision**'));
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  }
});

test('implementation intent validation fails before writing task.md', async () => {
  const cases = [
    { rows: ['| CD-1 | code | 1 | major | needs-human-decision | review-code.md#CD-1 |'], args: ['CD-1', 'missing flag'] },
    { rows: ['| CD-1 | code | 1 | major | needs-human-decision | review-code.md#CD-1 |'], args: ['CD-1', '--needs-implementation', 'maybe', 'bad flag'] },
    { rows: ['| HD-1 | plan | - | decision | needs-human-decision | plan.md#HD-1 |'], args: ['HD-1', '--needs-implementation', 'true', 'wrong stage'] }
  ];
  for (const item of cases) {
    const { repoRoot, taskId, taskMd } = makeTask(item.rows);
    try {
      const before = fs.readFileSync(taskMd);
      assert.equal(await decide([taskId, ...item.args], { repoRoot }), 1);
      assert.deepEqual(fs.readFileSync(taskMd), before);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  }
});

test('decide rejects duplicate ids for both stable and ordinal selectors without writes', async () => {
  const { repoRoot, taskId, taskMd } = makeTask([
    '| HD-1 | plan | - | decision | needs-human-decision | plan.md#HD-1 |',
    '| HD-1 | code | - | decision | needs-human-decision | code.md#HD-1 |'
  ]);
  try {
    const before = fs.readFileSync(taskMd);
    assert.equal(await decide([taskId, 'HD-1', 'x'], { repoRoot }), 1);
    assert.ok(before.equals(fs.readFileSync(taskMd)), 'ambiguous selection must not write');
    assert.equal(await decide([taskId, '2', '--needs-implementation', 'true', 'choose code'], {
      repoRoot,
      now: () => '2026-07-01 09:30:00+08:00',
      version: '0.7.8-alpha.0'
    }), 1);
    assert.ok(before.equals(fs.readFileSync(taskMd)));
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('decide rejects invalid, non-pending, decided, unknown, and invalid ordinal targets without writes', async () => {
  const { repoRoot, taskId, taskMd } = makeTask([
    '| AN-1 | plan | 1 | minor | needs-human-decision | review-analysis.md#AN-1 |',
    '| PL-1 | plan | 1 | minor | confirmed | review-plan.md#PL-1 |',
    '| CD-1 | code | 1 | minor | human-decided | task.md#HDR-7 |',
    '| PRC-1 | post-review-commit | - | - | needs-human-decision | task.md#PRC-1 |'
  ]);
  try {
    for (const selector of ['AN-1', 'PL-1', 'CD-1', 'PRC-1', 'HD-99', '0']) {
      const before = fs.readFileSync(taskMd);
      assert.equal(await decide([taskId, selector, 'x'], { repoRoot }), 1, selector);
      assert.ok(before.equals(fs.readFileSync(taskMd)), `${selector} must not modify task.md`);
    }
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
