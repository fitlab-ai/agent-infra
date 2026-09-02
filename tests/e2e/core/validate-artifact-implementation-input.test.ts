import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyInProcess } from '../../../lib/task/verification-engine.ts';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'implementation-input-gate-'));
  const taskDir = path.join(root, 'TASK-20260101-000001');
  fs.mkdirSync(taskDir);
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---
id: TASK-20260101-000001
---

## 实现输入

| id | ledger_id | decision_evidence | stage | needs_implementation | decided_at | status | consumed_by |
|----|-----------|-------------------|-------|----------------------|------------|--------|-------------|
| II-1 | CD-1 | task.md#HDR-1 | code | true | 2026-07-18 10:01:00+08:00 | consumed | code-r2.md |

## 活动日志

- 2026-07-18 10:02:00+08:00 — **Code Task (Round 2, decision II-1)** by codex — Code implemented, 1 files modified, 4 tests passed → code-r2.md
`);
  fs.writeFileSync(path.join(taskDir, 'code-r2.md'), `# 实现报告

## 实现输入

- **模式**：decision
- **方案输入**：\`plan.md\`
- **审查输入**：\`review-code.md\`
- **裁决输入**：\`II-1\`
- **账本 ID**：\`CD-1\`
- **裁决证据**：\`task.md#HDR-1\`
- **需求摘要**：apply ruling
`);
  return { root, taskDir };
}

function run(taskDir: string) {
  return verifyInProcess({
    mode: 'checks', skillName: 'code-task', taskDir, artifactFile: 'code-r2.md',
    checks: ['implementation-input'], repositoryRoot: process.cwd()
  }) as { status: string };
}

test('implementation input gate accepts matching action, report, and task row', () => {
  const f = fixture();
  try {
    const result = run(f.taskDir);
    assert.equal(result.status, 'pass');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('implementation input gate rejects identity and consumption mismatches', () => {
  for (const replacement of [
    ['`II-1`', '`II-2`'],
    ['| consumed | code-r2.md |', '| pending | |'],
    ['`task.md#HDR-1`', '`task.md#HDR-9`']
  ] as Array<[string, string]>) {
    const f = fixture();
    try {
      const report = path.join(f.taskDir, replacement[0].startsWith('`') ? 'code-r2.md' : 'task.md');
      fs.writeFileSync(report, fs.readFileSync(report, 'utf8').replace(replacement[0], replacement[1]));
      const result = run(f.taskDir);
      assert.equal(result.status, 'fail');
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  }
});
