import test from 'node:test';
import assert from 'node:assert/strict';

import { recordForArtifact, recordForSummary, renderActivityRecoveryMetadata } from '../../../lib/platform/activity-recovery.ts';
import { renderTaskComment } from '../../../lib/platform/issue-comments.ts';
import { recoverTaskFromComments } from '../../../lib/platform/task-recovery.ts';

test('restore rebuilds an activity log from metadata distributed to task, code report, and summary comments', () => {
  const taskId = 'TASK-20260101-000001';
  const task = [
    '---', `id: ${taskId}`, 'type: feature', '---', '', '# Task', '',
    '## Description', '', '<!-- preserved local comment -->', '',
    '## 活动日志', '',
    '- 2026-01-01 09:00:00+08:00 — **Create Task [started]** by codex — started',
    '- 2026-01-01 09:00:01+08:00 — **Create Task** by codex — Task created from structured candidate',
    '- 2026-01-01 10:00:00+08:00 — **Code Task (Round 1) [started]** by codex — started',
    '- 2026-01-01 10:00:30+08:00 — **Commit** by codex — abc1234 feat: add code',
    '- 2026-01-01 10:01:00+08:00 — **Code Task (Round 1)** by codex — Implementation completed → code.md',
    '- 2026-01-01 11:00:00+08:00 — **Create PR [started]** by codex — started',
    '- 2026-01-01 11:00:01+08:00 — **Create PR** by codex — PR #1 created',
    '- 2026-01-01 12:00:00+08:00 — **Complete Task [started]** by codex — started',
    '- 2026-01-01 12:00:01+08:00 — **Complete Task** by codex — Task moved to completed/'
  ].join('\n');
  const taskComment = renderTaskComment(task, taskId, 'codex');
  const metadata = renderActivityRecoveryMetadata(recordForArtifact(taskId, task, 'code.md'));
  const summaryMetadata = renderActivityRecoveryMetadata(recordForSummary(taskId, task));
  const artifactComment = `<!-- sync-issue:${taskId}:code -->\n## Code\n\n> **codex** · ${taskId}\n\n${metadata}# Code\n`;
  const summaryComment = `<!-- sync-issue:${taskId}:summary -->\n## Summary\n\n> **codex** · ${taskId}\n\n${summaryMetadata}# Summary\n`;

  const restored = recoverTaskFromComments({
    taskId,
    comments: [
      { body: taskComment, user: { login: 'codex' } },
      { body: artifactComment, user: { login: 'codex' } },
      { body: summaryComment, user: { login: 'codex' } }
    ]
  });

  assert.match(restored, /<!-- preserved local comment -->/);
  assert.match(restored, /## 活动日志/);
  assert.match(restored, /Task created from structured candidate/);
  assert.match(restored, /Code Task \(Round 1\) \[started\]/);
  assert.match(restored, /abc1234 feat: add code/);
  assert.match(restored, /Implementation completed → code\.md/);
  assert.match(restored, /PR #1 created/);
  assert.match(restored, /Task moved to completed/);
});
