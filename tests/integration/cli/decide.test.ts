import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CLI_PATH } from '../../helpers.ts';

const SHORT_ID_SCRIPT = path.resolve(process.cwd(), '.agents/scripts/task-short-id.js');

function fixture(rows: string[]): { repoRoot: string; taskId: string; taskMd: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'decide-cli-'));
  spawnSync('git', ['init', '--quiet'], { cwd: repoRoot });
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(path.join(repoRoot, '.agents', 'scripts'), { recursive: true });
  fs.mkdirSync(taskDir, { recursive: true });
  fs.copyFileSync(SHORT_ID_SCRIPT, path.join(repoRoot, '.agents', 'scripts', 'task-short-id.js'));
  fs.writeFileSync(path.join(repoRoot, '.agents', '.airc.json'), JSON.stringify({ project: 'demo' }));
  const taskMd = path.join(taskDir, 'task.md');
  fs.writeFileSync(taskMd, `---\nid: ${taskId}\nupdated_at: 2026-01-01 00:00:00+00:00\nagent_infra_version: v0.0.0\n---\n# Task\n\n## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n${rows.join('\n')}\n\n## Human Rulings\n\n## Implementation Inputs\n\n| id | ledger_id | decision_evidence | stage | needs_implementation | decided_at | status | consumed_by |\n|----|-----------|-------------------|-------|----------------------|------------|--------|-------------|\n\n## Activity Log\n`);
  spawnSync('node', [SHORT_ID_SCRIPT, 'alloc', taskId], { cwd: repoRoot, encoding: 'utf8' });
  return { repoRoot, taskId, taskMd };
}

function run(repoRoot: string, args: string[]) {
  return spawnSync('node', [CLI_PATH, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC' }
  });
}

test('real CLI writes AN, PL, CD, and HD targets through full and short task refs', () => {
  const data = fixture([
    '| AN-1 | analysis | 1 | minor | needs-human-decision | analysis.md#AN-1 |',
    '| PL-1 | plan | 1 | major | needs-human-decision | plan.md#PL-1 |',
    '| CD-1 | code | 1 | blocker | needs-human-decision | code.md#CD-1 |',
    '| HD-1 | plan | - | decision | needs-human-decision | plan.md#HD-1 |'
  ]);
  try {
    for (const args of [
      [data.taskId, 'AN-1', 'analysis choice'],
      ['1', 'PL-1', 'plan choice'],
      ['#1', '1', '--needs-implementation', 'true', 'code choice'],
      [data.taskId, 'HD-1', 'executor choice']
    ]) {
      const result = run(data.repoRoot, ['decide', ...args]);
      assert.equal(result.status, 0, result.stderr);
    }
    const content = fs.readFileSync(data.taskMd, 'utf8');
    assert.equal((content.match(/human-decided/g) ?? []).length, 4);
    assert.match(content, /\| II-1 \| CD-1 \| task\.md#HDR-3 \| code \| true \| \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\+00:00 \| pending \|\s*\|/);
    assert.deepEqual([...content.matchAll(/^### HDR-(\d+)$/gm)].map((match) => match[1]), ['4', '3', '2', '1']);
    for (const id of ['AN-1', 'PL-1', 'CD-1', 'HD-1']) {
      assert.match(content, new RegExp(`\\*\\*原账本 ID\\*\\*：${id}`));
    }
  } finally {
    fs.rmSync(data.repoRoot, { recursive: true, force: true });
  }
});

test('real CLI rejects duplicate ids without writes for stable and ordinal selectors', () => {
  const data = fixture([
    '| HD-1 | analysis | - | decision | needs-human-decision | analysis.md#HD-1 |',
    '| HD-1 | plan | - | decision | needs-human-decision | plan.md#HD-1 |'
  ]);
  try {
    const before = fs.readFileSync(data.taskMd);
    const ambiguous = run(data.repoRoot, ['decide', data.taskId, 'HD-1', 'x']);
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /duplicate table key/);
    assert.ok(before.equals(fs.readFileSync(data.taskMd)));

    const selected = run(data.repoRoot, ['decide', data.taskId, '2', 'plan row']);
    assert.equal(selected.status, 1);
    assert.match(selected.stderr, /duplicate table key/);
    assert.ok(before.equals(fs.readFileSync(data.taskMd)));
  } finally {
    fs.rmSync(data.repoRoot, { recursive: true, force: true });
  }
});
